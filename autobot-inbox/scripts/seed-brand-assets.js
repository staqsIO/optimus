#!/usr/bin/env node
/**
 * Seed the bundled UMB Advisors brand assets into content.brand_profile_assets.
 *
 * Migration 145 creates the brand_profile row but not the binary assets —
 * SQL migrations stay text-only so we don't base64 multi-megabyte TTFs into
 * a .sql file. This script loads the bundled files from
 * lib/contracts/assets/ and writes them to the assets table.
 *
 * Idempotent: re-runs upsert by (profile_id, asset_kind).
 *
 * Usage:
 *   node scripts/seed-brand-assets.js                 # seed UMB default
 *   node scripts/seed-brand-assets.js --slug acme     # seed for a named profile
 */

import 'dotenv/config';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', '..', 'lib', 'contracts', 'assets');

const slugIdx = process.argv.indexOf('--slug');
const slug = slugIdx !== -1 ? process.argv[slugIdx + 1] : 'umb-advisors';

const FONT_MAP = {
  font_heading_regular:      'fonts/cormorant-garamond/CormorantGaramond-regular.ttf',
  font_heading_bold:         'fonts/cormorant-garamond/CormorantGaramond-bold.ttf',
  font_heading_italic:       'fonts/cormorant-garamond/CormorantGaramond-italic.ttf',
  font_heading_bold_italic:  'fonts/cormorant-garamond/CormorantGaramond-boldItalic.ttf',
  font_body_regular:         'fonts/dm-sans/DMSans-regular.ttf',
  font_body_bold:            'fonts/dm-sans/DMSans-bold.ttf',
  font_body_italic:          'fonts/dm-sans/DMSans-italic.ttf',
  font_body_bold_italic:     'fonts/dm-sans/DMSans-boldItalic.ttf',
};

const r = await query(
  `SELECT id FROM content.brand_profiles WHERE lower(slug) = lower($1) AND archived_at IS NULL`,
  [slug]
);
if (!r.rows[0]) {
  console.error(`No brand profile with slug "${slug}". Run migrate first.`);
  process.exit(1);
}
const profileId = r.rows[0].id;

let inserted = 0;
let skipped = 0;

async function upsert(kind, relPath, mime, extra = {}) {
  const abs = join(ASSETS_DIR, relPath);
  try {
    statSync(abs);
  } catch {
    console.warn(`  ✗ missing asset file: ${relPath} (skipping)`);
    skipped += 1;
    return;
  }
  const buf = readFileSync(abs);
  await query(
    `INSERT INTO content.brand_profile_assets
       (profile_id, asset_kind, mime_type, size_bytes, width_px, height_px, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (profile_id, asset_kind)
     DO UPDATE SET mime_type = EXCLUDED.mime_type,
                   size_bytes = EXCLUDED.size_bytes,
                   width_px = EXCLUDED.width_px,
                   height_px = EXCLUDED.height_px,
                   content = EXCLUDED.content,
                   updated_at = now()`,
    [profileId, kind, mime, buf.length, extra.width || null, extra.height || null, buf]
  );
  console.log(`  ✓ ${kind} (${(buf.length / 1024).toFixed(1)} KB)`);
  inserted += 1;
}

console.log(`Seeding brand assets for profile "${slug}" (${profileId})`);
await upsert('logo', 'umb-logo.png', 'image/png', { width: 444, height: 81 });
for (const [kind, rel] of Object.entries(FONT_MAP)) {
  await upsert(kind, rel, 'font/ttf');
}

console.log(`\nDone. ${inserted} written, ${skipped} skipped.`);
process.exit(0);
