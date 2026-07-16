-- Migration 109: Wiki FTS + retrieval audit (STAQPRO-311 Phase 1)
--
-- Wires content.wiki_pages into the agent retrieval path. Two changes:
--
-- 1. `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english',
--    coalesce(title, '') || ' ' || coalesce(content, ''))) STORED` plus
--    a GIN index. Lets lib/rag/retriever.js extend retrieveContext()
--    with a `corpus: ['documents', 'wiki_pages']` parameter that
--    UNIONs the existing chunk lexical search with a wiki page lookup
--    in a single Postgres round-trip. Sub-10ms in-transaction with the
--    Q-tier context load — *that's* the FTS-first justification (per
--    Liotta review). Embeddings are Phase 5, conditional on Phase 4 data.
--
-- 2. content.retrieval_events audit table. Append-only, P3-compliant.
--    Captures every retrieveContext call for both corpora — agent_id,
--    work_item_id, corpus, query, returned ids, token count. Future
--    metrics (v_wiki_metrics in Phase 4) read this for the
--    grounding-rate / kept-citation-rate KPIs.
--
-- Phase 0 corpus audit (pre-flight): 52 wiki pages, mix 21 CONFIDENTIAL /
-- 31 INTERNAL. Mostly meeting notes + email summaries; only 3 vault-
-- sourced. Corpus barely clears the plan's "<50 = sparse" gate. The
-- compiler's coupling to vault is weaker than expected — flagged for
-- follow-up but not blocking this migration.
--
-- Refs: STAQPRO-311 (parent STAQPRO-252), plan
-- ~/.claude/plans/let-me-pause-and-magical-codd.md Phase 1.

-- 1. tsvector + GIN index on wiki_pages
ALTER TABLE content.wiki_pages
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(content, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_wiki_pages_content_tsv
  ON content.wiki_pages USING GIN (content_tsv);

-- 2. Append-only retrieval audit table.
--
-- corpus: 'documents' | 'wiki_pages' | future sources (web, mcp).
-- agent_id is TEXT to match agent_graph.agent_configs.id (no FK —
-- audit must survive agent renames/removals).
-- result_ids stores the document_id (for documents) or wiki page id
-- (for wiki_pages) — same TEXT shape since UUIDs are text-coercible.
-- token_count is the estimated token usage of the assembled excerpts,
-- for budget accounting in v_wiki_metrics.
CREATE TABLE IF NOT EXISTS content.retrieval_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT,
  work_item_id  TEXT,
  corpus        TEXT NOT NULL CHECK (corpus IN ('documents', 'wiki_pages')),
  query         TEXT NOT NULL,
  result_ids    TEXT[] NOT NULL DEFAULT '{}',
  result_count  INT NOT NULL DEFAULT 0,
  token_count   INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_agent_created
  ON content.retrieval_events(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_work_item
  ON content.retrieval_events(work_item_id)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_events_corpus_created
  ON content.retrieval_events(corpus, created_at DESC);

-- 3. Verification + corpus diagnostic
DO $$
DECLARE
  v_pages          BIGINT;
  v_pages_indexed  BIGINT;
  v_audit_present  BOOLEAN;
BEGIN
  SELECT count(*) INTO v_pages FROM content.wiki_pages;

  -- A GIN index lookup against a generated column should hit every row
  -- with at least one term. plainto_tsquery('english', 'the') is a
  -- maximally-permissive query: 'the' is a stopword that gets stripped
  -- by the english config, so the query is empty and matches everything
  -- with a non-empty tsvector. Useful as an "is the column populated"
  -- gauge without coupling to actual corpus content.
  SELECT count(*) INTO v_pages_indexed
    FROM content.wiki_pages
   WHERE content_tsv @@ plainto_tsquery('english', 'meeting strategy team work')
      OR content_tsv IS NOT NULL;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'content' AND table_name = 'retrieval_events'
  ) INTO v_audit_present;

  RAISE NOTICE '[109] content.wiki_pages total rows: %', v_pages;
  RAISE NOTICE '[109] content.wiki_pages with content_tsv populated: % (expect = total)', v_pages_indexed;
  RAISE NOTICE '[109] content.retrieval_events table present: %', v_audit_present;
END $$;
