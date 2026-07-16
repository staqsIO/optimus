-- Migration 108: classification_level ordinal column (STAQPRO-310)
--
-- Fixes the lexicographic-comparison bug in lib/rag/retriever.js:121.
-- The classification column on content.documents / content.chunks /
-- content.wiki_pages stores ordered values (PUBLIC < INTERNAL <
-- CONFIDENTIAL < RESTRICTED by security sensitivity) as TEXT. Postgres
-- compares text lexicographically; the alphabetic order of these
-- values' first letters is:
--
--   CONFIDENTIAL (C=67) < INTERNAL (I=73) < PUBLIC (P=80) < RESTRICTED (R=82)
--
-- Which is *not* the security ordering. A filter `classification <= 'INTERNAL'`
-- already includes CONFIDENTIAL (leak above tier) and excludes PUBLIC
-- (hide below tier). retriever.js:121 uses exactly that filter and has
-- shipped this bug since migration 017.
--
-- match_chunks() in migration 017 has the same `<=` pattern but layers
-- an explicit IN-CASE expression on top that enumerates the correct
-- subset for each tier. That path is functionally safe but ugly;
-- cleaning it up to use classification_level is a separate follow-up.
-- This migration only adds the column + indexes; the retriever.js
-- companion change in this same PR switches lexicalChunkSearch over.
--
-- STORED GENERATED columns: classification_level is derived from
-- classification text at write time. No INSERT/UPDATE code changes
-- needed downstream — the column is read-only and auto-populated.
-- Postgres backfills existing rows when the column is added.
--
-- Refs: STAQPRO-310 (parent STAQPRO-252), Linus code-review finding,
-- plan ~/.claude/plans/let-me-pause-and-magical-codd.md Phase 0.

ALTER TABLE content.documents
  ADD COLUMN IF NOT EXISTS classification_level smallint
  GENERATED ALWAYS AS (
    CASE classification
      WHEN 'PUBLIC'       THEN 0
      WHEN 'INTERNAL'     THEN 1
      WHEN 'CONFIDENTIAL' THEN 2
      WHEN 'RESTRICTED'   THEN 3
    END
  ) STORED;

ALTER TABLE content.chunks
  ADD COLUMN IF NOT EXISTS classification_level smallint
  GENERATED ALWAYS AS (
    CASE classification
      WHEN 'PUBLIC'       THEN 0
      WHEN 'INTERNAL'     THEN 1
      WHEN 'CONFIDENTIAL' THEN 2
      WHEN 'RESTRICTED'   THEN 3
    END
  ) STORED;

ALTER TABLE content.wiki_pages
  ADD COLUMN IF NOT EXISTS classification_level smallint
  GENERATED ALWAYS AS (
    CASE classification
      WHEN 'PUBLIC'       THEN 0
      WHEN 'INTERNAL'     THEN 1
      WHEN 'CONFIDENTIAL' THEN 2
      WHEN 'RESTRICTED'   THEN 3
    END
  ) STORED;

-- Indexes for the new filtered-retrieval path. Mirrors
-- idx_chunks_classification on the text column from migration 017.
CREATE INDEX IF NOT EXISTS idx_documents_classification_level
  ON content.documents(classification_level);

CREATE INDEX IF NOT EXISTS idx_chunks_classification_level
  ON content.chunks(classification_level);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_classification_level
  ON content.wiki_pages(classification_level);

-- Verification: every row's classification_level must be non-NULL,
-- since classification has a CHECK constraint restricting it to one
-- of the four known values and the GENERATED CASE covers all four.
-- A non-zero count here indicates a row with NULL classification
-- (predating the CHECK or default) — that row needs UPDATE-set
-- before the retriever can be trusted.
DO $$
DECLARE
  v_docs_null   BIGINT;
  v_chunks_null BIGINT;
  v_wiki_null   BIGINT;
BEGIN
  SELECT count(*) INTO v_docs_null
    FROM content.documents
   WHERE classification_level IS NULL;

  SELECT count(*) INTO v_chunks_null
    FROM content.chunks
   WHERE classification_level IS NULL;

  SELECT count(*) INTO v_wiki_null
    FROM content.wiki_pages
   WHERE classification_level IS NULL;

  RAISE NOTICE '[108] content.documents rows with NULL classification_level: % (expect 0)', v_docs_null;
  RAISE NOTICE '[108] content.chunks rows with NULL classification_level: % (expect 0)', v_chunks_null;
  RAISE NOTICE '[108] content.wiki_pages rows with NULL classification_level: % (expect 0)', v_wiki_null;

  IF v_docs_null > 0 OR v_chunks_null > 0 OR v_wiki_null > 0 THEN
    RAISE WARNING '[108] At least one row has NULL classification_level — check classification text column for unexpected values';
  END IF;
END $$;
