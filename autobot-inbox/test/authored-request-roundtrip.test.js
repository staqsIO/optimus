import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Hub Wedge B — governed round-trip integration test.
 *
 * Proves the end-to-end path the plan rests on, in code, against the real schema
 * (PGlite + migrations): a human authors a request -> a vague one is rejected at
 * the route (P2) -> a good one becomes a pending intent -> board approval creates a
 * governed work_item that carries the author's acceptance-criteria contract verbatim.
 * Also pins the approve-boundary defense-in-depth (a criteria-less human intent
 * cannot become governed work even if it reaches the queue).
 *
 * Mirrors the DB-bootstrap idiom from reaper-orphan-created.test.js.
 */
describe('Hub Wedge B: human-authored work request round-trip', () => {
  let query;
  let createIntent;
  let createHandler;
  let approveHandler;
  let authoredHandler;
  const RUN = `wedgeb-${Date.now()}`;

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
    registerIntentRoutes(routes, {}); // no withViewer -> ownerOrgId DEFAULT
    createHandler = routes.get('POST /api/intents');
    approveHandler = routes.get('POST /api/intents/:id/approve');
    authoredHandler = routes.get('GET /api/intents/authored');
    assert.ok(createHandler && approveHandler && authoredHandler, 'intent routes registered');
  });

  const GOOD_BODY = {
    title: 'Add CSV export to the contacts list',
    outcome: 'A non-technical user can download the contacts list as a CSV from the board.',
    acceptanceCriteria: [
      'A "Download CSV" button appears on the /contacts page',
      'Clicking it downloads a .csv file containing all visible contacts',
      'The CSV first row is a header matching the on-screen column names',
    ],
    outOfScope: ['Exporting to Excel/xlsx format'],
    pattern: 'new',
  };

  const authorReq = (sub) => ({ auth: { sub } });
  const boardReq = (id, sub) => ({ url: `/api/intents/${id}/approve`, auth: { role: 'board', sub } });

  it('rejects an underspecified request at the route (P2, 400)', async () => {
    await assert.rejects(
      () => createHandler(authorReq('dustin@umbadvisors.com'), { title: 'do a thing', outcome: 'make it work' }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /not ready/i);
        return true;
      }
    );
  });

  it('rejects an unauthenticated author (401)', async () => {
    await assert.rejects(
      () => createHandler({ auth: null }, GOOD_BODY),
      (err) => (assert.equal(err.statusCode, 401), true)
    );
  });

  let authoredIntentId;

  it('accepts a complete request as a pending intent carrying the contract', async () => {
    const res = await createHandler(authorReq('dustin@umbadvisors.com'), GOOD_BODY);
    assert.equal(res.ok, true);
    assert.equal(res.intent.status, 'pending');
    const contract = res.intent.proposed_action.payload.acceptance_criteria;
    assert.equal(contract.outcome, GOOD_BODY.outcome);
    assert.equal(contract.criteria.length, 3);
    assert.equal(contract.criteria[0].result, null);
    assert.equal(contract.authored_by, 'dustin@umbadvisors.com');
    authoredIntentId = res.intent.id;
  });

  it('board approval creates a governed work_item carrying the contract verbatim', async () => {
    const res = await approveHandler(boardReq(authoredIntentId, 'ecgang'));
    assert.equal(res.ok, true);
    const wi = res.workItem;
    // acceptance_criteria is the author's contract, stored on the work_item.
    const ac = typeof wi.acceptance_criteria === 'string'
      ? JSON.parse(wi.acceptance_criteria)
      : wi.acceptance_criteria;
    assert.equal(ac.outcome, GOOD_BODY.outcome);
    assert.equal(ac.criteria.length, 3);
    assert.equal(ac.out_of_scope.length, 1);
    assert.equal(ac.authored_by, 'dustin@umbadvisors.com');
    // provenance: the work_item knows a human authored it.
    const meta = typeof wi.metadata === 'string' ? JSON.parse(wi.metadata) : wi.metadata;
    assert.equal(meta.authored_by, 'dustin@umbadvisors.com');

    // intent transitioned to executed.
    const r = await query(`SELECT status FROM agent_graph.agent_intents WHERE id = $1`, [authoredIntentId]);
    assert.equal(r.rows[0].status, 'executed');
  });

  it('render-back lists the authored request with its work_item lifecycle', async () => {
    const { requests } = await authoredHandler({ auth: { role: 'board', sub: 'ecgang' } });
    assert.ok(Array.isArray(requests));
    const mine = requests.find((r) => r.intent_id === authoredIntentId);
    assert.ok(mine, 'authored request present in render-back');
    assert.equal(mine.intent_status, 'executed');
    assert.ok(mine.work_item_id, 'linked to a work_item');
    assert.ok(
      ['created', 'assigned', 'in_progress', 'review', 'completed'].includes(mine.work_item_status),
      `legible work_item_status (got ${mine.work_item_status})`
    );
    const contract = mine.work_item_contract || mine.contract;
    assert.equal(contract.criteria.length, 3);
  });

  it('approve-boundary rejects a human-authored intent with an incomplete contract (422)', async () => {
    // Forge a human-authored intent that bypassed the create-route validation:
    // only 1 criterion. The approve route's isCompleteContract guard must catch it.
    const forged = await createIntent({
      agentId: 'dustin@umbadvisors.com',
      intentType: 'task',
      decisionTier: 'tactical',
      title: 'Sneak a vague request past intake',
      reasoning: 'this should never become governed work',
      proposedAction: {
        type: 'create_work_item',
        payload: {
          type: 'task',
          title: 'Sneak a vague request past intake',
          description: 'this should never become governed work',
          acceptance_criteria: {
            outcome: 'it should generally be better than before honestly',
            criteria: [{ text: 'make it good', result: null }],
            out_of_scope: [],
            authored_by: 'dustin@umbadvisors.com',
          },
        },
      },
      triggerContext: { source: 'human-authored', authored_by: 'dustin@umbadvisors.com', pattern: `forged:${Date.now()}` },
    });
    assert.ok(forged, 'forged intent created');

    await assert.rejects(
      () => approveHandler(boardReq(forged.id, 'ecgang')),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.match(err.message, /complete acceptance-criteria contract/i);
        return true;
      }
    );
    // and it must still be pending (not approved/executed).
    const r = await query(`SELECT status FROM agent_graph.agent_intents WHERE id = $1`, [forged.id]);
    assert.equal(r.rows[0].status, 'pending');
  });

  it('approve-boundary fails closed when a human-authored intent has NO contract (422)', async () => {
    // The contract key is outright missing — isCompleteContract(null) must be false,
    // so the guard fails closed rather than letting ungoverned work through.
    const forged = await createIntent({
      agentId: 'dustin@umbadvisors.com',
      intentType: 'task',
      decisionTier: 'tactical',
      title: 'Human-authored but no acceptance_criteria at all',
      reasoning: 'no contract present',
      proposedAction: {
        type: 'create_work_item',
        payload: { type: 'task', title: 'No contract', description: 'none' },
      },
      triggerContext: { source: 'human-authored', authored_by: 'dustin@umbadvisors.com', pattern: `forged-null:${Date.now()}` },
    });
    await assert.rejects(
      () => approveHandler(boardReq(forged.id, 'ecgang')),
      (err) => (assert.equal(err.statusCode, 422), true)
    );
    const r = await query(`SELECT status FROM agent_graph.agent_intents WHERE id = $1`, [forged.id]);
    assert.equal(r.rows[0].status, 'pending');
  });

  it('GET /api/intents/authored rejects a non-board identity (403)', async () => {
    await assert.rejects(
      () => authoredHandler({ auth: { role: 'agent', sub: 'executor-coder' } }),
      (err) => (assert.equal(err.statusCode, 403), true)
    );
  });

  it('agent-originated intents (no contract) still approve unaffected', async () => {
    const agentIntent = await createIntent({
      agentId: 'orchestrator',
      intentType: 'task',
      decisionTier: 'tactical',
      title: 'Agent-proposed work item',
      reasoning: 'normal agent flow, no acceptance criteria',
      proposedAction: { type: 'create_work_item', payload: { type: 'task', title: 'Agent work', description: 'no criteria' } },
      triggerContext: { pattern: `agent:${Date.now()}` },
    });
    const res = await approveHandler(boardReq(agentIntent.id, 'ecgang'));
    assert.equal(res.ok, true);
    const ac = res.workItem.acceptance_criteria;
    assert.equal(ac === null || ac === undefined, true, 'agent work_item has no contract');
  });
});
