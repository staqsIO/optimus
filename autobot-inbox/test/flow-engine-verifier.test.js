/**
 * OPT-3 — the verifier is actually WIRED into flow completion (USE SITE 1).
 *
 * verifier.test.js proves gateFlowCompletion() in isolation. This proves the
 * acceptance criterion end-to-end through FlowEngine.executeFlow: a flow that
 * carries success_criteria and whose output FAILS them is parked in
 * 'verification_failed' and NEVER written 'completed'; a passing flow completes;
 * a flow with no criteria is unaffected (backward compatible).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlowEngine } from '../../lib/runtime/flow-engine.js';

function makeMockDb() {
  const db = {
    query: async (sql, params) => {
      db._calls.push({ sql, params });
      // Both flow_executions + step_executions INSERTs use RETURNING * and
      // destructure { rows: [row] }; hand them a row with an id.
      if (/INSERT/i.test(sql)) return { rows: [{ id: 'exec-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    _calls: [],
  };
  return db;
}

function makeToolRegistry(output) {
  return {
    dispatch: async () => output, // becomes lastOutput → the verifier's observation
    _calls: [],
  };
}

const signal = { id: 'sig-1', signal_type: 'email.received', payload: { subject: 'hi' }, source_adapter: 'gmail' };

function flowDef(success_criteria) {
  return {
    id: 'flow-verif-1',
    name: 'verif-flow',
    trigger_signal_type: 'email.received',
    max_depth: 5,
    timeout_ms: 30000,
    retry_policy: { strategy: 'none' },
    steps: [{ tool_id: 'tool-a', config: {} }],
    success_criteria,
  };
}

const QUALITY_GATE = [{ text: 'quality_score >= 0.85', field: 'quality_score', operator: '>=', value: 0.85 }];

function flowExecUpdates(db) {
  return db._calls.filter(
    (c) => /UPDATE/i.test(c.sql) && /flow_executions/.test(c.sql),
  );
}

describe('FlowEngine completion gate (OPT-3 USE SITE 1)', () => {
  it('parks a flow whose output FAILS its success_criteria in verification_failed (not completed)', async () => {
    const db = makeMockDb();
    const engine = new FlowEngine({ db, toolRegistry: makeToolRegistry({ quality_score: 0.5 }) });

    const res = await engine.executeFlow(flowDef(QUALITY_GATE), signal, {
      depth: 0, parentExecutionId: null, dryRun: false,
    });

    assert.equal(res.verificationFailed, true);
    const updates = flowExecUpdates(db);
    assert.ok(
      updates.some((c) => c.params?.includes('verification_failed')),
      'flow_executions marked verification_failed',
    );
    assert.equal(
      updates.some((c) => c.params?.includes('completed')),
      false,
      'flow_executions must NOT be marked completed when verification fails',
    );
  });

  it('completes a flow whose output PASSES its success_criteria', async () => {
    const db = makeMockDb();
    const engine = new FlowEngine({ db, toolRegistry: makeToolRegistry({ quality_score: 0.95 }) });

    const res = await engine.executeFlow(flowDef(QUALITY_GATE), signal, {
      depth: 0, parentExecutionId: null, dryRun: false,
    });

    assert.ok(!res.verificationFailed);
    const updates = flowExecUpdates(db);
    assert.ok(updates.some((c) => c.params?.includes('completed')), 'flow completed');
    assert.equal(updates.some((c) => c.params?.includes('verification_failed')), false);
  });

  it('is a pure pass-through for flows with no success_criteria (backward compatible)', async () => {
    const db = makeMockDb();
    const engine = new FlowEngine({ db, toolRegistry: makeToolRegistry({ anything: true }) });

    await engine.executeFlow(flowDef([]), signal, {
      depth: 0, parentExecutionId: null, dryRun: false,
    });
    await engine.executeFlow(flowDef(undefined), signal, {
      depth: 0, parentExecutionId: null, dryRun: false,
    });

    const updates = flowExecUpdates(db);
    assert.ok(updates.every((c) => !c.params?.includes('verification_failed')), 'no gate fires');
    assert.ok(updates.some((c) => c.params?.includes('completed')), 'flows still complete');
  });
});
