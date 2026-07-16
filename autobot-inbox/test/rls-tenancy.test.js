// STAQPRO-303 PR-B-prereq.1e + PR-B-3 (load-bearing test):
//
// The whole point of switching the pool role to autobot_agent and FORCING
// RLS on agent-keyed tables is to make `app.agent_id` actually gate row
// visibility. If we get this wrong, every "tenancy hardening" claim in
// CONSTITUTION.md is a lie and `/governance` etc. are theatre.
//
// The assertion: with the pool connected as autobot_agent (NOT superuser)
// and `app.agent_id` set to a UUID that owns no rows, SELECTs on the
// current_agent_id()-keyed tables return zero rows.
//
// PGlite SKIP rationale
// ---------------------
// lib/db.js:147 pre-creates `autobot_agent` and `explorer_ro` as SUPERUSER
// inside PGlite (only way migrations like the baseline GRANTs apply without
// PGlite role machinery). SUPERUSER bypasses RLS, so this entire test would
// pass vacuously on PGlite — masking exactly the production bug it exists
// to catch. We gate the test on DATABASE_URL being set AND
// AUTOBOT_AGENT_DB_PASSWORD being set (i.e. PR-B-2 opted in for the test
// environment). When neither is true, the test SKIPS with a clear log line
// rather than passing-but-asserting-nothing.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HAS_REAL_PG = !!process.env.DATABASE_URL;
const HAS_AUTOBOT_AGENT_OPT_IN = !!process.env.AUTOBOT_AGENT_DB_PASSWORD;
const RLS_TEST_ENABLED = HAS_REAL_PG && HAS_AUTOBOT_AGENT_OPT_IN;

const BOGUS_AGENT_ID = '00000000-0000-0000-0000-deadbeefdead';

describe('RLS tenancy — agent_id scoping (STAQPRO-303 PR-B-3)', () => {
  let query;
  let withAgentScope;
  let close = async () => {};

  before(async () => {
    if (!RLS_TEST_ENABLED) {
      // eslint-disable-next-line no-console
      console.log(
        '[rls-tenancy] SKIPPING — requires DATABASE_URL and ' +
        'AUTOBOT_AGENT_DB_PASSWORD. PGlite roles are SUPERUSER and would ' +
        'bypass RLS, making this test vacuous.'
      );
      return;
    }
    ({ query, withAgentScope, close } = await import('../../lib/db.js'));
  });

  after(async () => {
    if (RLS_TEST_ENABLED) await close();
  });

  it('pool connects as autobot_agent, NOT as a superuser', { skip: !RLS_TEST_ENABLED }, async () => {
    const r = await query(
      `SELECT current_user AS u,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`
    );
    // Username is `autobot_agent` (or Supabase pooler form `autobot_agent.<ref>`)
    const user = String(r.rows[0].u || '');
    assert.ok(
      user === 'autobot_agent' || user.startsWith('autobot_agent.'),
      `Expected pool connected as autobot_agent (or pooler form), got ${user}`
    );
    assert.equal(
      r.rows[0].is_super,
      false,
      'autobot_agent must NOT be a superuser — superuser bypasses RLS'
    );
  });

  it('SELECT on agent_graph.work_items returns 0 rows under a bogus agent_id', { skip: !RLS_TEST_ENABLED }, async () => {
    const scoped = await withAgentScope(BOGUS_AGENT_ID);
    try {
      const r = await scoped(`SELECT count(*)::int AS cnt FROM agent_graph.work_items`);
      assert.equal(
        r.rows[0].cnt,
        0,
        'work_items must be empty under a non-existent agent_id — ' +
        'if non-zero, the parent_id IS NULL OR-clause in agent_read_work_items ' +
        'or some other backdoor is leaking the whole table.'
      );
    } finally {
      await scoped.release();
    }
  });

  it('SELECT on agent_graph.llm_invocations returns 0 rows under a bogus agent_id', { skip: !RLS_TEST_ENABLED }, async () => {
    const scoped = await withAgentScope(BOGUS_AGENT_ID);
    try {
      const r = await scoped(`SELECT count(*)::int AS cnt FROM agent_graph.llm_invocations`);
      assert.equal(r.rows[0].cnt, 0, 'llm_invocations must be empty under a non-existent agent_id');
    } finally {
      await scoped.release();
    }
  });

  it('SELECT on agent_graph.task_events returns 0 rows under a bogus agent_id', { skip: !RLS_TEST_ENABLED }, async () => {
    const scoped = await withAgentScope(BOGUS_AGENT_ID);
    try {
      // agent_read_events keys on target_agent_id = current_agent_id().
      const r = await scoped(`SELECT count(*)::int AS cnt FROM agent_graph.task_events`);
      assert.equal(r.rows[0].cnt, 0, 'task_events must be empty under a non-existent agent_id');
    } finally {
      await scoped.release();
    }
  });

  // Cross-schema sample assertions: the migration FORCEs RLS on inbox
  // and voice tables too. Their existing SELECT policies are permissive
  // (USING true), so we can't assert visibility-by-agent_id. Instead we
  // assert the structural invariant: FORCE ROW LEVEL SECURITY is set,
  // meaning the policy stack actually runs for every caller including
  // table owners. If FORCE is unset, an owner-level connection could
  // sidestep the agent-keyed policies on agent_graph tables that share
  // this migration's transaction — so this is defense-in-depth.
  it('FORCE ROW LEVEL SECURITY is set on every target table', { skip: !RLS_TEST_ENABLED }, async () => {
    const r = await query(
      `SELECT n.nspname || '.' || c.relname AS tbl, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname, c.relname) IN (
          ('agent_graph', 'work_items'),
          ('agent_graph', 'state_transitions'),
          ('agent_graph', 'task_events'),
          ('agent_graph', 'llm_invocations'),
          ('agent_graph', 'action_proposals'),
          ('inbox',       'messages'),
          ('voice',       'edit_deltas')
        )
        ORDER BY tbl`
    );
    for (const row of r.rows) {
      assert.equal(row.forced, true, `FORCE ROW LEVEL SECURITY missing on ${row.tbl}`);
    }
    assert.equal(r.rows.length, 7, 'Expected exactly 7 target tables in pg_class lookup');
  });

  it('un-scoped pool query on a sensitive table sees 0 rows when app.agent_id is unset', { skip: !RLS_TEST_ENABLED }, async () => {
    // Top-level query() opens a fresh pool client with no app.agent_id set.
    // Under FORCE, the agent_read_work_items policy reduces to:
    //   assigned_to = current_agent_id() -- which is NULL → false
    //   OR created_by = current_agent_id() -- NULL → false
    //   OR parent_id IS NULL -- THIS is the backdoor still permitted
    //   OR current_setting('app.role', true) = 'board'
    // i.e. root-level work_items are still visible. That's a known scope
    // gap intentionally left in the v1 policy set (root tasks are visible
    // to all agents so any orchestrator can pick up new top-level work).
    // The narrower assertion we CAN make: non-root work_items (parent_id
    // NOT NULL) are invisible to an unset agent context.
    const r = await query(
      `SELECT count(*)::int AS cnt
         FROM agent_graph.work_items
        WHERE parent_id IS NOT NULL`
    );
    assert.equal(
      r.rows[0].cnt,
      0,
      'non-root work_items must not be visible without an agent context. ' +
      'If non-zero, RLS is not being enforced — most likely the pool is ' +
      'still connecting as a superuser or autobot_agent inherited too much.'
    );
  });
});
