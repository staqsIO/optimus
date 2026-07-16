import { withTransaction } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { notify } from '../runtime/event-bus.js';
import { getUserInfo, sendMessage } from './client.js';
import { parseCommand, executeCommand } from '../commands/board-commands.js';
import { handleBoardQuery } from '../commands/board-query.js';

/**
 * Slack inbound message handler.
 * Pre-filter at ingestion (Liotta #3): only DMs and @mentions create work items.
 * Bot messages, file_share, channel_join, etc. are ignored — no LLM cost.
 */

// Subtypes to ignore — these never create work items
const IGNORED_SUBTYPES = new Set([
  'bot_message', 'bot_add', 'bot_remove',
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name',
  'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name',
  'file_share', 'file_comment', 'file_mention',
  'pinned_item', 'unpinned_item',
  'message_changed', 'message_deleted',
  'ekm_access_denied', 'me_message',
  'thread_broadcast',
]);

/**
 * Register Slack message listeners on the Bolt app.
 * @param {import('@slack/bolt').App} app - Slack Bolt app instance
 * @param {string} slackAccountId - The inbox.accounts.id for this Slack workspace
 */
export function registerSlackListeners(app, slackAccountId) {
  // Listen for all messages via event (more reliable than app.message in Socket Mode)
  app.event('message', async ({ event, context }) => {
    try {
      await handleMessage(event, context, slackAccountId);
    } catch (err) {
      console.error('[slack-listener] Error handling message:', err.message);
    }
  });

  // Listen for app_mention events (when someone @mentions the bot)
  app.event('app_mention', async ({ event }) => {
    try {
      await handleMention(event, slackAccountId);
    } catch (err) {
      console.error('[slack-listener] Error handling mention:', err.message);
    }
  });

  console.log('[slack-listener] Listeners registered');
}

async function handleMessage(message, context, slackAccountId) {
  // Pre-filter: skip ignored subtypes
  if (message.subtype && IGNORED_SUBTYPES.has(message.subtype)) return;

  // Skip bot messages (no subtype but has bot_id)
  if (message.bot_id) return;

  // Skip messages without text
  if (!message.text) return;

  // Only process DMs (channel type 'im')
  // Channel messages are handled via app_mention only
  if (message.channel_type !== 'im') return;

  // Board commands: parse DMs for approve/reject/resolve/status before ingesting as work items
  const cmd = parseCommand(message.text);
  if (cmd) {
    try {
      const reply = await executeCommand(cmd, { source: 'slack' });
      await sendMessage(message.channel, reply, message.ts);
    } catch (err) {
      await sendMessage(message.channel, `Command failed: ${err.message}`, message.ts);
    }
    return; // Don't ingest commands as work items
  }

  // Not a command — answer conversationally (actions only supported on Telegram)
  const result = await handleBoardQuery(message.text, { source: 'slack', sessionId: `slack:${message.channel}` });
  if (result?.type === 'answer') {
    await sendMessage(message.channel, result.answer, message.ts);
  } else if (result?.type === 'action') {
    await sendMessage(message.channel, `Proposed: ${result.summary} (use Telegram to confirm)`, message.ts);
  } else {
    // Fallback: ingest as work item (no API key, or query failed)
    await ingestSlackMessage({
      channelId: message.channel,
      messageTs: message.ts,
      threadTs: message.thread_ts || null,
      userId: message.user,
      text: message.text,
      slackAccountId,
    });
  }
}

async function handleMention(event, slackAccountId) {
  // Skip bot messages
  if (event.bot_id) return;
  if (!event.text) return;

  await ingestSlackMessage({
    channelId: event.channel,
    messageTs: event.ts,
    threadTs: event.thread_ts || null,
    userId: event.user,
    text: event.text,
    slackAccountId,
  });
}

/**
 * Ingest a Slack message into the pipeline.
 *
 * Atomic: INSERT messages (with ON CONFLICT against the (channel, channel_id)
 * partial unique index) → createWorkItem (sharing the parent client) → UPDATE
 * messages.work_item_id. Any throw rolls all three back so a Slack retry can
 * re-ingest cleanly without a duplicate row or a 500 response.
 *
 * Conflict path mirrors voice-memo: if the messages row already exists with a
 * work_item_id we clean-skip; if it exists without a work_item_id (a prior
 * attempt crashed mid-flight), we recover by reusing the row.
 */
export async function ingestSlackMessage({ channelId, messageTs, threadTs, userId, text, slackAccountId }) {
  const channelIdKey = `${channelId}:${messageTs}`;

  // User lookup (HTTP) before the transaction — no row lock to hold here, and
  // we need the result to populate the INSERT.
  let fromName = userId;
  let fromAddress = userId;
  try {
    const userInfo = await getUserInfo(userId);
    fromName = userInfo.realName || userInfo.name;
    fromAddress = userInfo.email || `${userId}@slack`;
  } catch {
    // Fall back to userId
  }

  const result = await withTransaction(async (client) => {
    const msgResult = await client.query(
      `INSERT INTO inbox.messages
       (provider_msg_id, provider, thread_id, message_id, from_address, from_name, to_addresses,
        subject, snippet, received_at, labels, has_attachments, in_reply_to,
        channel, account_id, channel_id)
       VALUES (NULL, 'slack', $1, $2, $3, $4, $5, $6, $7, now(), $8, false, $9,
               'slack', $10, $11)
       ON CONFLICT (channel, channel_id) DO NOTHING
       RETURNING id`,
      [
        threadTs || channelId,           // thread_id
        channelIdKey,                    // message_id
        fromAddress,
        fromName,
        [],
        null,
        text,
        ['SLACK'],
        threadTs || null,                // in_reply_to
        slackAccountId,
        channelIdKey,                    // channel_id (dedup key)
      ]
    );

    let messageId = msgResult.rows[0]?.id;
    if (!messageId) {
      // ON CONFLICT fired. Either (a) a true duplicate (Slack retry after
      // success — work item exists) or (b) a prior crashed attempt left a
      // messages row with no work_item_id — recover.
      const existing = await client.query(
        `SELECT id, work_item_id FROM inbox.messages WHERE channel = 'slack' AND channel_id = $1`,
        [channelIdKey]
      );
      const existingRow = existing.rows[0];
      if (!existingRow) {
        throw new Error(`Slack channel_id ${channelIdKey} hit ON CONFLICT but row not found`);
      }
      if (existingRow.work_item_id) {
        return { skipped: true, reason: 'duplicate, work_item already exists' };
      }
      messageId = existingRow.id;
      console.warn(`[slack-listener] Recovering orphan messages row for ${channelIdKey} — creating missing work item`);
    }

    const workItem = await createWorkItem({
      type: 'task',
      title: `Process Slack: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`,
      description: `Slack message from ${fromName}`,
      createdBy: 'orchestrator',
      assignedTo: 'orchestrator',
      priority: 0,
      metadata: { email_id: messageId, channel: 'slack', slack_channel: channelId, slack_ts: messageTs },
      client,
    });

    if (!workItem) {
      return { skipped: true, reason: 'createWorkItem returned null' };
    }

    await client.query(
      `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
      [workItem.id, messageId]
    );

    return { messageId, workItemId: workItem.id, fromName };
  });

  if (result.skipped) return;

  // Post-commit notify (createWorkItem deferred because we owned the tx).
  notify({ eventType: 'task_assigned', workItemId: result.workItemId, targetAgentId: 'orchestrator' })
    .catch(() => {});

  console.log(`[slack-listener] New message from ${result.fromName} → task ${result.workItemId}`);
}
