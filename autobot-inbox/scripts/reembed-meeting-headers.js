#!/usr/bin/env node
/**
 * One-shot pass to retrofit existing meeting documents with the chunk-0
 * envelope header introduced in Phase 2 of the meeting-retrieval rework.
 *
 * Going forward, `lib/rag/ingest.js` prepends a one-line header like
 *   "Meeting — Formul8 Sync · 2026-05-11 · participants: Carlos, Eric · domains: formul8.ai"
 * to chunk 0 before embedding, so vector search can anchor on the meeting's
 * identity even when nobody utters the org name mid-call. This script does
 * the same retrofit for already-ingested transcripts.
 *
 * What it does, per (tldv|gemini|drive+gemini) document with at least one
 * chunk and no existing has_header tag on chunk 0:
 *   1. Build the same header string `buildMeetingHeader` would have used.
 *   2. Prepend it to chunk 0's text (only when not already prefixed).
 *   3. Re-embed chunk 0 and update content.chunks (text, embedding,
 *      metadata.has_header=true, token_count).
 * Other chunks are left untouched — the header only ever lived on chunk 0.
 *
 * Idempotent: chunks already tagged `metadata.has_header = true` skip.
 *
 * Usage:
 *   node scripts/reembed-meeting-headers.js [--limit N] [--dry-run]
 *
 * On Railway:
 *   railway run -s autobot-inbox-api node scripts/reembed-meeting-headers.js --dry-run
 *   railway run -s autobot-inbox-api node scripts/reembed-meeting-headers.js
 */

import 'dotenv/config';
import { query, close } from '../src/db.js';
import { embedOne, getEmbeddingInfo } from '../../lib/rag/embedder.js';
import { estimateTokens } from '../../lib/rag/chunker.js';

/**
 * Embed `text`, falling back to halved body slices when the provider
 * rejects the input (e.g. OpenAI's 8192-token cap). Some legacy meeting
 * transcripts tokenize denser than the 4-chars-per-token estimate — a
 * raw char cap can still go over. Halving on failure converges in ≤4
 * attempts on anything the corpus has thrown at it.
 *
 * Preserves the header prefix on every retry: only the body slice
 * shrinks. Returns { embedding, finalText } or null if every retry
 * still failed.
 */
