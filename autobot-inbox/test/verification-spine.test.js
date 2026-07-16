import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from './helpers/setup-db.js';
import {
  planVerificationRouting,
  hasFactoryScenarios,
  resolveReentry,
  shouldGenerateScenarios,
} from '../../lib/runtime/verification/verification-gate.js';

// Mock spawnCLI BEFORE importing the tester handler so the tester never spawns a
// real CLI. cliResponse is mutated per-test to script pass/fail.
let cliResponse = { isError: false, result: '{"verdict":"pass"}', costUsd: 0 };
mock.module('../../lib/runtime/agents/spawn-cli.js', {
  namedExports: {
    spawnCLI: async () => cliResponse,
    checkCliCapacity: () => ({ running: 0 }),
  },
});
const { testerHandler, parseVerdict } = await import('../../agents/tester/handler.js');

const PFX = 'vstest-';

// ---------------------------------------------------------------------------
// Layer 0 — pure gate logic (no DB)
// ---------------------------------------------------------------------------
describe('verification-gate (pure)', () => {
  const withScenarios = {
    id: 'wi-1',
    metadata: {},
    acceptance_criteria: { generated_by: 'scenario-factory', scenarios: [{ given: 'a' }] },
  };

  it('hasFactoryScenarios detects the stamped mirror only', () => {
    assert.equal(hasFactoryScenarios(withScenarios), true);
    assert.equal(hasFactoryScenarios({ acceptance_criteria: { scenarios: [] } }), false);
    assert.equal(hasFactoryScenarios({ acceptance_criteria: null }), false);
    assert.equal(hasFactoryScenarios({}), false);
  });

  it('planVerificationRouting: implementer completes with scenarios → verify', () => {
    const r = planVerificationRouting({ completedItem: withScenarios, completingAgent: 'executor-coder', flagEnabled: true });
    assert.equal(r.action, 'verify');
    assert.equal(r.targetId, 'wi-1');
    assert.equal(r.implementer, 'executor-coder');
  });

  it('planVerificationRouting: fix child completion re-verifies the target', () => {
    const fixItem = { id: 'fix-1', metadata: { is_verification_fix: true, verify_target_id: 'wi-1', verify_implementer: 'executor-coder' } };
    const r = planVerificationRouting({ completedItem: fixItem, completingAgent: 'executor-coder', flagEnabled: true });
    assert.equal(r.action, 'verify');
    assert.equal(r.targetId, 'wi-1');
    assert.equal(r.implementer, 'executor-coder');
  });

  it('planVerificationRouting: tester fail under budget → refix', () => {
    const child = { id: 'v-1', metadata: { verification_verdict: 'fail', verify_target_id: 'wi-1', verify_implementer: 'executor-coder', fix_attempts_after: 1, last_failure_mode: 'edge 2 broke' } };
    const r = planVerificationRouting({ completedItem: child, completingAgent: 'tester', flagEnabled: true });
    assert.equal(r.action, 'refix');
    assert.equal(r.targetId, 'wi-1');
    assert.equal(r.implementer, 'executor-coder');
    assert.equal(r.failureMode, 'edge 2 broke');
  });

  it('planVerificationRouting: tester pass → terminal', () => {
    const child = { id: 'v-1', metadata: { verification_verdict: 'pass', verify_target_id: 'wi-1' } };
    const r = planVerificationRouting({ completedItem: child, completingAgent: 'tester', flagEnabled: true });
    assert.equal(r.action, 'terminal');
  });

  it('planVerificationRouting: tester fail at budget (no implementer) → terminal', () => {
    const child = { id: 'v-1', metadata: { verification_verdict: 'fail', verify_target_id: 'wi-1', fix_attempts_after: 3 } };
    const r = planVerificationRouting({ completedItem: child, completingAgent: 'tester', flagEnabled: true });
    assert.equal(r.action, 'terminal');
  });

  it('planVerificationRouting: flag OFF → none (no-op spine)', () => {
    assert.equal(planVerificationRouting({ completedItem: withScenarios, completingAgent: 'executor-coder', flagEnabled: false }).action, 'none');
  });

  it('planVerificationRouting: ordinary completion (no scenarios) → none', () => {
    assert.equal(planVerificationRouting({ completedItem: { id: 'x', metadata: {} }, completingAgent: 'executor-responder', flagEnabled: true }).action, 'none');
  });

  it('shouldGenerateScenarios gates on flag + verify-agent + not-a-fix', () => {
    const prev = { flag: process.env.VERIFICATION_SPINE_ENABLED, agents: process.env.VERIFY_AGENTS };
    process.env.VERIFICATION_SPINE_ENABLED = 'true';
    process.env.VERIFY_AGENTS = 'executor-coder';
    try {
      const base = { type: 'task', metadata: {} };
      assert.equal(shouldGenerateScenarios(base, 'executor-coder'), true);
      assert.equal(shouldGenerateScenarios(base, 'executor-responder'), false, 'non-verify agent');
      assert.equal(shouldGenerateScenarios({ type: 'task', metadata: { is_verification_fix: true } }, 'executor-coder'), false, 'fix child');
      assert.equal(shouldGenerateScenarios({ type: 'task', metadata: {}, acceptance_criteria: { generated_by: 'scenario-factory', scenarios: [{}] } }, 'executor-coder'), false, 'already has scenarios');
      process.env.VERIFICATION_SPINE_ENABLED = 'false';
      assert.equal(shouldGenerateScenarios(base, 'executor-coder'), false, 'flag off');
    } finally {
      if (prev.flag === undefined) delete process.env.VERIFICATION_SPINE_ENABLED; else process.env.VERIFICATION_SPINE_ENABLED = prev.flag;
      if (prev.agents === undefined) delete process.env.VERIFY_AGENTS; else process.env.VERIFY_AGENTS = prev.agents;
    }
  });

  it('resolveReentry: fix child without failure_mode aborts to failed (no blind re-run)', () => {
    assert.deepEqual(resolveReentry({ metadata: { is_verification_fix: true } }), { abort: 'failed', fixInstruction: null });
  });
  it('resolveReentry: fix child with failure_mode → inject it', () => {
    assert.deepEqual(
      resolveReentry({ metadata: { is_verification_fix: true, last_failure_mode: 'scenario 2 broke' } }),
      { abort: null, fixInstruction: 'scenario 2 broke' }
    );
  });
  it('resolveReentry: non-fix item → no instruction even with stray failure_mode', () => {
    assert.deepEqual(resolveReentry({ metadata: { last_failure_mode: 'x' } }), { abort: null, fixInstruction: null });
  });
});

