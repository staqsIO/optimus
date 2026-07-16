-- 173-agent-memories-entities-gin.sql
-- OPT-134 (feature 010-D scale path): GIN index over the entities array in
-- agent_memories.metadata. Lets relevance recall pull entity-matched memories
-- of ANY age via jsonb containment
--   metadata->'entities' @> '[{"email":"x@y.co"}]'
-- instead of loading a fixed recency pool (the old ≤200 ceiling). Partial on
-- active rows — recall ignores superseded memories.

CREATE INDEX IF NOT EXISTS idx_agent_memories_entities_gin
  ON agent_graph.agent_memories USING GIN ((metadata -> 'entities'))
  WHERE superseded_by IS NULL;