async function embedWithShrinkOnFailure(header, body) {
  const sep = header ? '\n\n' : '';
  let bodyText = body;
  for (let attempt = 0; attempt < 5; attempt++) {
    const text = `${header}${sep}${bodyText}`;
    const embedding = await embedOne(text);
    if (embedding) return { embedding, finalText: text };
    if (bodyText.length <= 200) return null; // hit floor — give up
    bodyText = bodyText.slice(0, Math.floor(bodyText.length / 2));
  }
  return null;
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--limit') { out.limit = Number(next) || 0; i++; }
    else if (flag === '--dry-run' || flag === '-n') { out.dryRun = true; }
    else if (flag === '--help' || flag === '-h') {
      // eslint-disable-next-line no-console
      console.log('Usage: reembed-meeting-headers.js [--limit N] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

function coerceJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Mirror of buildMeetingHeader in lib/rag/ingest.js — kept here so the
 * script can be run against any deploy without importing ingest.js
 * (which pulls in the sanitizer + LLM client and slows startup).
 */
function buildMeetingHeader({ title, metadata, participants }) {
  const parts = [];
  if (title) parts.push(String(title).trim());

  const happenedAt = metadata?.happenedAt;
  if (typeof happenedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(happenedAt)) {
    parts.push(happenedAt.slice(0, 10));
  }

  const org = metadata?.organization || metadata?.org || null;
  if (org) parts.push(`org: ${String(org)}`);

  if (Array.isArray(participants) && participants.length > 0) {
    const names = participants.map((p) => p?.name || p?.email).filter(Boolean).slice(0, 8);
    if (names.length > 0) parts.push(`participants: ${names.join(', ')}`);

    const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me']);
    const domains = new Set();
    for (const p of participants) {
      const email = p?.email;
      if (typeof email !== 'string') continue;
      const at = email.indexOf('@');
      if (at <= 0) continue;
      const domain = email.slice(at + 1).toLowerCase();
      if (!FREE_MAIL.has(domain)) domains.add(domain);
    }
    if (domains.size > 0) parts.push(`domains: ${[...domains].join(', ')}`);
  }

  if (parts.length === 0) return null;
  return `Meeting — ${parts.join(' · ')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const info = getEmbeddingInfo();
  if (!info) {
    console.error('[reembed] No embedding provider configured (OPENAI_API_KEY / EMBEDDING_MODEL).');
    process.exit(1);
  }

  // Pick every meeting-like document. Filter at the SQL layer so we don't
  // pull the whole corpus.
  const limitClause = args.limit > 0 ? `LIMIT ${args.limit}` : '';
  const docs = await query(
    `SELECT id, title, metadata, participants, source, format
       FROM content.documents
      WHERE deleted_at IS NULL
        AND (
          source IN ('tldv','gemini')
          OR (source = 'drive' AND format IN ('tldv','gemini'))
        )
      ORDER BY created_at DESC
      ${limitClause}`,
  );

  const stats = { docs: docs.rows.length, updated: 0, skipped: 0, no_chunks: 0, no_header: 0, dry_run: args.dryRun };
  console.log(`[reembed] Scanning ${stats.docs} meeting document(s)…${args.dryRun ? ' (dry-run)' : ''}`);

  for (const d of docs.rows) {
    const participants = coerceJsonArray(d.participants);
    const metadata = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
    const header = buildMeetingHeader({ title: d.title, metadata, participants });
    if (!header) { stats.no_header++; continue; }

    // Fetch chunk 0.
    const c0 = await query(
      `SELECT id, text, metadata, token_count
         FROM content.chunks
        WHERE document_id = $1
        ORDER BY chunk_index
        LIMIT 1`,
      [d.id],
    );
    if (c0.rows.length === 0) { stats.no_chunks++; continue; }

    const chunk = c0.rows[0];
    const chunkMd = chunk.metadata && typeof chunk.metadata === 'object' ? chunk.metadata : {};
    if (chunkMd.has_header === true) { stats.skipped++; continue; }

    // Idempotency guard: don't double-prefix if the chunk text already
    // starts with the header (previous incomplete run wrote the text but
    // failed to set the metadata flag). Strip it back to bare body so the
    // embed-with-shrink helper owns header composition.
    const alreadyPrefixed = typeof chunk.text === 'string' && chunk.text.startsWith(header);
    const bareBody = alreadyPrefixed
      ? chunk.text.slice(header.length).replace(/^\n+/, '')
      : chunk.text;

    // Pre-shrink to a soft char cap. OpenAI text-embedding-3-* caps inputs
    // at 8192 tokens; ~31k chars covers most English transcripts. Anything
    // denser hits the halving fallback below.
    const SOFT_MAX_CHARS = 31_000;
    const seedBody = bareBody.length > SOFT_MAX_CHARS ? bareBody.slice(0, SOFT_MAX_CHARS) : bareBody;

    if (args.dryRun) {
      console.log(`[reembed] would update doc=${d.id} title="${(d.title || '').slice(0, 60)}"`);
      stats.updated++;
      continue;
    }

    const result = await embedWithShrinkOnFailure(header, seedBody);
    if (!result) {
      console.warn(`[reembed] embed failed (even after shrinking) for doc=${d.id}; skipping`);
      stats.skipped++;
      continue;
    }
    const newText = result.finalText;
    const newMd = { ...chunkMd, has_header: true };
    const newTokens = estimateTokens(newText);

    await query(
      `UPDATE content.chunks
          SET text = $1,
              metadata = $2::jsonb,
              token_count = $3,
              embedding = $4
        WHERE id = $5`,
      [newText, JSON.stringify(newMd), newTokens, `[${result.embedding.join(',')}]`, chunk.id],
    );
    stats.updated++;
    if (stats.updated % 25 === 0) {
      console.log(`[reembed] progress: ${stats.updated}/${stats.docs}`);
    }
  }

  console.log(`[reembed] Done: ${JSON.stringify(stats)}`);
  await close();
}

main().catch((err) => {
  console.error('[reembed] fatal:', err);
  process.exitCode = 1;
});
