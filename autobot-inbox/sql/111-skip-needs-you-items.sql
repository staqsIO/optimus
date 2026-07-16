-- Migration 111: Skip support for /board "Needs you" lane (ADR-005).
--
-- Two additive changes:
--   1) Set agent_graph.action_proposals.board_action CHECK constraint to the
--      full whitelist used by the system today: the four board verdicts
--      ('approved','edited','rejected','skipped') plus the two auto-archive
--      states ('archived_external','archived_no_reply') that the
--      gmail-reconciler sweep has been writing since migration 088. Production
--      was patched mid-2026-05 to accept the archived_* values, leaving 143
--      such rows in place; this migration codifies that whitelist so the
--      runner stops failing on every boot and PGlite/fresh installs match
--      prod.
--   2) Add agent_graph.needs_attention_log.acknowledgment_reason TEXT (nullable)
--      so the board can leave a note when acknowledging without resolving the
--      underlying issue.
--
-- M3/M4 (draft accuracy / edit rate) already filter to
--   board_action IN ('approved','edited','rejected')
-- per migration 093, so adding 'skipped' / 'archived_*' to the CHECK set does
-- NOT shift those metrics. Skip + archive are intentionally outside the
-- quality signal.

-- 1) action_proposals.board_action CHECK
ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_board_action_check;

ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_board_action_check
  CHECK (board_action IS NULL OR board_action IN (
    'approved', 'edited', 'rejected', 'skipped',
    'archived_external', 'archived_no_reply'
  ));

-- 2) needs_attention_log.acknowledgment_reason
ALTER TABLE agent_graph.needs_attention_log
  ADD COLUMN IF NOT EXISTS acknowledgment_reason TEXT;

COMMENT ON COLUMN agent_graph.needs_attention_log.acknowledgment_reason IS
  'Free-text reason the board acked this without resolving. Optional. See ADR-005.';

-- Verification
DO $$
DECLARE
  v_constraint_def TEXT;
  v_col_exists     BOOLEAN;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_constraint_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'agent_graph'
     AND t.relname = 'action_proposals'
     AND c.conname = 'action_proposals_board_action_check';
  RAISE NOTICE '[111] board_action CHECK: %', v_constraint_def;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'agent_graph'
       AND table_name = 'needs_attention_log'
       AND column_name = 'acknowledgment_reason'
  ) INTO v_col_exists;
  RAISE NOTICE '[111] acknowledgment_reason column present: %', v_col_exists;
END $$;
