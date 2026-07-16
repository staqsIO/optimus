-- 026: Register issue-triage agent and grant assignment permissions
-- P2 enforcement: agent_assignment_rules FK requires agent_configs entry
-- Without these rules, issue-triage gets: "Agent is not authorized to assign work to" errors

-- Agent config entry (FK target for assignment rules)
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES ('issue-triage', 'executor', 'claude-haiku-4-5-20251001', 'Proactive issue triage and auto-assignment', 'migration-seed')
ON CONFLICT (id) DO NOTHING;

-- Assignment rules: issue-triage can create work items assigned to claw runners
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
VALUES
  ('issue-triage', 'claw-workshop'),
  ('issue-triage', 'claw-campaigner')
ON CONFLICT (agent_id, can_assign) DO NOTHING;
