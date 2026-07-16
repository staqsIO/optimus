-- 057: Extend content.match_chunks() with participant filter + boost.
--
-- Adds two optional params:
--   filter_participant_ids — hard filter; only return chunks whose document
--     has every one of these contact_ids in its participants array. Use when
--     query intent is explicit ("meeting with John").
--   boost_participant_ids — scoring hint; the SQL returns a `participant_match`
--     boolean so the retriever (JS) can nudge similarity upward for docs
--     involving these contacts without excluding others.
--
-- Also surfaces d.participants on the result so retrieval can render a
-- "Meeting participants: …" header in the context block (which is what lets
-- the LLM answer "who was at the meeting with John").
--
-- Backward compatible: both new params default to NULL and are no-ops when
-- omitted. Existing callers in lib/rag/retriever.js continue to work unchanged
-- until they opt in.

CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL,
  max_classification TEXT DEFAULT 'INTERNAL',
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
    AND (
      filter_participant_ids IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM unnest(filter_participant_ids) fid
        WHERE NOT (d.participants @> jsonb_build_array(
          jsonb_build_object('contact_id', fid::text)
        ))
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE SQL STABLE;
