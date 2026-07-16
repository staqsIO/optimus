-- NemoClaw external agent support (2026-03-30)
-- Adds 'external' to agent_type CHECK constraint and inserts NemoClaw configs
-- so heartbeat tracking works (agent_heartbeats FK → agent_configs).

-- 1. Drop and recreate the CHECK constraint to include 'external'
ALTER TABLE agent_graph.agent_configs
  DROP CONSTRAINT IF EXISTS agent_configs_agent_type_check;

ALTER TABLE agent_graph.agent_configs
  ADD CONSTRAINT agent_configs_agent_type_check
  CHECK (agent_type IN ('orchestrator', 'strategist', 'executor', 'reviewer', 'architect', 'board', 'external'));

-- 2. Insert NemoClaw agent configs
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, is_active)
VALUES
  ('nemoclaw-eric', 'external', 'google/gemini-2.5-pro',
   'NemoClaw orchestration instance for Eric Gang. Interacts via Board API only.',
   '{}', 'nemoclaw-v1', true),
  ('nemoclaw-dustin', 'external', 'google/gemini-2.5-pro',
   'NemoClaw orchestration instance for Dustin Powers. Interacts via Board API only.',
   '{}', 'nemoclaw-v1', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Also update the heartbeat status CHECK to include 'online'
ALTER TABLE agent_graph.agent_heartbeats
  DROP CONSTRAINT IF EXISTS agent_heartbeats_status_check;

ALTER TABLE agent_graph.agent_heartbeats
  ADD CONSTRAINT agent_heartbeats_status_check
  CHECK (status IN ('idle', 'processing', 'stopped', 'online'));
