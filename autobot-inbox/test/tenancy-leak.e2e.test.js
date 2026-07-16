// tenancy-leak.e2e.test.js — ADR-012 exit gate (STAQPRO-588 DoD).
//
// THE definition of "leak closed": resolve Dustin's real principal and prove he
// reads ZERO Staqs-owned rows on every board surface, with a two-sided control
// (he DOES see his own consulting-futures row), plus SQL<->JS predicate parity.
//
// ORG-ONLY scoping: these tables have no per-user owner column, so visibleClause
// is org-only and the SQL twin is tenancy.visible(NULL::uuid, owner_org_id).
//
// Runs against a REAL Postgres (DATABASE_URL). Skips on PGlite/unset — the
// month-long false-green was unit mocks against bypassed RLS; this gate refuses
// to run there. Seeds one consulting-futures contact and deletes it in finally.
//
// Run:  DATABASE_URL=... node --test test/tenancy-leak.e2e.test.js
// (NOTE: migration 134 must be applied first — owner_org_id must exist.)

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { resolvePrincipal, visibleClause } from '../../lib/tenancy/scope.js';

const URL = process.env.DATABASE_URL;
const SKIP = !URL || /pglite/i.test(URL);

function countVisible(client, rel, principal, cols) {
  const v = visibleClause(principal, cols);
  return client
    .query(`SELECT count(*)::int n FROM ${rel} WHERE ${v.sql}`, v.params)
    .then((r) => r.rows[0].n);
}

test('ADR-012 exit gate: Dustin reads zero Staqs rows; Eric reads them', { skip: SKIP && 'requires real DATABASE_URL' }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  const query = (text, params) => client.query(text, params);

  const idOf = async (u) =>
    (await query(`SELECT id FROM agent_graph.board_members WHERE github_username=$1`, [u])).rows[0]?.id;
  const ericId = await idOf('ecgang');
  const dustinId = await idOf('ConsultingFuture4200');
  assert.ok(ericId, 'ecgang board member must exist');
  assert.ok(dustinId, 'ConsultingFuture4200 (Dustin) board member must exist');

  const eric = await resolvePrincipal({ userId: ericId, adminBypass: false }, { query });
  const dustin = await resolvePrincipal({ userId: dustinId, adminBypass: false }, { query });

  const cfOrg = (await query(`SELECT id FROM tenancy.orgs WHERE slug='consulting-futures'`)).rows[0].id;
  const staqsOrg = (await query(`SELECT id FROM tenancy.orgs WHERE slug='staqs'`)).rows[0].id;

  assert.ok(eric.readOrgIds.includes(staqsOrg), 'Eric must read Staqs (owner)');
  assert.ok(!dustin.readOrgIds.includes(staqsOrg), 'Dustin must NOT read Staqs — this is the boundary');
  assert.ok(dustin.readOrgIds.includes(cfOrg), 'Dustin must read consulting-futures');

  const C = { ownerOrgCol: 'owner_org_id' }; // org-only (no per-user owner column)
  const TEST_EMAIL = 'tenancy-exit-gate+cf@example.invalid';

  try {
    await query(`DELETE FROM signal.contacts WHERE email_address=$1`, [TEST_EMAIL]);
    await query(
      `INSERT INTO signal.contacts (email_address, owner_org_id) VALUES ($1, $2)`,
      [TEST_EMAIL, cfOrg]
    );

    // PRIMARY: Dustin sees ZERO Staqs-owned rows on every leak surface.
    const dustinStaqs = await query(
      `SELECT count(*)::int n FROM signal.contacts
        WHERE owner_org_id=$1 AND ${visibleClause(dustin, { ...C, startIndex: 2 }).sql}`,
      [staqsOrg, ...visibleClause(dustin, { ...C, startIndex: 2 }).params]
    );
    assert.equal(dustinStaqs.rows[0].n, 0, 'LEAK: Dustin sees Staqs-owned contacts');

    for (const rel of ['inbox.signals', 'inbox.human_tasks', 'signal.briefings']) {
      const n = await countVisible(client, rel, dustin, C);
      assert.equal(n, 0, `LEAK: Dustin sees rows in ${rel} (all Staqs-owned today)`);
    }

    // CONTROL: Dustin sees exactly his 1 seeded CF contact.
    assert.equal(await countVisible(client, 'signal.contacts', dustin, C), 1, 'Dustin must see his 1 CF contact');

    // CONTROL: Eric sees Staqs contacts, NOT the CF control row.
    assert.ok((await countVisible(client, 'signal.contacts', eric, C)) >= 1, 'Eric must see Staqs contacts');
    const ericSeesCf = await query(
      `SELECT count(*)::int n FROM signal.contacts
        WHERE email_address=$1 AND ${visibleClause(eric, { ...C, startIndex: 2 }).sql}`,
      [TEST_EMAIL, ...visibleClause(eric, { ...C, startIndex: 2 }).params]
    );
    assert.equal(ericSeesCf.rows[0].n, 0, 'Eric (not a CF member) must NOT see the CF control row');

    // PARITY: JS visibleClause == SQL tenancy.visible(NULL, owner_org_id) for Dustin.
    const jsRows = await query(
      `SELECT id FROM signal.contacts WHERE ${visibleClause(dustin, C).sql} ORDER BY id`,
      visibleClause(dustin, C).params
    );
    // Must run in ONE explicit transaction: on the Supabase transaction pooler
    // (port 6543) session GUCs set outside a txn are lost between statements, so
    // SET LOCAL inside BEGIN..COMMIT is the only way tenancy.visible sees them.
    await query('BEGIN');
    await query(`SELECT set_config('app.user', $1, true)`, [dustin.userId]);
    await query(`SELECT set_config('app.org_ids', $1, true)`, [dustin.readOrgIds.join(',')]);
    const sqlRows = await query(
      `SELECT id FROM signal.contacts WHERE tenancy.visible(NULL::uuid, owner_org_id) ORDER BY id`
    );
    await query('COMMIT');
    assert.deepEqual(
      jsRows.rows.map((r) => r.id),
      sqlRows.rows.map((r) => r.id),
      'JS visibleClause and SQL tenancy.visible must return identical rows'
    );
  } finally {
    await query(`DELETE FROM signal.contacts WHERE email_address=$1`, [TEST_EMAIL]).catch(() => {});
    await client.end();
  }
});

