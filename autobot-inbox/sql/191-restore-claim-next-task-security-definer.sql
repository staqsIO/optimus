-- 191-restore-claim-next-task-security-definer.sql
-- STAQPRO-303 PR-B-prereq.1b (restoration): re-apply the SECURITY DEFINER
-- hardening to agent_graph.claim_next_task that migration 159
-- (fleet-runner-routing) inadvertently dropped.
--
-- What happened
-- -------------
-- Migration 123 originally added three hardenings to claim_next_task:
--   1. SECURITY DEFINER — so the function's internal UPDATE on task_events
--      runs as table-owner, bypassing the row-level deny that FORCE RLS
--      would otherwise impose on the caller.
--   2. SET search_path = pg_catalog, agent_graph — closes the SECURITY
--      DEFINER hijack-by-search-path footgun.
--   3. Caller-identity assertion: when app.agent_id is set, the function
--      refuses to claim as a different agent (defense in depth against
--      cross-agent task hijack via SECURITY DEFINER bypass).
--
-- Migration 159 added a fleet-runner signature (added `p_runner_id TEXT
-- DEFAULT NULL`) by DROPping the function and recreating it from scratch.
-- The recreation copied the original 001-baseline body — none of 123's
-- hardenings carried over. The function has been running without
-- SECURITY DEFINER / search_path / caller assertion since 159 landed,
-- which is exactly the state migration 123 explicitly said would brick
-- the orchestrator under FORCE RLS.
--
-- The test/migration-123.test.js suite has been failing on main ever since
-- (caught by this audit — it's why this file exists).
--
-- This migration
-- --------------
-- Re-apply all three hardenings to the current (159-era) signature. The
-- function body is the 159 body verbatim; we only add the SECURITY DEFINER
-- clause, the SET search_path, and the caller-identity guard at the top.
-- No behavioral change for callers: same args, same return shape, same
-- claim semantics.
--
-- Idempotent: DROP FUNCTION IF EXISTS first so re-runs don't accumulate
-- signature variants. Re-GRANT to autobot_agent after the CREATE since
-- Postgres revokes ACLs on signature changes.

DROP FUNCTION IF EXISTS agent_graph.claim_next_task(TEXT, TEXT);
DROP FUNCTION IF EXISTS agent_graph.claim_next_task(TEXT);

CREATE OR REPLACE FUNCTION agent_graph.claim_next_task(
  p_agent_id TEXT,
  p_runner_id TEXT DEFAULT NULL
) RETURNS TABLE (
  event_id TEXT,
  event_type TEXT,
  work_item_id TEXT,
  event_data JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agent_graph
AS $$
DECLARE
  v_event RECORD;
  v_caller TEXT;
BEGIN
  -- STAQPRO-303 1b (restored): caller-identity assertion. Pre-PR-A
  -- enforcement sessions have app.agent_id unset; the check skips and
  -- behavior matches pre-migration. Post-enforcement, a caller cannot
  -- pass someone else's agent_id to claim their tasks.
  v_caller := current_setting('app.agent_id', true);
  IF v_caller IS NOT NULL AND v_caller <> '' AND v_caller <> p_agent_id THEN
    RAISE EXCEPTION 'claim_next_task: caller agent_id % cannot claim as %', v_caller, p_agent_id
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  -- Skip events whose work items are no longer claimable.
  -- EXCEPT state_changed: these are routing events fired AFTER a task completes —
  -- the orchestrator needs to claim them to route follow-up work.
  UPDATE agent_graph.task_events te
  SET processed_at = now()
  FROM agent_graph.work_items wi
  WHERE te.work_item_id = wi.id
    AND te.processed_at IS NULL
    AND te.event_type != 'state_changed'
    AND wi.status IN ('cancelled', 'completed', 'timed_out');

  -- Now claim the next valid event.
  -- state_changed events are claimable even when the work item is completed
  -- (they trigger routing to the next pipeline stage).
  SELECT te.event_id, te.event_type, te.work_item_id, te.event_data
  INTO v_event
  FROM agent_graph.task_events te
  JOIN agent_graph.work_items wi ON wi.id = te.work_item_id
  WHERE (te.target_agent_id = p_agent_id OR te.target_agent_id = '*')
    -- Fleet routing (Phase 3): claim unrouted events, or events routed to THIS
    -- runner. When p_runner_id is NULL (legacy caller) only unrouted events match,
    -- so an unidentified caller never steals runner-pinned work.
    AND (te.target_runner_id IS NULL OR te.target_runner_id = p_runner_id)
    AND te.processed_at IS NULL
    AND (
      te.event_type = 'state_changed'
      OR wi.status IN ('assigned', 'created')
    )
  ORDER BY te.priority DESC, te.created_at
  FOR UPDATE OF te SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE agent_graph.task_events
  SET processed_at = now()
  WHERE agent_graph.task_events.event_id = v_event.event_id;

  RETURN QUERY SELECT v_event.event_id, v_event.event_type, v_event.work_item_id, v_event.event_data;
END;
$$;

-- Re-GRANT execute to autobot_agent (Postgres revokes ACLs on signature
-- changes; we re-grant defensively). Guarded for environments without the
-- role (PGlite local dev does not create autobot_agent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION agent_graph.claim_next_task(TEXT, TEXT) TO autobot_agent';
  END IF;
END $$;

-- Verify: the function exists with SECURITY DEFINER and the pinned search_path.
-- If migration 159's pattern recurs (a future migration drops + recreates
-- without the hardening), the next CI run on test/migration-123.test.js will
-- catch it — but this assertion catches it AT MIGRATION TIME, not test time.
DO $$
DECLARE
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT p.prosecdef, p.proconfig
  INTO v_secdef, v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'agent_graph'
    AND p.proname = 'claim_next_task'
  LIMIT 1;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'claim_next_task restoration failed: SECURITY DEFINER not applied';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) c WHERE c LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'claim_next_task restoration failed: search_path not pinned';
  END IF;
END $$;
