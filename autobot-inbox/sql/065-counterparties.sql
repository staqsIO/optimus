-- 065: Counterparty entity — pull client identity out of seo_metadata JSON
--
-- Background
-- ----------
-- Every contract stores client_name / signer_name / signer_email / signer_title
-- as free-text strings inside content.drafts.seo_metadata. Effects:
--   * Three contracts for "Acme Corp" have three independent name strings;
--     typos fracture the history ("Acme Corporation", "acme corp", "ACME").
--   * No way to ask "show me every contract with this client".
--   * Provenance work (Phase 3) needs a stable entity to anchor emails and
--     meetings against.
--
-- Change
-- ------
--   1. content.counterparties table (internal-only — single UMB tenant).
--   2. content.drafts gets a nullable counterparty_id FK.
--   3. Backfill: one counterparty per distinct lower(trim(client_name)) in
--      existing contract drafts; link drafts in a second pass.
--
-- Non-goals (deferred)
-- --------------------
--   * No multi-tenant org column. Optimus is staying internal.
--   * Address is free-text for now; structured fields can come later.
--   * No merge UI — manual SQL for now.

CREATE TABLE IF NOT EXISTS content.counterparties (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  domain                   TEXT,                                                   -- email domain for auto-linking later
  primary_signer_name      TEXT,
  primary_signer_email     TEXT,
  primary_signer_title     TEXT,
  address                  TEXT,                                                   -- free-form for MVP
  notes                    TEXT,
  created_by               TEXT        NOT NULL DEFAULT 'unknown',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft-delete so existing contracts retain their counterparty reference.
  archived_at              TIMESTAMPTZ
);

COMMENT ON TABLE content.counterparties IS
  'Clients / counterparties for contracts. Internal UMB tool — no tenancy column. '
  'Pulled out of content.drafts.seo_metadata JSON by migration 065.';

-- Name uniqueness (case-insensitive) across active rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_name_lower
  ON content.counterparties (lower(name))
  WHERE archived_at IS NULL;

-- Domain lookup for future auto-linking from inbound emails
CREATE INDEX IF NOT EXISTS idx_counterparties_domain
  ON content.counterparties (lower(domain))
  WHERE domain IS NOT NULL AND archived_at IS NULL;

-- updated_at bump
CREATE OR REPLACE FUNCTION content.touch_counterparty_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_counterparties_touch ON content.counterparties;
CREATE TRIGGER trg_counterparties_touch
  BEFORE UPDATE ON content.counterparties
  FOR EACH ROW EXECUTE FUNCTION content.touch_counterparty_updated_at();

-- ============================================================
-- Link column on content.drafts
-- ============================================================

ALTER TABLE content.drafts
  ADD COLUMN IF NOT EXISTS counterparty_id UUID
    REFERENCES content.counterparties(id) ON DELETE SET NULL;

COMMENT ON COLUMN content.drafts.counterparty_id IS
  'Link to content.counterparties. Only populated for content_type = contract. '
  'seo_metadata->>''client_name'' remains as a denormalized fallback for display '
  'until all read paths migrate to the join.';

CREATE INDEX IF NOT EXISTS idx_drafts_counterparty
  ON content.drafts (counterparty_id)
  WHERE counterparty_id IS NOT NULL;

-- ============================================================
-- Backfill: one counterparty per distinct client name
-- Two passes: (1) insert distinct counterparties, (2) link drafts.
-- DISTINCT ON picks the most-recent contract's signer details as the
-- primary_signer for each counterparty — newest-wins for backfill.
-- ============================================================

INSERT INTO content.counterparties (
  name, primary_signer_name, primary_signer_email, primary_signer_title, created_by
)
SELECT DISTINCT ON (lower(trim(d.seo_metadata->>'client_name')))
  trim(d.seo_metadata->>'client_name')       AS name,
  d.seo_metadata->>'signer_name'             AS primary_signer_name,
  d.seo_metadata->>'signer_email'            AS primary_signer_email,
  d.seo_metadata->>'signer_title'            AS primary_signer_title,
  'backfill-065'                              AS created_by
FROM content.drafts d
WHERE d.content_type = 'contract'
  AND d.seo_metadata->>'client_name' IS NOT NULL
  AND length(trim(d.seo_metadata->>'client_name')) > 0
ORDER BY lower(trim(d.seo_metadata->>'client_name')), d.created_at DESC
ON CONFLICT DO NOTHING;  -- guards against re-running the migration

UPDATE content.drafts d
SET counterparty_id = cp.id
FROM content.counterparties cp
WHERE d.content_type = 'contract'
  AND d.counterparty_id IS NULL
  AND d.seo_metadata->>'client_name' IS NOT NULL
  AND lower(trim(d.seo_metadata->>'client_name')) = lower(cp.name);

-- ============================================================
-- Verification
-- ============================================================
--   -- Every contract with a client_name should now have a counterparty_id:
--   SELECT count(*) FILTER (WHERE counterparty_id IS NULL AND seo_metadata->>'client_name' IS NOT NULL) AS unlinked,
--          count(*) FILTER (WHERE counterparty_id IS NOT NULL) AS linked,
--          count(*) AS total
--   FROM content.drafts WHERE content_type = 'contract';
--
--   -- Name dedup landed as expected:
--   SELECT count(*) AS counterparty_count,
--          count(DISTINCT lower(trim(seo_metadata->>'client_name'))) AS distinct_names
--   FROM content.drafts WHERE content_type = 'contract' AND seo_metadata->>'client_name' IS NOT NULL;
