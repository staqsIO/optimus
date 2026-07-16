import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFlowCore,
  listFlowsCore,
  getFlowCore,
  runFlowCore,
  getExecutionCore,
  emitSignalCore,
  listSignalsCore,
} from '../src/api-routes/flows.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuery(results) {
  return mock.fn(async () => ({ rows: results, rowCount: results.length }));
}

function makeQueryMulti(resultSets) {
  let callIdx = 0;
  return mock.fn(async () => {
    const rows = resultSets[callIdx] || [];
    callIdx++;
    return { rows, rowCount: rows.length };
  });
}

// ---------------------------------------------------------------------------
// POST /api/flows — createFlowCore
// ---------------------------------------------------------------------------

describe('createFlowCore', () => {
  it('inserts a flow definition and returns it', async () => {
    const created = {
      id: 'flow-uuid-1',
      name: 'my-flow',
      trigger_signal_type: 'email.received',
      steps: [{ tool_id: 'echo' }],
      version: 1,
      is_active: true,
      created_at: '2026-04-06T00:00:00Z',
    };
    // STAQPRO-615: validate-then-insert in ONE transaction. Call sequence is
    // BEGIN → SELECT active flows (DAG validate) → INSERT → COMMIT.
    const db = makeQueryMulti([
      [],          // BEGIN
      [],          // SELECT active flows (none → no cycle)
      [created],   // INSERT ... RETURNING *
      [],          // COMMIT
    ]);

    const result = await createFlowCore(db, {
      name: 'my-flow',
      trigger_signal_type: 'email.received',
      steps: [{ tool_id: 'echo' }],
    });

    assert.equal(db.mock.callCount(), 4);
    assert.equal(db.mock.calls[0].arguments[0], 'BEGIN');
    assert.equal(db.mock.calls[3].arguments[0], 'COMMIT');
    assert.equal(result.flow.id, 'flow-uuid-1');
    assert.equal(result.flow.name, 'my-flow');
  });

  it('returns error when name is missing', async () => {
    const db = makeQuery([]);
    const result = await createFlowCore(db, { trigger_signal_type: 'x', steps: [] });
    assert.ok(result.error);
    assert.equal(db.mock.callCount(), 0);
  });

  it('returns error when trigger_signal_type is missing', async () => {
    const db = makeQuery([]);
    const result = await createFlowCore(db, { name: 'x', steps: [] });
    assert.ok(result.error);
    assert.equal(db.mock.callCount(), 0);
  });

  it('returns error when steps is missing', async () => {
    const db = makeQuery([]);
    const result = await createFlowCore(db, { name: 'x', trigger_signal_type: 'y' });
    assert.ok(result.error);
    assert.equal(db.mock.callCount(), 0);
  });

  it('passes optional fields through to SQL', async () => {
    const created = {
      id: 'flow-uuid-2',
      name: 'detailed',
      trigger_signal_type: 'slack.message',
      steps: [],
      description: 'A test flow',
      max_depth: 3,
      timeout_ms: 5000,
      retry_policy: { strategy: 'linear' },
      version: 1,
      is_active: true,
      created_at: '2026-04-06T00:00:00Z',
    };
    const db = makeQuery([created]);

    await createFlowCore(db, {
      name: 'detailed',
      trigger_signal_type: 'slack.message',
      steps: [],
      description: 'A test flow',
      max_depth: 3,
      timeout_ms: 5000,
      retry_policy: { strategy: 'linear' },
    });

    // The INSERT is the parameterized call (BEGIN/SELECT/COMMIT carry no flow
    // params); find it by its SQL rather than a fixed index.
    const insertCall = db.mock.calls.find(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO agent_graph.flow_definitions'),
    );
    const params = insertCall.arguments[1];
    assert.equal(params[0], 'detailed');
    assert.equal(params[3], 'A test flow');
    assert.equal(params[4], 3);
    assert.equal(params[5], 5000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/flows — listFlowsCore
// ---------------------------------------------------------------------------

describe('listFlowsCore', () => {
  it('returns all flows', async () => {
    const flows = [
      { id: '1', name: 'flow-a', is_active: true },
      { id: '2', name: 'flow-b', is_active: false },
    ];
    const db = makeQuery(flows);
    const result = await listFlowsCore(db, {});
    assert.equal(result.flows.length, 2);
  });

  it('filters by active when specified', async () => {
    const db = makeQuery([{ id: '1', name: 'flow-a', is_active: true }]);
    await listFlowsCore(db, { active: 'true' });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(sql.includes('is_active'));
  });

  it('returns empty array when no flows exist', async () => {
    const db = makeQuery([]);
    const result = await listFlowsCore(db, {});
    assert.deepEqual(result.flows, []);
  });
});

// ---------------------------------------------------------------------------
// GET /api/flows/:id — getFlowCore
// ---------------------------------------------------------------------------

describe('getFlowCore', () => {
  it('returns flow with recent executions', async () => {
    const db = makeQueryMulti([
      [{ id: 'flow-1', name: 'test', steps: [], trigger_signal_type: 'email.received' }],
      [{ id: 'exec-1', status: 'completed' }, { id: 'exec-2', status: 'running' }],
    ]);

    const result = await getFlowCore(db, 'flow-1');
    assert.equal(result.flow.id, 'flow-1');
    assert.equal(result.executions.length, 2);
    assert.equal(db.mock.callCount(), 2);
  });

  it('returns error when flow not found', async () => {
    const db = makeQuery([]);
    const result = await getFlowCore(db, 'missing-id');
    assert.ok(result.error);
    assert.match(result.error, /not found/i);
  });

  it('returns error when id is missing', async () => {
    const db = makeQuery([]);
    const result = await getFlowCore(db, null);
    assert.ok(result.error);
  });
});

// ---------------------------------------------------------------------------
// POST /api/flows/:id/run — runFlowCore
// ---------------------------------------------------------------------------

describe('runFlowCore', () => {
  it('returns error when flow not found', async () => {
    const db = makeQuery([]);
    const result = await runFlowCore(db, 'missing', {}, { dryRun: false });
    assert.ok(result.error);
  });

  it('returns error when id is missing', async () => {
    const db = makeQuery([]);
    const result = await runFlowCore(db, null, {}, { dryRun: false });
    assert.ok(result.error);
  });

  it('creates signal and runs engine on valid flow', async () => {
    const flowDef = {
      id: 'flow-1',
      name: 'test',
      trigger_signal_type: 'email.received',
      steps: [{ tool_id: 'echo' }],
      max_depth: 5,
      timeout_ms: 30000,
      retry_policy: { strategy: 'none' },
    };
    const signal = { id: 'sig-1', signal_type: 'email.received', payload: { key: 'val' } };

    const db = makeQueryMulti([
      [flowDef],  // find flow
      [signal],   // create signal
    ]);

    const mockEngine = {
      onSignal: mock.fn(async () => [{ executionId: 'exec-1', output: { ok: true } }]),
    };

    const result = await runFlowCore(db, 'flow-1', { key: 'val' }, { dryRun: false, flowEngine: mockEngine });
    assert.equal(result.execution_count, 1);
    assert.equal(result.results[0].executionId, 'exec-1');
    assert.equal(mockEngine.onSignal.mock.callCount(), 1);
  });

  it('passes dry_run flag to engine', async () => {
    const flowDef = {
      id: 'flow-1', name: 'test', trigger_signal_type: 'x',
      steps: [], max_depth: 5, timeout_ms: 30000, retry_policy: {},
    };
    const signal = { id: 'sig-1', signal_type: 'x', payload: {} };
    const db = makeQueryMulti([[flowDef], [signal]]);
    const mockEngine = {
      onSignal: mock.fn(async () => []),
    };

    await runFlowCore(db, 'flow-1', {}, { dryRun: true, flowEngine: mockEngine });
    const callArgs = mockEngine.onSignal.mock.calls[0].arguments;
    assert.equal(callArgs[1].dryRun, true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/flows/executions/:id — getExecutionCore
// ---------------------------------------------------------------------------

describe('getExecutionCore', () => {
  it('returns execution with steps', async () => {
    const execution = { id: 'exec-1', status: 'completed', flow_definition_id: 'f1' };
    const steps = [
      { step_index: 0, tool_id: 'echo', status: 'completed' },
      { step_index: 1, tool_id: 'store', status: 'completed' },
    ];
    const db = makeQueryMulti([[execution], steps]);

    const result = await getExecutionCore(db, 'exec-1');
    assert.equal(result.execution.id, 'exec-1');
    assert.equal(result.steps.length, 2);
  });

  it('returns error when execution not found', async () => {
    const db = makeQuery([]);
    const result = await getExecutionCore(db, 'missing');
    assert.ok(result.error);
  });

  it('returns error when id is missing', async () => {
    const db = makeQuery([]);
    const result = await getExecutionCore(db, null);
    assert.ok(result.error);
  });
});

// ---------------------------------------------------------------------------
// POST /api/signals — emitSignalCore
// ---------------------------------------------------------------------------

describe('emitSignalCore', () => {
  it('inserts a signal and returns it', async () => {
    const created = { id: 'sig-1', signal_type: 'email.received', payload: { x: 1 } };
    const db = makeQuery([created]);

    const result = await emitSignalCore(db, {
      signal_type: 'email.received',
      payload: { x: 1 },
    });

    assert.equal(result.signal.id, 'sig-1');
    assert.equal(db.mock.callCount(), 1);
  });

  it('returns error when signal_type is missing', async () => {
    const db = makeQuery([]);
    const result = await emitSignalCore(db, { payload: {} });
    assert.ok(result.error);
    assert.equal(db.mock.callCount(), 0);
  });

  it('passes source_adapter through', async () => {
    const db = makeQuery([{ id: 'sig-1', signal_type: 'x', payload: {} }]);
    await emitSignalCore(db, { signal_type: 'x', payload: {}, source_adapter: 'slack' });
    const params = db.mock.calls[0].arguments[1];
    assert.equal(params[1], 'slack');
  });

  it('accepts `type` as alias for signal_type (OPT-22 board modal compat)', async () => {
    const created = { id: 'sig-2', signal_type: 'email.received', payload: {} };
    const db = makeQuery([created]);
    const result = await emitSignalCore(db, { type: 'email.received', payload: {} });
    assert.equal(result.signal.id, 'sig-2');
    // DB call must have received the resolved signal_type as first param
    const params = db.mock.calls[0].arguments[1];
    assert.equal(params[0], 'email.received');
  });
});

// ---------------------------------------------------------------------------
// GET /api/signals — listSignalsCore
// ---------------------------------------------------------------------------

describe('listSignalsCore', () => {
  it('returns signals', async () => {
    const signals = [
      { id: 's1', signal_type: 'email.received', created_at: '2026-01-01' },
    ];
    const db = makeQuery(signals);
    const result = await listSignalsCore(db, {});
    assert.equal(result.signals.length, 1);
  });

  it('filters by type', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, { type: 'email.received' });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(sql.includes('signal_type'));
  });

  it('filters by since', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, { since: '2026-01-01' });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(sql.includes('created_at'));
  });

  it('respects limit parameter', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, { limit: '10' });
    const params = db.mock.calls[0].arguments[1];
    assert.ok(params.includes(10));
  });

  it('caps limit at 200', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, { limit: '999' });
    const params = db.mock.calls[0].arguments[1];
    assert.ok(params.includes(200));
  });
});

// ---------------------------------------------------------------------------
// Tenancy scoping (ADR-012 M-C / STAQPRO-588) — the cross-tenant leak fix
// ---------------------------------------------------------------------------

describe('listSignalsCore tenancy scope', () => {
  it('fails closed with no principal (unidentified caller → WHERE FALSE)', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, {}, null);
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(/\bFALSE\b/.test(sql), 'unresolved principal must emit FALSE (fail-closed)');
  });

  it('scopes by owner_org_id for an identified member', async () => {
    const db = makeQuery([]);
    const principal = { userId: 'u1', readOrgIds: ['org-a'], roles: {}, adminBypass: false };
    await listSignalsCore(db, {}, principal);
    const sql = db.mock.calls[0].arguments[0];
    const params = db.mock.calls[0].arguments[1];
    assert.ok(sql.includes('owner_org_id'), 'must filter on owner_org_id');
    assert.ok(params.some((p) => Array.isArray(p) && p.includes('org-a')), 'must bind readOrgIds');
  });

  it('grants org-wide access to verified agents (adminBypass → TRUE)', async () => {
    const db = makeQuery([]);
    await listSignalsCore(db, {}, { adminBypass: true, readOrgIds: [] });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(/\bTRUE\b/.test(sql), 'adminBypass must emit TRUE');
  });

  it('keeps type + since filters alongside the scope clause', async () => {
    const db = makeQuery([]);
    const principal = { userId: 'u1', readOrgIds: ['org-a'], roles: {}, adminBypass: false };
    await listSignalsCore(db, { type: 'email.received', since: '2026-01-01' }, principal);
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(sql.includes('signal_type') && sql.includes('created_at') && sql.includes('owner_org_id'));
  });
});

