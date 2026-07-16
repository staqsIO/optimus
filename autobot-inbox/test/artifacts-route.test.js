/**
 * OPT-92 — /api/artifacts (the artifact registry).
 *
 * The handlers are pure functions of (req, body) → result. These tests build a
 * routes Map, register the routes with a stubbed withViewer, and invoke the
 * handlers directly, asserting the security + lineage contract:
 *
 *   - ownership is derived from the token, never the body (body owner params → 400)
 *   - a create writes artifact + version + document + enrichment_queue row, all
 *     stamped with the principal's owner_org_id
 *   - an identical re-push is an idempotent no-op (no new version, no new queue row)
 *   - changed bytes mint version_no + 1 and flip current_version_id
 *   - reads are fail-closed for a non-owning principal (list = 0 rows, get = 404)
 *
 * The live multi-principal HTTP proof is verify-tenancy-live.mjs; this is the
 * deterministic data-layer + handler contract (mirrors ingest-route.test.js).
 *
 * Cap is set BEFORE importing the route module (it reads the env at load).
 */

process.env.MCP_ARTIFACT_DAILY_CAP = '500';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { registerArtifactRoutes } = await import('../src/api-routes/artifacts.js');
const { createArtifact } = await import('../../lib/content/create-artifact.js');

const UMB_ORG = '11111111-1111-1111-1111-111111111111';
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const MEMBER_STAQS = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-0000000000b2';

let query;
let routes;

function post(body, principal) {
  const handler = routes.get('POST /api/artifacts');
  return handler({ url: '/api/artifacts', headers: {}, __principal: principal }, body);
}
function list(qs, principal) {
  const handler = routes.get('GET /api/artifacts');
  return handler({ url: `/api/artifacts${qs || ''}`, headers: {}, __principal: principal });
}
function getOne(id, principal) {
  const handler = routes.get('GET /api/artifacts/:id');
  return handler({ url: `/api/artifacts/${id}`, headers: {}, __principal: principal });
}

const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });

