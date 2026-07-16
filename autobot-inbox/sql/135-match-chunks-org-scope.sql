-- 135-match-chunks-org-scope.sql — Phase-2 tenancy (live read-leak, Commit A)
--
-- Closes the RAG cross-tenant read leak. Migration 118's content.match_chunks()
-- filters only by a per-USER `filter_owner_id` with a FAIL-OPEN
-- `WHEN filter_owner_id IS NULL THEN TRUE` arm and references NO org column at
-- all. Migration 134 added `owner_org_id` to content.documents but the function
-- ignored it. The moment any non-Staqs document is ingested, /api/search and
-- agent RAG can surface another org's chunks.
--
-- This migration adds an org gate that is FAIL-CLOSED (SPEC §0 P1: deny by
-- default). A new param `filter_org_ids UUID[]` carries the caller principal's
-- readable tenancy orgs. Absence of a valid org list yields ZERO rows — never
-- "everything". The per-user `filter_owner_id` CASE (mig 118:49-56) is kept
-- UNCHANGED as an additional intra-org narrowing.
--
-- Org gate design (Linus blocker 1):
--   * The org filter is an UNCONDITIONAL `AND` placed OUTSIDE the owner CASE,
--     never inside an arm — so the `shared_documents_only` arm cannot bypass it.
--   * `COALESCE(d.owner_org_id, <Staqs>)` means legacy / un-stamped / shared
--     (owner_org_id IS NULL) docs COALESCE to Staqs: they stay visible to Staqs
--     principals (availability) and never silently vanish, while still being
--     org-gated (no cross-org bypass).
--   * An explicit early-return guard (plpgsql) returns 0 rows when
--     filter_org_ids IS NULL or empty. We do NOT rely implicitly on
--     `= ANY(NULL)` / `= ANY('{}')` semantics — the guard is the fail-closed
--     contract, documented here.
--
-- Arity change (9 → 10 args): per migration 118's pattern, DROP the prior
-- 9-arg overload FIRST so no call can resolve to the fail-open shape. The
-- single live caller (lib/rag/retriever.js) is updated in the same change to
-- pass filter_org_ids.
--
-- Idempotent + Supabase-safe: CREATE OR REPLACE + DROP FUNCTION IF EXISTS, no
-- auth-schema / pgcrypto touch. Runs on deploy via the best-effort migrate path.

-- Drop the fail-open 9-arg shape (migration 118) so only the new 10-arg
-- org-gated shape resolves. IF EXISTS keeps this idempotent across fresh PGlite
-- and already-migrated Supabase.
DROP FUNCTION IF EXISTS content.match_chunks(
  vector(1536), INT, FLOAT, UUID, SMALLINT, BOOLEAN, BOOLEAN, UUID[], UUID[]
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
  filter_org_ids UUID[] DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  document_id UUID,
  text TEXT,
  metadata JSONB,
  similarity FLOAT,
  document_participants JSONB,
  participant_match BOOLEAN
) AS $$
BEGIN
  -- FAIL-CLOSED org gate (SPEC §0 P1). An unresolved / empty org scope must
  -- yield NO rows — never an unfiltered query. This is the inverse of mig 118's
  -- `filter_owner_id IS NULL → TRUE` fail-open. Do not remove this guard: the
  -- COALESCE/ANY clause below would otherwise behave on `= ANY(NULL)` which is
  -- NULL (no match) for non-null left sides but is too subtle to rely on as the
  -- security contract. The explicit RETURN is the contract.
  IF filter_org_ids IS NULL OR cardinality(filter_org_ids) = 0 THEN
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
    END AS participant_match
  FROM content.chunks c
  JOIN content.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > min_similarity
    AND d.sanitized = true
    AND d.deleted_at IS NULL
    -- Per-USER owner gate (migration 118, UNCHANGED). Intra-org narrowing only.
    AND (
      CASE
        WHEN shared_documents_only THEN d.owner_id IS NULL
        WHEN filter_owner_id IS NULL THEN TRUE
        WHEN include_org_wide THEN (d.owner_id IS NULL OR d.owner_id = filter_owner_id)
        ELSE d.owner_id = filter_owner_id
      END
    )
    -- ORG gate (Commit A). UNCONDITIONAL — placed OUTSIDE the owner CASE so the
    -- shared_documents_only arm cannot bypass it. COALESCE-to-Staqs keeps
    -- legacy/shared (owner_org_id IS NULL) docs visible to Staqs principals
    -- while still org-gating every row.
    -- NOTE: PGlite divergence accepted — prod Staqs UUID is the canonical fallback for legacy NULL owner_org_id; PGlite seeds a random org UUID (mig 133) so legacy docs are Staqs-visible in prod only.
    AND COALESCE(d.owner_org_id, '7c164445-43f2-4802-a7d3-5cab06611e99'::uuid) = ANY(filter_org_ids)
    -- Ordinal classification ceiling (migration 118 / STAQPRO-313). NULL
    -- classification_level (legacy/unbackfilled chunks) is excluded — fail-closed.
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
END;
$$ LANGUAGE plpgsql STABLE;
