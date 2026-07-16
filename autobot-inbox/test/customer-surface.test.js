/**
 * OPT-37 — external customer principal can USE the org-shared surface.
 *
 * Regression for the gap the customer-token admin tests missed: a customer
 * token (iss optimus-customer) reached org-shared READS but was rejected by
 * KB search ("cannot derive retriever scope") and the ingest/artifact WRITE
 * paths ("authentication required", because a customer has no per-user
 * userId). These tests exercise a customer principal through all three.
 *
 * Customer principal shape after auth:
 *   req.auth = { source:'customer_jwt', sub:<customer_principals.id>, org_id:<org> }
 *   withViewer(req) → { principal: syntheticPrincipal(org_id) } (userId null)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  retrieverScopeFromRequest,
  retrieverScopeWithOrg,
} from '../src/api-routes/document-access.js';

const { registerIngestRoutes } = await import('../src/api-routes/ingest.js');
const { registerArtifactRoutes } = await import('../src/api-routes/artifacts.js');

const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
// A customer_principals.id — deliberately NOT a board_members row (a customer
// can never satisfy the content.documents.owner_id FK).
const CUSTOMER_ID = 'dddddddd-0000-0000-0000-00000000c001';

// Build a request as the dispatch layer would for a verified customer token.
function customerReq(orgId = STAQS_ORG, sub = CUSTOMER_ID, extra = {}) {
  return {
    url: '/x',
    headers: {},
    auth: { source: 'customer_jwt', sub, org_id: orgId, role: 'customer', scope: ['kb:read', 'kb:write', 'artifacts:read', 'artifacts:write'] },
    // withViewer returns this; the customer path ignores principal.userId.
    __principal: { userId: null, readOrgIds: orgId ? [orgId] : [], adminBypass: false },
    ...extra,
  };
}

// ── Search scope derivation (pure) ───────────────────────────────────────────

describe('OPT-37 customer — retriever scope derivation', () => {
  it('derives ownerId = the customer principal id (collapses to org-shared in SQL)', () => {
    const scope = retrieverScopeFromRequest(customerReq(), {});
    assert.deepEqual(scope, { ownerId: CUSTOMER_ID });
  });

  it('attaches readOrgIds = [the customer org] (the hard tenant gate)', async () => {
    const scope = await retrieverScopeWithOrg(customerReq(STAQS_ORG), {});
    assert.equal(scope.ownerId, CUSTOMER_ID);
    assert.deepEqual(scope.readOrgIds, [STAQS_ORG]);
  });

  it('a customer token with no org_id cannot derive a scope (fail-closed)', () => {
    // org_id missing → falls through to the "no auth" throw rather than a default.
    assert.throws(
      () => retrieverScopeFromRequest(customerReq(null), {}),
      /cannot derive retriever scope/
    );
  });
});

// ── Ingest + artifact write paths (PGlite) ───────────────────────────────────

describe('OPT-37 customer — write paths (org-shared ownership)', () => {
  let query;
  let ingestRoutes;
  let artifactRoutes;

  before(async () => {
    ({ query } = await getDb());
    ingestRoutes = new Map();
    registerIngestRoutes(ingestRoutes, query, { withViewer: async (req) => ({ principal: req.__principal }) });
    artifactRoutes = new Map();
    registerArtifactRoutes(artifactRoutes, query, { withViewer: async (req) => ({ principal: req.__principal }) });
    await query(`DELETE FROM content.documents WHERE owner_org_id = $1 AND owner_id IS NULL AND title LIKE 'OPT37-cust%'`, [STAQS_ORG]).catch(() => {});
  });

  it('ingest: customer write is org-shared — owner_id NULL, owner_org_id = its org', async () => {
    const handler = ingestRoutes.get('POST /api/ingest');
    const res = await handler(customerReq(), { raw: 'customer-pushed PRD body', title: 'OPT37-cust doc', source: 'mcp-upload', format: 'markdown' });
    assert.equal(res.ok, true);
    const row = await query(`SELECT owner_org_id, owner_id FROM content.documents WHERE id = $1`, [res.documentId]);
    assert.equal(row.rows[0].owner_org_id, STAQS_ORG);
    assert.equal(row.rows[0].owner_id, null); // org-shared (FK-safe; a customer can't own a content.documents row)
  });

  it('ingest: customer with no org_id is rejected (401, fail-closed)', async () => {
    const handler = ingestRoutes.get('POST /api/ingest');
    await assert.rejects(
      () => handler(customerReq(null), { raw: 'x', title: 'OPT37-cust noorg' }),
      /authentication required/
    );
  });

  it('artifact: customer write is org-shared — owner_id NULL, owner_org_id = its org', async () => {
    const handler = artifactRoutes.get('POST /api/artifacts');
    const res = await handler(customerReq(), { raw: 'customer artifact body', kind: 'prd', title: 'OPT37-cust artifact' });
    assert.ok(res.id || res.artifactId, 'artifact created');
    const id = res.id || res.artifactId;
    const row = await query(`SELECT owner_org_id, owner_id FROM content.artifacts WHERE id = $1`, [id]);
    assert.equal(row.rows[0].owner_org_id, STAQS_ORG);
    assert.equal(row.rows[0].owner_id, null);
  });

  it('artifact: customer with no org_id is rejected (401, before the cap query)', async () => {
    const handler = artifactRoutes.get('POST /api/artifacts');
    await assert.rejects(
      () => handler(customerReq(null), { raw: 'x', kind: 'prd', title: 'OPT37-cust noorg' }),
      /authentication required/
    );
  });
});