// STAQPRO-589 (ADR-012, Commit B): the SSE /api/events heartbeat ran three
// UNSCOPED global aggregates. Prove the scoped forms (now in api.js) return zero
// Staqs rows for Dustin's principal. We exercise the exact predicates the
// heartbeat builds (visibleClause), not the live socket — same discipline as the
// exit gate above. Skips on PGlite/unset.
test('Commit B SSE heartbeat: Dustin sees 0 Staqs briefing/draft/hitl rows', { skip: SKIP && 'requires real DATABASE_URL' }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  const query = (text, params) => client.query(text, params);
  try {
    const idOf = async (u) =>
      (await query(`SELECT id FROM agent_graph.board_members WHERE github_username=$1`, [u])).rows[0]?.id;
    const dustinId = await idOf('ConsultingFuture4200');
    const ericId = await idOf('ecgang');
    assert.ok(dustinId && ericId, 'board members must exist');
    const dustin = await resolvePrincipal({ userId: dustinId, adminBypass: false }, { query });
    const eric = await resolvePrincipal({ userId: ericId, adminBypass: false }, { query });
    const admin = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };

    // (1) Briefing aggregate (signal.v_daily_briefing) — scoped by owner_org_id.
    // Dustin → 0 rows (all briefing data is Staqs-owned today); admin → 'TRUE'.
    const bvD = visibleClause(dustin, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    const dBrief = await query(
      `SELECT count(*)::int n FROM signal.v_daily_briefing WHERE ${bvD.sql}`, bvD.params
    );
    assert.equal(dBrief.rows[0].n, 0, 'LEAK: Dustin sees Staqs daily-briefing rows over SSE heartbeat');
    const bvA = visibleClause(admin, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    // adminBypass clause is literal TRUE → query is valid and returns the view.
    await query(`SELECT count(*)::int n FROM signal.v_daily_briefing WHERE ${bvA.sql}`, bvA.params);

    // (2) Pending email-draft count (action_proposals carries owner_org_id, mig 134).
    const pvD = visibleClause(dustin, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    const dPending = await query(
      `SELECT count(*)::int n FROM agent_graph.action_proposals
        WHERE action_type='email_draft' AND reviewer_verdict IS NOT NULL
          AND board_action IS NULL AND ${pvD.sql}`, pvD.params
    );
    assert.equal(dPending.rows[0].n, 0, 'LEAK: Dustin sees Staqs pending drafts over SSE heartbeat');

    // (3) Pending HITL count — campaign_hitl_requests has NO owner_org_id, scoped
    // via JOIN campaigns on campaigns.owner_org_id. Dustin → 0.
    const hvD = visibleClause(dustin, { ownerOrgCol: 'c.owner_org_id', startIndex: 1 });
    const dHitl = await query(
      `SELECT count(*)::int n
         FROM agent_graph.campaign_hitl_requests ch
         JOIN agent_graph.campaigns c ON c.id = ch.campaign_id
        WHERE ch.status='pending' AND ${hvD.sql}`, hvD.params
    );
    assert.equal(dHitl.rows[0].n, 0, 'LEAK: Dustin sees Staqs HITL requests over SSE heartbeat');

    // CONTROL: Eric (Staqs) MAY see >= 0 rows — the join + predicate must at least
    // execute without error and not throw on his principal.
    const hvE = visibleClause(eric, { ownerOrgCol: 'c.owner_org_id', startIndex: 1 });
    await query(
      `SELECT count(*)::int n
         FROM agent_graph.campaign_hitl_requests ch
         JOIN agent_graph.campaigns c ON c.id = ch.campaign_id
        WHERE ch.status='pending' AND ${hvE.sql}`, hvE.params
    );
  } finally {
    await client.end();
  }
});
