-- Migration 103: embedding column on agent_graph.action_proposals (STAQPRO-301)
--
-- Phase 1 metric M3 is being redefined from "approval accuracy" (which
-- requires the unused /drafts board approve flow — see STAQPRO-296) to
-- voice similarity between the AI draft and Eric's actual sent reply on
-- the same thread. The sent-reply side is already embedded in
-- voice.sent_emails.embedding (1024-dim Voyage voyage-3.5-lite, 1011
-- rows in production). The draft side has no embedding storage yet.
--
-- This migration:
--   1. Adds embedding (vector(1024)) to action_proposals when pgvector
--      is available; falls back to JSONB on PGlite/CI so tests can
--      still assert column presence.
--   2. Adds an HNSW cosine-ops index over the new column.
--   3. Adds a partial b-tree index over (created_at DESC) for the
--      email_draft / embedding IS NULL backfill queue scan.
--
-- The actual embedding generation is wired up in
-- autobot-inbox/src/voice/embeddings.js#generateDraftEmbeddings()
-- and swept periodically from src/index.js (mirrors the TLDv poller
-- pattern). M3 v_phase1_metrics rewrite is migration 104.
--
-- Refs: STAQPRO-301, STAQPRO-296 Decision A, parent STAQPRO-252.

DO $$
DECLARE
  v_has_vector BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;

  IF v_has_vector THEN
    EXECUTE 'ALTER TABLE agent_graph.action_proposals
             ADD COLUMN IF NOT EXISTS embedding vector(1024)';
  ELSE
    -- PGlite / no-pgvector: store as JSONB so the column exists for
    -- tests + the embedding worker degrades gracefully. The metric
    -- subquery in migration 104 returns NULL without pgvector anyway.
    EXECUTE 'ALTER TABLE agent_graph.action_proposals
             ADD COLUMN IF NOT EXISTS embedding JSONB';
  END IF;
END $$;

-- HNSW for cosine distance — only with pgvector. Mirrors the voice.sent_emails
-- index pattern (idx_sent_emails_embedding) so query plans stay symmetric.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_action_proposals_embedding
             ON agent_graph.action_proposals
             USING hnsw (embedding vector_cosine_ops)
             WHERE embedding IS NOT NULL';
  END IF;
END $$;

-- Backfill queue scan: the periodic sweep selects email drafts that
-- still need embedding, newest first. Partial index keeps it tiny —
-- once a row is embedded, it drops out of the index.
CREATE INDEX IF NOT EXISTS idx_action_proposals_embed_pending
  ON agent_graph.action_proposals (created_at DESC)
  WHERE action_type = 'email_draft' AND embedding IS NULL;

-- Verification
DO $$
DECLARE
  v_has_vector BOOLEAN;
  v_col_exists BOOLEAN;
  v_index_count INTEGER;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'agent_graph'
       AND table_name = 'action_proposals'
       AND column_name = 'embedding'
  ) INTO v_col_exists;
  SELECT count(*) INTO v_index_count
    FROM pg_indexes
   WHERE schemaname = 'agent_graph'
     AND tablename = 'action_proposals'
     AND indexname IN ('idx_action_proposals_embedding', 'idx_action_proposals_embed_pending');

  RAISE NOTICE '[103] pgvector present: %', v_has_vector;
  RAISE NOTICE '[103] embedding column exists: %', v_col_exists;
  RAISE NOTICE '[103] supporting indexes created: % (expect 2 with pgvector, 1 without)', v_index_count;
END $$;
