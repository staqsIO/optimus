-- 041-wiki-id-types-text.sql
-- Align wiki tables with repo-wide ID convention (TEXT UUID strings).

-- Drop triggers temporarily while altering key columns
DROP TRIGGER IF EXISTS trg_wiki_pages_no_cycle ON content.wiki_pages;
DROP TRIGGER IF EXISTS trg_wiki_pages_revision_insert ON content.wiki_pages;
DROP TRIGGER IF EXISTS trg_wiki_pages_revision_update ON content.wiki_pages;

-- Drop FK constraints that depend on UUID-typed columns
ALTER TABLE content.wiki_page_revisions
  DROP CONSTRAINT IF EXISTS wiki_page_revisions_wiki_page_id_fkey;

ALTER TABLE content.wiki_pages
  DROP CONSTRAINT IF EXISTS wiki_pages_parent_id_fkey;
ALTER TABLE content.wiki_pages
  DROP CONSTRAINT IF EXISTS wiki_pages_source_document_id_fkey;

-- Convert wiki_pages key columns to TEXT
ALTER TABLE content.wiki_pages
  ALTER COLUMN id TYPE TEXT USING id::text,
  ALTER COLUMN project_id TYPE TEXT USING project_id::text,
  ALTER COLUMN parent_id TYPE TEXT USING parent_id::text,
  ALTER COLUMN source_document_id TYPE TEXT USING source_document_id::text;

-- Convert wiki_page_revisions linkage columns to TEXT
ALTER TABLE content.wiki_page_revisions
  ALTER COLUMN id TYPE TEXT USING id::text,
  ALTER COLUMN wiki_page_id TYPE TEXT USING wiki_page_id::text,
  ALTER COLUMN parent_id TYPE TEXT USING parent_id::text;

-- Recreate FK constraints with TEXT keys
ALTER TABLE content.wiki_pages
  ADD CONSTRAINT wiki_pages_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES content.wiki_pages(id) ON DELETE SET NULL;

ALTER TABLE content.wiki_page_revisions
  ADD CONSTRAINT wiki_page_revisions_wiki_page_id_fkey
  FOREIGN KEY (wiki_page_id) REFERENCES content.wiki_pages(id) ON DELETE CASCADE;

-- Recreate triggers
CREATE TRIGGER trg_wiki_pages_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON content.wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION content.prevent_wiki_page_cycle();

CREATE TRIGGER trg_wiki_pages_revision_insert
  AFTER INSERT ON content.wiki_pages
  FOR EACH ROW
  EXECUTE FUNCTION content.append_wiki_page_revision();

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
