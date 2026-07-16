#!/usr/bin/env node
/**
 * Re-extract signals on historical webhook-channel messages (tl;dv, gemini,
 * voice_memo) by deleting their existing signals and re-firing the triage
 * event. Used to retroactively apply prompt changes.
 *
 * Why: the previous triage prompt under-extracted from meeting transcripts —
 * suggestions, soft commitments, and "we should X" agreements were tagged as
 * `info` rather than `action_item`. The sharpened prompt in
 * config/webhook-sources.json fixes go-forward classification, but messages
 * already in inbox.signals carry the old classification. This script kicks
 * them through triage again.
 *
 * Mechanism (per-message, in a transaction):
 *   1. DELETE existing signals
 *   2. NULL out inbox.messages.triage_category + processed_at
 *   3. Reset agent_graph.work_items.status to 'created'
 *   4. Emit a task_assigned event targeting executor-triage
 *
 * The running triage executor on Railway picks up the events via pg_notify
 * and re-classifies one by one. With ~50 meetings, expect ~5–10 minutes total.
 *
 * Usage (run with prod DATABASE_URL — Railway env var):
 *   DATABASE_URL=... node scripts/reextract-tldv-signals.js
 *   DATABASE_URL=... node scripts/reextract-tldv-signals.js --source all
 *   DATABASE_URL=... node scripts/reextract-tldv-signals.js --limit 5 --dry-run
 *
 * Flags:
 *   --source <name>  Webhook source: tldv (default), gemini, voice_memo, all
 *   --limit N        Cap how many messages to reset (no cap by default)
 *   --dry-run        Print what would be reset, change nothing, exit 0
 *
 * Cost note: each re-extract is one LLM call (Haiku via executor-triage).
 * 50 messages ≈ a few cents. Well within the $20/day G1 ceiling, but be
 * aware if running --source=all on a busy environment.
 */

import { query, withTransaction } from '../src/db.js';
import { emit } from '../../lib/runtime/event-bus.js';

// ---------------------------------------------------------------------------
// CLI args

const args = process.argv.slice(2);
function flagValue(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? true;
}
const dryRun = args.includes('--dry-run');
const source = flagValue('--source', 'tldv');
const limit = parseInt(flagValue('--limit', '0'), 10) || null;

const VALID_SOURCES = new Set(['tldv', 'gemini', 'voice_memo', 'all']);
if (!VALID_SOURCES.has(source)) {
  console.error(`invalid --source: ${source}. valid: ${[...VALID_SOURCES].join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Find candidates

const labelFilter = source === 'all'
  ? `labels && ARRAY['webhook:tldv','webhook:gemini','webhook:voice_memo']::text[]`
  : `'webhook:${source}' = ANY(labels)`;

const limitClause = limit ? `LIMIT ${limit}` : '';

const candidatesSql = `
  SELECT m.id           AS message_id,
         m.work_item_id AS work_item_id,
         m.subject      AS title,
         m.received_at,
         w.status       AS work_item_status,
         (SELECT COUNT(*)::int FROM inbox.signals s WHERE s.message_id = m.id) AS signal_count
  FROM inbox.messages m
  LEFT JOIN agent_graph.work_items w ON w.id = m.work_item_id
  WHERE m.channel = 'webhook'
    AND ${labelFilter}
    AND m.work_item_id IS NOT NULL
  ORDER BY m.received_at DESC
  ${limitClause}
`;

const { rows: candidates } = await query(candidatesSql);
console.log(`[reextract] source=${source} candidates=${candidates.length}${limit ? ` (limit=${limit})` : ''}`);

if (candidates.length === 0) {
  console.log('[reextract] nothing to do');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dry run

if (dryRun) {
  console.log('[reextract] DRY RUN — no changes will be made');
  for (const r of candidates) {
    const tag = r.work_item_status === 'in_progress' || r.work_item_status === 'review'
      ? ' SKIP(in-flight)'
      : '';
    console.log(`  ${r.received_at.toISOString().slice(0, 10)} signals=${r.signal_count} status=${r.work_item_status} — ${(r.title || '').slice(0, 60)}${tag}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Reset + re-fire

// In-flight states — the executor is mid-run, don't stomp on it.
// Anything else (created, completed, failed, cancelled) is safe to re-fire.
const IN_FLIGHT_STATES = new Set(['assigned', 'in_progress', 'review']);

let reset = 0;
let skipped = 0;
const t0 = Date.now();

for (const r of candidates) {
  if (IN_FLIGHT_STATES.has(r.work_item_status)) {
    skipped++;
    console.log(`[reextract] skip ${r.message_id} (work_item in-flight: ${r.work_item_status})`);
    continue;
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM inbox.signals WHERE message_id = $1`, [r.message_id]);
    await client.query(
      `UPDATE inbox.messages
         SET triage_category = NULL, processed_at = NULL
       WHERE id = $1`,
      [r.message_id]
    );
    await client.query(
      `UPDATE agent_graph.work_items
         SET status = 'created', retry_count = 0
       WHERE id = $1`,
      [r.work_item_id]
    );
  });

  // Backfill events run at low priority so they never block live ingest.
  // claim_next_task orders by priority DESC — fresh poll-cycle work (priority 0)
  // always preempts re-extraction work (priority -10).
  await emit({
    eventType: 'task_assigned',
    workItemId: r.work_item_id,
    targetAgentId: 'executor-triage',
    priority: -10,
    eventData: { title: r.title, type: 'task', reextract: true },
  });

  reset++;
  if (reset % 5 === 0 || reset === candidates.length) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[reextract] reset ${reset}/${candidates.length} (skipped=${skipped}) elapsed=${elapsed}s`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[reextract] done. reset=${reset} skipped=${skipped} elapsed=${elapsed}s`);
console.log('[reextract] events queued. The triage executor on Railway will work through them on its poll cycle.');
console.log('[reextract] watch progress by re-running the DevTools diagnostic, or tail Railway logs for "[executor-triage]" lines.');

process.exit(0);
