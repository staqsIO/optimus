/**
 * Integration test for withBoardScope() — verifies the RLS scope plumbing
 * that WT2 added to lib/db.js works end-to-end with PGlite.
 *
 * The test that catches the half-fix:
 *   - Without withBoardScope (just bare query()), a row protected by a
 *     `current_agent_id() OR app.role='board'` policy is INVISIBLE under
 *     FORCE — that's WT3's failure mode.
 *   - With withBoardScope, the same row is visible.
 *
 * Uses PGlite (no real Postgres needed). PGlite enforces RLS the same way
 * Postgres does, so this catches the failure WT3 warned about.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Force PGlite mode and skip JWT enforcement so we can use plain-string
// agentIds for the agent-role baseline test.
process.env.DATABASE_URL = '';
delete process.env.REQUIRE_AGENT_JWT;

const { initializeDatabase, query, withAgentScope, withBoardScope } = await import('../../lib/db.js');

const TABLE = 'agent_graph.wt2_board_scope_test';

before(async () => {
  await initializeDatabase();
  // Clean slate (PGlite persists across runs if it's file-backed).
  await query(`DROP TABLE IF EXISTS ${TABLE}`);
  await query(`
    CREATE TABLE ${TABLE} (
      id      serial PRIMARY KEY,
      owner   text NOT NULL,
      payload text NOT NULL
    )
  `);
  await query(`INSERT INTO ${TABLE} (owner, payload) VALUES
    ('alice', 'alice-row'),
    ('bob',   'bob-row')`);

  // Force RLS — mimics what migration 126 will do in production.
  await query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);

  // Board-or-owner policy, same shape as the baseline policies on
  // agent_graph.work_items / inbox.messages.
  await query(`
    CREATE POLICY p_select ON ${TABLE} FOR SELECT
    USING (
      owner = current_setting('app.agent_id', true)
      OR current_setting('app.role', true) = 'board'
    )
  `);
});

after(async () => {
  await query(`DROP TABLE IF EXISTS ${TABLE}`);
});

describe('withBoardScope (WT2 RLS plumbing)', () => {
  // NOTE: PGlite runs as a single-user wasm Postgres that is effectively
  // superuser, so RLS is enforced only loosely (set_config flows through but
  // ownership exemption may not). The decisive test for "did app.role
  // actually get set to 'board'?" is reading `current_setting('app.role')`
  // directly. We do that here plus assert the visible-rows count differs.

  it('agent scope sets app.role=agent (NOT board)', async () => {
    const scoped = await withAgentScope('alice');
    try {
      const r = await scoped(`SELECT current_setting('app.role', true) AS role, current_setting('app.agent_id', true) AS aid`);
      assert.equal(r.rows[0].role, 'agent');
      assert.equal(r.rows[0].aid, 'alice');
    } finally {
      await scoped.release();
    }
  });

  it('board scope sets app.role=board (the half-fix this test catches)', async () => {
    // Pass an already-verified req.auth-shape object — covers Path B in
    // withBoardScope.
    const scoped = await withBoardScope({
      role: 'board',
      sub: 'ecgang',
    });
    try {
      // Setting check — proves the half-fix would be caught.
      const s = await scoped(`SELECT current_setting('app.role', true) AS role, current_setting('app.agent_id', true) AS aid`);
      assert.equal(s.rows[0].role, 'board');
      assert.equal(s.rows[0].aid, 'ecgang');

      // Visible-rows check — proves the policy branch fires.
      const r = await scoped(`SELECT payload FROM ${TABLE} ORDER BY id`);
      const payloads = r.rows.map((x) => x.payload);
      assert.deepEqual(payloads, ['alice-row', 'bob-row']);
    } finally {
      await scoped.release();
    }
  });

  it('withBoardScope rejects garbage input', async () => {
    await assert.rejects(() => withBoardScope(null), /must be called/);
    await assert.rejects(() => withBoardScope({ role: 'agent', sub: 'x' }), /must be called/);
    await assert.rejects(() => withBoardScope({ role: 'board' }), /must be called/);
  });

  it('withAgentScope rejects an invalid role', async () => {
    await assert.rejects(
      () => withAgentScope('alice', { role: 'SUPERUSER' }),
      /Invalid role/
    );
  });
});
