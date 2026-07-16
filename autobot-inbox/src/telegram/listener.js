import { query } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { sendMessage } from './client.js';
import { parseCommand, executeCommand } from '../commands/board-commands.js';
import { handleBoardQuery } from '../commands/board-query.js';
import { proposeAction, handleCallbackQuery, subscribeToCompletions } from './actions.js';

/**
 * Telegram inbound message handler.
 * P1: deny by default — only board members (TELEGRAM_BOARD_USER_IDS) get responses.
 * Non-board members are silently ignored.
 */

// Parse board member IDs from env once (comma-separated Telegram user IDs)
let _boardUserIds = null;
function getBoardUserIds() {
  if (!_boardUserIds) {
    const raw = process.env.TELEGRAM_BOARD_USER_IDS || '';
    _boardUserIds = new Set(raw.split(',').map(id => id.trim()).filter(Boolean));
  }
  return _boardUserIds;
}

function isBoardMember(userId) {
  return getBoardUserIds().has(String(userId));
}

/**
 * Register Telegram message listeners on the bot.
 * @param {import('node-telegram-bot-api')} bot - Telegram bot instance
 * @param {string} telegramAccountId - The inbox.accounts.id for this Telegram bot
 */
export function registerTelegramListeners(bot, telegramAccountId) {
  bot.on('message', async (msg) => {
    try {
      await handleMessage(msg, telegramAccountId);
    } catch (err) {
      console.error('[telegram-listener] Error handling message:', err.message);
    }
  });

  // Inline keyboard button clicks (action confirmations)
  bot.on('callback_query', async (cbq) => {
    try {
      if (!isBoardMember(cbq.from?.id)) return;
      if (cbq.data?.startsWith('action:')) {
        await handleCallbackQuery(cbq);
      }
    } catch (err) {
      console.error('[telegram-listener] Error handling callback_query:', err.message);
    }
  });

  // Subscribe to async task completions (e.g., research results pushed back to Telegram)
  subscribeToCompletions();

  console.log('[telegram-listener] Listeners registered');
}

async function handleMessage(msg, telegramAccountId) {
  // Skip messages without text (stickers, photos, etc.)
  if (!msg.text) return;

  // Channel posts and service messages lack msg.from
  if (!msg.from) return;

  // P1: deny by default — only board members get responses
  if (!isBoardMember(msg.from.id)) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  // Board commands: parse for approve/reject/resolve/status
  const cmd = parseCommand(text);
  if (cmd) {
    try {
      const reply = await executeCommand(cmd, { source: 'telegram' });
      await sendMessage(chatId, reply);
    } catch (err) {
      await sendMessage(chatId, `Command failed: ${err.message}`);
    }
    return;
  }

  // Not a command — answer conversationally or propose an action
  const result = await handleBoardQuery(text, { source: 'telegram', sessionId: `tg:${chatId}` });
  if (result?.type === 'answer') {
    await sendMessage(chatId, result.answer);
  } else if (result?.type === 'action') {
    await proposeAction(chatId, msg.from.id, result);
  } else {
    // Fallback: ingest as work item (no API key, or query failed)
    await ingestTelegramMessage({
      chatId,
      messageId: msg.message_id,
      userId: msg.from.id,
      username: msg.from.username || msg.from.first_name || String(msg.from.id),
      firstName: msg.from.first_name || '',
      text,
      telegramAccountId,
    });
  }
}

/**
 * Ingest a Telegram message into the pipeline.
 * Dedup via (channel, channel_id) unique index.
 */
async function ingestTelegramMessage({ chatId, messageId, userId, username, firstName, text, telegramAccountId }) {
  const channelIdKey = `${chatId}:${messageId}`;

  // Dedup check
  const existing = await query(
    `SELECT id FROM inbox.messages WHERE channel = 'telegram' AND channel_id = $1`,
    [channelIdKey]
  );
  if (existing.rows.length > 0) return;

  const fromName = firstName || username;
  const fromAddress = `${userId}@telegram`;

  // Insert into inbox.messages (Telegram messages are short like Slack — store in snippet)
  const msgResult = await query(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, thread_id, message_id, from_address, from_name, to_addresses,
      subject, snippet, received_at, labels, has_attachments, in_reply_to,
      channel, account_id, channel_id)
     VALUES (NULL, 'telegram', $1, $2, $3, $4, $5, $6, $7, now(), $8, false, $9,
             'telegram', $10, $11)
     RETURNING id`,
    [
      String(chatId),                  // thread_id: chat ID groups messages
      channelIdKey,                    // message_id (unique ref)
      fromAddress,                     // from_address
      fromName,                        // from_name
      [],                              // to_addresses
      null,                            // subject (Telegram has no subjects)
      text,                            // snippet: store full text
      ['TELEGRAM'],                    // labels
      null,                            // in_reply_to
      telegramAccountId,               // account_id
      channelIdKey,                    // channel_id for dedup
    ]
  );

  const dbMessageId = msgResult.rows[0]?.id;
  if (!dbMessageId) return;

  // Create work item → normal pipeline
  const workItem = await createWorkItem({
    type: 'task',
    title: `Process Telegram: ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`,
    description: `Telegram message from ${fromName}`,
    createdBy: 'orchestrator',
    assignedTo: 'orchestrator',
    priority: 0,
    metadata: { email_id: dbMessageId, channel: 'telegram', telegram_chat_id: String(chatId), telegram_msg_id: messageId },
  });

  if (!workItem) return;

  // Link message to work item
  await query(
    `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
    [workItem.id, dbMessageId]
  );

  console.log(`[telegram-listener] New message from ${fromName} → task ${workItem.id}`);
}
