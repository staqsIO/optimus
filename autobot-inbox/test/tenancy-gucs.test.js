/**
 * Tenancy GUC plumbing — ADR-012 §5.2 follow-through.
 *
 * Pins the per-request GUC contract that lets tenancy.visible() evaluate
 * inside an RLS policy. Three load-bearing assertions:
 *
 *   (1) withAgentScope / withBoardScope propagate user + orgIds into
 *       app.user / app.org_ids — values round-trip through Postgres
 *       (current_setting reads back what was set).
 *
 *   (2) tenancy.visible(NULL, org) reads those GUCs and returns the
 *       expected boolean: TRUE for an org the principal can read,
 *       FALSE for an org it cannot, FALSE when the GUCs are unset.
 *
 *   (3) Argument validation rejects malformed UUIDs at the boundary —
 *       no chance of poisoning the GUC with a value tenancy.visible
 *       would either error on or silently coerce.
 *
 * Migration 190 plants the SELECT policies USING tenancy.visible(...) but
 * those only enforce when (a) the pool runs as autobot_agent (not the
 * default superuser) and (b) the table is FORCE'd (deferred). Under
 * PGlite, both prerequisites are absent, so this suite verifies the
 * GUC mechanics rather than the policy enforcement itself. The matching
 * autobot_agent + FORCE assertions live in rls-tenancy.test.js and are
 * env-gated on DATABASE_URL + AUTOBOT_AGENT_DB_PASSWORD.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { setAgentContext, withAgentScope, withBoardScope } from '../../lib/db.js';

const VALID_UUID_1 = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';
const VALID_UUID_3 = '33333333-3333-3333-3333-333333333333';
// Plain-agentId entry point — withAgentScope accepts this in non-enforcement
// mode (REQUIRE_AGENT_JWT unset). The actual identity doesn't matter for
// these tests; we're exercising the GUC plumbing inside the scope.
const TEST_AGENT = 'tenancy-gucs-test-agent';

let query;
let STAQS_ORG;
let OTHER_ORG;

before(async () => {
  ({ query } = await getDb());

  const staqsRow = await query(
    `SELECT id FROM tenancy.orgs WHERE slug = 'staqs' LIMIT 1`
  );
  STAQS_ORG = staqsRow.rows[0]?.id;

  const otherRow = await query(`
    INSERT INTO tenancy.orgs (slug, name)
    VALUES ('org-tenancy-gucs-test', 'Org (tenancy-gucs test)')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  OTHER_ORG = otherRow.rows[0].id;
});

describe('tenancy GUCs — withAgentScope user + orgIds plumbing', () => {
  it('(1) round-trips a user UUID and a single-org list', async () => {
    const scoped = await withAgentScope(TEST_AGENT, {
      user: VALID_UUID_1,
      orgIds: [VALID_UUID_2, VALID_UUID_3],
    });
    try {
      const r = await scoped(`
        SELECT
          current_setting('app.user',    true) AS u,
          current_setting('app.org_ids', true) AS o
      `);
      assert.equal(r.rows[0].u, VALID_UUID_1, 'app.user must round-trip');
      assert.equal(
        r.rows[0].o,
        `${VALID_UUID_2},${VALID_UUID_3}`,
        'app.org_ids must round-trip as CSV'
      );
    } finally {
      await scoped.release();
    }
  });

  it('(2) empty orgIds → empty CSV → tenancy.visible() fails closed', async () => {
    const scoped = await withAgentScope(TEST_AGENT, {
      user: VALID_UUID_1,
      orgIds: [],
    });
    try {
      const r = await scoped(`
        SELECT current_setting('app.org_ids', true) AS o,
               tenancy.visible(NULL::uuid, $1::uuid) AS visible
      `, [STAQS_ORG]);
      assert.equal(r.rows[0].o, '', 'empty array must produce empty CSV');
      assert.equal(
        r.rows[0].visible,
        false,
        'tenancy.visible must be FALSE when app.org_ids is empty (fail-closed)'
      );
    } finally {
      await scoped.release();
    }
  });

  it('(3) GUC set to a matching org → tenancy.visible() returns TRUE', async () => {
    const scoped = await withAgentScope(TEST_AGENT, {
      user: VALID_UUID_1,
      orgIds: [STAQS_ORG],
    });
    try {
      const r = await scoped(
        `SELECT tenancy.visible(NULL::uuid, $1::uuid) AS visible`,
        [STAQS_ORG]
      );
      assert.equal(
        r.rows[0].visible,
        true,
        'tenancy.visible must be TRUE when row owner is in app.org_ids'
      );
    } finally {
      await scoped.release();
    }
  });

  it('(4) GUC set to a different org → tenancy.visible() returns FALSE', async () => {
    const scoped = await withAgentScope(TEST_AGENT, {
      user: VALID_UUID_1,
      orgIds: [OTHER_ORG],
    });
    try {
      const r = await scoped(
        `SELECT tenancy.visible(NULL::uuid, $1::uuid) AS visible`,
        [STAQS_ORG]
      );
      assert.equal(
        r.rows[0].visible,
        false,
        'tenancy.visible must be FALSE when row owner is not in app.org_ids'
      );
    } finally {
      await scoped.release();
    }
  });

  it('(5) rejects malformed user UUID — fail-fast, never poison the GUC', async () => {
    // setAgentContext is exercised directly here because the validation
    // throws before any client.query() runs — no scoped client needed.
    const fakeClient = { query: () => { throw new Error('must not reach query'); } };
    await assert.rejects(
      setAgentContext(fakeClient, 'test-agent', 'agent', { user: 'not-a-uuid' }),
      /Invalid user UUID/,
      'setAgentContext must reject non-UUID app.user values'
    );
  });

  it('(6) rejects malformed UUID inside orgIds — fail-fast', async () => {
    const fakeClient = { query: () => { throw new Error('must not reach query'); } };
    await assert.rejects(
      setAgentContext(fakeClient, 'test-agent', 'agent', {
        orgIds: [VALID_UUID_1, 'not-a-uuid'],
      }),
      /Invalid org UUID in orgIds/,
      'setAgentContext must reject any non-UUID element of orgIds'
    );
  });

  it('(7) rejects non-array orgIds — fail-fast', async () => {
    const fakeClient = { query: () => { throw new Error('must not reach query'); } };
    await assert.rejects(
      setAgentContext(fakeClient, 'test-agent', 'agent', { orgIds: 'not-an-array' }),
      /orgIds must be an array/,
      'setAgentContext must reject scalar orgIds'
    );
  });

  it('(8) omitting user/orgIds leaves the GUCs unset — tenancy.visible fail-closed', async () => {
    // Legacy call shape — no user/orgIds. Must not write those GUCs.
    const scoped = await withAgentScope(TEST_AGENT);
    try {
      const r = await scoped(`
        SELECT NULLIF(current_setting('app.user',    true), '') AS u,
               NULLIF(current_setting('app.org_ids', true), '') AS o,
               tenancy.visible(NULL::uuid, $1::uuid) AS visible
      `, [STAQS_ORG]);
      assert.equal(r.rows[0].u, null, 'app.user must remain unset');
      assert.equal(r.rows[0].o, null, 'app.org_ids must remain unset');
      assert.equal(
        r.rows[0].visible,
        false,
        'tenancy.visible must fail-closed when GUCs are unset'
      );
    } finally {
      await scoped.release();
    }
  });
});

describe('tenancy GUCs — withBoardScope principal plumbing', () => {
  it('(9) withBoardScope(auth, { principal }) sets app.user/app.org_ids', async () => {
    const auth = { sub: 'test-board-user', role: 'board' };
    const principal = {
      userId: VALID_UUID_1,
      readOrgIds: [STAQS_ORG],
      readGroupIds: [],
      roles: {},
      adminBypass: false,
    };
    const scoped = await withBoardScope(auth, { principal });
    try {
      const r = await scoped(`
        SELECT current_setting('app.user',    true) AS u,
               current_setting('app.org_ids', true) AS o,
               current_setting('app.role',    true) AS r
      `);
      assert.equal(r.rows[0].u, VALID_UUID_1, 'app.user set from principal.userId');
      assert.equal(r.rows[0].o, STAQS_ORG,   'app.org_ids set from principal.readOrgIds');
      assert.equal(r.rows[0].r, 'board',     'app.role still set to board');
    } finally {
      await scoped.release();
    }
  });

  it('(10) withBoardScope without principal leaves app.user/app.org_ids unset', async () => {
    const auth = { sub: 'test-board-user-2', role: 'board' };
    const scoped = await withBoardScope(auth);
    try {
      const r = await scoped(`
        SELECT NULLIF(current_setting('app.user',    true), '') AS u,
               NULLIF(current_setting('app.org_ids', true), '') AS o
      `);
      assert.equal(r.rows[0].u, null, 'app.user remains unset without principal');
      assert.equal(r.rows[0].o, null, 'app.org_ids remains unset without principal');
    } finally {
      await scoped.release();
    }
  });
});

describe('tenancy RLS — migration 190 policies (presence check)', () => {
  it('every targeted table has a tenancy_visible_select_* policy', async () => {
    const r = await query(`
      SELECT schemaname, tablename, policyname
      FROM pg_policies
      WHERE policyname LIKE 'tenancy_visible_select_%'
      ORDER BY schemaname, tablename
    `);
    // Migration 190 plants 11 tenancy_visible_select_* policies in EVERY
    // environment. Migration 195 (#545) adds content.gate_log's
    // tenancy_visible_select_gate_log (DELETE-parity work, scoped through the
    // parent draft). Migration 197 (#561) adds content.send_overrides'
    // tenancy_visible_select_send_overrides (send-override write parity, scoped
    // through the parent draft the same way) — its SELECT policy is load-bearing
    // because Postgres enforces it implicitly on INSERT ... RETURNING and
    // UPDATE ... WHERE, not just direct reads. BOTH 195 and 197 cascade-skip on
    // PGlite (their parity spans the signatures/auth schemas PGlite lacks; see
    // the guards in sql/195 + sql/197 and PGLITE_INCOMPAT_SIGNATURES in
    // lib/db.js) — so they land only on real Postgres (+2 there, +0 on PGlite).
    //
    // Migration 198 (STAQPRO-263 Bucket 1a) adds TWO more —
    // content.counterparties' tenancy_visible_select_counterparties (direct
    // owner_org_id scope) and content.draft_versions'
    // tenancy_visible_select_draft_versions (scoped through the parent draft).
    // Unlike 195/197, BOTH these tables (and counterparties' owner_org_id column,
    // mig 149) exist on PGlite — they're created by auth-free migrations that run
    // everywhere; only their sql/070 dead-auth.uid() policies were skipped. So
    // 198 applies in BOTH environments and adds +2 to EACH count.
    //
    // Net: real Postgres = 11 (190) + 2 (195/197) + 2 (198) = 15;
    //      PGlite        = 11 (190) + 0 (195/197) + 2 (198) = 13.
    // Discriminate on the same signal lib/db.js uses (USE_REAL_PG =
    // !!DATABASE_URL). The verify-block inside each migration itself raises if
    // its own policies are absent, so any drift below the expected floor is a bug
    // in the harness or a partial migration run, not silent rot. This exact count
    // remains an anti-rot tripwire: a new tenancy_visible_select_* policy must
    // consciously bump the number for its environment.
    const onRealPg = !!process.env.DATABASE_URL;
    const expected = onRealPg ? 15 : 13;
    assert.equal(
      r.rows.length,
      expected,
      `Expected ${expected} tenancy_visible_select_* policies ` +
      `(${onRealPg ? 'real Postgres, mig 195/197 apply + 198' : 'PGlite, mig 195/197 skipped, 198 applies'}), ` +
      `got ${r.rows.length}: ` +
      r.rows.map((row) => `${row.schemaname}.${row.tablename}`).join(', ')
    );
  });

  it('content.drafts has the migration-196 tenancy_visible_update_drafts policy', async () => {
    // Migration 196 (#555) adds an UPDATE policy on content.drafts, USING =
    // WITH CHECK = tenancy.visible(NULL, owner_org_id), for parity with the
    // table's existing SELECT (190) and DELETE (195) policies. Unlike mig 195
    // — whose DELETE parity spans the signatures/auth schemas PGlite lacks and
    // therefore cascade-skips on PGlite (see the count discrimination above) —
    // 196 references only content.drafts and tenancy.visible, both present on
    // PGlite. So 196 applies in BOTH environments and this policy is present
    // in both; there is no env-dependent count to discriminate. The env signal
    // is read here purely to make that difference explicit and to fail loudly
    // if a future change makes 196 environment-dependent the way 195 is.
    const onRealPg = !!process.env.DATABASE_URL;
    const expected = 1; // present on real Postgres AND PGlite — mig 196 is drafts-only
    const r = await query(`
      SELECT schemaname, tablename, policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'content'
        AND tablename  = 'drafts'
        AND policyname = 'tenancy_visible_update_drafts'
    `);
    assert.equal(
      r.rows.length,
      expected,
      `Expected the tenancy_visible_update_drafts policy on content.drafts ` +
      `(${onRealPg ? 'real Postgres' : 'PGlite'} — mig 196 applies in both), ` +
      `got ${r.rows.length}`
    );
    assert.equal(
      r.rows[0]?.cmd,
      'UPDATE',
      'tenancy_visible_update_drafts must be a FOR UPDATE policy'
    );
  });
});
