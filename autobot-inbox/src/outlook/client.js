import { getOutlookAuth } from './auth.js';

/**
 * Outlook client: fetch email bodies and metadata via Microsoft Graph API.
 * Mirrors gmail/client.js interface. Uses built-in fetch (Node 20+, P4).
 * D1: Bodies fetched on-demand, never stored in DB.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Make an authenticated Graph API request.
 * @param {string} path - API path (e.g., '/me/messages/{id}')
 * @param {string} accountId - inbox.accounts.id
 * @param {Object} [options] - fetch options
 * @returns {Promise<Object>} JSON response
 */
async function graphRequest(path, accountId, options = {}) {
  const accessToken = await getOutlookAuth(accountId);
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Graph API error ${response.status}: ${errText}`);
  }

  // Handle 204 No Content (e.g., send returns no body)
  if (response.status === 204) return null;

  return response.json();
}

/**
 * Fetch email body on-demand from Outlook (D1: never stored in DB).
 * Short-circuits for null/demo_/test_ IDs (same as gmail/client.js).
 * @param {string|null} msgId - Graph message ID
 * @param {string} accountId - inbox.accounts.id
 * @returns {Promise<string|null>} Plain text body
 */
export async function fetchOutlookBody(msgId, accountId) {
  if (!msgId) return null;
  if (msgId.startsWith('demo_') || msgId.startsWith('test_')) return null;

  try {
    const data = await graphRequest(
      `/me/messages/${msgId}?$select=body,bodyPreview`,
      accountId
    );

    if (!data?.body?.content) return null;

    // Graph API returns body with contentType 'text' or 'html'
    if (data.body.contentType === 'text') {
      return data.body.content;
    }

    // HTML body — strip tags
    return stripHtml(data.body.content);
  } catch (err) {
    console.error(`[outlook] Failed to fetch body for ${msgId}:`, err.message);
    return null;
  }
}

/**
 * Fetch email metadata from Outlook.
 * Returns same normalized shape as gmail/client.js:fetchEmailMetadata.
 * @param {string} msgId - Graph message ID
 * @param {string} accountId - inbox.accounts.id
 * @returns {Promise<Object>} Normalized message metadata
 */
export async function fetchOutlookMetadata(msgId, accountId) {
  const data = await graphRequest(
    `/me/messages/${msgId}?$select=id,conversationId,internetMessageId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,hasAttachments,internetMessageHeaders`,
    accountId
  );

  const inReplyTo = (data.internetMessageHeaders || [])
    .find(h => h.name.toLowerCase() === 'in-reply-to')?.value || null;

  return {
    provider_msg_id: data.id,
    thread_id: data.conversationId,
    message_id: data.internetMessageId || '',
    from_address: data.from?.emailAddress?.address || '',
    from_name: data.from?.emailAddress?.name || null,
    to_addresses: (data.toRecipients || []).map(r => r.emailAddress.address),
    cc_addresses: (data.ccRecipients || []).map(r => r.emailAddress.address),
    subject: data.subject || '',
    snippet: data.bodyPreview || '',
    received_at: data.receivedDateTime || new Date().toISOString(),
    labels: [],
    has_attachments: data.hasAttachments || false,
    in_reply_to: inReplyTo,
    account_id: accountId,
  };
}

/**
 * Create a draft message in Outlook (D2: drafts, not sends, in L0).
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text)
 * @param {string|null} conversationId - Outlook conversation ID for threading
 * @param {string|null} inReplyTo - Message-ID header for threading
 * @param {string} accountId - inbox.accounts.id
 * @returns {Promise<string>} Graph draft message ID
 */
export async function createOutlookDraftMessage(to, subject, body, conversationId, inReplyTo, accountId) {
  const message = {
    subject,
    body: {
      contentType: 'text',
      content: body,
    },
    toRecipients: [{ emailAddress: { address: to } }],
  };

  if (conversationId) message.conversationId = conversationId;
  if (inReplyTo) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: inReplyTo },
    ];
  }

  const data = await graphRequest('/me/messages', accountId, {
    method: 'POST',
    body: JSON.stringify(message),
  });

  return data.id;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
