-- 118-match-chunks-ordinal.sql — STAQPRO-313
--
-- STAQPRO-310 / PR #197 fixed the lexicographic data-leak in
-- lib/rag/retriever.js#lexicalChunkSearch by filtering on the
-- classification_level smallint ordinal (migration 108). content.match_chunks()
-- was never cleaned up: migration 058 still carries the verbose CASE-IN block
-- that enumerates the correct subset per tier (functionally correct, but
-- fragile — a 5th classification tier would be silently missed, and it's a
-- different filter shape than lexicalChunkSearch).
--
-- This migration switches match_chunks() to the same ordinal filter:
--   AND c.classification_level <= max_classification_level
--
-- Signature change: max_classification TEXT  →  max_classification_level
-- SMALLINT. The single caller (lib/rag/retriever.js) is updated in the same
-- change to pass the numeric level via toClassificationLevel(). No back-compat
-- TEXT overload — there is exactly one caller and keeping two signatures
-- reintroduces the "two places to fix" hazard this ticket exists to remove.
--
-- Level mapping (from migration 108): 0=PUBLIC, 1=INTERNAL, 2=CONFIDENTIAL,
-- 3=RESTRICTED. An agent with ceiling level L sees chunks where
-- classification_level <= L.

CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL,
  max_classification_level SMALLINT DEFAULT 1,
  include_org_wide BOOLEAN DEFAULT TRUE,
  shared_documents_only BOOLEAN DEFAULT FALSE,
  filter_participant_ids UUID[] DEFAULT NULL,
  boost_participant_ids UUID[] DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  document_id UUID,
  text TEXT,
  metadata JSONB,
  similarity FLOAT,
  document_participants JSONB,
  participant_match BOOLEAN
) AS $$
  SELECT
    c.id,
    c.document_id,
    c.text,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity,
    d.participants AS document_participants,
    CASE
      WHEN boost_participant_ids IS NULL THEN FALSE
      ELSE EXISTS (
        SELECT 1
        FROM unnest(boost_participant_ids) bid
        WHERE d.participants @> jsonb_build_array(
          jsonb_build_object('contact_id', bid::text)
        )
      )
    END AS participant_match
  FROM content.chunks c
  JOIN content.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > min_similarity
    AND d.sanitized = true
    AND d.deleted_at IS NULL
    AND (
      CASE
        WHEN shared_documents_only THEN d.owner_id IS NULL
        WHEN filter_owner_id IS NULL THEN TRUE
        WHEN include_org_wide THEN (d.owner_id IS NULL OR d.owner_id = filter_owner_id)
        ELSE d.owner_id = filter_owner_id
      END
    )
    -- STAQPRO-313: ordinal classification ceiling. Replaces the migration-058
    -- CASE-IN block. NULL classification_level (legacy/unbackfilled chunks)
    -- is excluded by the comparison — fail-closed, matching lexicalChunkSearch.
    AND c.classification_level <= max_classification_level
    AND (
      filter_participant_ids IS NULL
      OR EXISTS (
        SELECT 1
        FROM unnest(filter_participant_ids) fid
        WHERE d.participants @> jsonb_build_array(
          jsonb_build_object('contact_id', fid::text)
        )
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE SQL STABLE;

-- Drop EVERY classification-bearing TEXT-signature overload so no call path
-- can resolve to the old lexicographic / CASE-IN logic. Postgres keeps
-- overloads side-by-side; CREATE OR REPLACE above only replaced same-arity
-- same-types, so these legacy shapes (migrations 017 / 034 / 057 / 058)
-- survived until now. IF EXISTS keeps the migration idempotent across fresh
-- PGlite and already-migrated Supabase.
--   9-arg (migration 058): the live shape retriever.js used to call
DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, TEXT, BOOLEAN, BOOLEAN, UUID[], UUID[]
);
--   7-arg (migrations 034 / 057): CASE-IN over text classification
DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, TEXT, BOOLEAN, BOOLEAN
);
--   5-arg (migration 017): the original lexicographic `<=` + CASE-IN hack
DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, TEXT
);
