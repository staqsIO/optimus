-- 176: Authoring-org ("on behalf of") branding for brand profiles (OPT-5).
--
-- Background
-- ----------
-- OPT-5 introduces the "on behalf of" authoring org: a generated proposal/contract
-- is authored on behalf of one of Optimus' own orgs (Staqs, UMB Advisors, …), and
-- that org's brand kit (fonts + color + logo) must drive the rendered document.
--
-- Migration 145 keyed brand profiles by slug + a single is_default flag, with the
-- bundled UMB Advisors profile as the system default. That works for one authoring
-- org; it cannot express "Staqs documents get the Staqs brand, UMB documents get the
-- UMB brand." This migration adds an authoring-org dimension.
--
-- Change
-- ------
--   1. content.brand_profiles gains owner_org_id — the authoring org this profile
--      brands FOR. NULL = org-agnostic (the legacy is_default fallback still applies).
--      No cross-schema FK (SPEC §12: schemas isolated by role) — the column is a
--      plain UUID validated at the application layer, same pattern as other
--      owner_org_id columns added by the tenancy increments.
--   2. A partial unique index guarantees at most one active profile per authoring
--      org, so the resolver's "profile owned by this org" lookup is unambiguous.
--   3. Stamps the existing umb-advisors profile with the UMB org id (matched by
--      tenancy.orgs.slug), and seeds a Staqs authoring profile (terminal-green
--      brand from spec/org-brand-kits.md). Both are idempotent and skip cleanly
--      when the org row is absent (e.g. a fresh PGlite test DB before org seed).
--
-- Non-goals (deferred)
-- --------------------
--   * The board-facing org→brand SELECTOR UI is a separate frontend PR.
--   * No asset bytes seeded here (SQL stays text-only; assets load from
--     lib/contracts/assets/ for the bundled UMB default, or the assets table).

ALTER TABLE content.brand_profiles
  ADD COLUMN IF NOT EXISTS owner_org_id UUID;

COMMENT ON COLUMN content.brand_profiles.owner_org_id IS
  'OPT-5: the authoring ("on behalf of") org this brand profile brands documents '
  'for. NULL = org-agnostic; the is_default fallback still applies. No cross-schema '
  'FK (SPEC §12) — validated at the application layer.';

-- At most one active brand profile per authoring org (the resolver picks "the
-- profile owned by this org" and must get a single deterministic row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_profiles_one_per_org
  ON content.brand_profiles (owner_org_id)
  WHERE owner_org_id IS NOT NULL AND archived_at IS NULL;

-- ─── Stamp the existing UMB Advisors default with its authoring org ───────────
UPDATE content.brand_profiles bp
   SET owner_org_id = o.id
  FROM tenancy.orgs o
 WHERE lower(bp.slug) = 'umb-advisors'
   AND bp.owner_org_id IS NULL
   AND lower(o.slug) = 'umb';

-- ─── Seed the Staqs authoring brand profile (terminal-green) ─────────────────
-- From spec/org-brand-kits.md: JetBrains Mono headings/body, #4ade80 accent.
-- Skips cleanly if the Staqs org row isn't present yet. Idempotent on slug.
INSERT INTO content.brand_profiles
  (name, slug, description,
   heading_font_family, body_font_family, brand_color_hex,
   show_logo_in_header, footer_left_text, footer_show_page_number,
   is_default, owner_org_id, created_by)
SELECT
  'STAQS.IO',
  'staqs',
  'Staqs authoring brand: JetBrains Mono terminal aesthetic, terminal-green accent.',
  'JetBrains Mono',
  'JetBrains Mono',
  '4ADE80',
  false,
  'Confidential',
  true,
  false,
  o.id,
  'system'
  FROM tenancy.orgs o
 WHERE lower(o.slug) = 'staqs'
   AND NOT EXISTS (
     SELECT 1 FROM content.brand_profiles WHERE lower(slug) = 'staqs'
   );
