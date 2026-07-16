-- 050: Assignment rules for content pipeline (P2: infrastructure enforces)
-- claw-campaigner needs to assign work to executor-writer and content-atomizer.
-- executor-writer needs to assign work to content-atomizer (for LinkedIn derivation).
-- FK requires agent_configs entries first.

-- Agent config entries (FK targets for assignment rules)
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES ('executor-writer', 'executor', 'claude-sonnet-4-6', '5-phase content pipeline: research, grounding, draft, image, memory', 'migration-seed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES ('content-atomizer', 'executor', 'claude-haiku-4-5-20251001', 'Blog to LinkedIn post derivation with voice guide matching', 'migration-seed')
ON CONFLICT (id) DO NOTHING;

-- Assignment rules
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign) VALUES
  ('claw-campaigner', 'executor-writer'),
  ('claw-campaigner', 'content-atomizer'),
  ('executor-writer', 'content-atomizer')
ON CONFLICT (agent_id, can_assign) DO NOTHING;
