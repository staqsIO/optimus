-- 034: Unify RAG match_chunks() after 017-rag-classification + multi-member access.
--
-- Extends the five-parameter classification version with:
--   include_org_wide (default true): when filter_owner_id is set, include shared (owner_id NULL) docs.
--   shared_documents_only (default false): only owner_id IS NULL documents.
--
-- Restores 013-style filters dropped in 017: min_similarity threshold and d.sanitized = true.

CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL,
  max_classification TEXT DEFAULT 'INTERNAL',
  include_org_wide BOOLEAN DEFAULT TRUE,
  shared_documents_only BOOLEAN DEFAULT FALSE
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
