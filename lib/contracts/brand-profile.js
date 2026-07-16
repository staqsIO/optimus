/**
 * Brand profile loader — shared by lib/contracts/pdf-render.js and
 * lib/contracts/docx-render.js.
 *
 * Resolution order (first non-null wins):
 *   1. draft.brand_profile_id          (explicit per-contract override)
 *   2. counterparty.brand_profile_id   (default for this client)
 *   3. authoring-org profile           (OPT-5: brand_profiles.owner_org_id ==
 *                                       the draft's engagement.owner_org_id — the
 *                                       "on behalf of" org's brand kit)
 *   4. is_default = true               (the system default profile)
 *   5. null                            (renderers fall back to vanilla styling)
 *
 * Asset bytes (logo PNG + 8 TTF font weights) are fetched from
 * content.brand_profile_assets. When the resolved profile is the bundled
 * UMB Advisors default (slug = 'umb-advisors') AND the assets table has
 * no row for a given kind, we fall back to the files in lib/contracts/assets/.
 * That keeps the system working out-of-the-box without requiring an
 * operator to run `npm run seed-brand-assets` after the migration.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ASSETS_DIR = join(__dirname, 'assets');

const BUNDLED_DEFAULT_FILES = {
  logo:                      'umb-logo.png',
  font_heading_regular:      'fonts/cormorant-garamond/CormorantGaramond-regular.ttf',
  font_heading_bold:         'fonts/cormorant-garamond/CormorantGaramond-bold.ttf',
  font_heading_italic:       'fonts/cormorant-garamond/CormorantGaramond-italic.ttf',
  font_heading_bold_italic:  'fonts/cormorant-garamond/CormorantGaramond-boldItalic.ttf',
  font_body_regular:         'fonts/dm-sans/DMSans-regular.ttf',
  font_body_bold:            'fonts/dm-sans/DMSans-bold.ttf',
  font_body_italic:          'fonts/dm-sans/DMSans-italic.ttf',
  font_body_bold_italic:     'fonts/dm-sans/DMSans-boldItalic.ttf',
};

const ASSET_KINDS = Object.keys(BUNDLED_DEFAULT_FILES);

/**
 * Resolve which brand profile applies to a given draft.
 *
 * @param {string} draftId
 * @returns {Promise<Object|null>} { profile, assets } or null if no profile resolved.
 *   profile: full row from content.brand_profiles
 *   assets: { logo: Buffer|null, font_heading_regular: Buffer|null, ... }
 */
export async function loadBrandProfileForDraft(draftId) {
  // Single round-trip that walks the fallback chain. The authoring-org step
  // (OPT-5) is tolerant of pre-176 databases: if brand_profiles has no
  // owner_org_id column yet, the owner-org CTE returns nothing and the query
  // degrades to the original draft → counterparty → default chain.
  const r = await query(
    `WITH d AS (
       SELECT brand_profile_id, counterparty_id, engagement_id
         FROM content.drafts
        WHERE id = $1
     ),
     cp AS (
       SELECT brand_profile_id
         FROM content.counterparties
        WHERE id = (SELECT counterparty_id FROM d)
     ),
     eng AS (
       SELECT owner_org_id
         FROM engagements.engagements
        WHERE id = (SELECT engagement_id FROM d)
     )
     SELECT bp.*
       FROM content.brand_profiles bp
      WHERE bp.archived_at IS NULL
        AND (
              bp.id = (SELECT brand_profile_id FROM d)
           OR bp.id = (SELECT brand_profile_id FROM cp)
           OR (bp.owner_org_id IS NOT NULL
               AND bp.owner_org_id = (SELECT owner_org_id FROM eng))
           OR bp.is_default = true
        )
      ORDER BY
        CASE
          WHEN bp.id = (SELECT brand_profile_id FROM d)  THEN 0
          WHEN bp.id = (SELECT brand_profile_id FROM cp) THEN 1
          WHEN bp.owner_org_id IS NOT NULL
            AND bp.owner_org_id = (SELECT owner_org_id FROM eng) THEN 2
          WHEN bp.is_default                              THEN 3
          ELSE 4
        END
      LIMIT 1`,
    [draftId]
  ).catch(async (err) => {
    // Pre-176 DB: no owner_org_id column on brand_profiles. Fall back to the
    // original draft → counterparty → default resolution so older databases
    // (and any caller mid-migration) keep rendering.
    if (/owner_org_id|column .* does not exist/i.test(err.message)) {
      return query(
        `WITH d AS (
           SELECT brand_profile_id, counterparty_id
             FROM content.drafts
            WHERE id = $1
         ),
         cp AS (
           SELECT brand_profile_id
             FROM content.counterparties
            WHERE id = (SELECT counterparty_id FROM d)
         )
         SELECT bp.*
           FROM content.brand_profiles bp
          WHERE bp.archived_at IS NULL
            AND (
                  bp.id = (SELECT brand_profile_id FROM d)
               OR bp.id = (SELECT brand_profile_id FROM cp)
               OR bp.is_default = true
            )
          ORDER BY
            CASE
              WHEN bp.id = (SELECT brand_profile_id FROM d)  THEN 0
              WHEN bp.id = (SELECT brand_profile_id FROM cp) THEN 1
              WHEN bp.is_default                              THEN 2
              ELSE 3
            END
          LIMIT 1`,
        [draftId]
      );
    }
    throw err;
  });
  const profile = r.rows[0] || null;
  if (!profile) return null;

  const assets = await loadAssetsForProfile(profile);
  return { profile, assets };
}

