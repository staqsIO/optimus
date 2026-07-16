-- Rename NemoClaw agent IDs to match github_username pattern used by heartbeat code.
-- Heartbeat writes `nemoclaw-${github_username}`, so DB IDs must match.

-- Delete old entries (heartbeats FK cascade not set, so delete heartbeats first)
DELETE FROM agent_graph.agent_heartbeats WHERE agent_id IN ('nemoclaw-eric', 'nemoclaw-dustin');
DELETE FROM agent_graph.agent_configs WHERE id IN ('nemoclaw-eric', 'nemoclaw-dustin');

-- Insert with correct IDs matching github usernames
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash, is_active)
VALUES
  ('nemoclaw-ecgang', 'external', 'google/gemini-2.5-pro',
   'NemoClaw orchestration instance for Eric Gang. Interacts via Board API only.',
   '{}', 'nemoclaw-v1', true),
  ('nemoclaw-ConsultingFuture4200', 'external', 'google/gemini-2.5-pro',
   'NemoClaw orchestration instance for Dustin Powers. Interacts via Board API only.',
   '{}', 'nemoclaw-v1', true)
ON CONFLICT (id) DO NOTHING;
