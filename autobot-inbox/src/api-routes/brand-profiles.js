/**
 * Brand Profiles API
 *
 * Surfaces content.brand_profiles + content.brand_profile_assets to the
 * board UI. Profiles drive how lib/contracts/pdf-render and docx-render
 * style every contract (heading font + brand color + body font + logo +
 * footer).
 *
 * Endpoints:
 *   GET    /api/brand-profiles                              — list active
 *   GET    /api/brand-profiles/:id                          — full row
 *   POST   /api/brand-profiles                              — create
 *   PATCH  /api/brand-profiles/:id                          — update fields
 *   POST   /api/brand-profiles/:id/archive                  — soft delete
 *   POST   /api/brand-profiles/:id/make-default             — flip is_default (atomic)
 *   POST   /api/brand-profiles/:id/assets/:kind             — upload asset (PNG / TTF)
 *   DELETE /api/brand-profiles/:id/assets/:kind             — remove an asset
 *   GET    /api/brand-profiles/:id/assets/:kind             — stream the asset bytes
 *
 * Asset kinds: logo | font_heading_{regular,bold,italic,bold_italic}
 *                  | font_body_{regular,bold,italic,bold_italic}
 */

import { query, withTransaction, withBoardScope } from '../db.js';

const ASSET_KINDS = new Set([
  'logo',
  'font_heading_regular', 'font_heading_bold', 'font_heading_italic', 'font_heading_bold_italic',
  'font_body_regular',    'font_body_bold',    'font_body_italic',    'font_body_bold_italic',
]);

// Asset size ceilings (bytes). Logos are PNG screenshots, fonts are TTFs.
const MAX_LOGO_BYTES = 2 * 1024 * 1024;       //  2 MB
const MAX_FONT_BYTES = 5 * 1024 * 1024;       //  5 MB per weight

