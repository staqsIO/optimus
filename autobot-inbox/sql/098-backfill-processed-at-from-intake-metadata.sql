-- Migration 098: backfill inbox.messages.processed_at from intake metadata (STAQPRO-280)
--
-- M1 was reading 55.31% even after the metric scope fix in 097. Diagnosis:
-- the executor-intake handler classifies emails (writing the result into
-- the child work_item's metadata.triage_result.category) but never writes
-- back to inbox.messages. processed_at and triage_category therefore stay
-- NULL forever. The view counts them as "stuck" even though intake handled
-- them successfully.
--
-- The going-forward fix is in agents/executor-intake/index.js: a new
-- markMessageProcessed() helper writes back to inbox.messages at every
-- classification return point. New emails will land correctly.
--
-- This migration backfills the historical gap. For every email message
-- whose work_item has a child triage subtask carrying a triage_result, we
-- copy the category + confidence into inbox.messages and set processed_at
-- to the child work_item's updated_at (the closest signal we have for
-- "when intake finished"). Idempotent — only touches rows still NULL.

UPDATE inbox.messages m
SET
  processed_at = COALESCE(m.processed_at, child_wi.updated_at),
  triage_category = (child_wi.metadata->'triage_result'->>'category'),
  triage_confidence = NULLIF(child_wi.metadata->'triage_result'->>'quick_score', '')::numeric
FROM agent_graph.work_items child_wi
WHERE child_wi.parent_id = m.work_item_id
  AND m.processed_at IS NULL
  AND m.archived_at IS NULL
  AND m.channel = 'email'
  AND child_wi.assigned_to IN ('executor-intake', 'executor-triage')
  AND child_wi.metadata->'triage_result'->>'category' IS NOT NULL;

DO $$
DECLARE v_m1 NUMERIC;
BEGIN
  SELECT m1_inbox_zero_rate_pct INTO v_m1 FROM agent_graph.v_phase1_metrics;
  RAISE NOTICE '[098] M1 inbox-zero rate after backfill (was 55.31, target ≥ 90): %', v_m1;
END $$;
