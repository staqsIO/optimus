import { query } from '../db.js';
import { sendMessage } from './client.js';
import { logCommsIntent, publishEvent } from '../runtime/infrastructure.js';

/**
 * Telegram sender: send approved drafts as Telegram messages.
 * Mirrors src/slack/sender.js.
 */

/**
 * Send an approved draft as a Telegram message.
 * @param {string} draftId - Database draft ID
 * @returns {Promise<number>} Telegram message ID
 */
export async function sendTelegramDraft(draftId) {
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

  // Get the original message for chat context
  const msgResult = await query(`SELECT * FROM inbox.messages WHERE id = $1`, [draft.message_id]);
  const message = msgResult.rows[0];
  if (!message) throw new Error(`Source message not found for draft ${draftId}`);

  // Extract Telegram chat ID from the source message metadata
  const chatId = message.thread_id; // thread_id stores the chat ID for Telegram

  const body = draft.board_edited_body || draft.body;

  const sentMsgId = await sendMessage(chatId, body);

  // Update draft record
  await query(
    `UPDATE agent_graph.action_proposals SET provider_sent_id = $1, send_state = 'delivered', updated_at = now()
     WHERE id = $2`,
    [String(sentMsgId), draftId]
  );

  // Log to communication gateway
  await logCommsIntent({
    channel: 'telegram',
    recipient: message.from_address,
    subject: null,
    body,
    intentType: 'send',
    sourceAgent: 'executor-responder',
    sourceTask: draftId,
  });
  await publishEvent('draft_sent', `Telegram message sent for draft ${draftId}`, null, null, { draft_id: draftId, telegram_msg_id: sentMsgId });

  console.log(`[telegram-sender] Message sent: ${sentMsgId} for draft ${draftId}`);
  return sentMsgId;
}

/**
 * Send a notification to all registered board members.
 * Used for proactive outbound (orchestrator notifications, alerts).
 * @param {string} text - Notification text
 * @returns {Promise<void>}
 */
export async function notifyBoard(text) {
  const raw = process.env.TELEGRAM_BOARD_USER_IDS || '';
  const userIds = raw.split(',').map(id => id.trim()).filter(Boolean);

  if (userIds.length === 0) {
    console.warn('[telegram-sender] notifyBoard called but TELEGRAM_BOARD_USER_IDS is empty');
    return;
  }

  const results = await Promise.allSettled(
    userIds.map(chatId => sendMessage(chatId, text))
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`[telegram-sender] notifyBoard: ${failed.length}/${userIds.length} sends failed`);
  }
}

/**
 * Notify the board member who created a specific campaign via Telegram DM.
 * Falls back to notifyBoard() broadcast if creator has no telegram_id.
 * @param {string} campaignId - Campaign UUID
 * @param {string} text - Notification text
 * @returns {Promise<void>}
 */
export async function notifyCreator(campaignId, text) {
  try {
    const result = await query(
      `SELECT bm.telegram_id, bm.display_name
       FROM agent_graph.campaigns c
       JOIN agent_graph.board_members bm ON bm.github_username = c.created_by
       WHERE c.id = $1`,
      [campaignId]
    );
    const member = result.rows[0];

    if (member?.telegram_id) {
      await sendMessage(member.telegram_id, text);
      return;
    }
  } catch (err) {
    console.warn(`[telegram-sender] notifyCreator lookup failed for ${campaignId}: ${err.message}`);
  }

  // Fallback: broadcast to all board members
  await notifyBoard(text);
}
