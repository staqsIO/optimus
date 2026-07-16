// STAQPRO-303 PR-B-prereq.1b: claim_next_task SECURITY DEFINER + caller
// assertion + llm_invocations INSERT policy.
//
// These tests pin the contract that PR-B-prereq.1e RLS rewrite + PR-B-2
// pool switch will rely on. Without them, the orchestrator claim loop
// dies silently under FORCE ROW LEVEL SECURITY and every LLM cost write
// is denied.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

describe('migration 123 — claim_next_task SECURITY DEFINER + llm_invocations INSERT policy', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  // -----------------------------------------------------------------------
  // claim_next_task function shape
  // -----------------------------------------------------------------------

  describe('claim_next_task — function metadata', () => {
    it('is SECURITY DEFINER', async () => {
      const r = await query(
        `SELECT prosecdef
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'agent_graph'
            AND p.proname = 'claim_next_task'`
      );
      assert.equal(r.rows.length, 1, 'claim_next_task must exist');
      assert.equal(
        r.rows[0].prosecdef,
        true,
        'claim_next_task must be SECURITY DEFINER — otherwise its internal UPDATE on task_events requires a policy that B-prereq.1e does not declare, breaking the orchestrator under FORCE'
      );
    });

    it('has pinned search_path including pg_catalog and agent_graph', async () => {
      const r = await query(
        `SELECT proconfig
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'agent_graph'
            AND p.proname = 'claim_next_task'`
      );
      const cfg = r.rows[0].proconfig;
      assert.ok(cfg, 'proconfig must be set — SECURITY DEFINER without pinned search_path is a hijack footgun');
      const sp = cfg.find((c) => c.startsWith('search_path='));
      assert.ok(sp, `must include search_path setting (got: ${JSON.stringify(cfg)})`);
      assert.ok(sp.includes('pg_catalog'), 'search_path must include pg_catalog');
      assert.ok(sp.includes('agent_graph'), 'search_path must include agent_graph');
    });
  });

  // -----------------------------------------------------------------------
  // claim_next_task caller-identity assertion (STAQPRO-303 1b)
  // -----------------------------------------------------------------------

  describe('claim_next_task — caller-identity assertion', () => {
    it('allows call when app.agent_id is unset (legacy / pre-enforcement)', async () => {
      // Clear any prior session var. set_config(..., true) is tx-local; the
      // test harness runs each test on a fresh connection so this should
      // already be null, but be explicit.
      await query(`SELECT set_config('app.agent_id', '', false)`);
      // Should not throw — returns 0 rows because no matching events exist.
      const r = await query(`SELECT * FROM agent_graph.claim_next_task('any-agent')`);
      assert.ok(Array.isArray(r.rows), 'must return rows (possibly empty)');
    });

    it('allows call when app.agent_id matches p_agent_id', async () => {
      await query(`SELECT set_config('app.agent_id', 'orchestrator', false)`);
      const r = await query(`SELECT * FROM agent_graph.claim_next_task('orchestrator')`);
      assert.ok(Array.isArray(r.rows));
    });

    it('rejects call when app.agent_id is set but does not match p_agent_id', async () => {
      await query(`SELECT set_config('app.agent_id', 'alice', false)`);
      await assert.rejects(
        () => query(`SELECT * FROM agent_graph.claim_next_task('bob')`),
        /caller agent_id .* cannot claim as/i,
        'caller-identity assertion must block cross-agent claim'
      );
      // Reset session for downstream tests.
      await query(`SELECT set_config('app.agent_id', '', false)`);
    });

    it('allows call when app.agent_id is empty string (treated as unset)', async () => {
      // PGlite reports unset GUCs as ''; ensure the empty-string branch
      // does not trip the assertion.
      await query(`SELECT set_config('app.agent_id', '', false)`);
      const r = await query(`SELECT * FROM agent_graph.claim_next_task('orchestrator')`);
      assert.ok(Array.isArray(r.rows));
    });
  });

  // -----------------------------------------------------------------------
  // llm_invocations INSERT policy (STAQPRO-303 1b)
  // -----------------------------------------------------------------------

  describe('llm_invocations — INSERT policy', () => {
    it('agent_insert_invocations policy exists with FOR INSERT', async () => {
      const r = await query(
        `SELECT polname, polcmd
           FROM pg_policy
          WHERE polname = 'agent_insert_invocations'
            AND polrelid = 'agent_graph.llm_invocations'::regclass`
      );
      assert.equal(r.rows.length, 1, 'agent_insert_invocations policy must be declared');
      // polcmd: 'r'=SELECT, 'a'=INSERT, 'w'=UPDATE, 'd'=DELETE, '*'=ALL
      assert.equal(r.rows[0].polcmd, 'a', 'policy must be FOR INSERT (polcmd=a)');
    });

    it('preserves the existing agent_read_invocations SELECT policy', async () => {
      // Regression: the INSERT policy addition must not collide with or
      // displace the existing read policy.
      const r = await query(
        `SELECT polname FROM pg_policy
          WHERE polname = 'agent_read_invocations'
            AND polrelid = 'agent_graph.llm_invocations'::regclass`
      );
      assert.equal(r.rows.length, 1, 'baseline read policy must still exist');
    });
  });
});
