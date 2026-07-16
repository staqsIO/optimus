import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  criteriaReconciled,
  buildContract,
  validateAuthoredRequest,
} from '../../lib/runtime/governance/authored-request.js';

/**
 * Hub Wedge C — review-binding: the board marks each acceptance criterion pass/fail
 * at review, persisting the verdict onto the work_item contract. "Reconciled" = every
 * authored criterion passed. This is the metric anchor and completes the round-trip:
 * a non-dev's words → governed work → verified against those same words.
 */

const GOOD = {
  title: 'Add CSV export to the contacts list',
  outcome: 'A non-technical user can download the contacts list as a CSV from the board.',
  acceptanceCriteria: [
    'A "Download CSV" button appears on the /contacts page',
    'Clicking it downloads a .csv file containing all visible contacts',
    'The CSV first row is a header matching the on-screen column names',
  ],
  outOfScope: ['Exporting to Excel/xlsx format'],
};

describe('criteriaReconciled (pure)', () => {
  const contract = () => buildContract(validateAuthoredRequest(GOOD).normalized, 'dustin@x');

  it('is false when criteria are unmarked', () => {
    assert.equal(criteriaReconciled(contract()), false);
  });
  it('is false when some criteria fail or are unmarked', () => {
    const c = contract();
    c.criteria[0].result = 'pass';
    c.criteria[1].result = 'fail';
    assert.equal(criteriaReconciled(c), false);
  });
  it('is true only when every criterion is marked pass', () => {
    const c = contract();
    c.criteria.forEach((x) => (x.result = 'pass'));
    assert.equal(criteriaReconciled(c), true);
  });
  it('is false for a non-contract', () => {
    assert.equal(criteriaReconciled(null), false);
    assert.equal(criteriaReconciled({ criteria: [] }), false);
  });
});

describe('Wedge C: criteria verify round-trip', () => {
  let createHandler, approveHandler, verifyHandler, createIntent, query;
  const RUN = `wedgec-${Date.now()}`;
  const authorReq = (sub) => ({ auth: { sub } });

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL(`../data/pglite-${RUN}`, import.meta.url).pathname;
    const db = await import('../src/db.js');
    query = db.query;
    await db.initializeDatabase();
    ({ createIntent } = await import('../src/runtime/intent-manager.js'));
    const { registerIntentRoutes } = await import('../src/api-routes/intents.js');
    const routes = new Map();
    registerIntentRoutes(routes, {});
    createHandler = routes.get('POST /api/intents');
    approveHandler = routes.get('POST /api/intents/:id/approve');
    verifyHandler = routes.get('POST /api/intents/authored/criteria');
    assert.ok(createHandler && approveHandler && verifyHandler, 'routes registered');
  });

  // Author + approve a request, returning the created work_item id.
  async function authorAndApprove() {
    const created = await createHandler(authorReq('dustin@umbadvisors.com'), GOOD);
    const approved = await approveHandler({
      url: `/api/intents/${created.intent.id}/approve`,
      auth: { role: 'board', sub: 'ecgang' },
    });
    return approved.workItem.id;
  }

  let workItemId;

  it('marks criteria and reports reconciled=false until all pass', async () => {
    workItemId = await authorAndApprove();
    const res = await verifyHandler(
      { auth: { role: 'board', sub: 'ecgang' } },
      { workItemId, results: [{ index: 0, result: 'pass' }, { index: 1, result: 'fail' }] }
    );
    assert.equal(res.ok, true);
    assert.equal(res.contract.criteria[0].result, 'pass');
    assert.equal(res.contract.criteria[1].result, 'fail');
    assert.equal(res.contract.verified_by, 'ecgang');
    assert.equal(res.reconciled, false);
  });

  it('reports reconciled=true once every criterion passes; verdict persists', async () => {
    const res = await verifyHandler(
      { auth: { role: 'board', sub: 'ecgang' } },
      { workItemId, results: [{ index: 0, result: 'pass' }, { index: 1, result: 'pass' }, { index: 2, result: 'pass' }] }
    );
    assert.equal(res.reconciled, true);
    // persisted on the work_item
    const r = await query(`SELECT acceptance_criteria FROM agent_graph.work_items WHERE id = $1`, [workItemId]);
    const ac = typeof r.rows[0].acceptance_criteria === 'string'
      ? JSON.parse(r.rows[0].acceptance_criteria)
      : r.rows[0].acceptance_criteria;
    assert.ok(ac.criteria.every((c) => c.result === 'pass'));
    assert.equal(ac.verified_by, 'ecgang');
    assert.ok(ac.verified_at);
  });

  it('rejects a non-board identity (403)', async () => {
    await assert.rejects(
      () => verifyHandler({ auth: { role: 'agent', sub: 'executor-coder' } }, { workItemId, results: [{ index: 0, result: 'pass' }] }),
      (e) => (assert.equal(e.statusCode, 403), true)
    );
  });

  it('rejects an out-of-range criterion index (400)', async () => {
    await assert.rejects(
      () => verifyHandler({ auth: { role: 'board', sub: 'ecgang' } }, { workItemId, results: [{ index: 99, result: 'pass' }] }),
      (e) => (assert.equal(e.statusCode, 400), true)
    );
  });

  it('rejects an invalid result value (400)', async () => {
    await assert.rejects(
      () => verifyHandler({ auth: { role: 'board', sub: 'ecgang' } }, { workItemId, results: [{ index: 0, result: 'maybe' }] }),
      (e) => (assert.equal(e.statusCode, 400), true)
    );
  });

  it('rejects duplicate indices in results (400) — one verdict per criterion', async () => {
    await assert.rejects(
      () => verifyHandler(
        { auth: { role: 'board', sub: 'ecgang' } },
        { workItemId, results: [{ index: 0, result: 'pass' }, { index: 0, result: 'fail' }] }
      ),
      (e) => (assert.equal(e.statusCode, 400), true)
    );
  });

  it('404s an unknown work item', async () => {
    await assert.rejects(
      () => verifyHandler({ auth: { role: 'board', sub: 'ecgang' } }, { workItemId: 'wi-does-not-exist', results: [{ index: 0, result: 'pass' }] }),
      (e) => (assert.equal(e.statusCode, 404), true)
    );
  });

  it('422s a work item with no human-authored contract', async () => {
    // agent-originated intent -> work_item with no acceptance_criteria
    const agentIntent = await createIntent({
      agentId: 'orchestrator',
      intentType: 'task',
      decisionTier: 'tactical',
      title: 'Agent work, no contract',
      reasoning: 'no criteria',
      proposedAction: { type: 'create_work_item', payload: { type: 'task', title: 'Agent work', description: 'x' } },
      triggerContext: { pattern: `agent-c:${Date.now()}` },
    });
    const approved = await approveHandler({ url: `/api/intents/${agentIntent.id}/approve`, auth: { role: 'board', sub: 'ecgang' } });
    await assert.rejects(
      () => verifyHandler({ auth: { role: 'board', sub: 'ecgang' } }, { workItemId: approved.workItem.id, results: [{ index: 0, result: 'pass' }] }),
      (e) => (assert.equal(e.statusCode, 422), true)
    );
  });
});