/**
 * Resolve which brand profile applies to a given engagement.
 *
 * Engagements have no direct `brand_profile_id` column today; we walk:
 *   1. counterparty matched by engagement.client (case-insensitive name)
 *      → counterparty.brand_profile_id
 *   2. is_default = true
 *
 * @param {string} engagementId
 * @returns {Promise<{profile, assets}|null>}
 */
export async function loadBrandProfileForEngagement(engagementId) {
  // Single round-trip: walk engagement → counterparty-by-name → default.
  // The counterparty match is case-insensitive against the engagement's
  // free-form `client` field. archived counterparties are excluded.
  const r = await query(
    `WITH e AS (
       SELECT lower(trim(client)) AS client_lc
         FROM engagements.engagements
        WHERE id = $1
     ),
     matched_cp AS (
       SELECT brand_profile_id
         FROM content.counterparties
        WHERE archived_at IS NULL
          AND lower(name) = (SELECT client_lc FROM e)
          AND brand_profile_id IS NOT NULL
        LIMIT 1
     )
     SELECT bp.*
       FROM content.brand_profiles bp
      WHERE bp.archived_at IS NULL
        AND (
              bp.id = (SELECT brand_profile_id FROM matched_cp)
           OR bp.is_default = true
        )
      ORDER BY
        CASE
          WHEN bp.id = (SELECT brand_profile_id FROM matched_cp) THEN 0
          WHEN bp.is_default                                       THEN 1
          ELSE 2
        END
      LIMIT 1`,
    [engagementId]
  );
  const profile = r.rows[0] || null;
  if (!profile) return null;

  const assets = await loadAssetsForProfile(profile);
  return { profile, assets };
}

/**
 * Resolve only the default brand profile (used when there's no draft or
 * engagement context but we still want consistent house branding).
 */
export async function loadDefaultBrandProfile() {
  const r = await query(
    `SELECT * FROM content.brand_profiles
      WHERE is_default = true AND archived_at IS NULL
      LIMIT 1`
  );
  const profile = r.rows[0] || null;
  if (!profile) return null;
  const assets = await loadAssetsForProfile(profile);
  return { profile, assets };
}

export async function loadBrandProfileById(profileId) {
  const r = await query(
    `SELECT * FROM content.brand_profiles WHERE id = $1 AND archived_at IS NULL`,
    [profileId]
  );
  if (!r.rows[0]) return null;
  const assets = await loadAssetsForProfile(r.rows[0]);
  return { profile: r.rows[0], assets };
}

async function loadAssetsForProfile(profile) {
  const result = {};
  for (const kind of ASSET_KINDS) result[kind] = null;

  const dbAssets = await query(
    `SELECT asset_kind, content, mime_type, size_bytes, width_px, height_px
       FROM content.brand_profile_assets
      WHERE profile_id = $1`,
    [profile.id]
  );
  const dbByKind = new Map(dbAssets.rows.map((r) => [r.asset_kind, r]));

  for (const kind of ASSET_KINDS) {
    const row = dbByKind.get(kind);
    if (row) {
      result[kind] = {
        data: row.content,
        mime: row.mime_type,
        size: row.size_bytes,
        width: row.width_px,
        height: row.height_px,
        source: 'db',
      };
      continue;
    }
    // Bundled fallback only for the system default profile.
    if (profile.slug === 'umb-advisors') {
      const bundled = readBundled(kind);
      if (bundled) result[kind] = bundled;
    }
  }
  return result;
}

function readBundled(kind) {
  const rel = BUNDLED_DEFAULT_FILES[kind];
  if (!rel) return null;
  try {
    const buf = readFileSync(join(BUNDLED_ASSETS_DIR, rel));
    if (kind === 'logo') {
      return { data: buf, mime: 'image/png', size: buf.length, width: 444, height: 81, source: 'bundled' };
    }
    return { data: buf, mime: 'font/ttf', size: buf.length, source: 'bundled' };
  } catch {
    return null;
  }
}

export { ASSET_KINDS };
