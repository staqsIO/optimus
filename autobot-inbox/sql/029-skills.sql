-- Migration 029: Skills Repository
-- Unified skill registry for code tools, prompt playbooks, and composite skills.
-- Skills are tier-gated via permission_grants (P1 deny by default, P2 infrastructure enforces).

-- 1. Skills table
CREATE TABLE IF NOT EXISTS agent_graph.skills (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('code', 'prompt', 'composite')),
  description     TEXT,
  version         TEXT NOT NULL DEFAULT '1.0.0',
  handler_name    TEXT,        -- code skills: tool registry key
  playbook_id     TEXT,        -- prompt skills: playbook filename
  depends_on      TEXT[] NOT NULL DEFAULT '{}',  -- composite: ordered skill IDs
  required_tier   TEXT NOT NULL DEFAULT 'Executor'
    CHECK (required_tier IN ('Executor', 'Reviewer', 'Orchestrator', 'Architect', 'Strategist')),
  category        TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Extend permission_grants.resource_type CHECK to include 'skill'
ALTER TABLE agent_graph.permission_grants
  DROP CONSTRAINT IF EXISTS permission_grants_resource_type_check;
ALTER TABLE agent_graph.permission_grants
  ADD CONSTRAINT permission_grants_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api', 'skill'));

-- Also extend tool_invocations.resource_type for audit trail
ALTER TABLE agent_graph.tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_resource_type_check;
ALTER TABLE agent_graph.tool_invocations
  ADD CONSTRAINT tool_invocations_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api', 'skill'));

-- 3. Convenience view: agent_skills
CREATE OR REPLACE VIEW agent_graph.agent_skills AS
  SELECT pg.agent_id, s.*
  FROM agent_graph.permission_grants pg
  JOIN agent_graph.skills s ON s.id = pg.resource_name
  WHERE pg.resource_type = 'skill'
    AND pg.revoked_at IS NULL
    AND s.is_active = true;

-- 4. Seed from existing tools
INSERT INTO agent_graph.skills (id, name, type, handler_name, category, description) VALUES
  ('task_read', 'Read Tasks', 'code', 'task_read', 'graph', 'Read work items from the task graph'),
  ('task_create', 'Create Tasks', 'code', 'task_create', 'graph', 'Create new work items in the task graph'),
  ('message_fetch', 'Fetch Messages', 'code', 'message_fetch', 'inbox', 'Fetch email messages via adapter'),
  ('signal_extract', 'Extract Signals', 'code', 'signal_extract', 'signal', 'Extract actionable signals from messages'),
  ('db_query', 'Database Query', 'code', 'db_query', 'data', 'Execute read-only database queries'),
  ('web_search', 'Web Search', 'code', 'web_search', 'research', 'Search the web via API'),
  ('web_fetch', 'Web Fetch', 'code', 'web_fetch', 'research', 'Fetch web page content'),
  ('github', 'GitHub API', 'code', 'github', 'engineering', 'Interact with GitHub repos, issues, PRs'),
  ('linear', 'Linear API', 'code', 'linear', 'engineering', 'Interact with Linear issues and projects')
ON CONFLICT (id) DO NOTHING;

-- 5. Seed from existing playbooks
INSERT INTO agent_graph.skills (id, name, type, playbook_id, category, required_tier, description) VALUES
  ('implement-feature', 'Implement Feature', 'prompt', 'implement-feature', 'engineering', 'Orchestrator', 'End-to-end feature implementation playbook'),
  ('fix-bug', 'Fix Bug', 'prompt', 'fix-bug', 'engineering', 'Orchestrator', 'Bug investigation and fix playbook'),
  ('investigate', 'Investigate', 'prompt', 'investigate', 'research', 'Architect', 'Deep investigation and analysis playbook'),
  ('design-implement', 'Design & Implement', 'prompt', 'design-implement', 'engineering', 'Orchestrator', 'Design-first implementation playbook'),
  ('report', 'Generate Report', 'prompt', 'report', 'research', 'Architect', 'Research synthesis and report generation')
ON CONFLICT (id) DO NOTHING;

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_skills_type ON agent_graph.skills(type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_skills_category ON agent_graph.skills(category) WHERE is_active = true;
