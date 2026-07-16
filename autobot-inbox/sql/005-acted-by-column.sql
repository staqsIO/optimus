-- 005: Add acted_by column to action_proposals for multi-user audit trail.
-- Tracks which board member approved/rejected/edited each draft.

ALTER TABLE agent_graph.action_proposals
  ADD COLUMN IF NOT EXISTS acted_by TEXT;

COMMENT ON COLUMN agent_graph.action_proposals.acted_by IS 'Board member identity — GitHub username (web) or Telegram user ID';
