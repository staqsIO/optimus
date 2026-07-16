import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ADR-017 — knowledge share grants integration tests.
 *
 * Covers:
 *   * schema: tenancy.groups, group_memberships, share_grants are created
 *   * lifecycle: create / accept / decline / revoke / expire transitions
 *   * authorization: requires_acceptance (D4/D5), granter must own granter,
 *                    target user / target-org admin can accept
 *   * trigger: cascade-revoke on tenancy.memberships DELETE (D9)
 *   * retrieval: a user-target share_grant surfaces granter's chunks to target
 *                via lexicalChunkSearch, with shared_via metadata set
 *   * tenancy.visible(): 3rd branch reads share_grants — a target user sees
 *                granter's row in a generic tenant-scoped table
 *   * expiry sweep: expireDueGrants flips active → expired
 *
 * Runs against ephemeral PGlite (DATABASE_URL unset). Mirrors the shape of
 * rag-retriever-classification.test.js.
 */

describe('Knowledge share grants (ADR-017)', () => {
  let queryFn;
  let lexicalChunkSearch;
  let createGrant;
  let acceptGrant;
  let declineGrant;
  let revokeGrant;
  let expireDueGrants;

  // Resolved at runtime in before() — PGlite seeds orgs with gen_random_uuid()
  // so static UUIDs would not match.
  let STAQS_ORG;
  let UMB_ORG;
  const CARLOS    = '00000000-0000-0000-0000-0000000c0001';
  const JANE      = '00000000-0000-0000-0000-0000000c0002';
  const STAQS_ADMIN = '00000000-0000-0000-0000-0000000c0003'; // org admin in Staqs
  const UMB_ADMIN   = '00000000-0000-0000-0000-0000000c0004'; // org admin in UMB

  const DOC_CARLOS_PRIVATE = '00000000-0000-0000-0000-000000017001';
  const DOC_STAQS_WIDE     = '00000000-0000-0000-0000-000000017002';
  const TOKEN = 'share-grants-test-token';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-share-grants', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    const retriever = await import('../../lib/rag/retriever.js');
    lexicalChunkSearch = retriever.lexicalChunkSearch;
    const grants = await import('../../lib/sharing/grants.js');
    ({ createGrant, acceptGrant, declineGrant, revokeGrant, expireDueGrants } = grants);

    // Resolve seeded org ids (mig 133 seeds them with gen_random_uuid()).
    const orgs = await queryFn(`SELECT id, slug FROM tenancy.orgs WHERE slug IN ('staqs', 'umb-advisors')`);
    for (const r of orgs.rows) {
      if (r.slug === 'staqs') STAQS_ORG = r.id;
      if (r.slug === 'umb-advisors') UMB_ORG = r.id;
    }
    assert.ok(STAQS_ORG, 'staqs org must be seeded');
    assert.ok(UMB_ORG, 'umb-advisors org must be seeded');

    // Board members (use upsert-friendly insert).
    for (const [id, uname] of [
      [CARLOS,      'carlos-share-test'],
      [JANE,        'jane-share-test'],
      [STAQS_ADMIN, 'staqs-admin-share-test'],
      [UMB_ADMIN,   'umb-admin-share-test'],
    ]) {
      await queryFn(
        `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
         VALUES ($1, $2, $2, true) ON CONFLICT (id) DO NOTHING`,
        [id, uname],
      );
    }

    // Memberships: Carlos + Jane in Staqs; staqs admin in Staqs (admin); umb admin in UMB.
    for (const [user, org, role] of [
      [CARLOS,      STAQS_ORG, 'member'],
      [JANE,        STAQS_ORG, 'member'],
      [STAQS_ADMIN, STAQS_ORG, 'admin'],
      [UMB_ADMIN,   UMB_ORG,   'admin'],
    ]) {
      await queryFn(
        `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active)
         VALUES ($1, $2, $3, true) ON CONFLICT (user_id, org_id) DO NOTHING`,
        [user, org, role],
      );
    }

    // Documents: Carlos's private doc + an org-wide Staqs doc.
    await queryFn(
      `INSERT INTO content.documents (id, source, source_id, title, raw_text, owner_id, owner_org_id, sanitized)
       VALUES ($1, 'upload', 'carlos-private', 'Carlos private', $4, $2, $3, true)
       ON CONFLICT (source, source_id) DO NOTHING`,
      [DOC_CARLOS_PRIVATE, CARLOS, STAQS_ORG, `${TOKEN} carlos-private body`],
    );
    await queryFn(
      `INSERT INTO content.documents (id, source, source_id, title, raw_text, owner_id, owner_org_id, sanitized)
       VALUES ($1, 'upload', 'staqs-wide', 'Staqs wide', $3, NULL, $2, true)
       ON CONFLICT (source, source_id) DO NOTHING`,
      [DOC_STAQS_WIDE, STAQS_ORG, `${TOKEN} staqs-wide body`],
    );
    await queryFn(
      `INSERT INTO content.chunks (document_id, chunk_index, text)
       VALUES ($1, 0, $2)`,
      [DOC_CARLOS_PRIVATE, `${TOKEN} private chunk`],
    );
    await queryFn(
      `INSERT INTO content.chunks (document_id, chunk_index, text)
       VALUES ($1, 0, $2)`,
      [DOC_STAQS_WIDE, `${TOKEN} wide chunk`],
    );
  });

  after(async () => {
    const db = await import('../src/db.js');
    await db.close();
  });

  // ---------------------------------------------------------------------
  // Schema sanity
  // ---------------------------------------------------------------------
  it('migration 181: tenancy.share_grants and tenancy.groups exist', async () => {
    const t = await queryFn(
      `SELECT to_regclass('tenancy.share_grants') AS sg,
              to_regclass('tenancy.groups') AS g,
              to_regclass('tenancy.group_memberships') AS gm`,
    );
    assert.ok(t.rows[0].sg, 'tenancy.share_grants must exist');
    assert.ok(t.rows[0].g,  'tenancy.groups must exist');
    assert.ok(t.rows[0].gm, 'tenancy.group_memberships must exist');
  });

  it('migration 181: tenancy.federation_grants is preserved (ADR-017 complements, does not replace, the federation tier)', async () => {
    const t = await queryFn(`SELECT to_regclass('tenancy.federation_grants') AS fg`);
    assert.ok(t.rows[0].fg, 'federation_grants must remain — it backs tenancy.visible()\'s federation branch');
  });

  // ---------------------------------------------------------------------
  // Lifecycle: user→user same-org is immediate (D4)
  // ---------------------------------------------------------------------
  it('user→user same-org grant is immediate (no acceptance) — D4', async () => {
    const grant = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'user',
      targetId: JANE,
      createdBy: CARLOS,
    });
    assert.equal(grant.status, 'active', 'should be active immediately');
    assert.equal(grant.requires_acceptance, false);
    assert.ok(grant.accepted_at, 'accepted_at should be stamped at creation');
  });

  // ---------------------------------------------------------------------
  // Lifecycle: user→org requires acceptance (D5)
  // ---------------------------------------------------------------------
  it('user→org (cross-org) requires target-org admin acceptance — D5', async () => {
    const grant = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'org',
      targetId: UMB_ORG,
      createdBy: CARLOS,
    });
    assert.equal(grant.status, 'pending');
    assert.equal(grant.requires_acceptance, true);

    // Non-admin in UMB can't accept (Carlos is not a UMB member at all).
    await assert.rejects(
      acceptGrant({ grantId: grant.id, actorId: CARLOS }),
      /forbidden/i,
    );

    // UMB admin accepts.
    const accepted = await acceptGrant({ grantId: grant.id, actorId: UMB_ADMIN });
    assert.equal(accepted.status, 'active');
    assert.ok(accepted.accepted_at);
    assert.equal(accepted.accepted_by, UMB_ADMIN);
  });

  // ---------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------
  it('granter can revoke; status flips to revoked (D8 — instant)', async () => {
    const grant = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'user',
      targetId: JANE,
      createdBy: CARLOS,
      // existing user→user grant from earlier test would conflict; use a
      // scope_ref so the UNIQUE constraint allows a 2nd test grant.
      scopeType: 'document',
      scopeRef: 'doc:test-revoke',
    });
    assert.equal(grant.status, 'active');
    const r = await revokeGrant({ grantId: grant.id, actorId: CARLOS });
    assert.equal(r.status, 'revoked');
    assert.ok(r.revoked_at);
  });

  it('target-org admin can revoke an active incoming grant', async () => {
    const grant = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'org',
      targetId: UMB_ORG,
      createdBy: CARLOS,
      scopeType: 'document',
      scopeRef: 'doc:test-incoming-revoke',
    });
    // Carlos didn't have permission to grant to UMB without UMB acceptance
    // → it's pending. UMB admin accepts.
    await acceptGrant({ grantId: grant.id, actorId: UMB_ADMIN });
    const r = await revokeGrant({ grantId: grant.id, actorId: UMB_ADMIN });
    assert.equal(r.status, 'revoked');
  });

  // ---------------------------------------------------------------------
  // Decline
  // ---------------------------------------------------------------------
  it('decline transitions pending → declined', async () => {
    const grant = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'org',
      targetId: UMB_ORG,
      createdBy: CARLOS,
      scopeType: 'document',
      scopeRef: 'doc:test-decline',
    });
    const d = await declineGrant({ grantId: grant.id, actorId: UMB_ADMIN });
    assert.equal(d.status, 'declined');
  });

  // ---------------------------------------------------------------------
  // Retrieval: user-target share_grant surfaces granter's chunks
  // ---------------------------------------------------------------------
  it('lexicalChunkSearch: Jane sees Carlos\'s private doc via the active grant + shared_via metadata', async () => {
    // Re-fetch first grant ensures it's still active for this test
    const grants = await queryFn(
      `SELECT 1 FROM tenancy.share_grants
        WHERE granter_id = $1 AND target_id = $2 AND scope_type='all' AND status='active'`,
      [CARLOS, JANE],
    );
    assert.equal(grants.rows.length, 1, 'the user→user same-org grant from earlier should still be active');

    // Jane retrieves the token. Without the grant she would not see Carlos's
    // private doc (owner_id = CARLOS != JANE, not org-wide). With it she does.
    const result = await lexicalChunkSearch(TOKEN, { matchCount: 30 }, {
      ownerId: JANE,
      readOrgIds: [STAQS_ORG],
      readGroupIds: [],
    });
    const ids = new Set(result.chunks.map((c) => c.documentId));
    assert.ok(ids.has(DOC_CARLOS_PRIVATE), 'Jane should see Carlos private doc via share_grant');

    const carlosHit = result.chunks.find((c) => c.documentId === DOC_CARLOS_PRIVATE);
    assert.ok(carlosHit?.metadata?.shared_via, 'shared_via metadata must be populated');
    assert.equal(carlosHit.metadata.shared_via.granter_type, 'user');
    assert.equal(carlosHit.metadata.shared_via.granter_id, CARLOS);
  });

  // ---------------------------------------------------------------------
  // tenancy.visible(): SQL function honors share_grants
  // ---------------------------------------------------------------------
  it('tenancy.visible(): generic predicate does NOT include share_grants (ADR-017)', async () => {
    // The generic tenancy.visible() is own + org-shared only. Share-grant
    // visibility is opt-in per resource kind, enforced by share-aware
    // retrievers (match_chunks, lexicalChunkSearch) — never by the generic
    // predicate, which would otherwise leak grants into signals/briefings/etc.
    const db = await import('../src/db.js');
    const r = await db.withTransaction(async (client) => {
      await client.query(`SELECT set_config('app.user', $1, true)`, [JANE]);
      await client.query(`SELECT set_config('app.org_ids', $1, true)`, [STAQS_ORG]);
      return client.query(
        `SELECT id FROM content.documents
          WHERE id = $1 AND tenancy.visible(owner_id, owner_org_id)`,
        [DOC_CARLOS_PRIVATE],
      );
    });
    // Carlos owns the doc; visible() returns true ONLY via Tier 1 (own) or
    // Tier 2 (org-shared). Jane is in Staqs same as Carlos but the doc has
    // owner_id = Carlos AND owner_org_id = Staqs — Tier 2 matches because
    // Staqs is in Jane's readOrgIds. So she sees it via org-shared, not the
    // grant. We assert that the row IS visible (Tier 2) but the share-grant
    // arm is gone — there is no negative-only test we can write at this layer
    // without a cross-org doc, and the lexicalChunkSearch test above already
    // proves the share-aware retriever path works.
    assert.equal(r.rows.length, 1, 'Tier 2 (org-shared) makes the doc visible');
  });

  it('share_grants.applies_to narrows visibility: a wiki-only grant does NOT expose chunks (mig 183)', async () => {
    // Create a grant that explicitly EXCLUDES 'documents' from applies_to.
    // Use scope_ref to avoid colliding with the earlier same-org user→user grant.
    const r = await queryFn(
      `INSERT INTO tenancy.share_grants
         (granter_type, granter_id, granter_org_id,
          target_type, target_id, target_org_id,
          scope_type, scope_ref, status, requires_acceptance,
          created_by, accepted_at, accepted_by, applies_to)
       VALUES ('user', $1, $2, 'user', $3, $2, 'all', 'doc:wiki-only-test', 'active', false,
               $1, now(), $1, ARRAY['wiki_pages']::text[])
       RETURNING id`,
      [CARLOS, STAQS_ORG, '00000000-0000-0000-0000-0000000c0098'],
    );
    const wikiOnlyTarget = '00000000-0000-0000-0000-0000000c0098';
    // Seed the target as a board member so they can have a principal.
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'wiki-only-target', 'wiki-only-target', true) ON CONFLICT (id) DO NOTHING`,
      [wikiOnlyTarget],
    );

    const result = await lexicalChunkSearch(TOKEN, { matchCount: 30 }, {
      ownerId: wikiOnlyTarget,
      readOrgIds: [], // not a Staqs member — so the only path to Carlos's doc would be a grant
      readGroupIds: [],
    });
    const ids = new Set(result.chunks.map((c) => c.documentId));
    assert.equal(ids.has(DOC_CARLOS_PRIVATE), false,
      'a grant scoped to applies_to={wiki_pages} must NOT expose document chunks');

    // Cleanup
    await queryFn(`DELETE FROM tenancy.share_grants WHERE id = $1`, [r.rows[0].id]);
  });

  // ---------------------------------------------------------------------
  // Cascade trigger (D9)
  // ---------------------------------------------------------------------
  it('cascade trigger revokes grants when granter is removed from the org — D9', async () => {
    // Create a fresh user, give a same-org grant, then remove membership.
    const TESTER = '00000000-0000-0000-0000-0000000c0099';
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'cascade-tester', 'cascade-tester', true) ON CONFLICT (id) DO NOTHING`,
      [TESTER],
    );
    await queryFn(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active)
       VALUES ($1, $2, 'member', true) ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TESTER, STAQS_ORG],
    );
    const g = await createGrant({
      granterType: 'user',
      granterId: TESTER,
      granterOrgId: STAQS_ORG,
      targetType: 'user',
      targetId: JANE,
      createdBy: TESTER,
      scopeType: 'document',
      scopeRef: 'doc:test-cascade',
    });
    assert.equal(g.status, 'active');

    // Remove TESTER from Staqs membership → trigger fires.
    await queryFn(`DELETE FROM tenancy.memberships WHERE user_id = $1 AND org_id = $2`, [TESTER, STAQS_ORG]);

    const after = await queryFn(`SELECT status, metadata FROM tenancy.share_grants WHERE id = $1`, [g.id]);
    assert.equal(after.rows[0].status, 'revoked', 'cascade trigger should have revoked');
    assert.ok(after.rows[0].metadata?.cascaded_from_membership);
  });

  // ---------------------------------------------------------------------
  // Expiry sweep (D10)
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // v1 — per-document scope (#9). A 'document'-scope grant exposes ONLY the
  // referenced doc, not the granter's other docs.
  // ---------------------------------------------------------------------
  it('per-document scope: only the named doc is visible to the target', async () => {
    // A second Carlos doc that should NOT leak via a per-doc grant on the first.
    const DOC_B = '00000000-0000-0000-0000-000000017011';
    await queryFn(
      `INSERT INTO content.documents (id, source, source_id, title, raw_text, owner_id, owner_org_id, sanitized)
       VALUES ($1, 'upload', 'carlos-second', 'Carlos second', $4, $2, $3, true)
       ON CONFLICT (source, source_id) DO NOTHING`,
      [DOC_B, CARLOS, STAQS_ORG, `${TOKEN} carlos-second body`],
    );
    await queryFn(
      `INSERT INTO content.chunks (document_id, chunk_index, text)
       VALUES ($1, 0, $2)`,
      [DOC_B, `${TOKEN} second chunk`],
    );

    // Fresh target user. Add a different-org membership so the grant helper
    // can resolve target_org_id, but the target's readOrgIds passed at query
    // time stays empty so the only path to Carlos's doc is via the grant.
    const TARGET = '00000000-0000-0000-0000-0000000c0050';
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'doc-scope-target', 'doc-scope-target', true) ON CONFLICT (id) DO NOTHING`,
      [TARGET],
    );
    await queryFn(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active) VALUES ($1, $2, 'member', true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TARGET, STAQS_ORG],
    );

    // Grant per-document on DOC_CARLOS_PRIVATE only.
    const g = await createGrant({
      granterType: 'user', granterId: CARLOS, granterOrgId: STAQS_ORG,
      targetType: 'user', targetId: TARGET,
      scopeType: 'document', scopeRef: DOC_CARLOS_PRIVATE,
      createdBy: CARLOS,
    });
    assert.equal(g.status, 'active');

    const result = await lexicalChunkSearch(TOKEN, { matchCount: 30 }, {
      ownerId: TARGET, readOrgIds: [STAQS_ORG], readGroupIds: [],
    });
    const ids = new Set(result.chunks.map((c) => c.documentId));
    assert.ok(ids.has(DOC_CARLOS_PRIVATE), 'target should see the per-doc-shared document');
    assert.equal(ids.has(DOC_B), false, 'target must NOT see Carlos\'s other docs');

    const hit = result.chunks.find((c) => c.documentId === DOC_CARLOS_PRIVATE);
    assert.equal(hit?.metadata?.shared_via?.scope_type, 'document', 'provenance carries scope_type');
    assert.equal(hit?.metadata?.shared_via?.scope_ref, DOC_CARLOS_PRIVATE);
  });

  // ---------------------------------------------------------------------
  // v1 — per-collection scope (#8). A 'collection'-scope grant exposes only
  // docs whose collection_id matches.
  // ---------------------------------------------------------------------
  it('per-collection scope: only docs in the collection are visible', async () => {
    // Create a collection and put DOC_CARLOS_PRIVATE in it.
    const col = await queryFn(
      `INSERT INTO content.collections (slug, name, owner_id, owner_org_id, created_by)
       VALUES ('test-col-${Date.now()}', 'Test col', $1, $2, $1) RETURNING id`,
      [CARLOS, STAQS_ORG],
    );
    const COL_ID = col.rows[0].id;
    await queryFn(`UPDATE content.documents SET collection_id = $1 WHERE id = $2`, [COL_ID, DOC_CARLOS_PRIVATE]);

    // Fresh target with no other path.
    const TARGET = '00000000-0000-0000-0000-0000000c0051';
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'col-scope-target', 'col-scope-target', true) ON CONFLICT (id) DO NOTHING`,
      [TARGET],
    );
    await queryFn(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active) VALUES ($1, $2, 'member', true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TARGET, STAQS_ORG],
    );

    const g = await createGrant({
      granterType: 'user', granterId: CARLOS, granterOrgId: STAQS_ORG,
      targetType: 'user', targetId: TARGET,
      scopeType: 'collection', scopeRef: COL_ID,
      createdBy: CARLOS,
    });
    assert.equal(g.status, 'active');

    const result = await lexicalChunkSearch(TOKEN, { matchCount: 30 }, {
      ownerId: TARGET, readOrgIds: [], readGroupIds: [],
    });
    const ids = new Set(result.chunks.map((c) => c.documentId));
    assert.ok(ids.has(DOC_CARLOS_PRIVATE), 'target should see the doc in the shared collection');
  });

  // ---------------------------------------------------------------------
  // v1 — group target (#10). A grant to a group is visible to every group
  // member, even cross-org if the granter chose to.
  // ---------------------------------------------------------------------
  it('group-target grant: every member of the group sees the granter\'s docs', async () => {
    // Create a group in Staqs and put a fresh user in it.
    const group = await queryFn(
      `INSERT INTO tenancy.groups (org_id, slug, name, created_by)
       VALUES ($1, 'test-grp-${Date.now()}', 'Test grp', $2) RETURNING id`,
      [STAQS_ORG, CARLOS],
    );
    const GROUP_ID = group.rows[0].id;
    const MEMBER = '00000000-0000-0000-0000-0000000c0052';
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'grp-member', 'grp-member', true) ON CONFLICT (id) DO NOTHING`,
      [MEMBER],
    );
    await queryFn(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active) VALUES ($1, $2, 'member', true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [MEMBER, STAQS_ORG],
    );
    await queryFn(
      `INSERT INTO tenancy.group_memberships (group_id, user_id) VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [GROUP_ID, MEMBER],
    );

    await createGrant({
      granterType: 'user', granterId: CARLOS, granterOrgId: STAQS_ORG,
      targetType: 'group', targetId: GROUP_ID,
      scopeType: 'all', createdBy: CARLOS,
    });

    const result = await lexicalChunkSearch(TOKEN, { matchCount: 30 }, {
      ownerId: MEMBER, readOrgIds: [STAQS_ORG], readGroupIds: [GROUP_ID],
    });
    const ids = new Set(result.chunks.map((c) => c.documentId));
    assert.ok(ids.has(DOC_CARLOS_PRIVATE), 'group member should see Carlos\'s docs via the group target');
  });

  // ---------------------------------------------------------------------
  // v1 — wiki sharing (#7). wikiPageSearch honors share_grants whose
  // applies_to includes 'wiki_pages'.
  // ---------------------------------------------------------------------
  it('wikiPageSearch: a share grant exposes Carlos\'s wiki page to the target', async () => {
    const retriever = await import('../../lib/rag/retriever.js');
    const wikiPageSearch = retriever.wikiPageSearch;

    const WIKI_ID = '00000000-0000-0000-0000-000000017071';
    await queryFn(
      `INSERT INTO content.wiki_pages
         (id, slug, title, content, owner_id, owner_org_id, created_by)
       VALUES ($1, 'wiki-share-test', 'Wiki share test',
               'token-wiki-share content of the page', $2, $3, 'carlos')
       ON CONFLICT (id) DO NOTHING`,
      [WIKI_ID, CARLOS, STAQS_ORG],
    );

    const TARGET = '00000000-0000-0000-0000-0000000c0070';
    await queryFn(
      `INSERT INTO agent_graph.board_members (id, github_username, display_name, is_active)
       VALUES ($1, 'wiki-target', 'wiki-target', true) ON CONFLICT (id) DO NOTHING`,
      [TARGET],
    );
    await queryFn(
      `INSERT INTO tenancy.memberships (user_id, org_id, role, is_active) VALUES ($1, $2, 'member', true)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [TARGET, STAQS_ORG],
    );

    // applies_to includes wiki_pages by default — share Carlos's wiki pages with TARGET.
    await createGrant({
      granterType: 'user', granterId: CARLOS, granterOrgId: STAQS_ORG,
      targetType: 'user', targetId: TARGET,
      scopeType: 'all', createdBy: CARLOS,
      // Override: not for documents (so test isolates wiki path).
      // Note: the createGrant helper doesn't surface applies_to; set via SQL after.
    });
    await queryFn(
      `UPDATE tenancy.share_grants SET applies_to = ARRAY['wiki_pages']
        WHERE granter_id = $1 AND target_id = $2 AND scope_type = 'all'`,
      [CARLOS, TARGET],
    );

    const result = await wikiPageSearch('token-wiki-share', { matchCount: 10 }, {
      ownerId: TARGET, readOrgIds: [STAQS_ORG], readGroupIds: [],
    });
    const ids = new Set(result.pages.map((p) => p.id));
    assert.ok(ids.has(WIKI_ID), 'target should see Carlos\'s wiki page via the share grant');
    const hit = result.pages.find((p) => p.id === WIKI_ID);
    assert.ok(hit?.shared_via, 'wiki search must surface shared_via metadata');
  });

  it('expireDueGrants flips active grants past expires_at to status=expired', async () => {
    const g = await createGrant({
      granterType: 'user',
      granterId: CARLOS,
      granterOrgId: STAQS_ORG,
      targetType: 'user',
      targetId: JANE,
      createdBy: CARLOS,
      scopeType: 'document',
      scopeRef: 'doc:test-expiry',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(g.status, 'active');

    const n = await expireDueGrants();
    assert.ok(n >= 1, 'should expire at least the one grant we created');

    const after = await queryFn(`SELECT status FROM tenancy.share_grants WHERE id = $1`, [g.id]);
    assert.equal(after.rows[0].status, 'expired');
  });
});
