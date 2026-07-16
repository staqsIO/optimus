/**
 * Create a Slack adapter implementing InputAdapter + OutputAdapter.
 * Output is delegated to an injected sender function; input is inline since
 * Slack stores full text at ingestion (no on-demand fetch needed).
 * @param {Object} deps - REQUIRED channel implementation
 * @param {Function} deps.sendSlackDraft
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createSlackAdapter(deps) {
  if (!deps || typeof deps.sendSlackDraft !== 'function') {
    throw new TypeError('createSlackAdapter requires {sendSlackDraft}');
  }
  const _sendSlackDraft = deps.sendSlackDraft;

  return {
    channel: 'slack',

    async fetchContent(message) {
      // Slack stores full text at ingestion — no API call needed
      return message.snippet || null;
    },

    buildPromptContext(message, body) {
      return {
        channel: 'slack',
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
        channelHint: '\nCHANNEL: Slack DM/mention. People DM expecting a reply — bias toward "needs_response" unless clearly informational.',
      };
    },

    async createDraft(_draftId) {
      // Slack has no draft concept
      return null;
    },

    async executeDraft(draftId) {
      return _sendSlackDraft(draftId);
    },
  };
}
