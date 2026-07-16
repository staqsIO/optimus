/**
 * STAQPRO-611 — POST /api/ingest (MCP capture write surface).
 *
 * The handler is a pure function of (req, body) → result. These tests build a
 * routes Map, register the route with a stubbed withViewer, and invoke the
 * handler directly, asserting the security contract the Liotta/Linus/Neo review
 * set BEFORE any code:
 *
 *   - ownership is derived from the token, never the body (body owner params → 400)
 *   - owner_org_id is stamped from the principal (UMB principal → UMB-owned row)
 *   - a no-org principal does NOT get stamped another org (DEFAULT applies, never UMB)
 *   - the dedup key is server-derived (same content → one row, dedup holds)
 *   - a per-user daily cap is enforced fail-closed (429)
 *
 * The live multi-principal HTTP proof is verify-tenancy-live.mjs; this is the
 * deterministic data-layer + handler contract.
 *
 * Cap is set to 3 BEFORE importing the route module (it reads the env at load).
 */

process.env.MCP_INGEST_DAILY_CAP = '3';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { registerIngestRoutes } = await import('../src/api-routes/ingest.js');

const UMB_ORG = '11111111-1111-1111-1111-111111111111';
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const MEMBER_STAQS = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEMBER_CAP = 'cccccccc-0000-0000-0000-000000000003';

let query;
let routes;

function call(body, principal) {
  const handler = routes.get('POST /api/ingest');
  return handler({ url: '/api/ingest', headers: {}, __principal: principal }, body);
}

const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });

before(async () => {
  ({ query } = await getDb());

  // board_members rows satisfy the owner_id FK on content.documents.
  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1,$2,'Staqs Test 611','member'),
            ($3,$4,'UMB Test 611','member'),
            ($5,$6,'Cap Test 611','member')
     ON CONFLICT (id) DO NOTHING`,
    [MEMBER_STAQS, 'staqs-test-611', MEMBER_UMB, 'umb-test-611', MEMBER_CAP, 'cap-test-611']
  );
  await query(`DELETE FROM content.documents WHERE owner_id IN ($1,$2,$3)`,
    [MEMBER_STAQS, MEMBER_UMB, MEMBER_CAP]);

  routes = new Map();
  registerIngestRoutes(routes, query, {
    withViewer: async (req) => ({ principal: req.__principal }),
  });
});

describe('POST /api/ingest — ownership is token-derived, never from the body', () => {
  it('rejects a caller-supplied owner_org_id with 400', async () => {
    await assert.rejects(
      () => call({ raw: 'body', title: 't', owner_org_id: UMB_ORG }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_org_id is not accepted/
    );
  });

  it('rejects caller-supplied owner_scope / owner_id too', async () => {
    await assert.rejects(
      () => call({ raw: 'body', title: 't', owner_scope: 'org' }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_scope is not accepted/
    );
    await assert.rejects(
      () => call({ raw: 'body', title: 't', owner_id: MEMBER_UMB }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_id is not accepted/
    );
  });

  it('stamps owner_org_id + owner_id from the principal (UMB principal → UMB-owned)', async () => {
    const res = await call({ raw: 'UMB advisory note body', title: 'UMB Note' }, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(res.ok, true);
    const row = await query(
      `SELECT owner_org_id, owner_id FROM content.documents WHERE id = $1`, [res.documentId]
    );
    assert.equal(row.rows[0].owner_org_id, UMB_ORG);
    assert.equal(row.rows[0].owner_id, MEMBER_UMB);
  });

  it('a no-org principal is NEVER stamped another org (DEFAULT applies, not UMB)', async () => {
    const res = await call({ raw: 'no org body content', title: 'NoOrg' }, P(MEMBER_STAQS, []));
    assert.equal(res.ok, true);
    const row = await query(`SELECT owner_org_id FROM content.documents WHERE id = $1`, [res.documentId]);
    assert.notEqual(row.rows[0].owner_org_id, UMB_ORG);
  });
});

describe('POST /api/ingest — auth + input validation', () => {
  it('requires an authenticated principal (401)', async () => {
    await assert.rejects(() => call({ raw: 'x', title: 't' }, null), /authentication required/);
  });
  it('requires raw text (400)', async () => {
    await assert.rejects(() => call({ raw: '   ', title: 't' }, P(MEMBER_STAQS, [STAQS_ORG])), /raw text is required/);
  });
  it('rejects an unknown source (400)', async () => {
    await assert.rejects(
      () => call({ raw: 'x', title: 't', source: 'evil' }, P(MEMBER_STAQS, [STAQS_ORG])),
      /source must be one of/
    );
  });
});

describe('POST /api/ingest — server-derived dedup key (no storm)', () => {
  it('same content from the same owner collapses to one row', async () => {
    const a = await call({ raw: 'identical body', title: 'Dup' }, P(MEMBER_UMB, [UMB_ORG]));
    const b = await call({ raw: 'identical body', title: 'Dup' }, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(a.documentId, b.documentId);
    assert.equal(b.deduped, true);
    const cnt = await query(
      `SELECT count(*)::int AS n FROM content.documents WHERE owner_id = $1 AND title = 'Dup'`,
      [MEMBER_UMB]
    );
    assert.equal(cnt.rows[0].n, 1);
  });
});

describe('POST /api/ingest — per-user daily cap (fail-closed)', () => {
  it('rejects past the cap with 429', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call({ raw: `cap body ${i}`, title: `Cap ${i}` }, P(MEMBER_CAP, [STAQS_ORG]));
      assert.equal(r.ok, true);
    }
    await assert.rejects(
      () => call({ raw: 'cap body overflow', title: 'Cap 4' }, P(MEMBER_CAP, [STAQS_ORG])),
      /daily ingest cap/
    );
  });
});
