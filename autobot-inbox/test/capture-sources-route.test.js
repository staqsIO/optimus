/**
 * OPT-96 (Feature 005) — /api/capture-sources (the board-managed per-org capture
 * source registry).
 *
 * The handlers are pure functions of (req, body) -> result. These tests build a
 * routes Map, register the routes with a stubbed withViewer, and invoke the handlers
 * directly, asserting the board surface contract (mirrors the 619-A linear-teams
 * pattern + the artifacts-route tenancy contract):
 *
 *   - create + enable with a known org works (owner-stamped)
 *   - a duplicate (source_type, external_id) -> 409 (GLOBAL unique)
 *   - enable-without-org -> 400 (the watcher would skip it)
 *   - a bad allowlist shape -> 400
 *   - PATCH by a non-owner (org-scoped UPDATE) -> 404 fail-closed
 *   - reads are org-scoped fail-closed (a no-org principal sees zero rows)
 *   - a plain viewer / bare-secret write -> 403 (board-human gate)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { registerCaptureSourceRoutes } = await import('../src/api-routes/capture-sources.js');

const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const UMB_ORG = '22222222-2222-2222-2222-222222222222';
const UNKNOWN_ORG = '99999999-9999-9999-9999-999999999999';
const MEMBER_STAQS = 'aaaaaaaa-0000-0000-0000-0000000000c3';
const MEMBER_UMB = 'bbbbbbbb-0000-0000-0000-0000000000d4';

let query;
let routes;

// Board human (passes requireBoardHuman).
const BOARD = { role: 'board', github_username: 'ecgang' };
// Bare api_secret: role:'board' but NO github_username (rejected).
const BARE_SECRET = { role: 'board' };
// Plain viewer / agent (rejected by the board-human write gate).
const VIEWER = { role: 'viewer', github_username: undefined };

// Read principals (for visibleClause scoping on GET / PATCH WHERE).
const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });

function call(key, { url, auth, principal }, body) {
  const handler = routes.get(key);
  return handler({ url, headers: {}, auth, __principal: principal }, body);
}
const create = (body, auth, principal) =>
  call('POST /api/capture-sources', { url: '/api/capture-sources', auth, principal }, body);
const list = (auth, principal) =>
  call('GET /api/capture-sources', { url: '/api/capture-sources', auth, principal });
const patch = (id, body, auth, principal) =>
  call('PATCH /api/capture-sources/:id', { url: `/api/capture-sources/${id}`, auth, principal }, body);

before(async () => {
  ({ query } = await getDb());

  // Seed the two orgs in the tenancy boundary table (assertKnownOrg validates here).
  await query(
    `INSERT INTO tenancy.orgs (id, slug, name) VALUES
       ($1, 'staqs-cs-test', 'Staqs CS Test'),
       ($2, 'umb-cs-test', 'UMB CS Test')
     ON CONFLICT (id) DO NOTHING`,
    [STAQS_ORG, UMB_ORG],
  );

  routes = new Map();
  registerCaptureSourceRoutes(routes, query, {
    withViewer: async (req) => ({ principal: req.__principal }),
    // OPT-101: stub the server-side impersonation-email resolver. The existing
    // tests create with BOARD (ecgang = a seeded board ADMIN, migration 007), so
    // assertCallerInOrg's admin-bypass applies and the resolver returns a domain
    // email — creates default to access:'impersonated' and stamp owner_email.
    resolveImpersonationEmail: async () => 'eric@staqs.io',
  });
});

describe('POST /api/capture-sources — create + board-human gate', () => {
  it('a board human creates a source with a known org (owner-stamped)', async () => {
    const res = await create(
      { source_type: 'drive_folder', external_id: 'folder-umb-1', label: 'UMB PRDs', owner_org_id: UMB_ORG, default_kind: 'prd' },
      BOARD, P(MEMBER_UMB, [UMB_ORG]),
    );
    assert.equal(res.ok, true);
    assert.equal(res.source.owner_org_id, UMB_ORG);
    assert.equal(res.source.source_type, 'drive_folder');
    assert.equal(res.source.external_id, 'folder-umb-1');
    assert.equal(res.source.default_kind, 'prd');
    assert.equal(res.source.enabled, false); // default off
  });

  it('a plain viewer cannot create (403)', async () => {
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-x', owner_org_id: UMB_ORG }, VIEWER, P(MEMBER_UMB, [UMB_ORG])),
      /board member/,
    );
  });

  it('a bare api_secret (no github_username) cannot create (403)', async () => {
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-y', owner_org_id: UMB_ORG }, BARE_SECRET, P(MEMBER_UMB, [UMB_ORG])),
      /board member/,
    );
  });

  it('an unknown org -> 400', async () => {
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-z', owner_org_id: UNKNOWN_ORG }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /not a known tenancy org/,
    );
  });

  it('a duplicate (source_type, external_id) -> 409', async () => {
    await create(
      { source_type: 'drive_folder', external_id: 'folder-dup', owner_org_id: UMB_ORG },
      BOARD, P(MEMBER_UMB, [UMB_ORG]),
    );
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-dup', owner_org_id: STAQS_ORG }, BOARD, P(MEMBER_STAQS, [STAQS_ORG])),
      (err) => { assert.equal(err.statusCode, 409); return true; },
    );
  });

  it('a bad allowlist shape -> 400', async () => {
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-bad-1', owner_org_id: UMB_ORG, allowlist: { mime: 'not-an-array' } }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /allowlist.mime must be an array/,
    );
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-bad-2', owner_org_id: UMB_ORG, allowlist: { max_bytes: 'big' } }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /allowlist.max_bytes must be a positive number/,
    );
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'folder-bad-3', owner_org_id: UMB_ORG, allowlist: [1, 2, 3] }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /allowlist must be an object/,
    );
  });
});

describe('PATCH /api/capture-sources/:id — enable, guards, tenancy', () => {
  let umbSourceId;
  before(async () => {
    const r = await create(
      { source_type: 'gmail_label', external_id: 'label-umb-patch', owner_org_id: UMB_ORG },
      BOARD, P(MEMBER_UMB, [UMB_ORG]),
    );
    umbSourceId = r.source.id;
  });

  it('enable a source that already has an org works', async () => {
    const res = await patch(umbSourceId, { enabled: true }, BOARD, P(MEMBER_UMB, [UMB_ORG]));
    assert.equal(res.ok, true);
    assert.equal(res.source.enabled, true);
    assert.equal(res.source.owner_org_id, UMB_ORG);
  });

  it('create without an org -> 400 (the table-level enable-without-org protection)', async () => {
    // owner_org_id is NOT NULL with no DEFAULT on content.capture_sources and is
    // REQUIRED on create, so a source can never reach an enabled-without-org state
    // through the normal API (the PATCH enable-with-org guard remains as
    // defense-in-depth, mirroring the nullable linear_sync_teams pattern). The
    // reachable "enable without org" failure is the missing org at create time.
    await assert.rejects(
      () => create({ source_type: 'slack_channel', external_id: 'chan-noorg' }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /owner_org_id must be a UUID string/,
    );
  });

  it('a bad allowlist on PATCH -> 400', async () => {
    await assert.rejects(
      () => patch(umbSourceId, { allowlist: { ext: [42] } }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /allowlist.ext must be an array of strings/,
    );
  });

  it('a non-editable field (source_type) -> 400', async () => {
    await assert.rejects(
      () => patch(umbSourceId, { source_type: 'gmail_label' }, BOARD, P(MEMBER_UMB, [UMB_ORG])),
      /Field not editable/,
    );
  });

  it('PATCH by a non-owner principal -> 404 (org-scoped UPDATE fail-closed)', async () => {
    // A Staqs principal cannot see/mutate the UMB-owned source.
    await assert.rejects(
      () => patch(umbSourceId, { label: 'hijack' }, BOARD, P(MEMBER_STAQS, [STAQS_ORG])),
      /not found/,
    );
  });

  it('a plain viewer cannot PATCH (403)', async () => {
    await assert.rejects(
      () => patch(umbSourceId, { label: 'x' }, VIEWER, P(MEMBER_UMB, [UMB_ORG])),
      /board member/,
    );
  });
});

describe('GET /api/capture-sources — reads are org-scoped fail-closed', () => {
  it('a UMB source is visible to UMB and NOT to a no-org principal', async () => {
    const created = await create(
      { source_type: 'drive_folder', external_id: 'folder-readgate', owner_org_id: UMB_ORG },
      BOARD, P(MEMBER_UMB, [UMB_ORG]),
    );
    const umb = await list(BOARD, P(MEMBER_UMB, [UMB_ORG]));
    assert.ok(umb.sources.some((s) => s.id === created.source.id));
    // no-org principal (empty readOrgIds) -> visibleClause FALSE -> zero rows
    const none = await list(BOARD, P(MEMBER_STAQS, []));
    assert.equal(none.sources.some((s) => s.id === created.source.id), false);
  });
});

// STAQPRO-623: PATCH re-attribution must be membership-gated, exactly like create.
// A non-admin board member who can SEE a source (visibleClause) must not be able to
// move it to an org they don't belong to. Board-admins (e.g. ecgang) bypass, so this
// suite seeds a dedicated NON-admin board member that belongs to STAQS only.
describe('PATCH /api/capture-sources/:id — owner_org_id re-attribution is membership-gated (STAQPRO-623)', () => {
  // A board human (passes requireBoardHuman) whose board_members.role is NOT admin.
  const MEMBER_AUTH = { role: 'board', github_username: 'staqpro623-member' };
  let memberId;     // board_members.id of the non-admin member
  let staqsSourceId; // a source owned by STAQS (visible to the member)

  before(async () => {
    // Non-admin board member, member of STAQS only.
    const bm = await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, role, is_active)
       VALUES ('staqpro623-member', 'STAQPRO-623 Member', 'member', true)
       ON CONFLICT (github_username) DO UPDATE SET role = 'member', is_active = true
       RETURNING id`,
    );
    memberId = bm.rows[0].id;
    await query(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active)
       VALUES ($1::uuid, $2::uuid, 'member', true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [memberId, STAQS_ORG],
    );
    // Source owned by STAQS (created by admin BOARD so create-side gating is not under test).
    const r = await create(
      { source_type: 'gmail_label', external_id: 'label-staqs-623', owner_org_id: STAQS_ORG },
      BOARD, P(MEMBER_STAQS, [STAQS_ORG]),
    );
    staqsSourceId = r.source.id;
  });

  it('a non-admin member cannot re-attribute a visible source to an org they are not in (403)', async () => {
    await assert.rejects(
      () => patch(staqsSourceId, { owner_org_id: UMB_ORG }, MEMBER_AUTH, P(memberId, [STAQS_ORG])),
      (err) => { assert.equal(err.statusCode, 403); assert.match(String(err.message), /belong to/); return true; },
    );
    // The row is unchanged — still STAQS.
    const after = await list(BOARD, P(MEMBER_STAQS, [STAQS_ORG]));
    const row = after.sources.find((s) => s.id === staqsSourceId);
    assert.equal(row.owner_org_id, STAQS_ORG);
  });

  it('the membership gate only fires on owner_org_id — the member can still edit other fields', async () => {
    const res = await patch(staqsSourceId, { label: 'renamed by member' }, MEMBER_AUTH, P(memberId, [STAQS_ORG]));
    assert.equal(res.ok, true);
    assert.equal(res.source.label, 'renamed by member');
    assert.equal(res.source.owner_org_id, STAQS_ORG);
  });

  it('a board admin may still re-attribute to any org (admin bypass preserved)', async () => {
    const res = await patch(staqsSourceId, { owner_org_id: UMB_ORG }, BOARD, P(MEMBER_STAQS, [STAQS_ORG]));
    assert.equal(res.ok, true);
    assert.equal(res.source.owner_org_id, UMB_ORG);
  });
});
