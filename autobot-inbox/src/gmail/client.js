import { readFileSync } from 'fs';
import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';

let gmail;
let demoFixtures = null;

function getGmail(auth) {
  if (auth) return google.gmail({ version: 'v1', auth });
  if (!gmail) {
    gmail = google.gmail({ version: 'v1', auth: getAuth() });
  }
  return gmail;
}

/**
 * Get a Gmail client for a specific account.
 * @param {string} [accountId] - Account ID (null for default env-var auth)
 * @returns {Promise<import('googleapis').gmail_v1.Gmail>}
 */
async function getGmailForAccount(accountId) {
  if (!accountId) return getGmail();
  const auth = await getAuthForAccount(accountId);
  return google.gmail({ version: 'v1', auth });
}

/**
 * Load demo fixtures lazily on first demo-mode fetch.
 */
function getDemoFixtures() {
  if (!demoFixtures) {
    try {
      demoFixtures = JSON.parse(
        readFileSync(new URL('../../fixtures/demo-emails.json', import.meta.url), 'utf-8')
      );
    } catch {
      demoFixtures = [];
    }
  }
  return demoFixtures;
}

/**
 * Fetch email body on-demand (D1: never stored in DB).
 * In demo mode, returns body from fixtures instead of hitting Gmail API.
 * Non-email channels (null gmailId) short-circuit to null — agents fall back to snippet.
 * @param {string|null} gmailId - Gmail message ID (null for non-email channels)
 * @param {string} [accountId] - Account ID for multi-account support
 * @returns {Promise<string|null>} Plain text body
 */
export async function fetchEmailBody(gmailId, accountId) {
  // Non-email channels have no gmailId — short-circuit (agents fall back to snippet)
  if (!gmailId) return null;

  // Demo mode: return fixture body instead of hitting Gmail API
  if (gmailId.startsWith('demo_')) {
    const fixture = getDemoFixtures().find(e => e.provider_msg_id === gmailId);
    return fixture?.body || null;
  }

  // Injected test emails have no real Gmail body — return null (falls back to snippet)
  if (gmailId.startsWith('test_')) {
    return null;
  }

  try {
    const gmailClient = accountId ? await getGmailForAccount(accountId) : getGmail();
    const response = await gmailClient.users.messages.get({
      userId: 'me',
      id: gmailId,
      format: 'full',
    });

    return extractBody(response.data.payload);
  } catch (err) {
    console.error(`[gmail] Failed to fetch body for ${gmailId}:`, err.message);
    return null;
  }
}

/**
 * Extract plain text body from Gmail message payload.
 */
function extractBody(payload) {
  if (!payload) return null;

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart — find text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      // Recursive for nested multipart
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    // Fallback to text/html if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return stripHtml(html);
      }
    }
  }

  return null;
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

/**
 * Fetch email metadata (headers) by Gmail ID.
 * @param {string} gmailId - Gmail message ID
 * @param {string} [accountId] - Account ID for multi-account support
 */
// STAQPRO-562: headers the deterministic header-sniff classifier reads.
// Bulk/automated-mail signals (List-Unsubscribe, List-ID, Precedence,
// Auto-Submitted) plus the envelope-sender hints (Return-Path, Sender) the
// ESP-domain rule already wanted. These are the ONLY structured inputs the
// noise classifier consumes — it never reads body content (invariant: noise
// derived from structured fields only). Fetched via format:'metadata' so this
// stays a single cheap Gmail call with no body download (D1 preserved).
const SNIFF_METADATA_HEADERS = [
  'List-Unsubscribe',
  'List-ID',
  'Precedence',
  'Auto-Submitted',
  'Return-Path',
  'Sender',
];

export async function fetchEmailMetadata(gmailId, accountId) {
  const gmailClient = accountId ? await getGmailForAccount(accountId) : getGmail();
  const response = await gmailClient.users.messages.get({
    userId: 'me',
    id: gmailId,
    format: 'metadata',
    metadataHeaders: [
      'From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To',
      ...SNIFF_METADATA_HEADERS,
    ],
  });

  const headers = {};
  for (const h of response.data.payload.headers) {
    headers[h.name.toLowerCase()] = h.value;
  }

  // Persisted header subset (lowercased name → value) for the deterministic
  // sniffer. We store only the sniff-relevant headers, not the addressing
  // headers (From/To/Cc/Subject) which already have dedicated columns — this
  // keeps the jsonb blob small and its purpose obvious to readers.
  const sniffHeaders = {};
  for (const name of SNIFF_METADATA_HEADERS) {
    const key = name.toLowerCase();
    if (headers[key] != null) sniffHeaders[key] = headers[key];
  }

  return {
    provider_msg_id: response.data.id,
    thread_id: response.data.threadId,
    message_id: headers['message-id'] || '',
    from_address: parseEmailAddress(headers.from || ''),
    from_name: parseEmailName(headers.from || ''),
    to_addresses: parseAddressList(headers.to || ''),
    cc_addresses: parseAddressList(headers.cc || ''),
    subject: headers.subject || '',
    snippet: response.data.snippet || '',
    received_at: headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
    labels: response.data.labelIds || [],
    has_attachments: (response.data.payload.parts || []).some(p => p.filename),
    in_reply_to: headers['in-reply-to'] || null,
    account_id: accountId || null,
    // Empty object (not null) when none of the sniff headers were present, so
    // the classifier always receives a well-formed map.
    headers: sniffHeaders,
  };
}

// Fix 6: Sanitize SMTP header values — prevent \r\n injection (Bcc/Cc injection)
const sanitizeHeader = (s) => String(s).replace(/[\r\n]/g, '');

/**
 * Create a Gmail draft (D2: drafts, not sends, in L0).
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @param {string} [threadId] - Gmail thread ID for threading
 * @param {string} [inReplyTo] - Message-ID header for threading
 * @param {string} [accountId] - Account ID for multi-account support
 */
export async function createDraft(to, subject, body, threadId = null, inReplyTo = null, accountId = null) {
  const headers = [
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(inReplyTo)}`);

  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + body
  ).toString('base64url');

  const params = {
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  };
  if (threadId) params.requestBody.message.threadId = threadId;

  const gmailClient = accountId ? await getGmailForAccount(accountId) : getGmail();
  const response = await gmailClient.users.drafts.create(params);
  return response.data.id;
}

/**
 * Fetch only label IDs for a Gmail message (cheapest API call — format: 'minimal').
 * @param {string} gmailId - Gmail message ID
 * @param {string} [accountId] - Account ID for multi-account support
 * @returns {Promise<string[]>} Label IDs
 */
export async function fetchMessageLabels(gmailId, accountId) {
  const gmailClient = accountId ? await getGmailForAccount(accountId) : getGmail();
  const response = await gmailClient.users.messages.get({
    userId: 'me',
    id: gmailId,
    format: 'minimal',
  });
  return response.data.labelIds || [];
}

function parseEmailAddress(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str.trim();
}

function parseEmailName(str) {
  const match = str.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : null;
}

function parseAddressList(str) {
  if (!str) return [];
  return str.split(',').map(s => parseEmailAddress(s.trim())).filter(Boolean);
}
