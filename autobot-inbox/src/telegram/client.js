/**
 * Telegram bot initialization (long polling — no inbound ports needed).
 * Mirrors src/slack/client.js singleton pattern.
 * P4: boring infrastructure — node-telegram-bot-api, long polling.
 */

let bot = null;
let _initPromise = null;

/**
 * Initialize the Telegram bot. Must be called before getTelegramBot().
 * Uses dynamic import so node-telegram-bot-api is only loaded when configured.
 * @returns {Promise<import('node-telegram-bot-api')>}
 */
export async function initTelegramBot() {
  if (bot) return bot;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    const TelegramBot = (await import('node-telegram-bot-api')).default;
    return new TelegramBot(token, { polling: false });
  })();

  try {
    bot = await _initPromise;
  } catch (err) {
    _initPromise = null;
    throw err;
  }
  return bot;
}

/**
 * Get the initialized Telegram bot instance.
 * @returns {import('node-telegram-bot-api')}
 */
export function getTelegramBot() {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegramBot() first.');
  return bot;
}

/**
 * Send a message to a Telegram chat.
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} text - Message text
 * @param {Object} [options] - Additional options (reply_to_message_id, etc.)
 * @returns {Promise<number>} Telegram message ID
 */
export async function sendMessage(chatId, text, options = {}) {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegramBot() first.');

  const result = await bot.sendMessage(chatId, text, options);

  return result.message_id;
}

/**
 * Send a message with an inline keyboard (action confirmation buttons).
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} text - Message text
 * @param {Array<Array<{text: string, callback_data: string}>>} keyboard - Inline keyboard rows
 * @param {Object} [options] - Additional options
 * @returns {Promise<number>} Telegram message ID
 */
export async function sendMessageWithKeyboard(chatId, text, keyboard, options = {}) {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegramBot() first.');

  const result = await bot.sendMessage(chatId, text, {
    ...options,
    reply_markup: { inline_keyboard: keyboard },
  });

  return result.message_id;
}

/**
 * Edit an existing message (e.g., after button click to show result).
 * @param {string|number} chatId - Telegram chat ID
 * @param {number} messageId - Message ID to edit
 * @param {string} text - New message text
 * @param {Object} [options] - Additional options
 */
export async function editMessage(chatId, messageId, text, options = {}) {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegramBot() first.');

  await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
}

/**
 * Acknowledge a callback_query (required by Telegram API to dismiss loading indicator).
 * @param {string} callbackQueryId
 */
export async function answerCallback(callbackQueryId) {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegramBot() first.');

  await bot.answerCallbackQuery(callbackQueryId);
}

/**
 * Start the Telegram bot (begin long polling).
 * Calls deleteWebhook first to force-disconnect any competing poller
 * (e.g., Railway instance using the same bot token).
 */
export async function startTelegram() {
  if (!bot) await initTelegramBot();

  // Force-disconnect any other instance polling with this token.
  // deleteWebhook also clears the getUpdates lock on Telegram's side.
  try {
    await bot.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    console.warn('[telegram] deleteWebhook failed (non-fatal):', err.message);
  }

  // Suppress noisy 409 errors during startup handoff
  bot.on('polling_error', (err) => {
    if (err?.message?.includes('409 Conflict')) {
      // Expected during handoff — another instance is releasing the lock
      return;
    }
    console.error('[telegram] Polling error:', err.message);
  });

  await bot.startPolling();
  console.log('[telegram] Bot started (long polling)');
}

/**
 * Stop the Telegram bot.
 */
export async function stopTelegram() {
  if (bot) {
    await bot.stopPolling();
    console.log('[telegram] Bot stopped');
  }
}
