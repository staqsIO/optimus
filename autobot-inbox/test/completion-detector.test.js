/**
 * OPT-44: completion-detector — offline PGlite tests.
 *
 * Tests:
 *   1. mapSignalToNextStatus: pure mapper — no DB needed.
 *   2. advanceWorkItem: a valid completion signal linked to a work_item
 *      advances it ONE legal step via transitionState + emits a receipt.
 *   3. Illegal signal (skip step, backwards) is a no-op / 'illegal'.
 *   4. Duplicate signal on already-terminal work_item is a no-op.
 *   5. Feature is inert (dry_run outcome) when COMPLETION_DETECTION_ENABLED is OFF.
 *   6. processCompletionSignals stamps processed_at on the signal row.
 *
 * Uses the real PGlite DB (via test/helpers/setup-db.js) so the SQL
 * transition_state() function runs and guard checks are real.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  mapSignalToNextStatus,
  advanceWorkItem,
  processCompletionSignals,
} from '../../lib/runtime/signals/completion-detector.js';

// ── Outer suite — contains all tests so before/afterEach scoping is clean ─────

describe('completion-detector (OPT-44)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb({ forcePGlite: true }));

    // Seed the completion-detector pseudo-agent so FK on state_transitions.agent_id resolves.
    // agent_type CHECK only allows known values — use 'executor' as the closest fit for
    // a utility-tier detector agent. The config_hash must match DETECTOR_CONFIG_HASH from
    // the module (sha256 of 'completion-detector-v1').
    const { createHash } = await import('crypto');
    const detectorConfigHash = createHash('sha256').update('completion-detector-v1').digest('hex');
    await query(`
      INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash, is_active)
      VALUES ('completion-detector', 'executor', 'none', 'completion detection utility', $1, true)
      ON CONFLICT (id) DO NOTHING
    `, [detectorConfigHash]);
  });

  afterEach(async () => {
    // Clean up completion_signals between tests; fresh work_items per-test avoids state bleed.
    try {
      await query(`DELETE FROM agent_graph.completion_signals`);
    } catch (_) {}
  });

  /**
   * Create a work_item and advance it to the desired status via the SQL state machine.
   * Returns the work_item id.
   */
  async function createWorkItemAtStatus(targetStatus) {
    const res = await query(
      `INSERT INTO agent_graph.work_items (type, title, created_by, status)
       VALUES ('task', 'OPT-44 test item', 'board', 'created')
       RETURNING id`,
    );
    const id = res.rows[0].id;

    const steps = ['assigned', 'in_progress', 'review', 'completed'];
    const stepIndex = { created: 0, assigned: 1, in_progress: 2, review: 3, completed: 4 };
    const targetIdx = stepIndex[targetStatus] ?? 0;

    for (let i = 0; i < targetIdx; i++) {
      const toState = steps[i];
      await query(
        `SELECT * FROM agent_graph.transition_state($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, toState, 'orchestrator', 'testhash', `test advance to ${toState}`, '{}', 0, null, null],
      );
    }

    return id;
  }

  // ── 1. Pure mapper tests (no DB) ────────────────────────────────────────────

  describe('mapSignalToNextStatus', () => {
    it('pr_merged signal maps to completed from in_progress', () => {
      const { toState, reason } = mapSignalToNextStatus(
        { signal_type: 'pr_merged', channel: 'github', content: '', pr_merged: true, next_status: null },
        'in_progress',
      );
      assert.equal(toState, 'completed');
      assert.equal(reason, 'pr_merged');
    });

    it('pr_merged with pr_merged=false is a no-op', () => {
      const { toState } = mapSignalToNextStatus(
        { signal_type: 'pr_merged', channel: 'github', content: '', pr_merged: false, next_status: null },
        'in_progress',
      );
      assert.equal(toState, null);
    });

    it('slack_done maps to review from in_progress', () => {
      const { toState, reason } = mapSignalToNextStatus(
        { signal_type: 'slack_done', channel: 'slack', content: 'This is done!', pr_merged: null, next_status: null },
        'in_progress',
      );
      assert.equal(toState, 'review');
      assert.equal(reason, 'slack_done');
    });

    it('slack_approval maps to completed from review', () => {
      const { toState, reason } = mapSignalToNextStatus(
        { signal_type: 'slack_approval', channel: 'slack', content: 'LGTM, ship it!', pr_merged: null, next_status: null },
        'review',
      );
      assert.equal(toState, 'completed');
      assert.equal(reason, 'slack_approval');
    });

    it('email_closed maps to completed', () => {
      const { toState } = mapSignalToNextStatus(
        { signal_type: 'email_closed', channel: 'email', content: 'Consider this done, all set', pr_merged: null, next_status: null },
        'in_progress',
      );
      assert.equal(toState, 'completed');
    });

    it('already-terminal work_item returns null (no-op)', () => {
      const { toState, reason } = mapSignalToNextStatus(
        { signal_type: 'pr_merged', channel: 'github', content: '', pr_merged: true, next_status: null },
        'completed',
      );
      assert.equal(toState, null);
      assert.equal(reason, 'already_terminal');
    });

    it('manual_override to the legal next step is accepted', () => {
      const { toState, reason } = mapSignalToNextStatus(
        { signal_type: 'manual_override', channel: null, content: '', pr_merged: null, next_status: 'review' },
        'in_progress',
      );
      assert.equal(toState, 'review');
      assert.equal(reason, 'manual_override');
    });

    it('manual_override attempting a skip is blocked', () => {
      const { toState } = mapSignalToNextStatus(
        { signal_type: 'manual_override', channel: null, content: '', pr_merged: null, next_status: 'completed' },
        'in_progress',
      );
      // in_progress → completed skips 'review' (legal next = review), so blocked
      assert.equal(toState, null);
    });

    it('unrecognized signal_type is a no-op', () => {
      const { toState } = mapSignalToNextStatus(
        { signal_type: 'unknown_type', channel: null, content: 'whatever', pr_merged: null, next_status: null },
        'in_progress',
      );
      assert.equal(toState, null);
    });
  });

  // ── 2. advanceWorkItem: legal single-step advance ──────────────────────────

  describe('advanceWorkItem', () => {
    it('slack_done on in_progress work_item advances to review via transitionState', async () => {
      const wid = await createWorkItemAtStatus('in_progress');
      const signal = {
        signal_type: 'slack_done',
        channel: 'slack',
        content: 'shipped! done!',
        pr_merged: null,
        next_status: null,
      };

      const result = await advanceWorkItem({ query, workItemId: wid, signal });

      assert.equal(result.outcome, 'advanced', `expected advanced, got ${result.outcome}: ${result.reason}`);
      assert.equal(result.fromState, 'in_progress');
      assert.equal(result.toState, 'review');
      assert.ok(result.receipt, 'expected capability receipt');
      assert.equal(result.receipt.action, 'work_item_auto_advance');
      assert.equal(result.receipt.agent_tier, 'utility');
      assert.ok(result.receipt.signature?.startsWith('ed25519:'), 'receipt must be signed');

      // Verify DB state changed
      const row = await query(`SELECT status FROM agent_graph.work_items WHERE id = $1`, [wid]);
      assert.equal(row.rows[0].status, 'review');

      // Verify state_transitions audit row exists with the detector agent_id
      const st = await query(
        `SELECT to_state, agent_id FROM agent_graph.state_transitions
          WHERE work_item_id = $1 AND to_state = 'review'
          ORDER BY created_at DESC LIMIT 1`,
        [wid],
      );
      assert.equal(st.rows[0]?.to_state, 'review');
      assert.equal(st.rows[0]?.agent_id, 'completion-detector');
    });

    it('pr_merged on in_progress work_item advances to completed', async () => {
      const wid = await createWorkItemAtStatus('in_progress');
      const signal = {
        signal_type: 'pr_merged',
        channel: 'github',
        content: '',
        pr_merged: true,
        next_status: null,
      };

      const result = await advanceWorkItem({ query, workItemId: wid, signal });
      assert.equal(result.outcome, 'advanced');
      assert.equal(result.toState, 'completed');

      const row = await query(`SELECT status FROM agent_graph.work_items WHERE id = $1`, [wid]);
      assert.equal(row.rows[0].status, 'completed');
    });

    it('already-completed work_item: signal is a no-op (not re-advanced)', async () => {
      const wid = await createWorkItemAtStatus('completed');
      const signal = {
        signal_type: 'pr_merged',
        channel: 'github',
        content: '',
        pr_merged: true,
        next_status: null,
      };

      const result = await advanceWorkItem({ query, workItemId: wid, signal });
      assert.equal(result.outcome, 'noop', `expected noop, got ${result.outcome}`);
      assert.equal(result.reason, 'already_terminal');
    });

    it('signal for non-existent work_item returns noop', async () => {
      const signal = { signal_type: 'pr_merged', channel: 'github', content: '', pr_merged: true, next_status: null };
      const result = await advanceWorkItem({ query, workItemId: 'nonexistent-uuid', signal });
      assert.equal(result.outcome, 'noop');
      assert.equal(result.reason, 'work_item_not_found');
    });

    it('illegal backwards hop (review → assigned) is blocked', async () => {
      const wid = await createWorkItemAtStatus('review');
      const signal = {
        signal_type: 'manual_override',
        channel: null,
        content: '',
        pr_merged: null,
        next_status: 'assigned', // backwards from review
      };

      const result = await advanceWorkItem({ query, workItemId: wid, signal });
      assert.notEqual(result.outcome, 'advanced', 'backwards hop must not advance');
    });

    it('dryRun=true returns dry_run outcome and does NOT change work_item status', async () => {
      const wid = await createWorkItemAtStatus('in_progress');
      const signal = {
        signal_type: 'slack_done',
        channel: 'slack',
        content: 'done for real',
        pr_merged: null,
        next_status: null,
      };

      const result = await advanceWorkItem({ query, workItemId: wid, signal, dryRun: true });
      assert.equal(result.outcome, 'dry_run');
      assert.equal(result.toState, 'review');

      // Status must NOT have changed
      const row = await query(`SELECT status FROM agent_graph.work_items WHERE id = $1`, [wid]);
      assert.equal(row.rows[0].status, 'in_progress', 'dry_run must not mutate DB');
    });

    it('processCompletionSignals stamps processed_at on signal row and advances work_item', async () => {
      const wid = await createWorkItemAtStatus('in_progress');

      await query(
        `INSERT INTO agent_graph.completion_signals (work_item_id, signal_type, channel, content, pr_merged)
         VALUES ($1, 'slack_done', 'slack', 'all done!', false)`,
        [wid],
      );

      const stats = await processCompletionSignals({ query, dryRun: false, batchSize: 10 });
      assert.equal(stats.processed, 1);
      assert.equal(stats.advanced, 1);
      assert.equal(stats.errors, 0);

      // Signal row must now be stamped
      const sig = await query(
        `SELECT processed_at, outcome FROM agent_graph.completion_signals WHERE work_item_id = $1`,
        [wid],
      );
      assert.ok(sig.rows[0]?.processed_at, 'processed_at must be set');
      assert.equal(sig.rows[0]?.outcome, 'advanced');

      // work_item must be at review
      const wi = await query(`SELECT status FROM agent_graph.work_items WHERE id = $1`, [wid]);
      assert.equal(wi.rows[0].status, 'review');
    });

    it('processCompletionSignals skips already-processed signals', async () => {
      const wid = await createWorkItemAtStatus('in_progress');

      await query(
        `INSERT INTO agent_graph.completion_signals (work_item_id, signal_type, channel, content, pr_merged, processed_at)
         VALUES ($1, 'slack_done', 'slack', 'already done', false, NOW())`,
        [wid],
      );

      const stats = await processCompletionSignals({ query, dryRun: false, batchSize: 10 });
      assert.equal(stats.processed, 0, 'already-processed signal must be skipped');
    });
  });
});
