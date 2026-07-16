-- 022-project-members-types.sql
-- Expand entity_type CHECK to include board_user and agent types.
ALTER TABLE agent_graph.project_memberships DROP CONSTRAINT IF EXISTS project_memberships_entity_type_check;
ALTER TABLE agent_graph.project_memberships ADD CONSTRAINT project_memberships_entity_type_check
  CHECK (entity_type IN ('chat_session', 'campaign', 'document', 'contact', 'work_item', 'board_user', 'agent'));
