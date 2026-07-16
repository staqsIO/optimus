import { query } from '../db.js';
import { findSimilar } from './embeddings.js';

/**
 * Few-shot selector: find similar sent emails for voice matching.
 * 3-5 similar emails to same recipient + 2-3 on same topic via vector similarity.
 *
 * IMPORTANT: Excludes emails sent after the AI pipeline was activated to avoid
 * feedback loops where AI-generated drafts become voice training examples.
 */

// Cutoff date: emails sent after this may be AI-generated via the pipeline.
// Only human-written emails should be used as voice examples.
const AI_PIPELINE_CUTOFF = '2026-02-25';

/**
 * Strip quoted reply chains from email body — only return the author's own text.
 */
function stripQuotedContent(body) {
  if (!body) return '';
  const lines = body.split('\n');
  const cleanLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at quoted reply markers (handle multiline "On ... wrote:" too)
    if (/^On .+(wrote|schrieb|a écrit):\s*$/i.test(trimmed)) break;
    if (/^On .+<.+@.+>/.test(trimmed)) break; // "On Mon, at 12:00 PM Name <email>"
    if (/^-{3,}\s*(Forwarded|Original)\s+message/i.test(trimmed)) break;
    if (/^>{1,2}\s/.test(trimmed)) continue; // skip > quoted lines
    if (/^>\s*$/.test(trimmed)) continue; // skip bare > lines
    if (/^--\s*$/.test(trimmed)) break; // signature delimiter
    if (/^_{3,}$/.test(trimmed)) break;
    if (/^\[image:/.test(trimmed)) continue;
    // Skip email signature blocks (phone, social links, etc.)
    if (/^(facebook|twitter|linkedin|instagram)\s*$/i.test(trimmed)) continue;
    if (/^(mobile|cell|phone|fax):/i.test(trimmed)) break;
    cleanLines.push(line);
  }
  // Trim trailing whitespace and blank lines
  let result = cleanLines.join('\n').trim();
  // Handle "On [date] ... wrote:" that may span multiple lines
  result = result.replace(/\n\s*On .+(wrote|schrieb|a écrit):[\s\S]*$/i, '').trim();
  // Handle "On [date] at [time] [Name] <email>" pattern (wrote: may be on next line)
  result = result.replace(/\n\s*On [A-Z][a-z]{2},\s+[A-Z][a-z]{2}\s+\d[\s\S]*$/i, '').trim();
  return result;
}

/**
 * Select few-shot examples for drafting a reply.
 * @param {Object} opts
 * @param {string} opts.recipientEmail - Who we're replying to
 * @param {string} opts.subject - Email subject
 * @param {string} [opts.body] - Email body (for embedding similarity)
 * @param {number} [opts.limit] - Max examples (default 5)
 * @param {string} [opts.accountId] - Account to scope examples to (prevents voice cross-contamination)
 * @returns {Promise<Array>} Selected sent emails (with body stripped of quoted content)
 */
export async function selectFewShots({ recipientEmail, subject, body, limit = 5, accountId = null }) {
  const results = [];

  // Strategy 1: Same recipient (highest priority — matches relationship tone)
  // Prefer older (pre-AI) emails to avoid feedback loops
  if (recipientEmail) {
    const recipientParams = [recipientEmail, Math.ceil(limit * 0.6), AI_PIPELINE_CUTOFF];
    let recipientAccountClause = '';
    if (accountId) {
      recipientParams.push(accountId);
      recipientAccountClause = `AND account_id = $${recipientParams.length}`;
    }
    const recipientEmails = await query(
      `SELECT id, provider_msg_id, to_address, subject, body, word_count, sent_at
       FROM voice.sent_emails
       WHERE to_address = $1
         AND sent_at < $3
         ${recipientAccountClause}
       ORDER BY sent_at DESC
       LIMIT $2`,
      recipientParams
    );
    results.push(...recipientEmails.rows);

    // If not enough pre-AI emails for this specific recipient, skip to other strategies
    // (don't fall back to post-AI emails to avoid feedback loops)
  }

  // Strategy 2: Similar subject (topic matching via trigram similarity)
  if (subject && results.length < limit) {
    const remaining = limit - results.length;
    const existingIds = results.map(r => r.id);

    const params = [subject, remaining, AI_PIPELINE_CUTOFF];
    let excludeClause = '';
    if (existingIds.length > 0) {
      params.push(existingIds);
      excludeClause = `AND id != ALL($${params.length})`;
    }
    let subjectAccountClause = '';
    if (accountId) {
      params.push(accountId);
      subjectAccountClause = `AND account_id = $${params.length}`;
    }

    const subjectMatches = await query(
      `SELECT id, provider_msg_id, to_address, subject, body, word_count, sent_at,
              similarity(subject, $1) AS sim
       FROM voice.sent_emails
       WHERE subject IS NOT NULL
         AND similarity(subject, $1) > 0.1
         AND sent_at < $3
         ${excludeClause}
         ${subjectAccountClause}
       ORDER BY similarity(subject, $1) DESC
       LIMIT $2`,
      params
    );
    results.push(...subjectMatches.rows);
  }

  // Strategy 3: Vector similarity via pgvector (spec §4, D3)
  if (body && results.length < limit) {
    const remaining = limit - results.length;
    const existingIds = results.map(r => r.id);
    try {
      const queryText = subject ? `Subject: ${subject}\n${body}` : body;
      const similar = await findSimilar(queryText, remaining + existingIds.length);
      for (const s of similar) {
        if (!existingIds.includes(s.id) && results.length < limit) {
          results.push(s);
          existingIds.push(s.id);
        }
      }
    } catch {
      // Vector search unavailable — proceed with what we have
    }
  }

  // Deduplicate by ID
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      unique.push(r);
    }
  }

  // Strip quoted content from bodies — only show Eric's own text
  return unique.slice(0, limit).map(r => ({
    ...r,
    body: stripQuotedContent(r.body),
  }));
}
