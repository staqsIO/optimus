/**
 * Create a Telegram adapter implementing InputAdapter + OutputAdapter.
 * Output is delegated to an injected sender function; input is inline since
 * Telegram stores full text at ingestion (no on-demand fetch needed).
 * @param {Object} deps - REQUIRED channel implementation
 * @param {Function} deps.sendTelegramDraft
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createTelegramAdapter(deps) {
  if (!deps || typeof deps.sendTelegramDraft !== 'function') {
    throw new TypeError('createTelegramAdapter requires {sendTelegramDraft}');
  }
  const _sendTelegramDraft = deps.sendTelegramDraft;

  return {
    channel: 'telegram',

    async fetchContent(message) {
      // Telegram stores full text at ingestion — no API call needed
      return message.snippet || null;
    },

    buildPromptContext(message, body) {
      return {
        channel: 'telegram',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_message',
        contentType: 'message',
        sender: {
          name: message.from_name || '',
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: message.in_reply_to || null,
          subject: null,
          toAddresses: message.to_addresses || [],
          ccAddresses: [],
        },
        channelHint: '\nCHANNEL: Telegram DM from board member. Expecting a reply — bias toward "needs_response" unless clearly informational.',
      };
    },

    async createDraft(_draftId) {
      // Telegram has no draft concept
      return null;
    },

    async executeDraft(draftId) {
      return _sendTelegramDraft(draftId);
    },
  };
}
