-- 039-wiki-pages.sql
-- Hierarchical wiki pages (Karpathy-style index + folders) for structured lookup.

CREATE TABLE IF NOT EXISTS content.wiki_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID, -- NULL = org-wide (no cross-schema FK by convention)
  parent_id UUID REFERENCES content.wiki_pages(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  is_index BOOLEAN NOT NULL DEFAULT false,
  compiled_at TIMESTAMPTZ,
  source_document_id TEXT, -- logical link to content.documents.id
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_project ON content.wiki_pages(project_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_parent ON content.wiki_pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_source_doc ON content.wiki_pages(source_document_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug ON content.wiki_pages(slug);

CREATE OR REPLACE FUNCTION content.set_wiki_pages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wiki_pages_updated_at ON content.wiki_pages;
CREATE TRIGGER trg_wiki_pages_updated_at
  BEFORE UPDATE ON content.wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION content.set_wiki_pages_updated_at();
