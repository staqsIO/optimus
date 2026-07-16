/**
 * OPT-94 — /api/artifacts/links/* (link-management surface).
 *
 * Backs the board review UI: the org-wide pending queue, the confirm/reject
 * mutation, and the auto-link precision SLO. The handlers are pure functions of
 * (req, body) → result; these tests register the artifact routes with a stubbed
 * withViewer, seed content.artifact_entity_links for two orgs, and assert the
 * security contract VERBATIM against the OPT-92/93 tenancy invariants:
 *
 *   - the pending list is org-scoped: a UMB link never appears for a Staqs viewer
 *   - PATCH confirm flips link_status + stamps resolved_by / resolved_at
 *   - PATCH by a non-owning principal → 404 (the visibleClause is in the WHERE,
 *     so it matches zero rows and is indistinguishable from "does not exist")
 *   - PATCH by a plain viewer / bare api_secret → 403 (privileged-writer gate)
 *   - an invalid link_status → 400
 *   - stats: counts by status + precision = confirmed / (confirmed + rejected)
 *
 * Cap is set BEFORE importing the route module (it reads the env at load).
 */

process.env.MCP_ARTIFACT_DAILY_CAP = '500';

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';

const { registerArtifactRoutes } = await import('../src/api-routes/artifacts.js');

const UMB_ORG = '11111111-1111-1111-1111-111111111111';
const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const MEMBER_STAQS = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-0000000000b2';

let query;
let routes;

// A board human (board JWT WITH github_username) — passes the privileged gate.
const boardAuth = { role: 'board', github_username: 'opt94-tester' };
// A bare api_secret resolves to role:'board' but carries NO github_username.
const bareSecretAuth = { role: 'board' };
// A plain viewer carries neither role:'board' nor github_username.
const viewerAuth = { role: 'viewer', github_username: 'someone' };

const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });

function pendingList(qs, principal) {
  const h = routes.get('GET /api/artifacts/links/pending');
  return h({ url: `/api/artifacts/links/pending${qs || ''}`, headers: {}, __principal: principal });
}
function stats(principal) {
  const h = routes.get('GET /api/artifacts/links/stats');
  return h({ url: '/api/artifacts/links/stats', headers: {}, __principal: principal });
}
function patchLink(id, body, principal, auth) {
  const h = routes.get('PATCH /api/artifacts/links/:id');
  return h({ url: `/api/artifacts/links/${id}`, headers: {}, auth, __principal: principal }, body);
}

