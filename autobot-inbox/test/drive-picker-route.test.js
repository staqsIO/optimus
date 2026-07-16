/**
 * OPT-101 (Feature 006) — Drive folder picker backend.
 *
 * Three surfaces under test, all keyed on the impersonation security model
 * (spec/features/006-drive-folder-picker.md §1): the impersonated workspace email
 * is derived SERVER-SIDE from the authenticated identity and is NEVER read from a
 * request param/header/body.
 *
 *   A. resolveImpersonationEmail (the real api.js helper, via seeded board_members):
 *        - bare api_secret (no github_username) -> 403 (no SA-direct fallback)
 *        - domain email (eric@staqs.io)          -> resolves
 *        - non-domain email (dustin@example.com) -> 400 impersonation_unavailable
 *   B. GET /api/drive/shared-drives + GET /api/drive/folders (injected Drive mock):
 *        - board-human gate (bare secret -> 403)
 *        - server-derived impersonation (no owner_email input exists on the route)
 *        - two-source merge + de-dup (shared-drives); folder list shape
 *        - Google errors map to 4xx/503, never a raw 500
 *   C. POST /api/capture-sources create-path hardening:
 *        - a body/query owner_email is IGNORED/REJECTED (regression — the leak class)
 *        - owner_email is stamped from the resolver (access:'impersonated')
 *        - access:'sa_direct' -> owner_email null
 *        - a caller assigning an org they're NOT in -> 403 (board-admin -> ok)
 *        - duplicate folder -> 409
 *
 * No real Google calls — the Drive client is injected. No real network.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { registerDrivePickerRoutes } = await import('../src/api-routes/drive-picker.js');
const { registerCaptureSourceRoutes } = await import('../src/api-routes/capture-sources.js');

let query;

// ── Auth principals ──────────────────────────────────────────────────────────
// ecgang: seeded board ADMIN, email eric@staqs.io (domain) — migration 007.
const ERIC = { role: 'board', github_username: 'ecgang', source: 'jwt' };
// Dustin: seeded board admin, email dustin@example.com (NON-domain).
const DUSTIN = { role: 'board', github_username: 'ConsultingFuture4200', source: 'jwt' };
// Casey: seeded board MEMBER, email casey@example.com (non-domain).
const CASEY = { role: 'board', github_username: 'cboone', source: 'jwt' };
// Bare api_secret: role:'board' but NO github_username.
const BARE_SECRET = { role: 'board', source: 'api_secret' };

before(async () => {
  ({ query } = await getDb());
});

// ─────────────────────────────────────────────────────────────────────────────
// A. resolveImpersonationEmail — the real derivation logic.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveImpersonationEmail (server-side derivation)', () => {
  let resolveImpersonationEmail;
  before(async () => {
    process.env.WORKSPACE_DELEGATED_DOMAINS = 'staqs.io';
    ({ resolveImpersonationEmail } = await import('../src/api.js'));
  });

  it('a bare api_secret board caller (no github_username) -> 403, never SA-direct', async () => {
    await assert.rejects(
      () => resolveImpersonationEmail({ auth: BARE_SECRET }),
      (err) => { assert.equal(err.statusCode, 403); return true; },
    );
  });

  it('no auth at all -> 403', async () => {
    await assert.rejects(
      () => resolveImpersonationEmail({}),
      (err) => { assert.equal(err.statusCode, 403); return true; },
    );
  });

  it('a domain board member resolves to their workspace email', async () => {
    const email = await resolveImpersonationEmail({ auth: ERIC });
    assert.equal(email, 'eric@staqs.io');
  });

  it('a non-domain board email (personal Gmail) -> 400 impersonation_unavailable', async () => {
    await assert.rejects(
      () => resolveImpersonationEmail({ auth: DUSTIN }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.errorCode, 'impersonation_unavailable');
        return true;
      },
    );
    // A non-domain member is likewise refused (never SA-direct fallback).
    await assert.rejects(
      () => resolveImpersonationEmail({ auth: CASEY }),
      (err) => { assert.equal(err.errorCode, 'impersonation_unavailable'); return true; },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Drive-listing endpoints — injected Drive mock, server-derived impersonation.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/drive/* — board-human gate + server-derived impersonation', () => {
  let routes;
  const calls = []; // record (subject) the client was built for

  // A fake Drive client factory keyed on the impersonated subject. The KEY POINT:
  // the route NEVER receives owner_email from the request — it asks the injected
  // resolver. We record which subject was used to prove derivation, not param-passing.
  function fakeGetDriveClient(userEmail) {
    calls.push(userEmail);
    return {
      drives: {
        list: async () => {
          if (userEmail === 'eric@staqs.io') {
            return { data: { drives: [{ id: 'D1', name: 'Eric Shared' }, { id: 'DSHARED', name: 'Both (impersonated)' }], nextPageToken: 'NEXT' } };
          }
          // SA-direct view
          return { data: { drives: [{ id: 'SA1', name: 'SA Drive' }, { id: 'DSHARED', name: 'Both (sa)' }] } };
        },
      },
      files: {
        list: async (params) => {
          assert.match(params.q, /mimeType='application\/vnd\.google-apps\.folder'/);
          assert.equal(params.supportsAllDrives, true);
          assert.equal(params.includeItemsFromAllDrives, true);
          return { data: { files: [{ id: 'F1', name: 'Folder One' }, { id: 'F2', name: 'Folder Two' }], nextPageToken: null } };
        },
      },
    };
  }

  before(() => {
    routes = new Map();
    registerDrivePickerRoutes(routes, {
      // Real-ish resolver: derives from the seeded auth identity (no request input).
      resolveImpersonationEmail: async (req) => {
        if (!req.auth?.github_username) throw Object.assign(new Error('403'), { statusCode: 403 });
        if (req.auth.github_username === 'ConsultingFuture4200') {
          throw Object.assign(new Error('non-domain'), { statusCode: 400, errorCode: 'impersonation_unavailable' });
        }
        return 'eric@staqs.io';
      },
      getDriveClient: fakeGetDriveClient,
      hasServiceAccount: () => true,
    });
  });

  const sharedDrives = (req) => routes.get('GET /api/drive/shared-drives')(req);
  const folders = (req) => routes.get('GET /api/drive/folders')(req);

  it('shared-drives: a bare api_secret -> 403 (board-human gate)', async () => {
    await assert.rejects(
      () => sharedDrives({ url: '/api/drive/shared-drives', auth: BARE_SECRET }),
      (err) => { assert.equal(err.statusCode, 403); return true; },
    );
  });

  it('shared-drives: two-source merge + de-dup, tagged by access; subject is derived', async () => {
    calls.length = 0;
    const res = await sharedDrives({ url: '/api/drive/shared-drives', auth: ERIC });
    assert.equal(res.ok, true);
    // The impersonated subject came from the resolver, NOT the request.
    assert.ok(calls.includes('eric@staqs.io'), 'impersonated subject was used');
    assert.ok(calls.includes(null), 'SA-direct view (null subject) was also fetched');
    const byId = Object.fromEntries(res.drives.map((d) => [d.id, d]));
    assert.equal(byId.D1.access, 'impersonated');
    assert.equal(byId.SA1.access, 'sa_direct');
    // Collision: impersonated wins the tag.
    assert.equal(byId.DSHARED.access, 'impersonated');
    assert.equal(res.nextPageToken, 'NEXT');
  });

  it('shared-drives: a non-domain caller -> 400 impersonation_unavailable', async () => {
    await assert.rejects(
      () => sharedDrives({ url: '/api/drive/shared-drives', auth: DUSTIN }),
      (err) => { assert.equal(err.errorCode, 'impersonation_unavailable'); return true; },
    );
  });

  it('folders: returns {folders,nextPageToken,parent}; impersonates the derived email', async () => {
    calls.length = 0;
    const res = await folders({ url: '/api/drive/folders?parent=root', auth: ERIC });
    assert.equal(res.ok, true);
    assert.equal(res.parent, 'root');
    assert.deepEqual(res.folders, [{ id: 'F1', name: 'Folder One' }, { id: 'F2', name: 'Folder Two' }]);
    assert.equal(calls[0], 'eric@staqs.io');
  });

  it('folders: rejects an injection-y parent id (Drive-query safety)', async () => {
    await assert.rejects(
      () => folders({ url: "/api/drive/folders?parent=root'%20or%20'1'='1", auth: ERIC }),
      (err) => { assert.equal(err.statusCode, 400); return true; },
    );
  });

  it('folders: a Google unauthorized_client error maps to 400 impersonation_unavailable (never 500)', async () => {
    const r2 = new Map();
    registerDrivePickerRoutes(r2, {
      resolveImpersonationEmail: async () => 'eric@staqs.io',
      getDriveClient: () => ({ files: { list: async () => { throw new Error('unauthorized_client: Client is unauthorized'); } } }),
      hasServiceAccount: () => true,
    });
    await assert.rejects(
      () => r2.get('GET /api/drive/folders')({ url: '/api/drive/folders?parent=root', auth: ERIC }),
      (err) => { assert.equal(err.statusCode, 400); assert.equal(err.errorCode, 'impersonation_unavailable'); return true; },
    );
  });

  it('shared-drives: no service account -> 503 drive_unavailable', async () => {
    const r3 = new Map();
    registerDrivePickerRoutes(r3, {
      resolveImpersonationEmail: async () => 'eric@staqs.io',
      getDriveClient: () => { throw new Error('should not be called'); },
      hasServiceAccount: () => false,
    });
    await assert.rejects(
      () => r3.get('GET /api/drive/shared-drives')({ url: '/api/drive/shared-drives', auth: ERIC }),
      (err) => { assert.equal(err.statusCode, 503); assert.equal(err.errorCode, 'drive_unavailable'); return true; },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. POST /api/capture-sources — create-path hardening (owner_email + membership).
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/capture-sources — owner_email is server-derived + org membership', () => {
  const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e91'; // distinct from the other test file
  const UMB_ORG = '33333333-3333-3333-3333-333333333333';
  let routes;
  let ericMemberId;

  before(async () => {
    // Two real tenancy orgs.
    await query(
      `INSERT INTO tenancy.orgs (id, slug, name) VALUES
         ($1, 'staqs-dp-test', 'Staqs DP Test'),
         ($2, 'umb-dp-test', 'UMB DP Test')
       ON CONFLICT (id) DO NOTHING`,
      [STAQS_ORG, UMB_ORG],
    );
    // ecgang is a seeded board member (migration 007). Resolve its id for memberships.
    const bm = await query(
      `SELECT id FROM agent_graph.board_members WHERE github_username = 'ecgang' LIMIT 1`,
    );
    ericMemberId = bm.rows[0].id;
    // Make ecgang a MEMBER of STAQS_ORG only (NOT UMB_ORG) — but note: migration 007
    // seeds ecgang as role='admin', so assertCallerInOrg's admin-bypass applies.
    // To test the NON-admin membership path we use a freshly-inserted member below.
    await query(
      `INSERT INTO tenancy.memberships (user_id, org_id, role)
       VALUES ($1::uuid, $2::uuid, 'member') ON CONFLICT DO NOTHING`,
      [ericMemberId, STAQS_ORG],
    );

    routes = new Map();
    registerCaptureSourceRoutes(routes, query, {
      withViewer: async (req) => ({ principal: req.__principal }),
      resolveImpersonationEmail: async () => 'eric@staqs.io',
    });
  });

  const P = (userId, orgs) => ({ userId, readOrgIds: orgs, roles: {}, adminBypass: false });
  const create = (body, auth, principal) =>
    routes.get('POST /api/capture-sources')({ url: '/api/capture-sources', headers: {}, auth, __principal: principal }, body);

  it('stamps owner_email from the resolver (access defaults to impersonated)', async () => {
    const res = await create(
      { source_type: 'drive_folder', external_id: 'dp-folder-1', owner_org_id: STAQS_ORG },
      ERIC, P(ericMemberId, [STAQS_ORG]),
    );
    assert.equal(res.ok, true);
    assert.equal(res.source.owner_email, 'eric@staqs.io');
  });

  it('a body-supplied owner_email is REJECTED (regression — the impersonation leak class)', async () => {
    await assert.rejects(
      () => create(
        { source_type: 'drive_folder', external_id: 'dp-folder-evil', owner_org_id: STAQS_ORG, owner_email: 'victim@staqs.io' },
        ERIC, P(ericMemberId, [STAQS_ORG]),
      ),
      (err) => { assert.equal(err.statusCode, 400); assert.match(err.message, /not accepted/); return true; },
    );
    // camelCase variant also rejected.
    await assert.rejects(
      () => create(
        { source_type: 'drive_folder', external_id: 'dp-folder-evil2', owner_org_id: STAQS_ORG, ownerEmail: 'victim@staqs.io' },
        ERIC, P(ericMemberId, [STAQS_ORG]),
      ),
      /not accepted/,
    );
  });

  it("access:'sa_direct' -> owner_email is null (no impersonation at poll time)", async () => {
    const res = await create(
      { source_type: 'drive_folder', external_id: 'dp-folder-sa', owner_org_id: STAQS_ORG, access: 'sa_direct' },
      ERIC, P(ericMemberId, [STAQS_ORG]),
    );
    assert.equal(res.ok, true);
    assert.equal(res.source.owner_email, null);
  });

  it('a duplicate folder -> 409', async () => {
    await create({ source_type: 'drive_folder', external_id: 'dp-folder-dup', owner_org_id: STAQS_ORG, access: 'sa_direct' }, ERIC, P(ericMemberId, [STAQS_ORG]));
    await assert.rejects(
      () => create({ source_type: 'drive_folder', external_id: 'dp-folder-dup', owner_org_id: STAQS_ORG, access: 'sa_direct' }, ERIC, P(ericMemberId, [STAQS_ORG])),
      (err) => { assert.equal(err.statusCode, 409); return true; },
    );
  });

  it('a board-ADMIN may assign any org (ecgang is admin -> UMB ok even though not a member)', async () => {
    // ecgang is seeded role='admin'; assertCallerInOrg admin-bypass lets it pick UMB_ORG.
    const res = await create(
      { source_type: 'drive_folder', external_id: 'dp-folder-umb-admin', owner_org_id: UMB_ORG, access: 'sa_direct' },
      ERIC, P(ericMemberId, [UMB_ORG]),
    );
    assert.equal(res.ok, true);
    assert.equal(res.source.owner_org_id, UMB_ORG);
  });

  it('a NON-admin member assigning an org they are NOT in -> 403', async () => {
    // Insert a fresh non-admin board member with a domain email, member of STAQS only.
    const ins = await query(
      `INSERT INTO agent_graph.board_members (github_username, display_name, email, role, is_active)
       VALUES ('dp-test-member', 'DP Member', 'dpmember@staqs.io', 'member', true)
       ON CONFLICT (github_username) DO UPDATE SET is_active = true
       RETURNING id`,
    );
    const memberId = ins.rows[0].id;
    await query(
      `INSERT INTO tenancy.memberships (user_id, org_id, role)
       VALUES ($1::uuid, $2::uuid, 'member') ON CONFLICT DO NOTHING`,
      [memberId, STAQS_ORG],
    );
    const MEMBER_AUTH = { role: 'board', github_username: 'dp-test-member', source: 'jwt' };

    // Member of STAQS -> assigning STAQS is OK.
    const ok = await create(
      { source_type: 'drive_folder', external_id: 'dp-member-staqs', owner_org_id: STAQS_ORG, access: 'sa_direct' },
      MEMBER_AUTH, P(memberId, [STAQS_ORG]),
    );
    assert.equal(ok.ok, true);

    // NOT a member of UMB -> 403.
    await assert.rejects(
      () => create(
        { source_type: 'drive_folder', external_id: 'dp-member-umb', owner_org_id: UMB_ORG, access: 'sa_direct' },
        MEMBER_AUTH, P(memberId, [UMB_ORG]),
      ),
      (err) => { assert.equal(err.statusCode, 403); assert.match(err.message, /org you belong to/); return true; },
    );
  });
});
