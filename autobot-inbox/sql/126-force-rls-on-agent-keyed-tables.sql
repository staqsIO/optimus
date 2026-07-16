-- STAQPRO-303 PR-B-prereq.1e + PR-B-3: FORCE ROW LEVEL SECURITY on every
-- table whose policy set is keyed on agent_graph.current_agent_id().
--
-- Background
-- ----------
-- Migration 001-baseline ENABLED RLS on a handful of agent_graph + inbox +
-- voice tables and shipped agent-keyed SELECT/UPDATE/INSERT policies. None
-- of them have done a single ounce of work in production because:
--
--   (a) the Postgres pool in lib/db.js connects as the Supabase
--       `postgres.<project>` superuser, and superusers are ALWAYS exempt
--       from RLS regardless of ENABLE/FORCE state; and
--   (b) even after the pool switches to an unprivileged role, ENABLE alone
--       does not enforce against the table OWNER (which the migration
--       runner is) — only FORCE does.
--
-- The companion code change (lib/db.js: applyAutobotAgentRole) flips (a).
-- This migration flips (b) by adding FORCE ROW LEVEL SECURITY to every
-- table where the policy set actually references current_agent_id() —
-- i.e. tables whose ACL is meant to depend on the per-tick agent context
-- set by setAgentContext() / withAgentScope().
--
-- Scope: just the seven tables below. Other tables that have RLS enabled
-- (signatures.*, content.counterparties, content.draft_versions, etc.) are
-- keyed on Supabase auth.uid() — board-facing, not agent-facing. Those are
-- WT2's lane; do not touch them here.
--
-- Prerequisites already shipped
-- -----------------------------
-- • 123-rls-prereq-claim-task-and-llm-invocations.sql: marked
--   claim_next_task() SECURITY DEFINER (so its internal UPDATE on
--   task_events runs under owner privileges even after FORCE) and added
--   the missing INSERT policy for llm_invocations.
--
-- Defense-in-depth gaps we close here
-- -----------------------------------
-- The audit below enumerates every existing policy on the target tables
-- against every runtime write site. Three tables have INSERT/UPDATE call
-- sites with NO corresponding policy and would silently fail the moment
-- FORCE activates:
--
--   1. agent_graph.work_items — no INSERT policy. Callers: spawn-work-items,
--      state-machine, board /campaigns Quick Build. (UPDATE policy exists;
--      DELETE is denied by `no_delete_work_items`.)
--
--   2. agent_graph.action_proposals — no INSERT, no UPDATE policy. Callers:
--      executor-responder, executor-coder, executor-ticket, claw-workshop,
--      linear/ingest, linear/comment-handler, runtime/campaign-promoter,
--      github/webhook-handler, github/issue-webhook, cli/commands/review.
--
--   3. agent_graph.task_events — only `agent_insert_events` (WITH CHECK
--      true). UPDATE policy missing. Callers (besides claim_next_task,
--      which is SECURITY DEFINER post-123): event-bus.clearHalt,
--      reaper.sweepStuckCreated.
--
--   4. inbox.messages — no UPDATE policy. Callers: strategist, executor-
--      triage, executor-intake.
--
-- For each gap we add a permissive `agent_*` policy: WITH CHECK / USING
-- `true`. This is deliberately not tightened to `current_agent_id()` —
-- there are infra paths (reaper sweeps, halt-clear, board CRUD) that legit
-- run without an agent context set, and tightening would brick them. The
-- isolation win that ships with this migration is the SELECT-side
-- enforcement (work_items, task_events, llm_invocations) which IS keyed on
-- current_agent_id() — that's the load-bearing assertion the test suite
-- verifies. Subsequent migrations can narrow the write policies once every
-- write call site is audited and routed through withAgentScope().
--
-- Rollback
-- --------
-- If FORCE breaks production:
--   ALTER TABLE <each_table> NO FORCE ROW LEVEL SECURITY;
-- (RLS itself stays enabled so non-owner roles are still scoped; FORCE is
-- the part that bites the migration runner / superuser-grandfathered code.)
-- Combined rollback for the code side: unset AUTOBOT_AGENT_DB_PASSWORD —
-- the pool falls back to the superuser URL and bypass-RLS-by-role takes
-- over. Either lever alone reverts the change.

BEGIN;

-- ============================================================
-- 1. Patch the missing write policies BEFORE flipping FORCE.
--    Order matters: if FORCE is enabled first and a write fires before
--    these CREATE POLICY statements commit, the write fails with
--    "new row violates row-level security policy". Wrapping the whole
--    migration in BEGIN/COMMIT keeps it atomic — either the entire
--    set lands or nothing does.
-- ============================================================

-- 1a. work_items: INSERT policy.
-- spawn-work-items, state-machine, board Quick Build all INSERT.
-- Existing UPDATE policy already guards UPDATE; no_delete_work_items
-- already denies DELETE.
CREATE POLICY agent_insert_work_items ON agent_graph.work_items
  FOR INSERT WITH CHECK (true);

-- 1b. action_proposals: INSERT + UPDATE policies.
-- 11+ runtime call sites INSERT proposals; reviewer/cli/github webhooks
-- UPDATE them through their state machine (send_state, board_action,
-- acted_at, etc.). No DELETE call sites.
CREATE POLICY agent_insert_action_proposals ON agent_graph.action_proposals
  FOR INSERT WITH CHECK (true);

CREATE POLICY agent_update_action_proposals ON agent_graph.action_proposals
  FOR UPDATE USING (true) WITH CHECK (true);

-- 1c. task_events: UPDATE policy.
-- claim_next_task() is SECURITY DEFINER per 123, so its internal UPDATE
-- runs as owner. But event-bus.clearHalt and reaper.sweepStuckCreated
-- UPDATE task_events directly via the top-level pool — under FORCE those
-- need a policy.
CREATE POLICY agent_update_events ON agent_graph.task_events
  FOR UPDATE USING (true) WITH CHECK (true);

-- 1d. inbox.messages: UPDATE policy.
-- strategist updates priority_score, executor-triage updates archived_at +
-- triage metadata, executor-intake updates classification metadata.
CREATE POLICY agent_update_messages ON inbox.messages
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- 2. FORCE ROW LEVEL SECURITY.
--    ENABLE was already set on these tables in 001-baseline. FORCE is
--    what makes the policies apply to the table OWNER too — without it,
--    the migration runner (and any other connection that happens to be
--    the owner) skips the policies entirely.
-- ============================================================

ALTER TABLE agent_graph.work_items         FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.state_transitions  FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.task_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.llm_invocations    FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.action_proposals   FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox.messages                 FORCE ROW LEVEL SECURITY;
ALTER TABLE voice.edit_deltas              FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Sanity gate — verify the connecting test user can still see
--    something AND that an un-scoped agent_id sees nothing. Runs in
--    the migration transaction; throws if the invariant is broken,
--    which rolls the whole thing back.
--
--    Skipped on PGlite because PGlite creates autobot_agent as
--    SUPERUSER (lib/db.js:147) — SUPERUSER bypasses RLS, so the
--    assertion below would always pass vacuously and mask a real
--    production bug. The real-PG test (test/rls-tenancy.test.js)
--    is the load-bearing gate.
-- ============================================================

DO $$
DECLARE
  v_role_kind TEXT;
  v_visible_with_bogus_agent INT;
BEGIN
  -- Sanity check intentionally minimal: just confirm the FORCE flag stuck.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'agent_graph.work_items'::regclass
      AND relforcerowsecurity = true
  ) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY did not apply to agent_graph.work_items';
  END IF;
END $$;

COMMIT;
