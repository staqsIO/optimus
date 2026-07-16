-- 183-share-grants-applies-to.sql
-- ADR-017 follow-up: tag every share_grant with the resource kinds it
-- applies to. Share-aware retrievers (content.match_chunks, lib/rag
-- lexicalChunkSearch/wikiPageSearch) consult this column to skip grants
-- whose `applies_to` doesn't include the kind they're searching — so a
-- wiki-only grant never accidentally exposes document chunks, and vice
-- versa.
--
-- The generic tenancy.visible() predicate (mig 133) is intentionally NOT
-- modified. Share-grant visibility is opt-in per resource kind at the
-- retriever layer; signals/briefings/contracts/deals keep their existing
-- three-tier predicate (own + org-shared + federation_grants) unchanged.
-- This guarantees that turning on a share_grant for documents can never
-- silently expose voice profiles, briefings, contract bodies, etc.

ALTER TABLE tenancy.share_grants
  ADD COLUMN IF NOT EXISTS applies_to TEXT[] NOT NULL
    DEFAULT ARRAY['documents','wiki_pages']::TEXT[];

COMMENT ON COLUMN tenancy.share_grants.applies_to IS
  'Resource kinds this grant covers. Default {documents,wiki_pages}. Voice/signal/briefing share-grants are out of scope today; they will opt in by widening this array AND by their retrievers consulting share_grants. The generic tenancy.visible() predicate does NOT read this column — only share-aware retrievers do.';
