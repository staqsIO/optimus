-- 159-fleet-runner-routing.sql
-- Phase 3 (fleet): make work routable to a specific runner and the claim
-- runner-aware, so a fleet of subscription machines can each pull only the work
-- routed to them (or unrouted '*' work). NO new transport — distribution falls
-- out of the existing atomic claim, now partitioned by runner.
--
-- Backward compatible: target_runner_id defaults NULL (every existing event is
-- claimable by anyone), and claim_next_task gains a defaulted p_runner_id so
-- existing claim_next_task($1) callers keep working (they see only NULL-targeted
-- events, which is all of them today).

BEGIN;

-- Route a task event to a specific runner. NULL = any runner may claim.
ALTER TABLE agent_graph.task_events
  ADD COLUMN IF NOT EXISTS target_runner_id TEXT;

-- A runner advertises which capabilities (agent ids) it can serve, so the
-- orchestrator can pick an online runner for a given work-item type.
ALTER TABLE agent_graph.agent_heartbeats
  ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_task_events_target_runner
  ON agent_graph.task_events (target_runner_id) WHERE target_runner_id IS NOT NULL;

-- Replace the 1-arg claim with a 2-arg, runner-aware version. Drop the old
-- signature first so claim_next_task($1) unambiguously resolves to the new
-- function with p_runner_id defaulting to NULL.
DROP FUNCTION IF EXISTS agent_graph.claim_next_task(TEXT);

CREATE OR REPLACE FUNCTION agent_graph.claim_next_task(
  p_agent_id TEXT,
  p_runner_id TEXT DEFAULT NULL
) RETURNS TABLE (
  event_id TEXT,
  event_type TEXT,
  work_item_id TEXT,
  event_data JSONB
) AS $$
DECLARE
  v_event RECORD;
BEGIN
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
$$ LANGUAGE plpgsql;

COMMIT;
