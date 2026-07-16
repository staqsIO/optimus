-- 017-rag-classification.sql
-- Phase 0: RAG security hardening (Linus blockers)
--
-- 1. Add classification column to documents and chunks
-- 2. Update match_chunks() to filter by max classification level
-- 3. Add index for classification filtering

-- Classification levels (ordered by sensitivity)
-- PUBLIC: safe for any agent or external exposure
-- INTERNAL: board members + agents only (default for existing docs)
-- CONFIDENTIAL: board members only, PII-flagged content
-- RESTRICTED: requires explicit board approval to access

ALTER TABLE content.documents
  ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'INTERNAL'
  CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'));

ALTER TABLE content.chunks
  ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'INTERNAL'
  CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'));

-- Propagate classification from document to its chunks
UPDATE content.chunks c
SET classification = d.classification
FROM content.documents d
WHERE c.document_id = d.id
  AND c.classification IS DISTINCT FROM d.classification;

-- Index for filtered retrieval
CREATE INDEX IF NOT EXISTS idx_chunks_classification
  ON content.chunks(classification);

-- Updated match_chunks: now accepts max_classification parameter
-- Agents get a ceiling — they can only see chunks at or below their level
CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL,
  max_classification TEXT DEFAULT 'INTERNAL'
) RETURNS TABLE (
  id UUID,
  document_id UUID,
  text TEXT,
  metadata JSONB,
  similarity FLOAT
) AS $$
  SELECT
    c.id,
    c.document_id,
    c.text,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM content.chunks c
  JOIN content.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND d.deleted_at IS NULL
    AND (filter_owner_id IS NULL OR d.owner_id = filter_owner_id)
    AND c.classification <= max_classification  -- lexicographic: CONFIDENTIAL < INTERNAL < PUBLIC < RESTRICTED
    AND c.classification IN (
      CASE max_classification
        WHEN 'PUBLIC' THEN 'PUBLIC'
        WHEN 'INTERNAL' THEN 'PUBLIC'
        WHEN 'CONFIDENTIAL' THEN 'PUBLIC'
        WHEN 'RESTRICTED' THEN 'PUBLIC'
      END,
      CASE max_classification
        WHEN 'INTERNAL' THEN 'INTERNAL'
        WHEN 'CONFIDENTIAL' THEN 'INTERNAL'
        WHEN 'RESTRICTED' THEN 'INTERNAL'
        ELSE NULL
      END,
      CASE max_classification
        WHEN 'CONFIDENTIAL' THEN 'CONFIDENTIAL'
        WHEN 'RESTRICTED' THEN 'CONFIDENTIAL'
        ELSE NULL
      END,
      CASE max_classification
        WHEN 'RESTRICTED' THEN 'RESTRICTED'
        ELSE NULL
      END
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE SQL STABLE;