// ---------------------------------------------------------------------------
// parseVerdict — tolerant extraction
// ---------------------------------------------------------------------------
describe('parseVerdict', () => {
  it('parses bare JSON', () => assert.equal(parseVerdict('{"verdict":"pass"}').verdict, 'pass'));
  it('parses fenced JSON with prose', () =>
    assert.equal(parseVerdict('checked.\n```json\n{"verdict":"fail","failure_mode":"x"}\n```').verdict, 'fail'));
  it('parses trailing JSON after prose', () =>
    assert.equal(parseVerdict('blah\n{"verdict":"pass","scenario_results":[]}').verdict, 'pass'));
  it('parses JSON with NESTED braces in arrays (regression)', () =>
    assert.equal(parseVerdict('{"verdict":"pass","scenario_results":[{"n":1,"pass":true},{"n":2,"pass":true}]}').verdict, 'pass'));
  it('returns null on no verdict', () => assert.equal(parseVerdict('no json here'), null));
});

// ---------------------------------------------------------------------------
// Layer 1 — migration 158 constraints
// ---------------------------------------------------------------------------
describe('migration 158 — schema', () => {
  let query;
  before(async () => { ({ query } = await getDb()); });

  it('review→failed transition exists', async () => {
    const r = await query(`SELECT 1 FROM agent_graph.valid_transitions WHERE from_state='review' AND to_state='failed'`);
    assert.equal(r.rows.length, 1);
  });

  it('tester agent_config registered as type reviewer', async () => {
    const r = await query(`SELECT agent_type FROM agent_graph.agent_configs WHERE id='tester'`);
    assert.equal(r.rows[0]?.agent_type, 'reviewer');
  });

  it('work_item_scenarios has RLS enabled/forced', async () => {
    const r = await query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='work_item_scenarios'`).catch(() => ({ rows: [] }));
    assert.ok(r.rows.length === 0 || r.rows[0].relrowsecurity === true, 'RLS should be enabled on work_item_scenarios');
  });

  it('fix_attempts CHECK rejects values > 5', async () => {
    const id = `${PFX}check`;
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [id]);
    await query(`INSERT INTO agent_graph.work_items (id, type, title, status, created_by) VALUES ($1,'task','t','created','board')`, [id]);
    await assert.rejects(() => query(`UPDATE agent_graph.work_items SET fix_attempts=6 WHERE id=$1`, [id]), /fix_attempts|constraint|check/i);
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [id]);
  });

  it('verification_verdicts UNIQUE(work_item_id, attempt) rejects a duplicate', async () => {
    const id = `${PFX}uniq`;
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [id]);
    await query(`INSERT INTO agent_graph.work_items (id, type, title, status, created_by) VALUES ($1,'task','t','review','board')`, [id]);
    await query(`INSERT INTO agent_graph.verification_verdicts (work_item_id, verdict, attempt, tester_agent) VALUES ($1,'fail',0,'tester')`, [id]);
    await assert.rejects(
      () => query(`INSERT INTO agent_graph.verification_verdicts (work_item_id, verdict, attempt, tester_agent) VALUES ($1,'pass',0,'tester')`, [id]),
      /unique|duplicate/i
    );
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [id]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2/3 — Tester handler against PGlite, CLI mocked. Verifies the verdict
// write + fix_attempts/last_failure_mode stamping + child-metadata routing facts.
// (child == target here via the self-verify fallback.)
// ---------------------------------------------------------------------------
describe('tester handler', () => {
  let query;
  before(async () => { ({ query } = await getDb()); });

  async function seedItem(id, { fixAttempts = 0, assignedTo = 'executor-coder' } = {}) {
    await query(`DELETE FROM agent_graph.verification_verdicts WHERE work_item_id=$1`, [id]);
    await query(`DELETE FROM agent_graph.work_item_scenarios WHERE work_item_id=$1`, [id]);
    await query(`DELETE FROM agent_graph.work_items WHERE id=$1`, [id]);
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to, fix_attempts, metadata)
       VALUES ($1,'task','Build widget','in_progress','orchestrator',$2,$3,'{}')`,
      [id, assignedTo, fixAttempts]
    );
    await query(
      `INSERT INTO agent_graph.work_item_scenarios (work_item_id, scenario, withheld, category) VALUES
        ($1,$2,false,'happy_path'), ($1,$3,true,'edge_case')`,
      [id, JSON.stringify({ given: 'g', when: 'w', then: 't' }), JSON.stringify({ given: 'ge', when: 'we', then: 'te' })]
    );
  }

  const agentStub = { agentId: 'tester', scopedQuery: null };
  const ctx = () => ({ workItem: { metadata: {} } });

  it('PASS → child metadata verdict=pass + verdict row', async () => {
    const id = `${PFX}pass`;
    await seedItem(id);
    agentStub.scopedQuery = query;
    cliResponse = { isError: false, result: '{"verdict":"pass","scenario_results":[{"n":1,"pass":true}]}', costUsd: 0.01 };

    const res = await testerHandler({ work_item_id: id }, ctx(), agentStub);
    assert.equal(res.success, true);

    const w = await query(`SELECT metadata FROM agent_graph.work_items WHERE id=$1`, [id]);
    assert.equal(w.rows[0].metadata.verification_verdict, 'pass');
    const v = await query(`SELECT verdict FROM agent_graph.verification_verdicts WHERE work_item_id=$1`, [id]);
    assert.equal(v.rows[0].verdict, 'pass');
  });

  it('FAIL (under budget) → fix_attempts++, last_failure_mode + routing facts stamped', async () => {
    const id = `${PFX}fail`;
    await seedItem(id, { fixAttempts: 0 });
    agentStub.scopedQuery = query;
    cliResponse = { isError: false, result: '{"verdict":"fail","failure_mode":"edge case 2 broke"}', costUsd: 0.02 };

    const res = await testerHandler({ work_item_id: id }, ctx(), agentStub);
    assert.equal(res.success, true);

    const w = await query(`SELECT fix_attempts, metadata FROM agent_graph.work_items WHERE id=$1`, [id]);
    assert.equal(w.rows[0].fix_attempts, 1);
    assert.equal(w.rows[0].metadata.last_failure_mode, 'edge case 2 broke');
    assert.equal(w.rows[0].metadata.verification_verdict, 'fail');
    assert.equal(w.rows[0].metadata.fix_attempts_after, 1);
    assert.equal(w.rows[0].metadata.verify_implementer, 'executor-coder');

    const v = await query(`SELECT verdict, attempt FROM agent_graph.verification_verdicts WHERE work_item_id=$1`, [id]);
    assert.equal(v.rows[0].verdict, 'fail');
    assert.equal(v.rows[0].attempt, 0);
  });

  it('FAIL at budget (fix_attempts=3) → terminal, no implementer, no increment', async () => {
    const id = `${PFX}terminal`;
    await seedItem(id, { fixAttempts: 3 });
    agentStub.scopedQuery = query;
    cliResponse = { isError: false, result: '{"verdict":"fail","failure_mode":"still broken"}', costUsd: 0 };

    await testerHandler({ work_item_id: id }, ctx(), agentStub);
    const w = await query(`SELECT fix_attempts, metadata FROM agent_graph.work_items WHERE id=$1`, [id]);
    assert.equal(w.rows[0].fix_attempts, 3, 'must not increment past budget');
    assert.equal(w.rows[0].metadata.fix_attempts_after, 3);
    assert.equal(w.rows[0].metadata.verify_implementer ?? null, null, 'no implementer → orchestrator routes terminal');
  });

  it('verification never touches retry_count', async () => {
    const id = `${PFX}retry`;
    await seedItem(id, { fixAttempts: 0 });
    agentStub.scopedQuery = query;
    cliResponse = { isError: false, result: '{"verdict":"fail","failure_mode":"x"}', costUsd: 0 };
    await testerHandler({ work_item_id: id }, ctx(), agentStub);
    const w = await query(`SELECT retry_count FROM agent_graph.work_items WHERE id=$1`, [id]);
    assert.equal(w.rows[0].retry_count, 0);
  });
});
