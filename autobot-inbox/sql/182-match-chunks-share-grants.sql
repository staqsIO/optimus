-- 182-match-chunks-share-grants.sql
-- ADR-017 — extend content.match_chunks() with a share_grants visibility arm.
--
-- This migration adds a NEW parameter `filter_group_ids UUID[]` carrying the
-- caller's tenancy.group_memberships (used as the target principal set when
-- matching share_grants with target_type='group'). The existing
-- `filter_owner_id` doubles as the caller's user principal (target_type='user')
-- and `filter_org_ids` doubles as the caller's org principal set
-- (target_type='org') — they already carry these meanings, so reuse without
-- renaming.
--
-- Visibility model:
--   A row is visible iff
--     (owner_gate AND org_gate) OR share_grant_match
--   where:
--     owner_gate          = existing per-USER owner case (mig 118)
--     org_gate            = existing cross-tenant org case (mig 135)
--     share_grant_match   = an active scope='all' share_grant whose granter is
--                           the row's owner (user or org) and whose target is
--                           one of the caller's principals (user/group/org)
--
-- A row visible via share_grant_match satisfies BOTH gates implicitly because
-- the grant is itself the cross-tenant authorization. share_grants widen the
-- cross-tenant boundary — that is the whole point of org-to-org sharing.
--
-- The existing 10-arg overload (migration 135) is dropped first so no caller
-- resolves to the smaller, share-grant-blind signature. The single live caller
-- (lib/rag/retriever.js searchChunks) is updated in the same change set to
-- pass filter_group_ids.
--
-- v0 enforces scope_type='all'. v1+ per-doc/collection scope will narrow the
-- share_grant_match here (or in callers) once row identity matters.

BEGIN;

-- Drop the 10-arg shape (migration 135) so only the new 11-arg shape resolves.
DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, SMALLINT, BOOLEAN, BOOLEAN, UUID[], UUID[], UUID[]
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
  -- ADR-017: shared_via — provenance for the UI / agent prompts. null when
  -- the row was visible via the (owner_gate AND org_gate) arm; a JSON object
  -- { granter_type, granter_id } when the row was visible via share_grants.
  shared_via JSONB
) AS $$
BEGIN
  -- FAIL-CLOSED org gate (SPEC §0 P1) — unchanged from migration 135. A caller
  -- with no readable orgs AND no share_grants targeted at them MUST see zero
  -- rows. We pre-check filter_org_ids; the share_grant case below still works
  -- because the grant's target_type='user' / 'group' arms do not require
  -- filter_org_ids to be non-empty (a user can be a share-grant target without
  -- any org membership). Move the early-return only when filter_org_ids AND
  -- filter_owner_id are both empty.
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
        SELECT 1
        FROM unnest(boost_participant_ids) bid
        WHERE d.participants @> jsonb_build_array(
          jsonb_build_object('contact_id', bid::text)
        )
      )
    END AS participant_match,
    -- ADR-017: shared_via provenance. Compute once per row via a correlated
    -- subquery — returns null when no matching share grant exists (own /
    -- org-wide path), otherwise the granter identity for UI attribution.
    (
      SELECT jsonb_build_object('granter_type', g.granter_type, 'granter_id', g.granter_id)
        FROM tenancy.share_grants g
       WHERE g.status = 'active'
         AND g.scope_type = 'all'
         AND (
           (g.granter_type = 'user' AND g.granter_id = d.owner_id)
           OR (g.granter_type = 'org' AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
         )
         AND (
           (g.target_type='user'  AND filter_owner_id IS NOT NULL AND g.target_id = filter_owner_id)
           OR (g.target_type='org'   AND filter_org_ids   IS NOT NULL AND g.target_id = ANY(filter_org_ids))
           OR (g.target_type='group' AND filter_group_ids IS NOT NULL AND g.target_id = ANY(filter_group_ids))
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
    -- Visibility: (owner_gate AND org_gate) OR share_grant_match.
    -- share_grant_match widens both gates simultaneously — a matching grant is
    -- itself the cross-tenant authorization.
    AND (
      -- (owner_gate AND org_gate) — the pre-ADR-017 visibility predicate.
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
      -- share_grant_match (ADR-017) — scope='all' only in v0.
      OR EXISTS (
        SELECT 1 FROM tenancy.share_grants g
         WHERE g.status = 'active'
           AND g.scope_type = 'all'
           AND (
             (g.granter_type = 'user' AND g.granter_id = d.owner_id)
             OR (g.granter_type = 'org'  AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
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
        SELECT 1
        FROM unnest(filter_participant_ids) fid
        WHERE d.participants @> jsonb_build_array(
          jsonb_build_object('contact_id', fid::text)
        )
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
