-- 186-match-chunks-scope-narrowed.sql
-- ADR-017 v1: extend the share-grant arm in content.match_chunks to honor
-- per-document and per-collection scopes. Previously only scope_type='all'
-- grants matched; now scope_type='document' and scope_type='collection'
-- grants narrow the match by scope_ref.
--
-- Matching contract:
--   scope_type='all'         → matches every row owned by the granter
--   scope_type='document'    → matches when d.id::text = g.scope_ref
--   scope_type='collection'  → matches when d.collection_id::text = g.scope_ref
--   scope_type='topic'       → reserved for vN; treated as no-match in v1
--
-- Function signature is unchanged — the v1 expansion is purely in the
-- subquery body, so callers do not need to update.

DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, SMALLINT, BOOLEAN, BOOLEAN, UUID[], UUID[], UUID[], UUID[]
);

CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL,
  max_classification_level SMALLINT DEFAULT 1,
  include_org_wide BOOLEAN DEFAULT TRUE,
  shared_documents_only BOOLEAN DEFAULT FALSE,
  filter_participant_ids UUID[] DEFAULT NULL,
  boost_participant_ids UUID[] DEFAULT NULL,
  filter_org_ids UUID[] DEFAULT NULL,
  filter_group_ids UUID[] DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  document_id UUID,
  text TEXT,
  metadata JSONB,
  similarity FLOAT,
  document_participants JSONB,
  participant_match BOOLEAN,
  shared_via JSONB
) AS $$
BEGIN
  IF (filter_org_ids IS NULL OR cardinality(filter_org_ids) = 0)
     AND filter_owner_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
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
        SELECT 1 FROM unnest(boost_participant_ids) bid
        WHERE d.participants @> jsonb_build_array(jsonb_build_object('contact_id', bid::text))
      )
    END AS participant_match,
    -- ADR-017: provenance + scope. The shared_via object now includes scope_type
    -- so the UI can distinguish "all knowledge" from "this specific document".
    (
      SELECT jsonb_build_object(
               'granter_type', g.granter_type,
               'granter_id',   g.granter_id,
               'scope_type',   g.scope_type,
               'scope_ref',    g.scope_ref
             )
        FROM tenancy.share_grants g
       WHERE g.status = 'active'
         AND 'documents' = ANY(g.applies_to)
         AND (
           (g.granter_type = 'user' AND g.granter_id = d.owner_id)
           OR (g.granter_type = 'org' AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
         )
         AND (
           g.scope_type = 'all'
           OR (g.scope_type = 'document'   AND g.scope_ref = d.id::text)
           OR (g.scope_type = 'collection' AND d.collection_id IS NOT NULL AND g.scope_ref = d.collection_id::text)
         )
         AND (
           (g.target_type = 'user'  AND filter_owner_id IS NOT NULL AND g.target_id = filter_owner_id)
           OR (g.target_type = 'org'   AND filter_org_ids   IS NOT NULL AND g.target_id = ANY(filter_org_ids))
           OR (g.target_type = 'group' AND filter_group_ids IS NOT NULL AND g.target_id = ANY(filter_group_ids))
         )
       LIMIT 1
    ) AS shared_via
  FROM content.chunks c
  JOIN content.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > min_similarity
    AND d.sanitized = true
    AND d.deleted_at IS NULL
    AND c.classification_level <= max_classification_level
    AND (
      (
        (
          CASE
            WHEN shared_documents_only THEN d.owner_id IS NULL
            WHEN filter_owner_id IS NULL THEN TRUE
            WHEN include_org_wide THEN (d.owner_id IS NULL OR d.owner_id = filter_owner_id)
            ELSE d.owner_id = filter_owner_id
          END
        )
        AND COALESCE(d.owner_org_id, '7c164445-43f2-4802-a7d3-5cab06611e99'::uuid) = ANY(filter_org_ids)
      )
      OR EXISTS (
        SELECT 1 FROM tenancy.share_grants g
         WHERE g.status = 'active'
           AND 'documents' = ANY(g.applies_to)
           AND (
             (g.granter_type = 'user' AND g.granter_id = d.owner_id)
             OR (g.granter_type = 'org' AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
           )
           AND (
             g.scope_type = 'all'
             OR (g.scope_type = 'document'   AND g.scope_ref = d.id::text)
             OR (g.scope_type = 'collection' AND d.collection_id IS NOT NULL AND g.scope_ref = d.collection_id::text)
           )
           AND (
             (g.target_type = 'user'  AND filter_owner_id IS NOT NULL AND g.target_id = filter_owner_id)
             OR (g.target_type = 'org'   AND filter_org_ids   IS NOT NULL AND g.target_id = ANY(filter_org_ids))
             OR (g.target_type = 'group' AND filter_group_ids IS NOT NULL AND g.target_id = ANY(filter_group_ids))
           )
      )
    )
    AND (
      filter_participant_ids IS NULL
      OR EXISTS (
        SELECT 1 FROM unnest(filter_participant_ids) fid
        WHERE d.participants @> jsonb_build_array(jsonb_build_object('contact_id', fid::text))
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;
