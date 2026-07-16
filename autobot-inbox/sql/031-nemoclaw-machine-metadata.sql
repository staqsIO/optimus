-- 031: Add machine metadata columns to agent_heartbeats for NemoClaw visibility
ALTER TABLE agent_graph.agent_heartbeats
  ADD COLUMN IF NOT EXISTS machine_name TEXT,
  ADD COLUMN IF NOT EXISTS machine_arch TEXT,
  ADD COLUMN IF NOT EXISTS client_version TEXT;