before(async () => {
  ({ query } = await getDb());

  // board_members rows satisfy the owner_id FK on content.documents.
  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1,$2,'Staqs Test 92','member'),
            ($3,$4,'UMB Test 92','member')
     ON CONFLICT (id) DO NOTHING`,
    [MEMBER_STAQS, 'staqs-test-92', MEMBER_UMB, 'umb-test-92']
  );

  routes = new Map();
  registerArtifactRoutes(routes, query, {
    withViewer: async (req) => ({ principal: req.__principal }),
  });
});

describe('POST /api/artifacts — ownership is token-derived, never from the body', () => {
  it('rejects a caller-supplied owner_org_id with 400', async () => {
    await assert.rejects(
      () => post({ raw: 'b', kind: 'doc', title: 't', owner_org_id: UMB_ORG }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_org_id is not accepted/
    );
  });
  it('rejects caller-supplied owner_scope / owner_id too', async () => {
    await assert.rejects(
      () => post({ raw: 'b', kind: 'doc', title: 't', owner_scope: 'org' }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_scope is not accepted/
    );
    await assert.rejects(
      () => post({ raw: 'b', kind: 'doc', title: 't', owner_id: MEMBER_UMB }, P(MEMBER_STAQS, [STAQS_ORG])),
      /owner_id is not accepted/
    );
  });
  it('requires an authenticated principal (401)', async () => {
    await assert.rejects(() => post({ raw: 'x', kind: 'doc', title: 't' }, null), /authentication required/);
  });
  it('rejects an unknown kind (400)', async () => {
    await assert.rejects(
      () => post({ raw: 'x', kind: 'evil', title: 't' }, P(MEMBER_STAQS, [STAQS_ORG])),
      /kind must be one of/
    );
  });
  it('a no-org principal cannot write (400 — no Staqs grandfather on this table)', async () => {
    await assert.rejects(
      () => post({ raw: 'x', kind: 'doc', title: 'NoOrg' }, P(MEMBER_STAQS, [])),
      /no org membership/
    );
  });
});

describe('POST /api/artifacts — create writes artifact + version + doc + queue', () => {
  it('a create stamps owner_org_id everywhere and enqueues enrichment', async () => {
    const res = await post(
      { raw: 'UMB PRD body v1', kind: 'prd', title: 'OPT-92 Create PRD' },
      P(MEMBER_UMB, [UMB_ORG])
    );
    assert.equal(res.ok, true);
    assert.equal(res.deduped, false);
    assert.equal(res.versionNo, 1);
    assert.equal(res.enrichment, 'pending');
    assert.equal(res.owner_org_id, UMB_ORG);

    const art = await query(
      `SELECT owner_org_id, owner_id, current_version_id, kind FROM content.artifacts WHERE id = $1`,
      [res.artifactId]
    );
    assert.equal(art.rows[0].owner_org_id, UMB_ORG);
    assert.equal(art.rows[0].owner_id, MEMBER_UMB);
    assert.equal(art.rows[0].kind, 'prd');
    assert.equal(art.rows[0].current_version_id, res.versionId);

    const ver = await query(
      `SELECT owner_org_id, document_id, version_no FROM content.artifact_versions WHERE id = $1`,
      [res.versionId]
    );
    assert.equal(ver.rows[0].owner_org_id, UMB_ORG);
    assert.equal(ver.rows[0].document_id, res.documentId);
    assert.equal(ver.rows[0].version_no, 1);

    const doc = await query(`SELECT owner_org_id FROM content.documents WHERE id = $1`, [res.documentId]);
    assert.equal(doc.rows[0].owner_org_id, UMB_ORG);

    const q = await query(
      `SELECT owner_org_id, status FROM content.enrichment_queue WHERE artifact_id = $1`,
      [res.artifactId]
    );
    assert.equal(q.rows.length, 1);
    assert.equal(q.rows[0].owner_org_id, UMB_ORG);
    assert.equal(q.rows[0].status, 'pending');
  });
});

describe('POST /api/artifacts — idempotency + versioning', () => {
  it('an identical re-push is a no-op (no new version, no new queue row)', async () => {
    const a = await post({ raw: 'idem body', kind: 'spec', title: 'OPT-92 Idem' }, P(MEMBER_UMB, [UMB_ORG]));
    const b = await post({ raw: 'idem body', kind: 'spec', title: 'OPT-92 Idem' }, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(a.artifactId, b.artifactId);
    assert.equal(b.deduped, true);
    assert.equal(b.enrichment, 'skipped');
    assert.equal(a.versionId, b.versionId);

    const vers = await query(
      `SELECT count(*)::int AS n FROM content.artifact_versions WHERE artifact_id = $1`,
      [a.artifactId]
    );
    assert.equal(vers.rows[0].n, 1);
    const queue = await query(
      `SELECT count(*)::int AS n FROM content.enrichment_queue WHERE artifact_id = $1`,
      [a.artifactId]
    );
    assert.equal(queue.rows[0].n, 1);
  });

  it('changed bytes mint version_no + 1 and flip current_version_id', async () => {
    const v1 = await post({ raw: 'versioned body A', kind: 'brief', title: 'OPT-92 Versioned' }, P(MEMBER_UMB, [UMB_ORG]));
    const v2 = await post({ raw: 'versioned body B (changed)', kind: 'brief', title: 'OPT-92 Versioned' }, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(v1.artifactId, v2.artifactId);
    assert.equal(v2.deduped, false);
    assert.equal(v2.versionNo, v1.versionNo + 1);
    assert.equal(v2.enrichment, 'pending');

    const art = await query(`SELECT current_version_id FROM content.artifacts WHERE id = $1`, [v1.artifactId]);
    assert.equal(art.rows[0].current_version_id, v2.versionId);

    const sup = await query(`SELECT supersedes_id FROM content.artifact_versions WHERE id = $1`, [v2.versionId]);
    assert.equal(sup.rows[0].supersedes_id, v1.versionId);

    const queue = await query(
      `SELECT count(*)::int AS n FROM content.enrichment_queue WHERE artifact_id = $1`,
      [v1.artifactId]
    );
    assert.equal(queue.rows[0].n, 2); // both new versions enqueued
  });
});

describe('GET /api/artifacts — reads are fail-closed across the org boundary', () => {
  it('a UMB artifact is visible to UMB and NOT to a no-org principal', async () => {
    const created = await post(
      { raw: 'fail-closed read body', kind: 'note'.replace('note', 'doc'), title: 'OPT-92 ReadGate' },
      P(MEMBER_UMB, [UMB_ORG])
    );
    // owning principal sees it
    const umbList = await list('', P(MEMBER_UMB, [UMB_ORG]));
    assert.ok(umbList.artifacts.some((a) => a.id === created.artifactId));
    // no-org principal (empty readOrgIds) → visibleClause FALSE → zero rows
    const noneList = await list('', P(MEMBER_STAQS, []));
    assert.equal(noneList.artifacts.some((a) => a.id === created.artifactId), false);
  });

  it('GET /api/artifacts/:id 404s for a principal that cannot see it', async () => {
    const created = await post(
      { raw: 'detail gate body', kind: 'doc', title: 'OPT-92 DetailGate' },
      P(MEMBER_UMB, [UMB_ORG])
    );
    const ok = await getOne(created.artifactId, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(ok.artifact.id, created.artifactId);
    assert.ok(ok.versions.length >= 1);
    await assert.rejects(() => getOne(created.artifactId, P(MEMBER_STAQS, [])), /not found/);
  });
});

// OPT-97 — createArtifact core: content-only content_hash + owner|title identity
// (door-independent artifact collapse) + trusted-owner contract.
describe('createArtifact core (OPT-97) — cross-door artifact collapse', () => {
  it('same owner/title/bytes under DIFFERENT source_system collapse to ONE artifact with ONE version', async () => {
    // identity_key = sha256(owner | title) — source_system dropped. So the SAME doc
    // captured via DIFFERENT doors (generate vs Drive) is ONE artifact; and because
    // the bytes are identical, content_hash collapses too → ONE version (the 2nd
    // call dedups). source_system is pure row metadata.
    const raw = 'OPT-97 same bytes both doors';
    const title = 'OPT-97 CrossDoorSameBytes';
    const a = await createArtifact({ raw, kind: 'proposal', title, source_system: 'optimus', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB });
    const b = await createArtifact({ raw, kind: 'proposal', title, source_system: 'drive', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB });

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.artifactId, b.artifactId);   // ONE artifact (owner|title identity)
    assert.equal(b.deduped, true);              // identical bytes → version no-op
    assert.equal(a.versionId, b.versionId);
    const n = await query(`SELECT count(*)::int AS n FROM content.artifact_versions WHERE artifact_id = $1`, [a.artifactId]);
    assert.equal(n.rows[0].n, 1);               // ONE version
  });

  it('same owner/title, DIFFERENT bytes under DIFFERENT source_system → ONE artifact, TWO versions (cross-door lineage)', async () => {
    // The same proposal, generated by Optimus then captured (edited) from Drive,
    // is ONE artifact whose versions track each door. version_no 1 → 2, current flips.
    const title = 'OPT-97 CrossDoorLineage';
    const v1 = await createArtifact({ raw: 'cross-door body A (optimus-generated)', kind: 'proposal', title, source_system: 'optimus', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB });
    const v2 = await createArtifact({ raw: 'cross-door body B (drive-captured, edited)', kind: 'proposal', title, source_system: 'drive', ownerOrgId: UMB_ORG, ownerId: MEMBER_UMB });

    assert.equal(v1.artifactId, v2.artifactId);   // ONE artifact across both doors
    assert.equal(v2.deduped, false);
    assert.equal(v1.versionNo, 1);
    assert.equal(v2.versionNo, 2);                // TWO versions
    assert.equal(v2.enrichment, 'pending');

    const art = await query(`SELECT current_version_id FROM content.artifacts WHERE id = $1`, [v1.artifactId]);
    assert.equal(art.rows[0].current_version_id, v2.versionId);   // current flips to v2
    const sup = await query(`SELECT supersedes_id FROM content.artifact_versions WHERE id = $1`, [v2.versionId]);
    assert.equal(sup.rows[0].supersedes_id, v1.versionId);        // lineage chained
    const n = await query(`SELECT count(*)::int AS n FROM content.artifact_versions WHERE artifact_id = $1`, [v1.artifactId]);
    assert.equal(n.rows[0].n, 2);
  });

  it('createArtifact with a null ownerOrgId throws (no silent Staqs default)', async () => {
    await assert.rejects(
      () => createArtifact({ raw: 'x', kind: 'doc', title: 't', source_system: 'optimus', ownerOrgId: null, ownerId: MEMBER_UMB }),
      /ownerOrgId is required/
    );
    await assert.rejects(
      () => createArtifact({ raw: 'x', kind: 'doc', title: 't', source_system: 'optimus', ownerId: MEMBER_UMB }),
      /ownerOrgId is required/
    );
  });
});
