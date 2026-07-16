-- 140-backfill-project-memberships.sql
-- STAQPRO-551: Project entity counters all 0 (campaigns/sessions) despite documents.
--
-- Root cause: a project's counters (projects.js) read exclusively from
-- agent_graph.project_memberships(entity_type=...). Documents got linked
-- (research-source-poller), but campaigns and chat sessions never had their
-- membership rows written on the create path. The write-path inserts are now
-- wired in:
--   - src/api-routes/campaigns.js   (entity_type='campaign', from body.project_id/slug)
--   - src/api-routes/agents.js      (entity_type='chat_session', for project-scoped chats)
--
-- This migration backfills the rows that pre-date those write-path fixes so the
-- counters reflect history, not just new activity.
--
-- IDEMPOTENT + SAFE TO RUN TWICE:
--   * INSERT ... SELECT ... WHERE NOT EXISTS + ON CONFLICT DO NOTHING
--   * Each ALTER/SELECT is guarded; no column is assumed to exist.
--   * No UPDATE/DELETE of existing data. Additive only.
--
-- HELD FOR ERIC: do NOT run against prod manually. This runs at deploy via the
-- standard migrate step (additive/idempotent).

-- ============================================================
-- 1. CHAT SESSIONS  (real backfill — board_chat_sessions.project_id exists, mig 024)
-- ============================================================
-- Every project-scoped session that lacks a membership row gets one. The
-- session id is the entity_id. FK to agent_graph.projects(id) is enforced by
-- the join, so orphaned project_ids are silently skipped (no FK violation).
INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
SELECT s.project_id, 'chat_session', s.id::text, 'backfill-140'
FROM agent_graph.board_chat_sessions s
JOIN agent_graph.projects p ON p.id = s.project_id
WHERE s.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_graph.project_memberships pm
    WHERE pm.project_id = s.project_id
      AND pm.entity_type = 'chat_session'
      AND pm.entity_id = s.id::text
  )
ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING;

-- ============================================================
-- 2. CAMPAIGNS  (conditional backfill — only if a project_id column exists)
-- ============================================================
-- agent_graph.campaigns does NOT carry a project_id column today; the campaign->
-- project link lives solely in project_memberships, written on the create path
-- going forward. If a project_id column is ever added to campaigns, this block
-- backfills from it without needing a new migration. Guarded so it is a no-op
-- (and never errors) on the current schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'agent_graph'
      AND table_name = 'campaigns'
      AND column_name = 'project_id'
  ) THEN
    INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
    SELECT c.project_id, 'campaign', c.id::text, 'backfill-140'
    FROM agent_graph.campaigns c
    JOIN agent_graph.projects p ON p.id = c.project_id
    WHERE c.project_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_graph.project_memberships pm
        WHERE pm.project_id = c.project_id
          AND pm.entity_type = 'campaign'
          AND pm.entity_id = c.id::text
      )
    ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING;
  END IF;
END $$;
