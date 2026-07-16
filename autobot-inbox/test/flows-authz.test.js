// flows-authz.test.js — STAQPRO-615 (M2 SECURITY-HARDENING).
//
// Proves the flow-definition WRITE surface is tenant-safe + authorized + atomic:
//   1. createFlowCore stamps owner_org_id from the principal and derives
//      created_by from identity, NEVER from body.created_by.
//   2. POST /api/flows rejects a non-board / non-agent principal with 403 and
//      rejects caller-supplied ownership/identity fields with 400.
//   3. GET /api/flows is org-scoped (org A's flow is invisible to an org B
//      principal) and fail-closed for an unresolved principal.
//   4. DELETE /api/flows/:id is privileged-only, org-scoped (404 outside scope).
//   5. A cyclic-steps flow rolls back atomically — no orphan is_active row.
//
// Unit cases use a query mock (fast, deterministic on call order). The org-scope
// case runs against PGlite (getDb) so migration 152's owner_org_id column and
// visibleClause act on a real schema.

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFlowCore,
  listFlowsCore,
  deleteFlowCore,
  registerFlowRoutes,
} from '../src/api-routes/flows.js';
import { getDb } from './helpers/setup-db.js';

// ── Query mock that returns a scripted result per sequential call ─────────────
function makeQueryMulti(resultSets) {
  let i = 0;
  return mock.fn(async () => {
    const rows = resultSets[i] || [];
    i++;
    return { rows, rowCount: rows.length };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. createFlowCore: owner_org_id + created_by come from the principal, not body
// ─────────────────────────────────────────────────────────────────────────────
describe('createFlowCore owner/identity stamping', () => {
  const body = {
    name: 'f', trigger_signal_type: 'email.received', steps: [{ tool_id: 'echo' }],
    created_by: 'attacker', owner_org_id: 'spoofed-org',
  };

  it('stamps owner_org_id from the writer principal (not body)', async () => {
    // BEGIN, SELECT active, INSERT, COMMIT
    const db = makeQueryMulti([[], [], [{ id: 'flow-1' }], []]);
    const principal = { userId: 'u1', readOrgIds: ['org-a'], roles: {}, adminBypass: false };

    await createFlowCore(db, body, principal);

    const insert = db.mock.calls.find(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO agent_graph.flow_definitions'),
    );
    assert.ok(insert.arguments[0].includes('owner_org_id'), 'INSERT must stamp owner_org_id');
    const params = insert.arguments[1];
    assert.ok(params.includes('org-a'), 'owner_org_id must be the principal org, never the body value');
    assert.ok(!params.includes('spoofed-org'), 'must NOT use body.owner_org_id');
    assert.ok(!params.includes('attacker'), 'must NOT use body.created_by');
    // created_by is the resolved user id.
    assert.ok(params.includes('u1'), 'created_by must be the principal userId');
  });

  it('omits owner_org_id (→ DEFAULT) for a verified agent (adminBypass)', async () => {
    const db = makeQueryMulti([[], [], [{ id: 'flow-1' }], []]);
    await createFlowCore(db, body, { adminBypass: true, readOrgIds: [] });

    const insert = db.mock.calls.find(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('INSERT INTO agent_graph.flow_definitions'),
    );
    assert.ok(!insert.arguments[0].includes('owner_org_id'), 'agent write defers owner_org_id to DEFAULT');
    assert.ok(insert.arguments[1].includes('agent'), 'created_by records agent for an adminBypass writer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. createFlowCore: cyclic flow rolls back atomically (no orphan row)
// ─────────────────────────────────────────────────────────────────────────────
describe('createFlowCore atomic cycle rejection', () => {
  it('ROLLs BACK and never INSERTs when the candidate creates a cycle', async () => {
    // Existing active flow: B -> A. Candidate: A -> B closes the cycle.
    const existing = [
      { id: 'x', trigger_signal_type: 'B', steps: [{ output_signal_type: 'A' }], is_active: true },
    ];
    // BEGIN, SELECT active (existing), then validate throws → ROLLBACK.
    const db = makeQueryMulti([[], existing]);

    const result = await createFlowCore(
      db,
      { name: 'cyc', trigger_signal_type: 'A', steps: [{ output_signal_type: 'B' }] },
      { userId: 'u1', readOrgIds: ['org-a'], adminBypass: false },
    );

    assert.ok(result.error && /cycle/i.test(result.error), 'must report a cycle error');
    const sqls = db.mock.calls.map((c) => c.arguments[0]);
    assert.ok(sqls.includes('BEGIN'), 'opened a transaction');
    assert.ok(sqls.includes('ROLLBACK'), 'rolled the transaction back');
    assert.ok(!sqls.some((s) => typeof s === 'string' && s.includes('INSERT INTO')), 'NO insert — no orphan row');
    assert.ok(!sqls.includes('COMMIT'), 'must not commit a rejected flow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. Route authz: privileged-writer gate + body-override rejection
// ─────────────────────────────────────────────────────────────────────────────
describe('POST/DELETE /api/flows authz gate', () => {
  // Build the routes Map with a withViewer stub that returns the principal we
  // attach to req._principal — lets us drive board / agent / viewer / none.
  function buildRoutes() {
    const routes = new Map();
    registerFlowRoutes(routes, {
      withViewer: async (req) => ({ principal: req._principal ?? null }),
    });
    return routes;
  }

  const POST = (overrides = {}) => ({
    url: 'http://localhost/api/flows',
    method: 'POST',
    headers: {},
    ...overrides,
  });

  it('403 for a plain viewer (no board role, not an agent)', async () => {
    const routes = buildRoutes();
    const handler = routes.get('POST /api/flows');
    const req = POST({
      auth: { role: 'agent', source: 'agent_jwt', github_username: null },
      _principal: { userId: 'u1', readOrgIds: ['org-a'], adminBypass: false }, // not adminBypass
    });
    await assert.rejects(
      () => handler(req, { name: 'f', trigger_signal_type: 't', steps: [] }),
      (e) => e.statusCode === 403,
      'a non-board, non-adminBypass caller must be 403',
    );
  });

  it('403 for a bare api_secret (board role but no human viewer)', async () => {
    const routes = buildRoutes();
    const handler = routes.get('POST /api/flows');
    const req = POST({
      auth: { role: 'board', source: 'api_secret', github_username: null },
      _principal: { userId: null, readOrgIds: [], adminBypass: false },
    });
    await assert.rejects(() => handler(req, { name: 'f', trigger_signal_type: 't', steps: [] }), (e) => e.statusCode === 403);
  });

  it('400 when the body carries owner_org_id / created_by', async () => {
    const routes = buildRoutes();
    const handler = routes.get('POST /api/flows');
    const req = POST({
      auth: { role: 'board', source: 'jwt', github_username: 'ecgang' },
      _principal: { userId: 'u1', readOrgIds: ['org-a'], adminBypass: false },
    });
    for (const bad of [{ owner_org_id: 'x' }, { created_by: 'x' }, { owner_user_id: 'x' }, { owner_scope: 'x' }]) {
      await assert.rejects(
        () => handler(req, { name: 'f', trigger_signal_type: 't', steps: [], ...bad }),
        (e) => e.statusCode === 400,
        `body ${JSON.stringify(bad)} must be rejected 400`,
      );
    }
  });

  it('allows a verified agent (adminBypass) through the gate', () => {
    // The gate must NOT throw for an agent principal; we stop before DB I/O by
    // asserting the gate predicate directly via a body that fails validation
    // AFTER the gate (so reaching createFlowCore proves the gate passed).
    const routes = buildRoutes();
    const handler = routes.get('POST /api/flows');
    const req = POST({
      auth: { role: 'agent', source: 'agent_jwt', github_username: null },
      _principal: { userId: null, readOrgIds: [], adminBypass: true },
    });
    // Missing steps → createFlowCore returns { error } (no throw) — but the gate
    // would have thrown 403 first if it rejected the agent. So no rejection here
    // means the gate allowed the agent.
    return assert.doesNotReject(() => handler(req, { name: 'f', trigger_signal_type: 't' }));
  });

  it('DELETE requires a privileged writer (403 for a plain viewer)', async () => {
    const routes = buildRoutes();
    const handler = routes.get('DELETE /api/flows/:id');
    const req = {
      url: 'http://localhost/api/flows/some-id',
      method: 'DELETE',
      headers: {},
      auth: { role: 'agent', source: 'agent_jwt', github_username: null },
      _principal: { userId: 'u1', readOrgIds: ['org-a'], adminBypass: false },
    };
    await assert.rejects(() => handler(req), (e) => e.statusCode === 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. End-to-end org scoping against a real schema (PGlite + migration 152)
// ─────────────────────────────────────────────────────────────────────────────
describe('flow definitions org scoping (PGlite, migration 152)', () => {
  let query;
  let orgA; // the seeded staqs org (mig 133)
  let orgB; // a second org we create

  before(async () => {
    ({ query } = await getDb());
    orgA = (await query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`)).rows[0].id;
    // A second org to prove cross-org invisibility.
    const r = await query(
      `INSERT INTO tenancy.orgs (slug, name) VALUES ('flows-test-org-b', 'Flows Test Org B')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    orgB = r.rows[0].id;
  });

  it('owner_org_id column exists (migration 152 applied)', async () => {
    const col = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agent_graph' AND table_name = 'flow_definitions'
          AND column_name = 'owner_org_id'`,
    );
    assert.equal(col.rows.length, 1, 'migration 152 must add owner_org_id');
  });

  it('stamps the writer org and hides it from another org principal', async () => {
    const principalA = { userId: null, readOrgIds: [orgA], roles: { [orgA]: 'member' }, adminBypass: false };
    const principalB = { userId: null, readOrgIds: [orgB], roles: { [orgB]: 'member' }, adminBypass: false };

    const created = await createFlowCore(
      query,
      { name: `scoped-flow-${Date.now()}`, trigger_signal_type: 'email.received', steps: [{ tool_id: 'echo' }] },
      principalA,
    );
    assert.ok(created.flow, 'flow created');
    assert.equal(created.flow.owner_org_id, orgA, 'stamped with the writer org');

    const flowId = created.flow.id;

    const seenByA = await listFlowsCore(query, {}, principalA);
    assert.ok(seenByA.flows.some((f) => f.id === flowId), 'org A sees its own flow');

    const seenByB = await listFlowsCore(query, {}, principalB);
    assert.ok(!seenByB.flows.some((f) => f.id === flowId), 'org B must NOT see org A flow');

    // Unresolved principal → fail closed (zero rows).
    const seenByNone = await listFlowsCore(query, {}, null);
    assert.ok(!seenByNone.flows.some((f) => f.id === flowId), 'unresolved principal sees nothing');

    // DELETE is org-scoped: org B cannot delete org A's flow (404).
    const delByB = await deleteFlowCore(query, flowId, principalB);
    assert.equal(delByB.statusCode, 404, 'org B cannot delete org A flow');

    // Org A can soft-delete it.
    const delByA = await deleteFlowCore(query, flowId, principalA);
    assert.equal(delByA.deleted, true, 'org A deletes its own flow');
    assert.equal(delByA.flow.is_active, false, 'soft delete sets is_active=false');
  });
});
