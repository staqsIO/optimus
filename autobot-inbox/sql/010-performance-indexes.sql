-- 010: Performance indexes for slow queries
-- tool_invocations INSERT was taking 2-3s, heartbeats 1s

-- Tool invocations: index on created_at for recent queries
CREATE INDEX IF NOT EXISTS idx_tool_invocations_recent
  ON agent_graph.tool_invocations(created_at DESC);

-- Agent heartbeats: unique on agent_id for upsert performance
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_unique
  ON agent_graph.agent_heartbeats(agent_id);

-- Config hash lookup (was taking 1.2s)
CREATE INDEX IF NOT EXISTS idx_agent_configs_hash_null
  ON agent_graph.agent_configs(id)
  WHERE is_active = true AND config_hash IS NULL;

-- Activity steps: agent + recent for per-agent queries
CREATE INDEX IF NOT EXISTS idx_activity_steps_agent_recent
  ON agent_graph.agent_activity_steps(agent_id, created_at DESC);
