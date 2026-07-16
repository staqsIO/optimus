#!/usr/bin/env node
// One-shot recovery for reviewer tasks that terminal-failed because the
// G3 tone_score went negative (cosine similarity < 0) and violated the
// action_proposals.tone_score CHECK (>= 0 AND <= 1).
//
// Fix in place: lib/runtime/guard-check.js clamps the persisted score to
// [0, 1]. This script transitions the affected work_items from
// `failed` -> `assigned` so the reviewer can re-run them.
//
// Usage: node autobot-inbox/scripts/recover-reviewer-tone-score-failures.js [--dry-run]

import { query } from '../../lib/db.js';
import { transitionState } from '../../lib/runtime/state-machine.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  // Find failed work items currently assigned to reviewer whose last
  // state_transition reason mentions the tone_score / action_proposals CHECK.
  const { rows } = await query(`
    SELECT w.id, w.title, w.assigned_to, w.created_at, st.reason
    FROM agent_graph.work_items w
    JOIN LATERAL (
      SELECT reason
      FROM agent_graph.state_transitions
      WHERE work_item_id = w.id
      ORDER BY created_at DESC
      LIMIT 1
    ) st ON true
    WHERE w.status = 'failed'
      AND w.assigned_to = 'reviewer'
      AND (st.reason ILIKE '%action_proposals%'
           OR st.reason ILIKE '%tone_score%'
           OR st.reason ILIKE '%violates check constraint%')
    ORDER BY w.created_at DESC
  `);

  console.log(`Found ${rows.length} failed reviewer tasks matching the tone_score CHECK signature.`);
  if (rows.length === 0) return;

  for (const r of rows) {
    console.log(`  ${r.id}  ${(r.title || '').slice(0, 80)}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: not transitioning. Re-run without --dry-run to apply.');
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    try {
      const success = await transitionState({
        workItemId: r.id,
        toState: 'assigned',
        agentId: 'orchestrator',
        configHash: 'recover-reviewer-tone-score-failures',
        reason: 'Recovery: G3 tone_score CHECK fixed (clamped to [0,1] in guard-check.js); retrying reviewer.',
      });
      if (success) ok++; else fail++;
    } catch (err) {
      console.error(`  FAIL ${r.id}: ${err.message}`);
      fail++;
    }
  }
  console.log(`\nReset complete: ${ok} succeeded, ${fail} failed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
