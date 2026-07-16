-- STAQPRO-303 PR-B-prereq.1b: SECURITY DEFINER for claim_next_task +
-- INSERT policy for llm_invocations.
--
-- Closes two gaps that would brick production the moment PR-B-prereq.1e's
-- FORCE ROW LEVEL SECURITY activates and PR-B-2 switches the Postgres pool
-- from superuser to the autobot_agent role:
--
--   1. claim_next_task() runs as caller (LANGUAGE plpgsql, no SECURITY
--      clause). Its internal UPDATE on agent_graph.task_events requires an
--      UPDATE policy on task_events — none is declared and none is planned
--      for the v2 policy set. Without this migration, the orchestrator
--      claim loop dies silently the moment FORCE activates.
--
--   2. agent_graph.llm_invocations has a SELECT policy but no INSERT
--      policy. Under FORCE, every LLM call's audit/cost write fails — a
--      silent break on every agent run.
--
-- Pattern matches 102-content-schedule-dequeue.sql:
--   - SECURITY DEFINER so the function executes with table-owner privileges
--     (bypasses RLS for its own body — RLS still applies to callers).
--   - SET search_path pinned to prevent SECURITY DEFINER hijack via
--     schema search-path attacks (CVE-class footgun on PG SECURITY DEFINER
--     functions).
--
-- Defense in depth: the function body now asserts that the caller's session
-- variable app.agent_id (set by setAgentContext via withAgentScope) matches
-- p_agent_id. Pre-PR-A-enforcement sessions have app.agent_id unset; the
-- check skips. Post-enforcement, a caller cannot pass someone else's
-- agent_id to claim their tasks.

-- ============================================================
-- 1. claim_next_task → SECURITY DEFINER + caller-identity assertion
-- ============================================================

CREATE OR REPLACE FUNCTION agent_graph.claim_next_task(
  p_agent_id TEXT
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
  -- STAQPRO-303 1b: caller-identity assertion. When app.agent_id is set
  -- (post-PR-A JWT enforcement), the function refuses to claim as a
  -- different agent. Pre-enforcement sessions (legacy callers, board API,
  -- migration scripts) leave app.agent_id unset → check skips and behavior
  -- matches pre-migration. After 1e ships and pool switches to autobot_agent,
  -- this is the *only* thing stopping cross-agent task hijack via SECURITY
  -- DEFINER bypass.
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

-- Grant explicit EXECUTE to autobot_agent so the role can call the function
-- once PR-B-2 switches the pool. CREATE OR REPLACE preserves existing grants
-- in PGlite but Postgres revokes ACLs on signature-changing replacements —
-- we re-grant defensively. Guarded for environments where the role does not
-- exist (PGlite local dev does not create autobot_agent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION agent_graph.claim_next_task(TEXT) TO autobot_agent';
  END IF;
END $$;

-- ============================================================
-- 2. llm_invocations INSERT policy
-- ============================================================
--
-- Existing baseline policy on this table:
--   CREATE POLICY agent_read_invocations ... FOR SELECT USING (
--     agent_id = agent_graph.current_agent_id() OR app.role='board'
--   );
--
-- No INSERT policy exists. Under FORCE, no UPDATE-INSERT-DELETE policy
-- = deny by default. Every LLM call's cost/audit write would fail silently.
--
-- This INSERT-only policy lets an agent write its own invocations and
-- nothing else. The board path (existing read policy `app.role='board'`)
-- is unchanged.

-- Guard with DROP IF EXISTS so the migration is idempotent under PGlite
-- (which sometimes silently keeps stale policy definitions across reruns).
DROP POLICY IF EXISTS agent_insert_invocations ON agent_graph.llm_invocations;

CREATE POLICY agent_insert_invocations ON agent_graph.llm_invocations
  FOR INSERT WITH CHECK (
    agent_id = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
  );
