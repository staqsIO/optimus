/**
 * Characterization tests for task-graph state-machine transitions (OPT-137 / plan 001).
 *
 * Pins the invariants of transitionState() from lib/runtime/state/state-machine.js:
 *
 *   (a) legal path created→assigned→in_progress→review→completed all succeed
 *   (b) illegal jump (created→completed) is rejected atomically: returns false,
 *       work_item.status unchanged, no state_transitions row written
 *   (c) transition on a non-existent work item returns false (no crash)
 *   (d) transitionState returns boolean true on success, false on rejection
 *   (e) work_item.status is updated in DB after each legal transition
 *   (f) failed state is reachable from in_progress (non-terminal retry path)
 *
 * Uses PGlite (no DATABASE_URL required).
 * Uses 'orchestrator' agent (seeded by setup-db) which has role '*' in valid_transitions.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

let query;
let transitionState;

const AGENT = 'orchestrator';
const CFG = 'testhash';

/**
 * Insert a work item in 'created' state and return its id.
 * created_by='board' bypasses the assignment-rules trigger.
 */
async function createWorkItem(title) {
  const r = await query(`
    INSERT INTO agent_graph.work_items (type, title, created_by, assigned_to)
    VALUES ('task', $1, 'board', $2)
    RETURNING id
  `, [title, AGENT]);
  return r.rows[0].id;
}

/** Return the current status of a work item. */
async function getStatus(workItemId) {
  const r = await query(
    `SELECT status FROM agent_graph.work_items WHERE id = $1`,
    [workItemId]
  );
  return r.rows[0]?.status ?? null;
}

/** Count state_transitions rows for a given work item. */
async function transitionCount(workItemId) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM agent_graph.state_transitions WHERE work_item_id = $1`,
    [workItemId]
  );
  return r.rows[0].n;
}

before(async () => {
  ({ query } = await getDb());
  ({ transitionState } = await import('../src/runtime/state-machine.js'));
});

describe('state-machine — legal transitions', () => {
  it('(a)(d)(e) created → assigned succeeds and updates work_item status', async () => {
    const id = await createWorkItem('st-legal-1');
    const ok = await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    assert.equal(ok, true, 'transitionState must return true');
    assert.equal(await getStatus(id), 'assigned', 'work_item status must be updated to assigned');
    assert.equal(await transitionCount(id), 1, 'one state_transitions row must be written');
  });

  it('(a) assigned → in_progress succeeds', async () => {
    const id = await createWorkItem('st-legal-2');
    await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    const ok = await transitionState({ workItemId: id, toState: 'in_progress', agentId: AGENT, configHash: CFG });
    assert.equal(ok, true);
    assert.equal(await getStatus(id), 'in_progress');
  });

  it('(a) in_progress → review succeeds', async () => {
    const id = await createWorkItem('st-legal-3');
    await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'in_progress', agentId: AGENT, configHash: CFG });
    const ok = await transitionState({ workItemId: id, toState: 'review', agentId: AGENT, configHash: CFG });
    assert.equal(ok, true);
    assert.equal(await getStatus(id), 'review');
  });

  it('(a) review → completed succeeds (full happy path)', async () => {
    const id = await createWorkItem('st-legal-4');
    await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'in_progress', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'review', agentId: AGENT, configHash: CFG });
    const ok = await transitionState({ workItemId: id, toState: 'completed', agentId: AGENT, configHash: CFG });
    assert.equal(ok, true);
    assert.equal(await getStatus(id), 'completed');
    assert.equal(await transitionCount(id), 4, 'full path must write 4 state_transitions rows');
  });

  it('(f) in_progress → failed is allowed', async () => {
    const id = await createWorkItem('st-legal-5');
    await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'in_progress', agentId: AGENT, configHash: CFG });
    const ok = await transitionState({ workItemId: id, toState: 'failed', agentId: AGENT, configHash: CFG });
    assert.equal(ok, true);
    assert.equal(await getStatus(id), 'failed');
  });
});

describe('state-machine — illegal transitions are atomically rejected', () => {
  it('(b) created → completed is rejected: returns false, status unchanged, no row written', async () => {
    const id = await createWorkItem('st-illegal-1');
    const ok = await transitionState({ workItemId: id, toState: 'completed', agentId: AGENT, configHash: CFG });
    assert.equal(ok, false, 'illegal transition must return false');
    assert.equal(await getStatus(id), 'created', 'status must remain created');
    assert.equal(await transitionCount(id), 0, 'no state_transitions row must be written');
  });

  it('(b) created → review (no valid_transitions row) is rejected atomically', async () => {
    // review is not reachable from created — only in_progress→review is valid.
    const id = await createWorkItem('st-illegal-2');
    const ok = await transitionState({ workItemId: id, toState: 'review', agentId: AGENT, configHash: CFG });
    assert.equal(ok, false);
    assert.equal(await getStatus(id), 'created', 'status must remain created');
    assert.equal(await transitionCount(id), 0);
  });

  it('(b) completed → assigned (backward jump) is rejected', async () => {
    const id = await createWorkItem('st-illegal-3');
    // Drive to completed via legal path first
    await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'in_progress', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'review', agentId: AGENT, configHash: CFG });
    await transitionState({ workItemId: id, toState: 'completed', agentId: AGENT, configHash: CFG });

    // Now attempt the illegal backward jump
    const ok = await transitionState({ workItemId: id, toState: 'assigned', agentId: AGENT, configHash: CFG });
    assert.equal(ok, false, 'backward transition from terminal state must be rejected');
    assert.equal(await getStatus(id), 'completed', 'status must remain completed');
    assert.equal(await transitionCount(id), 4, 'no additional row must be written');
  });
});

describe('state-machine — edge cases', () => {
  it('(c) non-existent workItemId returns undefined (does not throw, does not succeed)', async () => {
    // BUG NOTE (characterization, do not fix here): transitionState() returns `false` at the
    // guard `if (!fromState) return false` (line ~63 of state-machine.js), but the `.then()`
    // chain destructures the resolved value as an object: `({ success }) => success`.
    // Destructuring `false` yields `success = undefined`. Callers checking `=== false` will
    // miss this path; they should check `!result` or `result !== true` instead.
    // This test pins the ACTUAL return value so a future fix is a deliberate choice.
    const result = await transitionState({
      workItemId: 'nonexistent-work-item-id-xyz',
      toState: 'assigned',
      agentId: AGENT,
      configHash: CFG,
    });
    // Actual: undefined (falsy). The invariant is: it must NOT return true.
    assert.notEqual(result, true, 'missing work item must not indicate success');
    assert.ok(!result, 'missing work item must return a falsy value (currently undefined)');
  });
});
