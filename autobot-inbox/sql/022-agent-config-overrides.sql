-- 022-agent-config-overrides.sql
-- Agent config overrides survive Railway deploys.
--
-- Problem: config/agents.json is committed to git. Railway's ephemeral
-- filesystem resets it on every deploy. Board members change agent models
-- via the UI, the write succeeds to disk, then the next deploy reverts it.
--
-- Solution: store overrides in Postgres. GET /api/agents/config reads
-- agents.json as base defaults and merges DB overrides on top.

CREATE TABLE IF NOT EXISTS agent_graph.agent_config_overrides (
  agent_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('model', 'temperature', 'maxTokens', 'enabled')),
  value TEXT NOT NULL,  -- JSON-encoded value
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (agent_id, field)
);

-- Model overrides (models config, not agent config)
CREATE TABLE IF NOT EXISTS agent_graph.model_config_overrides (
  model_key TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',  -- full model config override
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (model_key)
);
