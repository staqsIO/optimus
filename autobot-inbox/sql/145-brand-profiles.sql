-- 145: Brand profiles for contracts (fonts, color, logo, footer).
--
-- Background
-- ----------
-- The PDF + DOCX renderers ship a fixed UMB Advisors look (Calibri body,
-- no logo, no header/footer). The board manually re-brands every contract
-- in Word after download — swapping in Cormorant Garamond + DM Sans, the
-- gold `#C9A96E` heading color, the UMB logo in the page header, and a
-- "Confidential" footer with page numbers. Reproducing that by hand on
-- every send is the problem this migration backs.
--
-- Change
-- ------
--   1. content.brand_profiles — name, fonts, color, footer config.
--   2. content.brand_profile_assets — bytea storage for logo PNG and
--      TTF font files. Kept in a sub-table because TTFs are 30–100 KB
--      apiece and 4 weights × 2 families per profile would bloat the
--      main row. Asset rows are wholly owned by their profile.
--   3. content.drafts and content.counterparties gain a brand_profile_id
--      FK so a contract can pick a brand explicitly (draft) or inherit
--      one from the counterparty (fallback). NULL on both means "use the
--      default profile."
--   4. Seeds the default UMB Advisors profile. Asset bytea is NOT seeded
--      here — bin/seed-brand-assets.js (run by `npm run seed`) loads the
--      bundled files from lib/contracts/assets/. SQL migrations stay
--      text-only so we don't have to base64 megabytes into a .sql file.
--
-- Non-goals (deferred)
-- --------------------
--   * No per-user / per-counterparty access control. Internal tool.
--   * No history table on the assets — the bytea is just overwritten.

CREATE TABLE IF NOT EXISTS content.brand_profiles (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  slug                     TEXT        NOT NULL,
  description              TEXT,

  -- Typography. font_family is the name written into docx/CSS; the actual
  -- TTF bytes (for docx embedding + @font-face PDF embedding) live in
  -- brand_profile_assets when present.
  heading_font_family      TEXT        NOT NULL DEFAULT 'Calibri',
  body_font_family         TEXT        NOT NULL DEFAULT 'Calibri',

  -- Color used for H1 (and H2/H3 if no override). Hex without '#', 6 chars.
  brand_color_hex          TEXT        NOT NULL DEFAULT '111111'
                                       CHECK (brand_color_hex ~ '^[0-9A-Fa-f]{6}$'),

  -- Page header / footer chrome. logo lives in assets; this is the textual
  -- side and the per-profile show/hide toggles. footer_left_text doubles
  -- as the confidentiality label.
  show_logo_in_header      BOOLEAN     NOT NULL DEFAULT true,
  footer_left_text         TEXT        NOT NULL DEFAULT 'Confidential',
  footer_show_page_number  BOOLEAN     NOT NULL DEFAULT true,

  -- Exactly one profile may carry is_default = true at a time (partial
  -- unique index below). Renderers fall back to that profile when neither
  -- the draft nor the counterparty names one.
  is_default               BOOLEAN     NOT NULL DEFAULT false,

  created_by               TEXT        NOT NULL DEFAULT 'system',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at              TIMESTAMPTZ
);

COMMENT ON TABLE content.brand_profiles IS
  'Per-counterparty (or default) branding applied by lib/contracts/pdf-render '
  'and lib/contracts/docx-render. Fonts, color, logo, footer chrome.';

-- Case-insensitive slug uniqueness across active rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_profiles_slug
  ON content.brand_profiles (lower(slug))
  WHERE archived_at IS NULL;

-- At most one default profile at a time. NULL-default rows can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_profiles_one_default
  ON content.brand_profiles ((1))
  WHERE is_default = true AND archived_at IS NULL;

-- updated_at bump.
CREATE OR REPLACE FUNCTION content.touch_brand_profile_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_brand_profile_updated_at ON content.brand_profiles;
CREATE TRIGGER trg_touch_brand_profile_updated_at
  BEFORE UPDATE ON content.brand_profiles
  FOR EACH ROW EXECUTE FUNCTION content.touch_brand_profile_updated_at();

-- ─── Assets sub-table ─────────────────────────────────────────────────────
-- One row per (profile, asset_kind). asset_kind enum:
--   'logo'        — the header image; mime_type='image/png' (only PNG for now)
--   'font_heading_regular'
--   'font_heading_bold'
--   'font_heading_italic'
--   'font_heading_bold_italic'
--   'font_body_regular'
--   'font_body_bold'
--   'font_body_italic'
--   'font_body_bold_italic'
--
-- font_* rows store TTF bytes. mime_type='font/ttf'. If a weight is missing
-- the docx renderer skips its embed (Word will substitute) and the PDF
-- renderer skips its @font-face (browser will substitute).

CREATE TABLE IF NOT EXISTS content.brand_profile_assets (
  profile_id   UUID        NOT NULL REFERENCES content.brand_profiles(id) ON DELETE CASCADE,
  asset_kind   TEXT        NOT NULL CHECK (asset_kind IN (
    'logo',
    'font_heading_regular', 'font_heading_bold', 'font_heading_italic', 'font_heading_bold_italic',
    'font_body_regular',    'font_body_bold',    'font_body_italic',    'font_body_bold_italic'
  )),
  mime_type    TEXT        NOT NULL,
  size_bytes   INTEGER     NOT NULL CHECK (size_bytes > 0),
  width_px     INTEGER,                          -- only set for logo
  height_px    INTEGER,                          -- only set for logo
  content      BYTEA       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, asset_kind)
);

COMMENT ON TABLE content.brand_profile_assets IS
  'Logo PNG + TTF font weights for a brand profile. One row per (profile, kind). '
  'Owned via ON DELETE CASCADE.';

-- ─── References from drafts + counterparties ──────────────────────────────

ALTER TABLE content.counterparties
  ADD COLUMN IF NOT EXISTS brand_profile_id UUID
    REFERENCES content.brand_profiles(id) ON DELETE SET NULL;

ALTER TABLE content.drafts
  ADD COLUMN IF NOT EXISTS brand_profile_id UUID
    REFERENCES content.brand_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_counterparties_brand_profile
  ON content.counterparties (brand_profile_id)
  WHERE brand_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drafts_brand_profile
  ON content.drafts (brand_profile_id)
  WHERE brand_profile_id IS NOT NULL;

-- ─── Seed: UMB Advisors default profile (metadata only) ───────────────────
-- Assets (logo + 8 TTFs) are seeded by bin/seed-brand-assets.js — see the
-- header comment. Re-running this migration is safe; INSERT … WHERE NOT
-- EXISTS makes it idempotent.

INSERT INTO content.brand_profiles
  (name, slug, description,
   heading_font_family, body_font_family, brand_color_hex,
   show_logo_in_header, footer_left_text, footer_show_page_number,
   is_default, created_by)
SELECT
  'UMB Advisors',
  'umb-advisors',
  'Default UMB Advisors brand: Cormorant Garamond headings in gold, DM Sans body, logo header, "Confidential" footer.',
  'Cormorant Garamond',
  'DM Sans',
  'C9A96E',
  true,
  'Confidential',
  true,
  true,
  'system'
WHERE NOT EXISTS (
  SELECT 1 FROM content.brand_profiles WHERE lower(slug) = 'umb-advisors'
);
