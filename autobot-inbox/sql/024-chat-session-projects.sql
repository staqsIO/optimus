-- 024-chat-session-projects.sql
-- Link chat sessions to projects for project-scoped chat.
-- Adds project_id column to board_chat_sessions (denormalized for query perf).
-- project_memberships already supports 'chat_session' entity_type.

ALTER TABLE agent_graph.board_chat_sessions ADD COLUMN IF NOT EXISTS project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_project
  ON agent_graph.board_chat_sessions (project_id) WHERE project_id IS NOT NULL;
