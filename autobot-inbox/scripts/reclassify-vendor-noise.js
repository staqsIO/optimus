#!/usr/bin/env node
// STAQPRO-523 / STAQPRO-562 — backfill: re-apply the deterministic noise rules
// to recent inbox.messages and update triage_category for matches.
//
// Two passes:
//   1. EMAIL: classifyByHeaders over labels / from_address / snippet / stored
//      headers (migration 131 now persists List-Unsubscribe / List-ID /
//      Precedence / Auto-Submitted, so those rules light up on rows ingested
//      after the poller widening). Includes the STAQPRO-562 machine-
//      notification vendor rule (github.com / linear.app / vercel.com /
//      railway.app / calendar-notification@google.com → noise).
//   2. GITHUB: classifyMachineNotification over channel + event-type for
//      webhook rows (channel='webhook', from='github'), catching the
//      historical push/check_run/workflow_run/status chatter that the
//      strategist was auto-archiving with gemini-2.5-pro.
//
// Useful for cleaning the existing actionable queue after the new rules ship,
// since old rows were classified by the over-eager Haiku/Gemini prompts.
//
// Usage:
//   node autobot-inbox/scripts/reclassify-vendor-noise.js              # dry-run (default)
//   node autobot-inbox/scripts/reclassify-vendor-noise.js --apply      # actually update
//   node autobot-inbox/scripts/reclassify-vendor-noise.js --days=7     # custom window
//   node autobot-inbox/scripts/reclassify-vendor-noise.js --limit=500  # per-run cap
//
// Safety:
//   * We only DOWNGRADE — we never promote a row from `noise`/`fyi` to
//     `action_required`. If the sniff would return a category, but the row
//     is already at that level or below, we skip it (idempotent re-runs).
//   * Rows whose sender has tier IN ('inner_circle', 'active') are bypassed,
//     matching the live runtime behavior.
//   * Classification is structured-field only — never body content or an LLM.
//
// Re-runnable: counters print before/after per-category totals so you can
// dry-run, eyeball the proposed delta, then apply.

import 'dotenv/config';
import { query } from '../../lib/db.js';
import {
  classifyByHeaders,
  classifyMachineNotification,
} from '../../lib/runtime/triage-header-sniff.js';

const CATEGORY_RANK = {
  noise: 0,
  fyi: 1,
  pending: 2,
  needs_response: 3,
  action_required: 4,
};

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const daysArg = argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 2000;
  return { apply, days, limit };
}

