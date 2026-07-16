-- 027: Index for Tier 1 audit hash-chain query performance
-- The LAG window query over state_transitions was doing full seq-scans,
-- taking 44-50s and holding pool connections, causing cascading pool exhaustion.

CREATE INDEX IF NOT EXISTS idx_state_transitions_created_at
  ON agent_graph.state_transitions (created_at DESC);

-- Also index work_items for the stuck-task check
CREATE INDEX IF NOT EXISTS idx_work_items_status_updated
  ON agent_graph.work_items (status, updated_at)
  WHERE status = 'in_progress';
