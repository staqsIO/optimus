-- 004: Fix pipeline routing + executor-responder permission grants
--
-- Two critical fixes:
-- 1. claim_next_task() was filtering out state_changed events because the work
--    item is already 'completed'. This broke ALL downstream routing — executor-
--    responder never received work, draft queue was permanently empty.
-- 2. executor-responder had zero permission_grants — would get Permission denied
--    errors even if routing worked.

-- Fix 1: Replace claim_next_task to handle state_changed events
CREATE OR REPLACE FUNCTION agent_graph.claim_next_task(
  p_agent_id TEXT
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

-- Fix 2: executor-responder permission grants
INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-responder', 'adapter', 'gmail',    'External-Read', 'gmail:readonly',    'migration'),
  ('executor-responder', 'adapter', 'outlook',  'External-Read', 'outlook:readonly',  'migration'),
  ('executor-responder', 'adapter', 'slack',    'External-Read', 'slack:read',        'migration'),
  ('executor-responder', 'adapter', 'telegram', 'External-Read', 'telegram:read',     'migration'),
  ('executor-responder', 'adapter', 'webhook',  'Internal',      NULL,                'migration'),
  ('executor-responder', 'tool', 'draft_create',  'Internal', NULL, 'migration'),
  ('executor-responder', 'tool', 'voice_query',   'Internal', NULL, 'migration'),
  ('executor-responder', 'tool', 'gmail_fetch',   'External-Read', 'gmail:readonly', 'migration')
ON CONFLICT DO NOTHING;