describe('emitSignalCore owner-stamp', () => {
  it('stamps owner_org_id for a single-org member', async () => {
    const db = makeQuery([{ id: 'sig-1' }]);
    await emitSignalCore(db, { signal_type: 'x', payload: {} }, { adminBypass: false, readOrgIds: ['org-a'] });
    const sql = db.mock.calls[0].arguments[0];
    const params = db.mock.calls[0].arguments[1];
    assert.ok(sql.includes('owner_org_id'), 'single-org member stamps owner_org_id');
    assert.ok(params.includes('org-a'));
  });

  it('defers to column DEFAULT for multi-org members (TODO 593)', async () => {
    const db = makeQuery([{ id: 'sig-1' }]);
    await emitSignalCore(db, { signal_type: 'x', payload: {} }, { adminBypass: false, readOrgIds: ['org-a', 'org-b'] });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(!sql.includes('owner_org_id'), 'multi-org emit defers owner_org_id to DEFAULT');
  });

  it('defers to column DEFAULT for verified agents (adminBypass)', async () => {
    const db = makeQuery([{ id: 'sig-1' }]);
    await emitSignalCore(db, { signal_type: 'x', payload: {} }, { adminBypass: true, readOrgIds: [] });
    const sql = db.mock.calls[0].arguments[0];
    assert.ok(!sql.includes('owner_org_id'));
  });
});

// ---------------------------------------------------------------------------
// Route registration integration
// ---------------------------------------------------------------------------

describe('registerFlowRoutes', () => {
  it('registers all expected routes', async () => {
    const { registerFlowRoutes } = await import('../src/api-routes/flows.js');
    const routes = new Map();
    registerFlowRoutes(routes);

    assert.ok(routes.has('POST /api/flows'));
    assert.ok(routes.has('GET /api/flows'));
    // Dynamic routes use pattern matching — check a few known patterns
    const keys = [...routes.keys()];
    assert.ok(keys.some(k => k.startsWith('GET /api/flows/')), 'should have GET /api/flows/:id pattern');
    assert.ok(keys.some(k => k.includes('/run')), 'should have /run route');
    assert.ok(routes.has('POST /api/signals'));
    assert.ok(routes.has('GET /api/signals'));
  });
});
