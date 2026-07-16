-- 185-wiki-owner-and-collections.sql
-- ADR-017 v1 schema: resolves wiki-ownership gap, introduces collections.
--
-- Closes FOLLOWUP-WIKI-OWNER (STAQPRO-591) by adding `owner_id` and
-- `owner_org_id` to content.wiki_pages. Migration 134 backfilled
-- owner_org_id on 11 tables but skipped wiki_pages — without these columns
-- wikiPageSearch cannot enforce per-user visibility, cross-tenant gating, or
-- share-grant semantics.
--
-- Also introduces content.collections — a flat (no nesting in v1) grouping for
-- documents. Wiki pages already have hierarchy via parent_id; flat documents
-- get this. share_grants with scope_type='collection' resolve to all documents
-- whose collection_id matches scope_ref.
--
-- Defaults follow migration 134's "owner_org_id = Staqs" convention: existing
-- rows are stamped to Staqs, new rows default to Staqs until write-path
-- stamping is plumbed for the second org (separate work item).

-- ---------------------------------------------------------------------------
-- wiki_pages ownership (resolves FOLLOWUP-WIKI-OWNER)
-- ---------------------------------------------------------------------------
-- IMPORTANT — PGlite quirk: combining ADD COLUMN with ALTER COLUMN ... SET
-- DEFAULT on content.wiki_pages corrupts the partial unique index
-- uq_wiki_pages_org_slug (mig 040, on slug WHERE project_id IS NULL) such
-- that every subsequent INSERT with project_id=NULL hits a false-positive
-- duplicate violation. Reproducible against rag-wiki-search.test.js. We
-- therefore add the columns WITHOUT a default and rely on the write-path
-- to stamp owner_org_id explicitly. Supabase is unaffected — the same
-- pattern works there with or without the default.
ALTER TABLE content.wiki_pages ADD COLUMN IF NOT EXISTS owner_id     UUID;
ALTER TABLE content.wiki_pages ADD COLUMN IF NOT EXISTS owner_org_id UUID;

DO $$
DECLARE staqs UUID;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NOT NULL THEN
    UPDATE content.wiki_pages SET owner_org_id = staqs WHERE owner_org_id IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wiki_pages_owner_id_idx     ON content.wiki_pages(owner_id);
CREATE INDEX IF NOT EXISTS wiki_pages_owner_org_id_idx ON content.wiki_pages(owner_org_id);

COMMENT ON COLUMN content.wiki_pages.owner_id IS
  'Per-user ownership for wiki pages. NULL = org-wide (visible to anyone in owner_org_id). Mirrors content.documents.owner_id semantics; consulted by lib/rag/retriever.js wikiPageSearch.';
COMMENT ON COLUMN content.wiki_pages.owner_org_id IS
  'Tenancy boundary for wiki pages. ADR-012. Defaults to Staqs for legacy rows.';

-- ---------------------------------------------------------------------------
-- Collections — flat document grouping for share-grants scope_type='collection'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content.collections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID,                                          -- NULL = org-wide
  owner_org_id  UUID NOT NULL REFERENCES tenancy.orgs(id),
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID NOT NULL,
  UNIQUE (owner_org_id, slug)
);
CREATE INDEX IF NOT EXISTS collections_owner_idx ON content.collections(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS collections_org_idx   ON content.collections(owner_org_id);

COMMENT ON TABLE content.collections IS
  'Flat document collections (v1 — no nesting). Wiki uses parent_id for hierarchy; documents use this. share_grants scope_type=collection narrows visibility to documents whose collection_id matches scope_ref.';

-- ---------------------------------------------------------------------------
-- Documents → collection
-- ---------------------------------------------------------------------------
ALTER TABLE content.documents
  ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES content.collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_collection_idx ON content.documents(collection_id) WHERE collection_id IS NOT NULL;

COMMENT ON COLUMN content.documents.collection_id IS
  'Optional grouping. NULL = uncollected. ADR-017 v1: share_grants with scope_type=collection match documents whose collection_id = scope_ref::uuid.';
