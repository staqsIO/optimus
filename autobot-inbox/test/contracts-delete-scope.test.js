/**
 * #562 (Codex P2 regression) — DELETE /api/contracts/:id must not 500 an agent JWT.
 *
 * DELETE /api/contracts/:id is an `org-shared` route (route-tiers.js), so agent
 * JWTs legitimately reach the handler. STAQPRO-303 PR-B (#555) wrapped the
 * delete txn in a scope helper to set the tenancy RLS GUCs; the first cut used
 * withBoardScope, which THROWS for any non-board principal (agent req.auth.role
 * is a tier string, never 'board') → an opaque 500 on a valid agent delete.
 *
 * This suite pins the fixed contract at the HANDLER level (mocked db, PGlite
 * lane — no Postgres needed), complementing contracts-delete-rls.test.js which
 * proves the RLS policy itself under real autobot_agent:
 *   [S1] agent JWT       → no throw; scope opened with role 'agent'
 *   [S2] board JWT       → scope opened with role 'board', lowercased sub,
 *                          principal readOrgIds passed through as app.org_ids
 *   [S3] adminBypass mapping → empty readOrgIds maps to CURRENT_ORG_READ_SCOPE
 *   [S4] hyphenated tier → role normalized to 'agent' (setAgentContext's
 *                          ^[a-z]+$ role regex would otherwise reject it)
 *
 * Run: cd autobot-inbox && node --experimental-test-module-mocks \
 *        --test --test-force-exit --test-timeout=20000 \
 *        test/contracts-delete-scope.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_ORG_READ_SCOPE } from '../../lib/tenancy/scope.js';

const DRAFT_ID = '22222222-2222-2222-2222-222222222222';

// ---- Module-level mocks (must precede importing the route module) ----
// contracts.js imports { query, withAgentScope, withBoardScope } from '../db.js';
// the mock must provide EVERY named import or the module fails to load with a
// missing-export SyntaxError (0 tests registered). The DELETE handler under test
// uses withAgentScope; withBoardScope is imported for other (board-scoped)
// handlers (OPT-166 P3-B3) and only needs to exist as an export here.
const mockQuery = mock.fn(async (sql) => {
  if (/FROM content\.drafts WHERE id/.test(sql)) {
    return { rows: [{ id: DRAFT_ID, title: 'Service Agreement', content_type: 'contract' }] };
  }
  // No active/completed signature request blocking the delete.
  return { rows: [] };
});

// Records the (sub, opts) each call so the tests can assert the branching.
const scopeCalls = [];
const mockWithAgentScope = mock.fn(async (sub, opts) => {
  scopeCalls.push({ sub, opts });
  const scoped = mock.fn(async () => ({ rows: [], rowCount: 0 }));
  scoped.release = mock.fn(async () => {});
  return scoped;
});

const mockWithBoardScope = mock.fn(async () => {
  const scoped = mock.fn(async () => ({ rows: [], rowCount: 0 }));
  scoped.release = mock.fn(async () => {});
  return scoped;
});

mock.module('../src/db.js', {
  namedExports: {
    query: mockQuery,
    withAgentScope: mockWithAgentScope,
    withBoardScope: mockWithBoardScope,
  },
});

// retrieverScopeWithOrg is imported at module top from ./document-access.js.
mock.module('../src/api-routes/document-access.js', {
  namedExports: { retrieverScopeWithOrg: mock.fn() },
});

const { registerContractRoutes } = await import('../src/api-routes/contracts.js');

// withViewer is injected by api.js; resolvePrincipalFor(req) = (await
// withViewer(req)).principal. Build routes with a withViewer that returns a
// caller-specified principal so each test drives the org/adminBypass branch.
function buildHandler(principal) {
  const routes = new Map();
  registerContractRoutes(routes, { withViewer: async () => ({ principal }) });
  return routes.get('DELETE /api/contracts/:id');
}

function deleteReq(auth) {
  return { url: `/api/contracts/${DRAFT_ID}`, headers: {}, auth };
}

describe('#562 DELETE /api/contracts/:id — scope wrapper accepts agents (no 500)', () => {
  beforeEach(() => {
    scopeCalls.length = 0;
    mockWithAgentScope.mock.resetCalls();
    mockQuery.mock.resetCalls();
  });

  it('[S1] agent JWT does not throw and opens the scope with role "agent"', async () => {
    const handler = buildHandler({ userId: null, readOrgIds: [], adminBypass: true });
    const res = await handler(
      deleteReq({ sub: 'executor-coder', role: 'orchestrator', source: 'agent_jwt' })
    );
    assert.equal(res.ok, true, 'agent JWT delete must succeed, not 500');
    assert.equal(res.deleted.id, DRAFT_ID);
    assert.equal(scopeCalls.length, 1, 'the delete txn opens exactly one scope');
    assert.equal(scopeCalls[0].opts.role, 'agent',
      'a non-board principal must scope as role "agent", never "board"');
  });

  it('[S2] board JWT scopes as "board" with lowercased sub and its readOrgIds', async () => {
    const ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
    const USER = '11111111-1111-1111-1111-111111111111';
    const handler = buildHandler({ userId: USER, readOrgIds: [ORG], adminBypass: false });
    await handler(deleteReq({ sub: 'Eric-GH', role: 'board', source: 'jwt' }));
    assert.equal(scopeCalls[0].sub, 'eric-gh',
      'board github-username sub must be lowercased to satisfy the agentId regex');
    assert.equal(scopeCalls[0].opts.role, 'board');
    assert.equal(scopeCalls[0].opts.user, USER);
    assert.deepEqual(scopeCalls[0].opts.orgIds, [ORG],
      'a resolved membership principal passes its readOrgIds through unchanged');
  });

  it('[S3] adminBypass principal (empty readOrgIds) maps to CURRENT_ORG_READ_SCOPE', async () => {
    const handler = buildHandler({ userId: null, readOrgIds: [], adminBypass: true });
    await handler(deleteReq({ sub: 'executor-coder', role: 'agent', source: 'agent_jwt' }));
    assert.deepEqual(scopeCalls[0].opts.orgIds, CURRENT_ORG_READ_SCOPE,
      'empty readOrgIds under adminBypass must map to the current-org scope so ' +
      'app.org_ids is populated and the drafts RLS policy matches (else silent no-op)');
  });

  it('[S4] a hyphenated/qualified agent tier is normalized to "agent"', async () => {
    const handler = buildHandler({ userId: null, readOrgIds: [], adminBypass: true });
    // A tier like 'external-nemoclaw' would trip setAgentContext's ^[a-z]+$
    // role regex if passed raw; the handler must normalize any non-board to 'agent'.
    await handler(deleteReq({ sub: 'nemoclaw-ecgang', role: 'external-nemoclaw', source: 'agent_jwt' }));
    assert.equal(scopeCalls[0].opts.role, 'agent');
  });
});
