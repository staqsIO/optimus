-- 187-document-topics.sql
-- ADR-017 vN (#11) — Topics primitive for documents + share grants.
--
-- A document-topic is a free-form label scoped to an org. Multiple documents
-- map to a topic; multiple topics map to a document. Share grants with
-- scope_type='topic' resolve to "all documents whose document_topics row
-- references this topic".
--
-- Naming note: existing `signal.topics` is CRM-domain (signal extraction);
-- existing `content.topics` is for the LinkedIn content queue. Both have
-- different semantics from "this document is about X". We add a third,
-- explicitly named for the document-tagging axis:
--   content.kb_topics                  — the topics themselves
--   content.document_topics            — many-to-many assignments
-- This is the minimum-surprise option; cross-pollination with signal.topics
-- can be a future "linking" feature without changing the share-grant model.

CREATE TABLE IF NOT EXISTS content.kb_topics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id UUID NOT NULL REFERENCES tenancy.orgs(id),
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID NOT NULL,
  UNIQUE (owner_org_id, slug)
);
CREATE INDEX IF NOT EXISTS kb_topics_org_idx ON content.kb_topics(owner_org_id);

COMMENT ON TABLE content.kb_topics IS
  'Knowledge-base topics for document tagging (ADR-017 #11). Scope-narrow target for share_grants with scope_type=topic. Distinct from signal.topics (CRM) and content.topics (publishing queue).';

CREATE TABLE IF NOT EXISTS content.document_topics (
  document_id UUID NOT NULL,
  topic_id    UUID NOT NULL REFERENCES content.kb_topics(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by    UUID,
  PRIMARY KEY (document_id, topic_id)
);
CREATE INDEX IF NOT EXISTS document_topics_topic_idx ON content.document_topics(topic_id);
CREATE INDEX IF NOT EXISTS document_topics_document_idx ON content.document_topics(document_id);

COMMENT ON TABLE content.document_topics IS
  'M:N — content.documents.id <-> content.kb_topics.id. Drives scope_type=topic share-grant matching: a doc matches a topic-scope grant iff this table contains (doc.id, grant.scope_ref::uuid).';

-- NOTE: content.wiki_pages.id is TEXT (mig 041 converted from UUID to TEXT for
-- repo-wide ID convention). The FK must match that type.
CREATE TABLE IF NOT EXISTS content.wiki_page_topics (
  wiki_page_id TEXT NOT NULL REFERENCES content.wiki_pages(id) ON DELETE CASCADE,
  topic_id     UUID NOT NULL REFERENCES content.kb_topics(id) ON DELETE CASCADE,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by     UUID,
  PRIMARY KEY (wiki_page_id, topic_id)
);
CREATE INDEX IF NOT EXISTS wiki_page_topics_topic_idx ON content.wiki_page_topics(topic_id);

COMMENT ON TABLE content.wiki_page_topics IS
  'M:N — content.wiki_pages.id <-> content.kb_topics.id. Same matching contract as content.document_topics but for the wiki retrieval path.';
