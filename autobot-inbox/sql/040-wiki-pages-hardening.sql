-- 040-wiki-pages-hardening.sql
-- Hardening for wiki pages:
-- 1) org-wide slug uniqueness
-- 2) hierarchy cycle prevention
-- 3) revision history table + trigger hooks

-- 1) Org-wide uniqueness (project_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_wiki_pages_org_slug
  ON content.wiki_pages(slug)
  WHERE project_id IS NULL;

-- 3a) Track last editor identity on page rows (used by revision trigger)
ALTER TABLE content.wiki_pages
  ADD COLUMN IF NOT EXISTS updated_by TEXT;

-- 2) Prevent parent cycles (A -> ... -> A)
CREATE OR REPLACE FUNCTION content.prevent_wiki_page_cycle()
RETURNS TRIGGER AS $$
DECLARE
  cycle_found BOOLEAN;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Self-parent guard
  IF NEW.id IS NOT NULL AND NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'wiki page cannot be its own parent';
  END IF;

  -- Walk ancestors from NEW.parent_id and ensure NEW.id is not among them.
  -- For INSERT, NEW.id is available because id has DEFAULT gen_random_uuid().
  WITH RECURSIVE ancestors AS (
    SELECT wp.id, wp.parent_id
    FROM content.wiki_pages wp
    WHERE wp.id = NEW.parent_id
    UNION ALL
    SELECT wp.id, wp.parent_id
    FROM content.wiki_pages wp
    JOIN ancestors a ON wp.id = a.parent_id
  )
  SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'wiki page hierarchy cycle detected';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wiki_pages_no_cycle ON content.wiki_pages;
CREATE TRIGGER trg_wiki_pages_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON content.wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION content.prevent_wiki_page_cycle();

-- 3b) Revision history
CREATE TABLE IF NOT EXISTS content.wiki_page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_page_id UUID NOT NULL REFERENCES content.wiki_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  classification TEXT NOT NULL,
  parent_id UUID,
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(wiki_page_id, version)
);

CREATE INDEX IF NOT EXISTS idx_wiki_page_revisions_page ON content.wiki_page_revisions(wiki_page_id, version DESC);

CREATE OR REPLACE FUNCTION content.append_wiki_page_revision()
RETURNS TRIGGER AS $$
DECLARE
  next_version INTEGER;
  who TEXT;
  op TEXT;
BEGIN
  who := COALESCE(NEW.updated_by, NEW.created_by, 'system');
  op := CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO next_version
  FROM content.wiki_page_revisions
  WHERE wiki_page_id = NEW.id;

  INSERT INTO content.wiki_page_revisions (
    wiki_page_id, version, title, content, classification, parent_id, changed_by, change_type
  ) VALUES (
    NEW.id, next_version, NEW.title, NEW.content, NEW.classification, NEW.parent_id, who, op
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wiki_pages_revision_insert ON content.wiki_pages;
CREATE TRIGGER trg_wiki_pages_revision_insert
  AFTER INSERT ON content.wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION content.append_wiki_page_revision();

DROP TRIGGER IF EXISTS trg_wiki_pages_revision_update ON content.wiki_pages;
CREATE TRIGGER trg_wiki_pages_revision_update
  AFTER UPDATE OF title, content, classification, parent_id ON content.wiki_pages
  FOR EACH ROW
  WHEN (
    OLD.title IS DISTINCT FROM NEW.title OR
    OLD.content IS DISTINCT FROM NEW.content OR
    OLD.classification IS DISTINCT FROM NEW.classification OR
    OLD.parent_id IS DISTINCT FROM NEW.parent_id
  )
  EXECUTE FUNCTION content.append_wiki_page_revision();