export function registerBrandProfileRoutes(routes) {
  // ─── List ───────────────────────────────────────────────────────────────
  routes.set('GET /api/brand-profiles', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let r;
    try {
      r = await scopedQuery(
        `SELECT bp.id, bp.name, bp.slug, bp.description,
                bp.heading_font_family, bp.body_font_family, bp.brand_color_hex,
                bp.show_logo_in_header, bp.footer_left_text, bp.footer_show_page_number,
                bp.is_default, bp.created_at, bp.updated_at,
                (SELECT count(*) FROM content.brand_profile_assets bpa
                  WHERE bpa.profile_id = bp.id)::int AS asset_count,
                (SELECT count(*) FROM content.counterparties cp
                  WHERE cp.brand_profile_id = bp.id AND cp.archived_at IS NULL)::int AS counterparty_count
           FROM content.brand_profiles bp
          WHERE bp.archived_at IS NULL
          ORDER BY bp.is_default DESC, lower(bp.name) ASC`
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { profiles: r.rows };
  });

  // ─── Detail ─────────────────────────────────────────────────────────────
  routes.set('GET /api/brand-profiles/:id', async (req) => {
    const id = lastPathSegment(req.url);
    const r = await query(
      `SELECT * FROM content.brand_profiles WHERE id = $1`,
      [id]
    );
    if (!r.rows[0]) throw notFound('Brand profile not found');

    // Asset summary (no bytes): present-or-absent + sizes.
    const a = await query(
      `SELECT asset_kind, mime_type, size_bytes, width_px, height_px, updated_at
         FROM content.brand_profile_assets WHERE profile_id = $1`,
      [id]
    );
    return { profile: r.rows[0], assets: a.rows };
  });

  // ─── Create ─────────────────────────────────────────────────────────────
  routes.set('POST /api/brand-profiles', async (req, body) => {
    const {
      name, slug, description,
      heading_font_family, body_font_family, brand_color_hex,
      show_logo_in_header, footer_left_text, footer_show_page_number,
    } = body || {};
    if (!name || !slug) throw badRequest('name and slug are required');
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) {
      throw badRequest('slug must be lowercase-hyphen, 2-60 chars');
    }
    if (brand_color_hex && !/^[0-9A-Fa-f]{6}$/.test(brand_color_hex)) {
      throw badRequest('brand_color_hex must be 6 hex chars (no leading #)');
    }
    const boardUser = req.headers['x-board-user'] || 'unknown';
    try {
      const r = await query(
        `INSERT INTO content.brand_profiles
           (name, slug, description,
            heading_font_family, body_font_family, brand_color_hex,
            show_logo_in_header, footer_left_text, footer_show_page_number,
            created_by)
         VALUES ($1, $2, $3,
                 COALESCE($4, 'Calibri'), COALESCE($5, 'Calibri'), COALESCE($6, '111111'),
                 COALESCE($7, true), COALESCE($8, 'Confidential'), COALESCE($9, true),
                 $10)
         RETURNING id, slug`,
        [
          name, slug, description || null,
          heading_font_family || null, body_font_family || null, brand_color_hex || null,
          typeof show_logo_in_header === 'boolean' ? show_logo_in_header : null,
          footer_left_text != null ? footer_left_text : null,
          typeof footer_show_page_number === 'boolean' ? footer_show_page_number : null,
          boardUser,
        ]
      );
      return { ok: true, id: r.rows[0].id, slug: r.rows[0].slug };
    } catch (err) {
      if (err.code === '23505') throw conflict(`Profile with slug "${slug}" already exists`);
      throw err;
    }
  });

  // ─── Update ─────────────────────────────────────────────────────────────
  routes.set('PATCH /api/brand-profiles/:id', async (req, body) => {
    const id = lastPathSegment(req.url);
    const allowed = [
      'name', 'description',
      'heading_font_family', 'body_font_family', 'brand_color_hex',
      'show_logo_in_header', 'footer_left_text', 'footer_show_page_number',
    ];
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(body || {})) {
      if (!allowed.includes(k)) throw badRequest(`Unknown field: ${k}`);
      if (k === 'brand_color_hex' && v && !/^[0-9A-Fa-f]{6}$/.test(v)) {
        throw badRequest('brand_color_hex must be 6 hex chars');
      }
      values.push(v === '' ? null : v);
      sets.push(`${k} = $${values.length}`);
    }
    if (sets.length === 0) throw badRequest('No fields to update');
    values.push(id);
    const r = await query(
      `UPDATE content.brand_profiles SET ${sets.join(', ')}
        WHERE id = $${values.length} AND archived_at IS NULL
        RETURNING id`,
      values
    );
    if (!r.rows[0]) throw notFound('Brand profile not found or archived');
    return { ok: true };
  });

  // ─── Archive ────────────────────────────────────────────────────────────
  routes.set('POST /api/brand-profiles/:id/archive', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];
    // Don't allow archiving the active default — operator must promote another
    // profile first. Otherwise renderers fall back to vanilla styling.
    const r = await query(
      `UPDATE content.brand_profiles
          SET archived_at = now()
        WHERE id = $1 AND archived_at IS NULL AND is_default = false
        RETURNING id`,
      [id]
    );
    if (!r.rows[0]) {
      throw conflict('Cannot archive the default profile, or profile not found.');
    }
    return { ok: true };
  });

  // ─── Promote to default ─────────────────────────────────────────────────
  // Wrapped in a single transaction so we never observe zero-or-two default
  // rows mid-flip (the partial unique index in migration 145 would reject
  // the second UPDATE if we did them as separate auto-commits).
  routes.set('POST /api/brand-profiles/:id/make-default', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE content.brand_profiles SET is_default = false WHERE is_default = true AND id != $1`,
        [id]
      );
      const r = await client.query(
        `UPDATE content.brand_profiles SET is_default = true
          WHERE id = $1 AND archived_at IS NULL RETURNING id`,
        [id]
      );
      if (!r.rows[0]) throw notFound('Profile not found');
    });
    return { ok: true };
  });

  // ─── Upload an asset (POST, base64 in JSON body) ────────────────────────
  // Body: { mime_type, content_base64, width_px?, height_px? }
  // POST (not PUT) because the board's ops proxy doesn't pass PUT through.
  // Idempotent server-side via ON CONFLICT, so semantics still match PUT.
  routes.set('POST /api/brand-profiles/:id/assets/:kind', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const kind = parts[parts.length - 1];
    const profileId = parts[parts.length - 3];
    if (!ASSET_KINDS.has(kind)) throw badRequest(`Unknown asset kind: ${kind}`);

    const { mime_type, content_base64, width_px, height_px } = body || {};
    if (!mime_type || !content_base64) throw badRequest('mime_type and content_base64 are required');

    if (kind === 'logo' && mime_type !== 'image/png') {
      throw badRequest('logo must be image/png');
    }
    if (kind !== 'logo' && !/^font\//.test(mime_type) && mime_type !== 'application/octet-stream') {
      throw badRequest('font assets must be font/* MIME type');
    }

    const buf = Buffer.from(content_base64, 'base64');
    if (buf.length === 0) throw badRequest('Empty asset');
    const max = kind === 'logo' ? MAX_LOGO_BYTES : MAX_FONT_BYTES;
    if (buf.length > max) {
      const e = new Error(`Asset too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, max ${(max / 1024 / 1024).toFixed(1)} MB)`);
      e.statusCode = 413;
      throw e;
    }

    const exists = await query(
      `SELECT 1 FROM content.brand_profiles WHERE id = $1 AND archived_at IS NULL`,
      [profileId]
    );
    if (!exists.rows[0]) throw notFound('Brand profile not found');

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
      [profileId, kind, mime_type, buf.length, width_px ?? null, height_px ?? null, buf]
    );

    return { ok: true, kind, size_bytes: buf.length };
  });

  // ─── Stream an asset out (used by the UI logo preview, etc.) ────────────
  routes.set('GET /api/brand-profiles/:id/assets/:kind', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const kind = parts[parts.length - 1];
    const profileId = parts[parts.length - 3];
    if (!ASSET_KINDS.has(kind)) throw badRequest(`Unknown asset kind: ${kind}`);

    const r = await query(
      `SELECT mime_type, content, size_bytes
         FROM content.brand_profile_assets
        WHERE profile_id = $1 AND asset_kind = $2`,
      [profileId, kind]
    );
    if (!r.rows[0]) throw notFound('Asset not found');
    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': r.rows[0].mime_type,
        'Content-Length': String(r.rows[0].size_bytes),
        'Cache-Control': 'private, max-age=300',
      },
      body: r.rows[0].content,
    };
  });

  // ─── Delete an asset ────────────────────────────────────────────────────
  routes.set('DELETE /api/brand-profiles/:id/assets/:kind', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const kind = parts[parts.length - 1];
    const profileId = parts[parts.length - 3];
    if (!ASSET_KINDS.has(kind)) throw badRequest(`Unknown asset kind: ${kind}`);
    const r = await query(
      `DELETE FROM content.brand_profile_assets
        WHERE profile_id = $1 AND asset_kind = $2
        RETURNING profile_id`,
      [profileId, kind]
    );
    if (!r.rows[0]) throw notFound('Asset not found');
    return { ok: true };
  });
}

// ─── Tiny helpers ──────────────────────────────────────────────────────────
function lastPathSegment(url) {
  const parts = new URL(url, 'http://localhost').pathname.split('/');
  return parts[parts.length - 1];
}
function notFound(msg) { const e = new Error(msg); e.statusCode = 404; return e; }
function badRequest(msg) { const e = new Error(msg); e.statusCode = 400; return e; }
function conflict(msg) { const e = new Error(msg); e.statusCode = 409; return e; }
