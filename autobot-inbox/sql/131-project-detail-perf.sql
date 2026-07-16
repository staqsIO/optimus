-- 131-project-detail-perf.sql
-- STAQPRO-545: Projects view takes ~60s to load.
--
-- Root cause: GET /api/projects/detail runs a "files" query that joins
--   content.documents d ON d.id::text = pm.entity_id
-- Casting the UUID primary key to text (`d.id::text`) makes the documents
-- primary-key index unusable, so Postgres sequentially scans all ~6,466
-- documents for every document membership row. With 6k+ docs this is the
-- ~1-1.7s "[db] Slow query" hit, compounded across the project-detail path.
--
-- The query is rewritten (in projects.js) to cast the SMALL side instead:
--   d.id = pm.entity_id::uuid
-- which lets the planner use content.documents_pkey. This migration adds the
-- supporting index on the memberships side so the document subset is fetched
-- by index rather than scanned.
--
-- Existing indexes (from 020-projects.sql):
--   - idx ON project_memberships(entity_type, entity_id)
--   - idx ON project_memberships(project_id)
-- Neither serves "project_id = $1 AND entity_type = 'document' ORDER BY added_at DESC"
-- efficiently. The composite below covers the counts GROUP BY, the recentMembers
-- ORDER BY, and the files filter in one index.

-- Composite index serving the project-detail queries:
--   - files:        WHERE project_id=$1 AND entity_type='document' ORDER BY added_at DESC LIMIT 100
--   - counts:       WHERE project_id=$1 GROUP BY entity_type
--   - recentMembers WHERE project_id=$1 ORDER BY added_at DESC LIMIT 20
-- The (project_id, entity_type, added_at DESC) ordering lets the planner satisfy the
-- WHERE + ORDER BY + LIMIT with early termination (no top-N heapsort over thousands
-- of membership rows). DBA-reviewed against prod EXPLAIN (STAQPRO-545): files query
-- dropped from ~15s (returning all 6,523 rows) to ~0.3s warm with the LIMIT + this index.
--
-- NOTE: built inline (not CONCURRENTLY) — works on PGlite (test path) and is sub-second
-- on project_memberships (~6.5k rows). For a very large prod table, run
--   CREATE INDEX CONCURRENTLY idx_project_memberships_project_type_added
--     ON agent_graph.project_memberships (project_id, entity_type, added_at DESC);
-- out-of-band first, then this IF NOT EXISTS becomes a no-op.
CREATE INDEX IF NOT EXISTS idx_project_memberships_project_type_added
  ON agent_graph.project_memberships (project_id, entity_type, added_at DESC);

-- Note on the ::uuid cast in projects.js: document-type memberships always store a
-- valid content.documents UUID in entity_id (it is the document's id), so casting
-- pm.entity_id::uuid in the files join is safe and lets the planner use the documents
-- primary key. No data mutation here — index creation + ANALYZE only.

ANALYZE agent_graph.project_memberships;
