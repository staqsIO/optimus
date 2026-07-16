/**
 * Create an email adapter implementing InputAdapter + OutputAdapter.
 * Channel-specific implementations are injected by the product (no direct
 * cross-layer imports here — keeps lib/ free of product-specific coupling).
 * @param {Object} deps - REQUIRED channel implementations
 * @param {Function} deps.fetchEmailBody
 * @param {Function} deps.createGmailDraft
 * @param {Function} deps.sendApprovedDraft
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createEmailAdapter(deps) {
  if (!deps || typeof deps.fetchEmailBody !== 'function' ||
      typeof deps.createGmailDraft !== 'function' ||
      typeof deps.sendApprovedDraft !== 'function') {
    throw new TypeError('createEmailAdapter requires {fetchEmailBody, createGmailDraft, sendApprovedDraft}');
  }
  const _fetchEmailBody = deps.fetchEmailBody;
  const _createGmailDraft = deps.createGmailDraft;
  const _sendApprovedDraft = deps.sendApprovedDraft;

  return {
    channel: 'email',

    async fetchContent(message) {
      return _fetchEmailBody(message.provider_msg_id, message.account_id);
    },

    buildPromptContext(message, body) {
      return {
        channel: 'email',
        body: body ?? message.snippet ?? null,
        contentLabel: 'untrusted_email',
        contentType: 'email',
        sender: {
          name: message.from_name || '',
          address: message.from_address || '',
        },
        threading: {
          threadId: message.thread_id || null,
          inReplyTo: message.in_reply_to || null,
          subject: message.subject || null,
          toAddresses: message.to_addresses || [],
          ccAddresses: message.cc_addresses || [],
        },
        channelHint: '',
      };
    },

    async createDraft(draftId) {
      return _createGmailDraft(draftId);
    },

    async executeDraft(draftId) {
      return _sendApprovedDraft(draftId);
    },
  };
}
