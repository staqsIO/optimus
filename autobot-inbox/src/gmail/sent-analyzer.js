import { google } from 'googleapis';
import { getAuth } from './auth.js';
import { query, withSystemOrgScope } from '../db.js';
import { resolveAndUpsert } from '../rag/participants/resolver.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

// OPT-166 P2e-E4 (last write-path blocker): the STAQPRO-584 recipient bump
// below reads+writes signal.contacts, whose SELECT policy is org-keyed
// (tenancy.visible(NULL, owner_org_id)) and whose write policy is org-scoped
// (mig 200: FOR ALL, allow_system=false) — system scope does NOT satisfy the
// write WITH CHECK. Under the RLS pool-flip a bare `query` would black-hole
// the read (recipient always resolves unresolved) and hard-fail the write
// (42501). Gmail sent-mail bootstrap is single-tenant → CURRENT_ORG_ID (Staqs
// internal), the same org mig 134's DEFAULT stamps on new signal.contacts
// rows — matches the calendar-poller (withCalendarOrgScope) and tldv-poller
// (withTldvOrgScope) precedent exactly. INERT today: the app connects as a
// BYPASSRLS superuser, so RLS is inert until the flip.
const SENT_ANALYZER_AGENT_ID = 'sent-analyzer';

// Run `fn(exec)` with `exec` org-scoped (app.org_ids=[CURRENT_ORG_ID]) via
// withSystemOrgScope — reachable under REQUIRE_AGENT_JWT=true (sent-analyzer
// holds no JWT principal), unlike the old withAgentScope path which threw for a
// plain-string id under enforcement and fell back to unscoped reads/writes →
// black-holed read + 42501 write post-flip. FAIL CLOSED: no bare-`query`
// fallback. The scope wraps the whole resolve+upsert — its internals are pure
// DB + JS (no network await), so no transaction ever spans I/O.
async function withSentAnalyzerOrgScope(fn) {
  const scoped = await withSystemOrgScope(SENT_ANALYZER_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Sent email analyzer: bootstrap voice data from sent mail.
 * D3: Voice profiles derived from sent mail analysis, not hand-authored.
 * Pulls sent emails → stores in voice.sent_emails → builds profile clusters.
 */

/**
 * Bootstrap: fetch sent emails for voice training.
 * @param {number} maxResults - Number of sent emails to fetch (default 1000)
 */
export async function bootstrapSentEmails(maxResults = 1000, authClient = null) {
  const gmail = google.gmail({ version: 'v1', auth: authClient || getAuth() });
  let pageToken = null;
  let fetched = 0;

  console.log(`[sent-analyzer] Bootstrapping up to ${maxResults} sent emails...`);

  do {
    const params = {
      userId: 'me',
      labelIds: ['SENT'],
      maxResults: Math.min(100, maxResults - fetched),
    };
    if (pageToken) params.pageToken = pageToken;

    const listResult = await gmail.users.messages.list(params);
    const messages = listResult.data.messages || [];

    for (const msg of messages) {
      try {
        // Skip if already imported
        const existing = await query(
          `SELECT id FROM voice.sent_emails WHERE provider_msg_id = $1`,
          [msg.id]
        );
        if (existing.rows.length > 0) continue;

        // Fetch full message
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const headers = {};
        for (const h of full.data.payload.headers) {
          headers[h.name.toLowerCase()] = h.value;
        }

        // Extract body
        const body = extractPlainText(full.data.payload);
        if (!body || body.length < 20) continue; // Skip empty/tiny emails

        const toAddress = parseEmailAddress(headers.to || '');
        const toName = parseEmailName(headers.to || '');

        const inReplyToHeader = (headers['in-reply-to'] || '').trim() || null;
        const sentAt = headers.date
          ? new Date(headers.date).toISOString()
          : new Date().toISOString();

        await query(
          `INSERT INTO voice.sent_emails
           (provider_msg_id, thread_id, to_address, to_name, subject, body, word_count, sent_at, is_reply, in_reply_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (provider_msg_id) DO NOTHING`,
          [
            msg.id,
            full.data.threadId,
            toAddress,
            toName,
            headers.subject || '',
            body,
            body.split(/\s+/).length,
            sentAt,
            inReplyToHeader !== null,
            inReplyToHeader,
          ]
        );

        // STAQPRO-584: bump signal.contacts.emails_sent for the recipient so
        // tier-resolution Rule 3 (correspondence volume) can promote genuine
        // correspondents off tier='unknown'. We only reach here for newly
        // imported sent mail (the provider_msg_id existence check above + the
        // ON CONFLICT DO NOTHING guard make this a once-per-email side effect),
        // so the non-idempotent counter bump in resolveAndUpsert is safe.
        if (toAddress) {
          try {
            await withSentAnalyzerOrgScope((exec) =>
              resolveAndUpsert(
                [{ email: String(toAddress).toLowerCase(), name: toName || null, role: 'recipient' }],
                { at: sentAt },
                exec
              )
            );
          } catch (resolveErr) {
            // Never let contact resolution crash voice ingestion.
            console.warn(
              `[sent-analyzer] participant resolve failed for ${msg.id}: ${resolveErr.message}`
            );
          }
        }

        fetched++;
        if (fetched % 50 === 0) {
          console.log(`[sent-analyzer] Imported ${fetched} sent emails...`);
        }
      } catch (err) {
        console.error(`[sent-analyzer] Failed to process ${msg.id}:`, err.message);
      }
    }

    pageToken = listResult.data.nextPageToken;
  } while (pageToken && fetched < maxResults);

  console.log(`[sent-analyzer] Bootstrap complete: ${fetched} sent emails imported`);
  return fetched;
}

function extractPlainText(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return null;
}

function parseEmailAddress(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str.trim();
}

function parseEmailName(str) {
  const match = str.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : null;
}
