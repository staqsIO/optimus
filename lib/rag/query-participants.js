/**
 * Detect participants referenced in a RAG query and classify intent.
 *
 * The RAG pipeline uses this to decide whether to:
 *   - filter: only return chunks from documents where the participant attended
 *     (strong intent, e.g. "meeting with John", "email from Sarah")
 *   - boost: bump chunks that involve the participant but don't exclude others
 *     (softer mention, e.g. "what is John working on")
 *
 * Pure heuristics — no LLM call — so it stays inside the retrieval latency budget.
 * The rewriteQuery path already does an LLM call for query reformulation; piling
 * another on would double per-query latency without much precision upside because
 * the contact directory is small.
 */

import { query } from '../db.js';
import { createLogger } from '../logger.js';
const log = createLogger('rag/query-participants');

const EMAIL_REGEX = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const NAME_REGEX = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})\b/g;

// Words that look capitalized but are rarely people names
const NAME_STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those',
  'Who', 'What', 'When', 'Where', 'Why', 'How',
  'Our', 'Their', 'His', 'Her', 'My',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Optimus', 'AutoBot', 'Claude', 'Gmail', 'Slack', 'Drive', 'Linear', 'GitHub',
]);

/**
 * Phrasing that implies "restrict to documents involving this person".
 * Looser variants land in boost instead.
 */
const FILTER_INTENT_PATTERNS = [
  /meeting\s+with\s+/i,
  /conversation\s+with\s+/i,
  /call\s+with\s+/i,
  /email\s+(?:from|to)\s+/i,
  /(?:message|thread)\s+(?:from|with)\s+/i,
  /what\s+did\s+.+\s+say/i,
  /attended\s+by\s+/i,
];

export function extractCandidates(queryText) {
  const emails = [];
  const names = [];
  const seen = new Set();

  for (const m of queryText.matchAll(EMAIL_REGEX)) {
    const e = m[1].toLowerCase();
    if (!seen.has(e)) { seen.add(e); emails.push(e); }
  }

  // Strip emails so their local-parts don't also match NAME_REGEX
  const without = queryText.replace(EMAIL_REGEX, ' ');
  for (const m of without.matchAll(NAME_REGEX)) {
    const n = m[1].trim();
    const first = n.split(/\s+/)[0];
    if (NAME_STOPWORDS.has(first)) continue;
    const key = n.toLowerCase();
    if (!seen.has(key)) { seen.add(key); names.push(n); }
  }

  return { emails, names };
}

export function classifyIntent(queryText) {
  for (const pat of FILTER_INTENT_PATTERNS) {
    if (pat.test(queryText)) return 'filter';
  }
  return 'boost';
}

/**
 * Look up contacts matching the given candidates in a single round trip.
 * Returns UUIDs of matched contacts.
 *
 * @param {string[]} emails
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function lookupContactIds(emails, names) {
  if (emails.length === 0 && names.length === 0) return [];

  const patterns = names.map(n => `%${n.toLowerCase()}%`);

  try {
    const result = await query(
      `SELECT id FROM signal.contacts
       WHERE ($1::text[] IS NOT NULL AND lower(email_address) = ANY($1::text[]))
          OR (
            $2::text[] IS NOT NULL
            AND name IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM unnest($2::text[]) pat WHERE lower(name) LIKE pat
            )
          )`,
      [emails.length > 0 ? emails : null, patterns.length > 0 ? patterns : null]
    );
    return result.rows.map(r => r.id);
  } catch (err) {
    log.warn(`Contact lookup failed: ${err.message}`);
    return [];
  }
}

// Cap the result so a generic name ("John") doesn't turn the filter into a
// no-op the size of the corpus. If more than MAX_DOC_MATCHES hit, the match
// is too broad to be useful as a hard filter — let the query fall back to
// vanilla vector search.
const MAX_DOC_MATCHES = 100;

/**
 * Fallback for the "name-only tl;dv speaker" case: when a candidate name has
 * no signal.contacts hit, look for documents whose `participants` array
 * contains an entry with a matching name. Returns those document IDs so the
 * retriever can scope the search to them.
 *
 * This closes the loop on the original bug — "meeting with John" now finds
 * the transcripts where John was a recorded speaker even when John has never
 * sent us an email and therefore doesn't exist as a contact.
 *
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function lookupDocumentsByParticipantName(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const patterns = names.map(n => `%${n.toLowerCase()}%`);

  try {
    const result = await query(
      `SELECT DISTINCT d.id
       FROM content.documents d,
            jsonb_array_elements(d.participants) p
       WHERE d.deleted_at IS NULL
         AND p ? 'name'
         AND EXISTS (
           SELECT 1 FROM unnest($1::text[]) pat
           WHERE lower(p->>'name') LIKE pat
         )
       LIMIT $2`,
      [patterns, MAX_DOC_MATCHES + 1]
    );
    const ids = result.rows.map(r => r.id);
    if (ids.length > MAX_DOC_MATCHES) {
      log.info(`Name lookup "${names.join(', ')}" matched >${MAX_DOC_MATCHES} docs — skipping filter (too broad)`);
      return [];
    }
    return ids;
  } catch (err) {
    log.warn(`Document-name lookup failed: ${err.message}`);
    return [];
  }
}

/**
 * Main entry point.
 *
 * @param {string} queryText
 * @returns {Promise<{
 *   filterIds: string[],
 *   boostIds: string[],
 *   documentIds: string[] | null,
 *   candidates: { emails: string[], names: string[] }
 * }>}
 */
export async function detectParticipantsInQuery(queryText) {
  const empty = { filterIds: [], boostIds: [], documentIds: null, candidates: { emails: [], names: [] } };
  if (!queryText || typeof queryText !== 'string') return empty;

  const candidates = extractCandidates(queryText);
  if (candidates.emails.length === 0 && candidates.names.length === 0) return empty;

  const ids = await lookupContactIds(candidates.emails, candidates.names);
  const intent = classifyIntent(queryText);

  // Fast path — named contact exists. Use its ID for filter/boost.
  if (ids.length > 0) {
    return intent === 'filter'
      ? { filterIds: ids, boostIds: ids, documentIds: null, candidates }
      : { filterIds: [], boostIds: ids, documentIds: null, candidates };
  }

  // Fallback — no contact match. For strong-intent queries, try to pin down
  // documents whose participants include this name directly. This handles the
  // "tl;dv speaker with no email" case that caused the original bug.
  if (intent === 'filter' && candidates.names.length > 0) {
    const documentIds = await lookupDocumentsByParticipantName(candidates.names);
    if (documentIds.length > 0) {
      return { filterIds: [], boostIds: [], documentIds, candidates };
    }
  }

  return { ...empty, candidates };
}
