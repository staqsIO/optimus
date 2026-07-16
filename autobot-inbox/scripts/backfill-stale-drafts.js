#!/usr/bin/env node
// One-shot backfill that runs the auto-archive sweep over every stale
// open draft on the board. Designed for the initial cleanup of the
// ~130 historical no-action drafts surfaced in the 2026-05-07 audit.
//
// Usage:
//   node autobot-inbox/scripts/backfill-stale-drafts.js              # dry-run (default)
//   node autobot-inbox/scripts/backfill-stale-drafts.js --apply      # actually update
//   node autobot-inbox/scripts/backfill-stale-drafts.js --limit=300  # how many per run
//
// Reuses src/gmail/auto-archive-sweep.js so the live reconciler and
// the backfill go through the same classifier and predicated-update
// logic. Only difference: the backfill processes a larger batch per
// invocation and is meant to be run manually.
//
// Re-runnable: subsequent invocations only see still-open proposals,
// so you can run --dry-run, then --apply, then --apply again to clean
// up anything new without double-action risk.

import 'dotenv/config';
import { autoArchiveSweep } from '../src/gmail/auto-archive-sweep.js';

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 300;
  return { apply, limit };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[backfill] mode=${mode} limit=${limit}`);

  const counters = await autoArchiveSweep({ limit, dryRun: !apply });

  const tierOverride = counters.archived_tier_override || 0;
  const totalArchived = counters.archived_external + counters.archived_no_reply + tierOverride;

  console.log('');
  console.log(`[backfill] swept             : ${counters.swept}`);
  console.log(`[backfill] eric_replied      : ${counters.archived_external}`);
  console.log(`[backfill] archived_no_reply : ${counters.archived_no_reply}`);
  console.log(`[backfill] tier_override     : ${tierOverride}`);
  console.log(`[backfill] still_open        : ${counters.still_open}`);
  console.log(`[backfill] errors            : ${counters.errors}`);
  console.log('');

  if (!apply) {
    console.log(`[backfill] DRY-RUN — would archive ${totalArchived} draft(s).`);
    console.log(`[backfill] Re-run with --apply to commit changes.`);
  } else {
    console.log(`[backfill] Archived ${totalArchived} draft(s).`);
  }

  // Exit cleanly so the pg pool doesn't keep the process alive.
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err.message);
  process.exit(1);
});
