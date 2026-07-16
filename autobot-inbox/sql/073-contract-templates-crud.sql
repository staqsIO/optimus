-- 073: Template authoring for contracts.
--
-- Background
-- ----------
-- content.contract_templates was created in migration 053 (alongside the
-- executor-contract agent seed) but no CRUD surface used it — the 3
-- bundled templates live as markdown files in agents/executor-contract/
-- and /api/contracts/templates loads them at module startup. Changing a
-- template means a PR, which the board isn't set up to do themselves.
--
-- Change
-- ------
-- Adds description + archived_at, a touch trigger for updated_at, and an
-- index for the slug lookup. Doesn't backfill the 3 file templates —
-- they stay file-based (they're maintained alongside the executor-contract
-- prompt, which version-controls them together). Any NEW templates go in
-- the DB, surfacing alongside file templates in the /templates endpoint.

-- Create the table if 053 never landed on this database. IF NOT EXISTS
-- makes this a no-op when the table is already present, so re-runs and
-- fresh-DB installs both work. Column list is byte-identical to 053 so
-- no row can go out of sync.
CREATE TABLE IF NOT EXISTS content.contract_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'service_proposal',
  variables JSONB DEFAULT '[]'::jsonb,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE content.contract_templates
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;

COMMENT ON COLUMN content.contract_templates.archived_at IS
  'Soft-delete marker. Active templates (NULL) appear in the new-contract '
  'picker; archived templates are hidden but preserved for historical reference.';

CREATE OR REPLACE FUNCTION content.touch_template_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_templates_touch ON content.contract_templates;
CREATE TRIGGER trg_templates_touch
  BEFORE UPDATE ON content.contract_templates
  FOR EACH ROW EXECUTE FUNCTION content.touch_template_updated_at();

-- Active-template lookup (the common picker query) hits slug + archived
CREATE INDEX IF NOT EXISTS idx_contract_templates_active_slug
  ON content.contract_templates (slug)
  WHERE archived_at IS NULL;

-- RLS — same permissive-authenticated shape as other round-2 additions
ALTER TABLE content.contract_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users see templates" ON content.contract_templates;
CREATE POLICY "Authenticated users see templates"
  ON content.contract_templates
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users write templates" ON content.contract_templates;
CREATE POLICY "Authenticated users write templates"
  ON content.contract_templates
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
