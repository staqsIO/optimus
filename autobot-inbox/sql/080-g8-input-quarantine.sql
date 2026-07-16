-- Migration 080: G8 input quarantine columns on work_items
-- Mirrors the existing output_quarantined boolean (sql/001-baseline.sql:101).
-- input_quarantined = "untrusted input rejected before agent ran"
-- output_quarantined = "agent output blocked from shipping"
-- Set by lib/runtime/context-loader.js when MODEL_ARMOR_MODE=block and a
-- HIGH-confidence Model Armor prompt-injection match fires on email body.

ALTER TABLE agent_graph.work_items
  ADD COLUMN IF NOT EXISTS input_quarantined  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quarantine_reason  TEXT;

-- Partial index — only flagged rows pay storage cost.
CREATE INDEX IF NOT EXISTS work_items_input_quarantined_idx
  ON agent_graph.work_items(input_quarantined) WHERE input_quarantined = true;
