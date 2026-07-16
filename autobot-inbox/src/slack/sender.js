import { query } from '../db.js';
import { sendMessage } from './client.js';
import { logCommsIntent, publishEvent } from '../runtime/infrastructure.js';

/**
 * Slack sender: send approved drafts as Slack messages.
 * Thread replies: if source was in a thread, reply in same thread.
 */

/**
 * Send an approved draft as a Slack message.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<string>} Slack message timestamp (ts)
 */
export async function sendSlackDraft(draftId) {
  const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
  const draft = result.rows[0];
  if (!draft) throw new Error(`Draft ${draftId} not found`);

  // Verify board has approved
  if (!draft.board_action || !['approved', 'edited', 'auto_approved'].includes(draft.board_action)) {
    throw new Error(`Draft ${draftId} has not been board-approved (board_action: ${draft.board_action})`);
  }

  // Already sent
  if (draft.provider_sent_id) {
    throw new Error(`Draft ${draftId} has already been sent`);
  }

  // Get the original message for threading context
  const msgResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [draft.message_id]);
  const message = msgResult.rows[0];
  if (!message) throw new Error(`Source message not found for draft ${draftId}`);

  // Extract Slack channel and thread info from the source message
  const slackChannel = message.thread_id; // For Slack DMs this is the channel ID
  const channelIdParts = (message.channel_id || '').split(':');
  const channelId = channelIdParts[0]; // channel ID is first part of "channel:ts"
  const threadTs = message.in_reply_to || null; // Reply in thread if source was threaded

  const body = draft.board_edited_body || draft.body;
  const targetChannel = channelId || slackChannel;

  const { ok, ts } = await sendMessage(targetChannel, body, threadTs);

  if (!ok) throw new Error(`Slack API returned ok=false for draft ${draftId}`);

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
     WHERE id = $2`,
    [ts, draftId]
  );

  // Log to communication gateway
  await logCommsIntent({
    channel: 'slack',
    recipient: message.from_address,
    subject: null,
    body,
    intentType: 'send',
    sourceAgent: 'executor-responder',
    sourceTask: draftId,
  });
  await publishEvent('draft_sent', `Slack message sent for draft ${draftId}`, null, null, { draft_id: draftId, slack_ts: ts });

  console.log(`[slack-sender] Message sent: ${ts} for draft ${draftId}`);
  return ts;
}