async function fetchCandidates({ days, limit }) {
  // Headers are now persisted (migration 131) so the List-Unsubscribe /
  // List-ID / Precedence / Auto-Submitted rules fire on rows ingested after
  // the poller widening. Older rows have headers = NULL and fall through to
  // the label / from_address rules, exactly as before.
  const result = await query(
    `SELECT m.id,
            m.from_address,
            m.subject,
            m.snippet,
            m.labels,
            m.headers,
            m.triage_category,
            c.tier AS contact_tier
       FROM inbox.messages m
       LEFT JOIN signal.contacts c ON c.email_address = m.from_address
      WHERE m.channel = 'email'
        AND m.received_at >= now() - ($1::int * INTERVAL '1 day')
        AND m.triage_category IS DISTINCT FROM 'noise'
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

// STAQPRO-562: github/webhook rows. `from_name='github'` is set by the signal
// ingester (it passes `source` as from_name). The labels carry `github:<event>`
// so we can recover the event type without an LLM.
async function fetchGithubCandidates({ days, limit }) {
  const result = await query(
    `SELECT m.id,
            m.labels,
            m.triage_category
       FROM inbox.messages m
      WHERE m.channel = 'webhook'
        AND m.from_name = 'github'
        AND m.received_at >= now() - ($1::int * INTERVAL '1 day')
        AND m.triage_category IS DISTINCT FROM 'noise'
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}

// Recover the event type from the `github:<event>` label the ingester wrote.
// Returns '' when no such label is present.
function eventTypeFromLabels(labels) {
  for (const l of labels || []) {
    if (typeof l === 'string' && l.startsWith('github:')) {
      const ev = l.slice('github:'.length);
      // Skip the action-style labels (github:review-approved etc.) — the bare
      // event label (github:push) is what classifyMachineNotification keys on.
      if (ev && !ev.includes('-')) return ev;
    }
  }
  return '';
}

async function applyUpdate(id, newCategory) {
  await query(
    `UPDATE inbox.messages
        SET triage_category = $1
      WHERE id = $2`,
    [newCategory, id]
  );
}

async function main() {
  const { apply, days, limit } = parseArgs(process.argv.slice(2));
  console.log(
    `[reclassify-vendor-noise] mode=${apply ? 'APPLY' : 'DRY-RUN'} days=${days} limit=${limit}`
  );

  const rows = await fetchCandidates({ days, limit });
  console.log(`[reclassify-vendor-noise] inspecting ${rows.length} rows`);

  const before = { noise: 0, fyi: 0, pending: 0, needs_response: 0, action_required: 0 };
  const after = { noise: 0, fyi: 0, pending: 0, needs_response: 0, action_required: 0 };
  const reasonCounts = {};
  let downgraded = 0;
  let skippedTrustedTier = 0;
  let skippedNoMatch = 0;
  let skippedAlreadyEqualOrLower = 0;

  for (const row of rows) {
    before[row.triage_category] = (before[row.triage_category] || 0) + 1;

    const sniff = classifyByHeaders(
      {
        from_address: row.from_address,
        subject: row.subject,
        snippet: row.snippet,
        labels: row.labels || [],
        // Stored headers (migration 131) — NULL on older rows, in which case
        // the header rules simply no-op and label/from_address rules carry.
        headers: row.headers || {},
      },
      { contactTier: row.contact_tier }
    );

    if (!sniff) {
      if (row.contact_tier === 'inner_circle' || row.contact_tier === 'active') {
        skippedTrustedTier++;
      } else {
        skippedNoMatch++;
      }
      after[row.triage_category] = (after[row.triage_category] || 0) + 1;
      continue;
    }

    const currentRank = CATEGORY_RANK[row.triage_category] ?? 99;
    const newRank = CATEGORY_RANK[sniff.category] ?? 99;
    if (newRank >= currentRank) {
      // Already at/below the target rank — leave it alone.
      skippedAlreadyEqualOrLower++;
      after[row.triage_category] = (after[row.triage_category] || 0) + 1;
      continue;
    }

    downgraded++;
    reasonCounts[sniff.reason] = (reasonCounts[sniff.reason] || 0) + 1;
    after[sniff.category] = (after[sniff.category] || 0) + 1;
    if (apply) {
      await applyUpdate(row.id, sniff.category);
    }
  }

  console.log('\n[reclassify-vendor-noise] EMAIL before:', before);
  console.log('[reclassify-vendor-noise] EMAIL after :', after);
  console.log('[reclassify-vendor-noise] EMAIL reasons:', reasonCounts);
  console.log('[reclassify-vendor-noise] EMAIL counters:', {
    downgraded,
    skippedTrustedTier,
    skippedNoMatch,
    skippedAlreadyEqualOrLower,
  });

  // --- Pass 2: github/webhook machine-notification rows (STAQPRO-562) ------
  const ghRows = await fetchGithubCandidates({ days, limit });
  console.log(`\n[reclassify-vendor-noise] inspecting ${ghRows.length} github/webhook rows`);
  const ghReasonCounts = {};
  let ghDowngraded = 0;
  let ghSkippedNoMatch = 0;
  let ghSkippedAlreadyNoise = 0;

  for (const row of ghRows) {
    const verdict = classifyMachineNotification({
      channel: 'github',
      eventType: eventTypeFromLabels(row.labels),
      linkedWorkItemId: null,
    });
    if (!verdict) {
      ghSkippedNoMatch++;
      continue;
    }
    const currentRank = CATEGORY_RANK[row.triage_category] ?? 99;
    const newRank = CATEGORY_RANK[verdict.category] ?? 99;
    if (newRank >= currentRank) {
      ghSkippedAlreadyNoise++;
      continue;
    }
    ghDowngraded++;
    ghReasonCounts[verdict.reason] = (ghReasonCounts[verdict.reason] || 0) + 1;
    if (apply) {
      await applyUpdate(row.id, verdict.category);
    }
  }

  console.log('[reclassify-vendor-noise] GITHUB reasons:', ghReasonCounts);
  console.log('[reclassify-vendor-noise] GITHUB counters:', {
    ghDowngraded,
    ghSkippedNoMatch,
    ghSkippedAlreadyNoise,
  });

  if (!apply) {
    console.log('\n[reclassify-vendor-noise] DRY-RUN — pass --apply to commit changes.');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[reclassify-vendor-noise] failed:', err);
    process.exit(1);
  }
);
