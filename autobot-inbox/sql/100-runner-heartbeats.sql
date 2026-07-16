-- 100-runner-heartbeats.sql
--
-- Add runner_id to agent_graph.agent_heartbeats so multiple runners (Railway
-- primary, M1 satellite, future) can heartbeat for the same agent without
-- clobbering each other's row. The pre-existing PRIMARY KEY (agent_id) made
-- last-writer-win for any agent that runs in both places (executor-research,
-- claw-campaigner, content-atomizer), corrupting per-runner visibility.
--
-- Strategy: add runner_id with a default so existing inserts don't fail,
-- backfill legacy rows, then swap the primary key to (agent_id, runner_id).
-- machine_name + pid columns already exist; this migration just makes
-- runner_id the canonical identity used by the writer and the dashboard.

ALTER TABLE agent_graph.agent_heartbeats
  ADD COLUMN IF NOT EXISTS runner_id TEXT NOT NULL DEFAULT 'unknown';

UPDATE agent_graph.agent_heartbeats
  SET runner_id = COALESCE(machine_name, 'legacy')
  WHERE runner_id = 'unknown';

ALTER TABLE agent_graph.agent_heartbeats
  DROP CONSTRAINT IF EXISTS agent_heartbeats_pkey;

DROP INDEX IF EXISTS agent_graph.idx_agent_heartbeats_agent_unique;

ALTER TABLE agent_graph.agent_heartbeats
  ADD PRIMARY KEY (agent_id, runner_id);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_runner_id
  ON agent_graph.agent_heartbeats (runner_id, heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_recent
  ON agent_graph.agent_heartbeats (heartbeat_at DESC);
