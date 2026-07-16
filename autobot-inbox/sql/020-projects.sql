-- 020-projects.sql
-- Projects as first-class scoping concept (Liotta + Linus + Neo consensus)
--
-- Architecture: membership table, not FK everywhere.
-- Entities can span multiple projects. NULL = global.
-- Zero changes to existing tables.

-- ============================================================
-- 1. PROJECTS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.projects (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  classification_floor TEXT DEFAULT 'INTERNAL'
    CHECK (classification_floor IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  -- Linus: instructions sanitized on write, length-capped, NEVER in system prompt
  instructions TEXT CHECK (length(instructions) <= 4096),
  settings JSONB DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. PROJECT MEMBERSHIPS (junction table)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.project_memberships (
  project_id TEXT NOT NULL REFERENCES agent_graph.projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('chat_session', 'campaign', 'document', 'contact', 'work_item')),
  entity_id TEXT NOT NULL,
  added_by TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_entity
  ON agent_graph.project_memberships(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_pm_project
  ON agent_graph.project_memberships(project_id);

-- ============================================================
-- 3. PROJECT MEMORY (append-only, Linus: never UPDATE)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_graph.project_memory (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id TEXT NOT NULL REFERENCES agent_graph.projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  written_by TEXT NOT NULL,
  superseded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_memory_active
  ON agent_graph.project_memory(project_id, key)
  WHERE superseded_by IS NULL;

-- ============================================================
-- 4. HELPER FUNCTIONS
-- ============================================================

-- Get entity IDs belonging to a project
CREATE OR REPLACE FUNCTION agent_graph.in_project(
  p_project_id TEXT,
  p_entity_type TEXT
) RETURNS SETOF TEXT AS $$
  SELECT entity_id FROM agent_graph.project_memberships
  WHERE project_id = p_project_id AND entity_type = p_entity_type
$$ LANGUAGE SQL STABLE;

-- Get active (non-superseded) memory entries for a project
CREATE OR REPLACE FUNCTION agent_graph.project_memory_active(
  p_project_id TEXT
) RETURNS TABLE (key TEXT, value TEXT, written_by TEXT, created_at TIMESTAMPTZ) AS $$
  SELECT key, value, written_by, created_at
  FROM agent_graph.project_memory
  WHERE project_id = p_project_id AND superseded_by IS NULL
  ORDER BY created_at DESC
$$ LANGUAGE SQL STABLE;
