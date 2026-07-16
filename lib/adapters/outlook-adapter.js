/**
 * Create an Outlook adapter implementing InputAdapter + OutputAdapter.
 * Channel-specific implementations are injected by the product.
 * Channel is 'email' (same medium as Gmail), provider is 'outlook'.
 * @param {Object} deps - REQUIRED channel implementations
 * @param {Function} deps.fetchOutlookBody
 * @param {Function} deps.createOutlookDraft
 * @param {Function} deps.sendApprovedOutlookDraft
 * @returns {import('./input-adapter.js').InputAdapter & import('./output-adapter.js').OutputAdapter}
 */
export function createOutlookAdapter(deps) {
  if (!deps || typeof deps.fetchOutlookBody !== 'function' ||
      typeof deps.createOutlookDraft !== 'function' ||
      typeof deps.sendApprovedOutlookDraft !== 'function') {
    throw new TypeError('createOutlookAdapter requires {fetchOutlookBody, createOutlookDraft, sendApprovedOutlookDraft}');
  }
  const _fetchOutlookBody = deps.fetchOutlookBody;
  const _createOutlookDraft = deps.createOutlookDraft;
  const _sendApprovedOutlookDraft = deps.sendApprovedOutlookDraft;

  return {
    channel: 'email',

    async fetchContent(message) {
      return _fetchOutlookBody(message.provider_msg_id, message.account_id);
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
      return _createOutlookDraft(draftId);
    },

    async executeDraft(draftId) {
      return _sendApprovedOutlookDraft(draftId);
    },
  };
}
