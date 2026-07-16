-- 053: executor-contract agent setup
-- Agent config, assignment rules, and permission grants for the contract engine.
--
-- 2026-05: rewritten to match actual schemas (defined in 001-baseline.sql).
-- Original migration referenced columns that don't exist:
--   agent_configs(tier, description, created_by) — actual columns are
--     (id, agent_type, model, system_prompt, tools_allowed, config_hash, ...)
--   agent_assignment_rules(assigner_id, assignee_id) — actual columns are
--     (id, agent_id, can_assign)
-- Both INSERTs were rejected by Postgres before they could run.

-- Agent config
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES (
  'executor-contract',
  'executor',
  'claude-sonnet-4-6-20250514',
  'AI contract/proposal generation from templates.',
  'migration-053-seed'
)
ON CONFLICT (id) DO NOTHING;

-- Assignment rules: claw-campaigner can delegate to executor-contract
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
VALUES ('claw-campaigner', 'executor-contract')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- Permission grants
INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-contract', 'api_client', 'llm_invoke', 'Internal', 'anthropic:sonnet', 'migration'),
  ('executor-contract', 'api_client', 'web_fetch', 'External-Read', 'web:*', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;

-- Contract templates table (optional — templates can also live as files)
CREATE TABLE IF NOT EXISTS content.contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'service_proposal',
  variables JSONB DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
