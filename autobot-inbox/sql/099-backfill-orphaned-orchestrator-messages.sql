-- Migration 099: backfill orphaned orchestrator-skipped messages (STAQPRO-281)
--
-- The orchestrator's handleNewEmailTask silent-skipped 189 work_items in
-- the last 7 days when context.email was null, leaving them stranded in
-- 'created' state and their underlying email rows with NULL processed_at
-- / NULL archived_at. This is the root cause of M1 staying at 58%.
--
-- The going-forward fix in agents/orchestrator/index.js archives the
-- message and cancels the work_item explicitly (instead of silent-success).
--
-- This migration backfills the historical orphans:
--   - inbox.messages.archived_at = COALESCE(wi.updated_at, received_at + 1m)
--     (best estimate of when the orchestrator gave up on it)
--   - inbox.messages.triage_category = 'orphaned'
--   - work_items get a sentinel marker in metadata noting they're orphaned.
--     We do NOT transition them to 'cancelled' here — that would emit
--     side-effect events; the going-forward fix handles new ones cleanly,
--     and stranded historical work_items are harmless.
--
-- Pattern matches: email message has a work_item, work_item is still in
-- 'created' state, and there's no child triage subtask under it (the
-- orchestrator never created the routing fanout).

UPDATE inbox.messages m
SET
  archived_at = COALESCE(m.archived_at, wi.updated_at, m.received_at + interval '1 minute'),
  triage_category = COALESCE(m.triage_category, 'orphaned')
FROM agent_graph.work_items wi
WHERE wi.id = m.work_item_id
  AND wi.status = 'created'
  AND m.processed_at IS NULL
  AND m.archived_at IS NULL
  AND m.channel = 'email'
  AND NOT EXISTS (
    SELECT 1 FROM agent_graph.work_items child
    WHERE child.parent_id = wi.id
      AND child.assigned_to IN ('executor-intake', 'executor-triage')
  );

DO $$
DECLARE v_m1 NUMERIC; v_stuck BIGINT;
BEGIN
  SELECT m1_inbox_zero_rate_pct INTO v_m1 FROM agent_graph.v_phase1_metrics;
  SELECT COUNT(*) INTO v_stuck
  FROM inbox.messages
  WHERE channel = 'email'
    AND received_at >= now() - interval '7 days'
    AND processed_at IS NULL AND archived_at IS NULL;
  RAISE NOTICE '[099] M1 inbox-zero rate (was 58.68): %', v_m1;
  RAISE NOTICE '[099] Still-stuck emails (was 188): %', v_stuck;
END $$;