// Seed one artifact + one entity link for a given org, returning the link id.
async function seedLink({ org, owner, entityType = 'contact', entityId, status = 'pending', confidence = 0.7 }) {
  const artId = randomUUID();
  await query(
    `INSERT INTO content.artifacts (id, kind, title, identity_key, owner_org_id, owner_id, created_by)
     VALUES ($1, 'doc', $2, $3, $4, $5, $5)`,
    [artId, `OPT-94 art ${artId.slice(0, 8)}`, `idk-${artId}`, org, owner]
  );
  const linkId = randomUUID();
  await query(
    `INSERT INTO content.artifact_entity_links
       (id, artifact_id, entity_type, entity_id, confidence, link_status, owner_org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [linkId, artId, entityType, entityId || randomUUID(), confidence, status, org]
  );
  return { linkId, artId };
}

before(async () => {
  ({ query } = await getDb());

  await query(
    `INSERT INTO agent_graph.board_members (id, github_username, display_name, role)
     VALUES ($1,$2,'Staqs Test 94','member'),
            ($3,$4,'UMB Test 94','member')
     ON CONFLICT (id) DO NOTHING`,
    [MEMBER_STAQS, 'staqs-test-94', MEMBER_UMB, 'umb-test-94']
  );

  routes = new Map();
  registerArtifactRoutes(routes, query, {
    withViewer: async (req) => ({ principal: req.__principal }),
  });
});

beforeEach(async () => {
  // Isolate each test's counts/queue — clear the link table between tests.
  await query(`DELETE FROM content.artifact_entity_links`);
});

describe('GET /api/artifacts/links/pending — org-scoped review queue', () => {
  it('a UMB pending link never appears for a Staqs viewer', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });

    const umb = await pendingList('', P(MEMBER_UMB, [UMB_ORG]));
    assert.ok(umb.links.some((l) => l.id === linkId), 'UMB owner sees its own pending link');

    const staqs = await pendingList('', P(MEMBER_STAQS, [STAQS_ORG]));
    assert.equal(staqs.links.some((l) => l.id === linkId), false, 'Staqs viewer must NOT see the UMB link');

    const noOrg = await pendingList('', P(MEMBER_STAQS, []));
    assert.equal(noOrg.links.length, 0, 'a no-org principal sees zero rows (fail-closed)');
  });

  it('only pending links are returned, with a resolved entity label', async () => {
    const contactId = randomUUID();
    await query(
      `INSERT INTO signal.contacts (id, email_address, name) VALUES ($1, $2, $3)`,
      [contactId, `c-${contactId}@umb.test`, 'Casey Contact']
    );
    const { linkId } = await seedLink({
      org: UMB_ORG, owner: MEMBER_UMB, entityType: 'contact', entityId: contactId, status: 'pending',
    });
    // an 'auto' link must NOT appear in the pending queue
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'auto' });

    const res = await pendingList('', P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(res.links.length, 1, 'only the pending link is listed');
    const row = res.links.find((l) => l.id === linkId);
    assert.ok(row, 'the pending link is present');
    assert.match(row.entity_label, /Casey Contact <c-.*@umb\.test>/, 'contact label is name <email>');
    assert.ok(row.artifact_title, 'the artifact title is joined');
    assert.equal(row.kind, 'doc');
  });

  it('?entity_type filters, and an unknown entity_type is 400', async () => {
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, entityType: 'contact', status: 'pending' });
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, entityType: 'project', status: 'pending' });

    const onlyProjects = await pendingList('?entity_type=project', P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(onlyProjects.links.length, 1);
    assert.equal(onlyProjects.links[0].entity_type, 'project');

    await assert.rejects(
      () => pendingList('?entity_type=evil', P(MEMBER_UMB, [UMB_ORG])),
      /unknown entity_type/
    );
  });
});

describe('PATCH /api/artifacts/links/:id — privileged + org-scoped mutation', () => {
  it('a board human confirms a pending link: status flips, resolved_by/at stamped', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    const res = await patchLink(linkId, { link_status: 'confirmed' }, P(MEMBER_UMB, [UMB_ORG]), boardAuth);
    assert.equal(res.ok, true);
    assert.equal(res.link.link_status, 'confirmed');
    assert.equal(res.link.resolved_by, MEMBER_UMB);
    assert.ok(res.link.resolved_at, 'resolved_at is stamped');
  });

  it('rejecting an auto link is allowed (flags a false auto-link for the SLO)', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'auto' });
    const res = await patchLink(linkId, { link_status: 'rejected' }, P(MEMBER_UMB, [UMB_ORG]), boardAuth);
    assert.equal(res.link.link_status, 'rejected');
  });

  it('a non-owning principal gets 404 (fail-closed — never another org\'s link)', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'confirmed' }, P(MEMBER_STAQS, [STAQS_ORG]), boardAuth),
      /link not found/
    );
    // the link is untouched
    const row = await query(`SELECT link_status FROM content.artifact_entity_links WHERE id = $1`, [linkId]);
    assert.equal(row.rows[0].link_status, 'pending');
  });

  it('a plain viewer is rejected with 403 (board-human gate)', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'confirmed' }, P(MEMBER_UMB, [UMB_ORG]), viewerAuth),
      /requires a board member/
    );
  });

  it('a bare api_secret (role board, no github_username) is rejected with 403', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'confirmed' }, P(MEMBER_UMB, [UMB_ORG]), bareSecretAuth),
      /requires a board member/
    );
  });

  it('a verified agent is NOT allowed to confirm — human-only review queue (Linus)', async () => {
    // The pending queue exists for HUMAN adjudication (D3); an agent grading its
    // own queue is circular and would corrupt the precision SLO. adminBypass agent
    // (no board JWT) → 403, even though it could otherwise write org-wide.
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    const agentPrincipal = { userId: null, readOrgIds: [UMB_ORG], roles: {}, adminBypass: true };
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'confirmed' }, agentPrincipal, { role: 'agent' }),
      /requires a board member/
    );
  });

  it('an invalid link_status is rejected with 400 (gate runs first, before body validation)', async () => {
    const { linkId } = await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'pending' }, P(MEMBER_UMB, [UMB_ORG]), boardAuth),
      /link_status must be one of/
    );
    await assert.rejects(
      () => patchLink(linkId, { link_status: 'garbage' }, P(MEMBER_UMB, [UMB_ORG]), boardAuth),
      /link_status must be one of/
    );
  });
});

describe('GET /api/artifacts/links/stats — auto-link precision SLO', () => {
  it('counts by status and computes precision = confirmed / (confirmed + rejected)', async () => {
    // 3 auto, 2 pending, 3 confirmed, 1 rejected → precision = 3 / (3+1) = 0.75
    for (let i = 0; i < 3; i++) await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'auto' });
    for (let i = 0; i < 2; i++) await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'pending' });
    for (let i = 0; i < 3; i++) await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'confirmed' });
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'rejected' });
    // a Staqs link must NOT pollute the UMB counts
    await seedLink({ org: STAQS_ORG, owner: MEMBER_STAQS, status: 'confirmed' });

    const res = await stats(P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(res.ok, true);
    assert.deepEqual(res.counts, { auto: 3, pending: 2, confirmed: 3, rejected: 1 });
    assert.equal(res.reviewed, 4);
    assert.equal(res.precision, 0.75);
  });

  it('precision is null when nothing has been reviewed', async () => {
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'auto' });
    const res = await stats(P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(res.reviewed, 0);
    assert.equal(res.precision, null);
  });

  it('a no-org principal sees all-zero counts (fail-closed)', async () => {
    await seedLink({ org: UMB_ORG, owner: MEMBER_UMB, status: 'confirmed' });
    const res = await stats(P(MEMBER_STAQS, []));
    assert.deepEqual(res.counts, { auto: 0, pending: 0, confirmed: 0, rejected: 0 });
    assert.equal(res.precision, null);
  });
});
