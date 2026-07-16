/**
 * Contracts API Routes
 *
 * Dedicated endpoints for the Contracts page — joins content.drafts
 * with signatures.* tables for a unified pipeline view.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, withAgentScope, withBoardScope } from '../db.js';

import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { visibleClause, CURRENT_ORG_READ_SCOPE } from '../../../lib/tenancy/scope.js';
import { retrieverScopeWithOrg } from './document-access.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load contract templates
const TEMPLATES = {};
const TEMPLATE_DIR = join(__dirname, '../../../agents/executor-contract');
for (const [key, file] of Object.entries({
  'service-proposal': 'template-service-proposal.md',
  'nda': 'template-nda.md',
  'sow': 'template-sow.md',
})) {
  try {
    TEMPLATES[key] = readFileSync(join(TEMPLATE_DIR, file), 'utf-8');
  } catch { /* template file not available */ }
}
const DEFAULT_TEMPLATE = TEMPLATES['service-proposal'] || '';

export function registerContractRoutes(routes, { withViewer } = {}) {
  // Resolve the tenancy principal for write routes (STAQPRO-593 owner-stamp).
  // withViewer is injected by api.js; absent/throw → null → column DEFAULT applies.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/contracts/templates — list available templates (file + DB merged).
  // File templates use their slug as `id`; DB templates use their UUID.
  // Both shapes: { id, name, variables, source, description?, archived? }
  routes.set('GET /api/contracts/templates', async () => {
    // Match both [UPPER_SNAKE] (legacy) and [TYPE:UPPER_SNAKE] (typed). The
    // UI parses the type prefix from the raw string — we just return the
    // full inner content and let the client split it.
    const bracketRe = /\[[A-Z][A-Z0-9_:]{1,80}\]/g;
    const extractVars = (body) => {
      const matches = body.match(bracketRe) || [];
      return matches.filter((v, i, a) => a.indexOf(v) === i).map((v) => v.slice(1, -1));
    };

    const fileTemplates = Object.keys(TEMPLATES).map((key) => ({
      id: key,
      slug: key,
      name: key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      variables: extractVars(TEMPLATES[key]),
      source: 'file',
      description: null,
    }));

    // DB templates — only active (non-archived). If a DB template's slug
    // collides with a file template, DB wins (lets the board override a
    // bundled template).
    let dbTemplates = [];
    try {
      const rows = await query(
        `SELECT id, name, slug, description, body, variables, updated_at
           FROM content.contract_templates
          WHERE archived_at IS NULL
          ORDER BY name ASC`
      );
      dbTemplates = rows.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        variables: Array.isArray(r.variables) && r.variables.length
          ? r.variables
          : extractVars(r.body),
        source: 'db',
        updated_at: r.updated_at,
      }));
    } catch (err) {
      // Table may not exist in dev — don't break the picker.
      console.warn('[contracts/templates] DB template load failed:', err.message);
    }

    // Dedup by slug with DB precedence
    const bySlug = new Map();
    for (const t of fileTemplates) bySlug.set(t.slug, t);
    for (const t of dbTemplates) bySlug.set(t.slug, t);
    const templates = Array.from(bySlug.values()).sort((a, b) => a.name.localeCompare(b.name));

    return { templates };
  });

  // GET /api/contracts/templates/:id — DB template detail (body + metadata).
  // File templates aren't editable so they're not served here.
  routes.set('GET /api/contracts/templates/:id', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 1];
    const r = await query(
      `SELECT id, name, slug, description, body, template_type, variables,
              created_by, created_at, updated_at, archived_at
         FROM content.contract_templates WHERE id = $1`,
      [id]
    );
    if (!r.rows[0]) {
      const err = new Error('Template not found');
      err.statusCode = 404;
      throw err;
    }
    return { template: r.rows[0] };
  });

  // POST /api/contracts/templates — create a DB template
  routes.set('POST /api/contracts/templates', async (req, body) => {
    const { name, slug, description, body: templateBody, template_type } = body || {};
    if (!name || !slug || !templateBody) {
      const err = new Error('name, slug, and body are required');
      err.statusCode = 400;
      throw err;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) {
      const err = new Error('slug must be lowercase-hyphen, 2-60 chars');
      err.statusCode = 400;
      throw err;
    }
    const boardUser = req.headers['x-board-user'] || 'unknown';

    try {
      const inserted = await query(
        `INSERT INTO content.contract_templates
           (name, slug, description, body, template_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug`,
        [name, slug, description || null, templateBody, template_type || 'service_proposal', boardUser]
      );
      return { ok: true, id: inserted.rows[0].id, slug: inserted.rows[0].slug };
    } catch (err) {
      if (err.code === '23505') {
        const e = new Error(`Template with slug "${slug}" already exists`);
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
  });

  // PATCH /api/contracts/templates/:id — update a DB template
  routes.set('PATCH /api/contracts/templates/:id', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 1];
    const allowed = ['name', 'description', 'body', 'template_type'];
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(body || {})) {
      if (!allowed.includes(k)) {
        const err = new Error(`Unknown field: ${k}`);
        err.statusCode = 400;
        throw err;
      }
      values.push(v === '' ? null : v);
      sets.push(`${k} = $${values.length}`);
    }
    if (sets.length === 0) {
      const err = new Error('No fields to update');
      err.statusCode = 400;
      throw err;
    }
    values.push(id);
    const r = await query(
      `UPDATE content.contract_templates
          SET ${sets.join(', ')}
        WHERE id = $${values.length} AND archived_at IS NULL
        RETURNING id`,
      values
    );
    if (!r.rows[0]) {
      const err = new Error('Template not found or archived');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true };
  });

  // POST /api/contracts/templates/:id/archive — soft-delete
  routes.set('POST /api/contracts/templates/:id/archive', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];
    const r = await query(
      `UPDATE content.contract_templates
          SET archived_at = now()
        WHERE id = $1 AND archived_at IS NULL
        RETURNING id`,
      [id]
    );
    if (!r.rows[0]) {
      const err = new Error('Template not found or already archived');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true };
  });

  // POST /api/contracts/ingest-proposal — drop in a .docx (typically the
  // signed/final proposal from the counterparty) and the system:
  //   1. Extracts markdown content via mammoth → seeds a new contract draft.
  //   2. Extracts logo, fonts (heading/body), brand color from the docx's
  //      styles.xml + word/media/ + word/fonts/ → creates a new brand profile.
  //   3. Links draft → brand profile (and to a counterparty if one is named).
  //
  // Body: { filename, content_base64, counterparty_id?, title? }
  //
  // The same module powers offline "import this proposal into our system"
  // workflows (CLI / scripts) — see lib/contracts/proposal-ingest.js.
  routes.set('POST /api/contracts/ingest-proposal', async (req, body) => {
    const { filename, content_base64, counterparty_id, title: overrideTitle } = body || {};
    if (!filename || !content_base64) {
      const err = new Error('filename and content_base64 are required');
      err.statusCode = 400;
      throw err;
    }
    if (!/\.docx$/i.test(filename)) {
      const err = new Error('Only .docx files are supported for ingest right now');
      err.statusCode = 400;
      throw err;
    }
    const buf = Buffer.from(content_base64, 'base64');
    if (buf.length === 0) {
      const err = new Error('Empty file');
      err.statusCode = 400;
      throw err;
    }
    if (buf.length > 25 * 1024 * 1024) {
      const err = new Error(`File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, max 25 MB)`);
      err.statusCode = 413;
      throw err;
    }

    const boardUser = req.headers['x-board-user'] || 'unknown';

    const { extractProposal } = await import('../../../lib/contracts/proposal-ingest.js');
    let extracted;
    try {
      extracted = await extractProposal(buf);
    } catch (err) {
      const e = new Error(`Failed to parse proposal: ${err.message}`);
      e.statusCode = 422;
      throw e;
    }

    const title = (overrideTitle || extracted.title || filename.replace(/\.docx$/i, '')).trim();
    if (!extracted.markdown) {
      const err = new Error('No content could be extracted from the docx');
      err.statusCode = 422;
      throw err;
    }

    // OPT-166 P3-B3: /api/contracts/ingest-proposal is an authed-any route.
    // content.counterparties, content.drafts, and content.append_draft_version's
    // underlying tables are RLS-enforced; content.brand_profiles/brand_profile_assets
    // are not, but ride the same scope for lifecycle consistency (no interleaved
    // external calls in this section, so one open scope for the handler tail is safe).
    // Board gets a scoped session; non-board keeps the legacy pool (INERT pre-flip,
    // RLS fail-closed post-flip). Do NOT use withAgentScope(req.auth.sub) here: a
    // non-board sub (customer email / plain agent id) would throw the agent-id regex
    // (lib/db.js:659) where bare query previously succeeded — a pre-flip INERT break.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scoped = boardScope ?? query;
    let draftId, brandProfileId;
    try {
      // ── Brand profile from extracted assets ──────────────────────────────
      // Only create a profile if we found something brand-y to anchor on
      // (color OR a logo OR an explicitly-named font). Otherwise the draft
      // just inherits the system default.
      const hasBrandSignal =
           extracted.brand.brand_color_hex
        || extracted.assets.logo
        || extracted.assets.fonts.length > 0
        || (extracted.brand.heading_font_family
            && extracted.brand.heading_font_family !== 'Calibri');

      brandProfileId = null;
      if (hasBrandSignal) {
        const slug = `ingest-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`;
        const cleanColor = extracted.brand.brand_color_hex && /^[0-9A-Fa-f]{6}$/.test(extracted.brand.brand_color_hex)
          ? extracted.brand.brand_color_hex
          : '111111';
        const profileRow = await scoped(
          `INSERT INTO content.brand_profiles
             (name, slug, description,
              heading_font_family, body_font_family, brand_color_hex,
              show_logo_in_header, footer_left_text, footer_show_page_number,
              created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            `${title} (ingested)`,
            slug,
            `Auto-created from uploaded proposal "${filename}".`,
            extracted.brand.heading_font_family || 'Calibri',
            extracted.brand.body_font_family || extracted.brand.heading_font_family || 'Calibri',
            cleanColor,
            Boolean(extracted.assets.logo),
            'Confidential',
            true,
            boardUser,
          ]
        );
        brandProfileId = profileRow.rows[0].id;

        if (extracted.assets.logo) {
          const l = extracted.assets.logo;
          await scoped(
            `INSERT INTO content.brand_profile_assets
               (profile_id, asset_kind, mime_type, size_bytes, width_px, height_px, content)
             VALUES ($1, 'logo', $2, $3, $4, $5, $6)
             ON CONFLICT (profile_id, asset_kind) DO UPDATE
               SET mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
                   width_px = EXCLUDED.width_px, height_px = EXCLUDED.height_px,
                   content = EXCLUDED.content, updated_at = now()`,
            [brandProfileId, l.mime, l.data.length, l.width, l.height, l.data]
          );
        }
        for (const f of extracted.assets.fonts) {
          await scoped(
            `INSERT INTO content.brand_profile_assets
               (profile_id, asset_kind, mime_type, size_bytes, content)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (profile_id, asset_kind) DO UPDATE
               SET mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
                   content = EXCLUDED.content, updated_at = now()`,
            [brandProfileId, f.kind, f.mime, f.data.length, f.data]
          );
        }
      }

      // ── Resolve counterparty (optional) ──────────────────────────────────
      let resolvedCounterpartyId = counterparty_id || null;
      if (resolvedCounterpartyId) {
        const cp = await scoped(
          `SELECT id FROM content.counterparties
            WHERE id = $1 AND archived_at IS NULL`,
          [resolvedCounterpartyId]
        );
        if (!cp.rows[0]) {
          const err = new Error('Counterparty not found or archived');
          err.statusCode = 400;
          throw err;
        }
      }

      // ── Create the contract draft ────────────────────────────────────────
      const slug = `ingest-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;
      const draftRow = await scoped(
        `INSERT INTO content.drafts
           (content_type, status, title, slug, author, body, word_count, cost_usd,
            seo_metadata, template_id, counterparty_id, brand_profile_id)
         VALUES ('contract', 'draft', $1, $2, $3, $4, $5, 0, $6, 'ingest', $7, $8)
         RETURNING id`,
        [
          title,
          slug,
          'Dustin Powers & Eric Gang',
          extracted.markdown,
          extracted.markdown.split(/\s+/).filter(Boolean).length,
          JSON.stringify({ ingested_filename: filename }),
          resolvedCounterpartyId,
          brandProfileId,
        ]
      );
      draftId = draftRow.rows[0].id;

      await scoped(
        `SELECT * FROM content.append_draft_version($1, $2, 'initial', $3, $4, NULL, NULL)`,
        [draftId, extracted.markdown, `Ingested from ${filename}`, boardUser]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return {
      ok: true,
      draft_id: draftId,
      brand_profile_id: brandProfileId,
      title,
      extracted: {
        chars: extracted.markdown.length,
        heading_font: extracted.brand.heading_font_family,
        body_font: extracted.brand.body_font_family,
        brand_color_hex: extracted.brand.brand_color_hex,
        has_logo: Boolean(extracted.assets.logo),
        embedded_fonts: extracted.assets.fonts.length,
      },
    };
  });

  // POST /api/contracts/new — create a blank contract from template
  routes.set('POST /api/contracts/new', async (req, body) => {
    const { title, client_name, template, counterparty_id } = body || {};
    if (!title) {
      const err = new Error('title is required');
      err.statusCode = 400;
      throw err;
    }

    const boardUser = req.headers['x-board-user'] || 'unknown';
    // Owner-stamp from the caller's org (STAQPRO-593). null → column DEFAULT.
    const ownerOrgId = writerOrgId(await resolvePrincipalFor(req));

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {

    // Resolve counterparty — either by explicit id or lazily by client_name.
    // Lazy path keeps legacy callers working until the UI fully switches over.
    let resolvedCounterpartyId = counterparty_id || null;
    let resolvedClientName = client_name || null;
    let resolvedSignerName = null;
    let resolvedSignerEmail = null;
    let resolvedSignerTitle = null;

    if (resolvedCounterpartyId) {
      const cp = await scopedQuery(
        `SELECT id, name, primary_signer_name, primary_signer_email, primary_signer_title
           FROM content.counterparties
          WHERE id = $1 AND archived_at IS NULL`,
        [resolvedCounterpartyId]
      );
      if (!cp.rows[0]) {
        const err = new Error('Counterparty not found or archived');
        err.statusCode = 400;
        throw err;
      }
      resolvedClientName = cp.rows[0].name;
      resolvedSignerName = cp.rows[0].primary_signer_name;
      resolvedSignerEmail = cp.rows[0].primary_signer_email;
      resolvedSignerTitle = cp.rows[0].primary_signer_title;
    } else if (resolvedClientName) {
      // Lazy-create / look-up by name. Keeps legacy callers working.
      const existing = await scopedQuery(
        `SELECT id FROM content.counterparties
          WHERE lower(name) = lower($1) AND archived_at IS NULL
          LIMIT 1`,
        [resolvedClientName.trim()]
      );
      if (existing.rows[0]) {
        resolvedCounterpartyId = existing.rows[0].id;
      } else {
        const created = await scopedQuery(
          `INSERT INTO content.counterparties (name, created_by)
           VALUES ($1, $2) RETURNING id`,
          [resolvedClientName.trim(), boardUser]
        );
        resolvedCounterpartyId = created.rows[0].id;
      }
    }

    const slug = `contract-${(resolvedClientName || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;

    // Resolve the template body from either a DB row (by uuid or slug) or
    // the file-based fallbacks. DB templates take precedence on slug
    // collision. Ultimate fallback is service-proposal file template.
    let templateId = 'service-proposal';
    let body_content = TEMPLATES['service-proposal'] || DEFAULT_TEMPLATE
      || `# Contract\n\nPrepared for: ${resolvedClientName || '[CLIENT_NAME]'}\n`;

    if (template) {
      // UUID → DB lookup
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(template)) {
        try {
          const dbT = await scopedQuery(
            `SELECT slug, body FROM content.contract_templates
              WHERE id = $1 AND archived_at IS NULL LIMIT 1`,
            [template]
          );
          if (dbT.rows[0]) {
            templateId = dbT.rows[0].slug;
            body_content = dbT.rows[0].body;
          }
        } catch (err) {
          console.warn('[contracts/new] DB template lookup failed, falling back:', err.message);
        }
      } else {
        // Slug — try DB first, then file
        try {
          const dbT = await scopedQuery(
            `SELECT slug, body FROM content.contract_templates
              WHERE slug = $1 AND archived_at IS NULL LIMIT 1`,
            [template]
          );
          if (dbT.rows[0]) {
            templateId = dbT.rows[0].slug;
            body_content = dbT.rows[0].body;
          } else if (TEMPLATES[template]) {
            templateId = template;
            body_content = TEMPLATES[template];
          }
        } catch {
          if (TEMPLATES[template]) {
            templateId = template;
            body_content = TEMPLATES[template];
          }
        }
      }
    }

    if (resolvedClientName) {
      // Fill [CLIENT_NAME] across the chosen template
      body_content = body_content.replace(/\[CLIENT_NAME\]/g, resolvedClientName);
    }

    const result = await scopedQuery(
      `INSERT INTO content.drafts
         (content_type, status, title, slug, author, body, word_count, cost_usd,
          seo_metadata, template_id, counterparty_id, owner_org_id)
       VALUES ('contract', 'draft', $1, $2, $3, $4, $5, 0, $6, $7, $8, $9)
       RETURNING id`,
      [
        title,
        slug,
        'Dustin Powers & Eric Gang',
        body_content,
        body_content.split(/\s+/).length,
        JSON.stringify({
          client_name: resolvedClientName,
          signer_name: resolvedSignerName,
          signer_email: resolvedSignerEmail,
          signer_title: resolvedSignerTitle,
        }),
        templateId,
        resolvedCounterpartyId,
        ownerOrgId,
      ]
    );

    const draftId = result.rows[0].id;

    // Seed the version history with the initial body
    await scopedQuery(
      `SELECT * FROM content.append_draft_version($1, $2, 'initial', $3, $4, NULL, NULL)`,
      [draftId, body_content, `Created from ${templateId} template`, boardUser]
    );

    return {
      ok: true,
      draft_id: draftId,
      template_id: templateId,
      counterparty_id: resolvedCounterpartyId,
    };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });
  // GET /api/contracts — list contracts with signing status
  routes.set('GET /api/contracts', async (req) => {
    // STAQPRO-608 (596-class): contracts are content.drafts rows
    // (content_type='contract'); content.drafts carries owner_org_id (migration
    // 134). Scope fail-closed so one org's contracts never enumerate to another.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: 1 });

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(`
      SELECT d.id, d.title, d.status AS draft_status, d.created_at, d.updated_at,
        d.word_count, d.cost_usd, d.slug, d.template_id, d.counterparty_id,
        -- Prefer the canonical counterparty name; fall back to the denormalized
        -- seo_metadata field for contracts created before migration 065.
        COALESCE(cp.name, d.seo_metadata->>'client_name') AS client_name,
        COALESCE(cp.primary_signer_name, d.seo_metadata->>'signer_name') AS signer_name,
        COALESCE(cp.primary_signer_email, d.seo_metadata->>'signer_email') AS signer_email,
        sr.id AS request_id, sr.status AS signing_status, sr.expires_at, sr.created_at AS sent_at,
        COALESCE((SELECT count(*) FROM signatures.signers s WHERE s.request_id = sr.id AND s.status = 'signed'), 0)::int AS signed_count,
        COALESCE((SELECT count(*) FROM signatures.signers s WHERE s.request_id = sr.id AND s.status = 'declined'), 0)::int AS declined_count,
        COALESCE((SELECT count(*) FROM signatures.signers s WHERE s.request_id = sr.id), 0)::int AS total_signers
      FROM content.drafts d
      LEFT JOIN content.counterparties cp ON cp.id = d.counterparty_id
      LEFT JOIN LATERAL (
        SELECT * FROM signatures.signature_requests WHERE draft_id = d.id ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      WHERE d.content_type = 'contract' AND ${v.sql}
      ORDER BY d.updated_at DESC
      LIMIT 100
    `, v.params);
    } finally {
      if (boardScope) await boardScope.release();
    }

    // Compute display status
    const contracts = result.rows.map((r) => {
      let displayStatus = 'draft';
      if (r.signing_status === 'completed') displayStatus = 'signed';
      else if (r.signing_status === 'declined') displayStatus = 'declined';
      else if (r.signing_status === 'expired') displayStatus = 'expired';
      else if (r.signing_status === 'cancelled') displayStatus = 'cancelled';
      else if (r.signing_status === 'in_progress' || r.signing_status === 'pending') displayStatus = 'sent';
      else if (r.draft_status === 'approved') displayStatus = 'ready';
      else if (r.draft_status === 'review') displayStatus = 'review';
      else displayStatus = 'draft';

      return { ...r, display_status: displayStatus };
    });

    return { contracts };
  });

  // DELETE /api/contracts/:id — remove a contract draft and its dependent
  // rows (gate_log, send_overrides, signature_requests, versions, attachments).
  // Blocked if signing is in flight or already completed — the system needs
  // those rows to validate signatures and explain why a signed contract exists.
  // Cancelled / declined / expired signing flows DO allow deletion.
  //
  // Cross-schema FK note: signatures.signature_requests.draft_id is a SOFT
  // reference (no constraint, per D5), so we explicitly DELETE it inside the
  // transaction. Versions + attachments are real FKs with ON DELETE CASCADE.
  routes.set('DELETE /api/contracts/:id', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
    const draftId = parts[2]; // /api/contracts/:id
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(draftId)) {
      const err = new Error('invalid contract id');
      err.statusCode = 400;
      throw err;
    }

    const draft = await query(
      `SELECT id, title, content_type FROM content.drafts WHERE id = $1`,
      [draftId]
    );
    if (!draft.rows[0]) {
      const err = new Error('Contract not found');
      err.statusCode = 404;
      throw err;
    }
    if (draft.rows[0].content_type !== 'contract') {
      const err = new Error('Draft is not a contract — use the drafts endpoint to delete it');
      err.statusCode = 400;
      throw err;
    }

    // Block deletion if any signature_request on this draft is active or
    // completed. Operator can still revoke first, then delete.
    const activeSigning = await query(
      `SELECT id, status FROM signatures.signature_requests
        WHERE draft_id = $1
          AND status IN ('pending', 'in_progress', 'completed')
        ORDER BY created_at DESC
        LIMIT 1`,
      [draftId]
    );
    if (activeSigning.rows[0]) {
      const err = new Error(
        `Cannot delete: a signature request is ${activeSigning.rows[0].status}. ` +
        `Revoke it first if you want to discard this contract.`
      );
      err.statusCode = 409;
      throw err;
    }

    // STAQPRO-303 PR-B (#555): run the deletion inside an RLS-scoped
    // transaction instead of a naked withTransaction. The UPDATE content.drafts
    // below (and the content.drafts DELETE) are gated by content.drafts'
    // tenancy.visible(NULL, owner_org_id) RLS predicate — SELECT from sql/190,
    // DELETE from sql/195, UPDATE from sql/196. Under the autobot_agent pool
    // (STAQPRO-303 PR-B-2) those statements silently affect 0 rows unless
    // app.user + app.org_ids are set for the transaction, leaving dangling
    // source_draft_id pointers. The scope wrapper plumbs those GUCs via
    // SET LOCAL and opens one BEGIN/COMMIT for the whole session, preserving
    // the multi-statement atomicity withTransaction gave this delete.
    //
    // Principal handling (#562, Codex P2): this is an `org-shared` route
    // (route-tiers.js), so agent JWTs legitimately reach it — but their
    // req.auth.role is a tier string, never 'board'. withBoardScope THROWS for
    // any non-board principal, which 500'd a valid agent delete. withBoardScope
    // is only a thin board-only wrapper over withAgentScope, so we call
    // withAgentScope directly and branch the role ourselves:
    //   - board JWT + ops api_secret (both req.auth.role==='board') → role 'board'
    //     (byte-identical to the old withBoardScope behavior).
    //   - agent JWT (any other tier) → normalized to 'agent' — normalizing
    //     rather than passing the raw tier avoids tripping setAgentContext's
    //     ^[a-z]+$ role regex on a hyphenated/qualified tier string.
    // sub is lowercased (as withBoardScope does, db.js:995) so a board
    // github-username sub with uppercase still matches the agentId regex.
    //
    // Org scope: an agent JWT resolves to an adminBypass principal whose
    // readOrgIds is empty (scope.js:60). Left unmapped, app.org_ids would be
    // unset and every content.drafts statement here would silently no-op under
    // the autobot_agent pool — the exact #555 bug, moved from board to agent.
    // Map adminBypass → CURRENT_ORG_READ_SCOPE (single org today); this is
    // deliberately NARROWER than app-layer adminBypass ('TRUE', org-wide) —
    // correct fail-safe for a destructive path.
    //
    // Note (residual, tracked): the content.send_overrides DELETE still relies
    // on that table's auth.uid()-based policy (sql/071/195), which is dead
    // until request.jwt.claim.sub is plumbed — see #561. And the precondition
    // SELECT above (content.drafts existence check) is still a naked query();
    // wiring the read path through the scope is the broader PR-B read-path
    // change, not this write-parity unit.
    const principal = await resolvePrincipalFor(req);
    const orgIds = principal?.readOrgIds?.length
      ? principal.readOrgIds
      : (principal?.adminBypass ? CURRENT_ORG_READ_SCOPE : null);
    const scoped = await withAgentScope(String(req.auth.sub).toLowerCase(), {
      role: req.auth?.role === 'board' ? 'board' : 'agent',
      user: principal?.userId ?? null,
      orgIds,
    });
    try {
      // INVARIANT: this try-block must contain ONLY scoped DB statements. The
      // scope holds an open txn that `scoped.release()` COMMITs in `finally`;
      // a non-DB throw here would still commit whatever ran before it (a
      // partial delete). If you need non-DB work, do it before withAgentScope
      // or after release() — never between the scoped writes.
      // Append-only audit + override tables don't cascade.
      await scoped(`DELETE FROM content.gate_log WHERE draft_id = $1`, [draftId]);
      await scoped(`DELETE FROM content.send_overrides WHERE draft_id = $1`, [draftId]);
      // Other drafts that referenced this one as their source — clear the
      // pointer rather than deleting them (preserves their history).
      await scoped(
        `UPDATE content.drafts SET source_draft_id = NULL WHERE source_draft_id = $1`,
        [draftId]
      );
      // Soft reference; clean up cancelled/declined/expired requests for this
      // draft so they don't dangle. Cascades to signers + signing_events.
      await scoped(
        `DELETE FROM signatures.signature_requests WHERE draft_id = $1`,
        [draftId]
      );
      // Versions + attachments cascade via their FKs.
      await scoped(`DELETE FROM content.drafts WHERE id = $1`, [draftId]);
    } finally {
      await scoped.release();
    }

    return { ok: true, deleted: { id: draftId, title: draft.rows[0].title } };
  });

  // POST /api/contracts/:id/send — send contract for signature
  routes.set('POST /api/contracts/:id/send', async (req, body) => {
    const { createSigningRequest } = await import('../../../lib/signatures/session.js');
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2]; // /api/contracts/:id/send

    // STAQPRO-303 PR-B (#561): scope EVERY content-schema statement in this
    // handler through withAgentScope so the RLS predicates match under the
    // non-superuser autobot_agent pool:
    //   - content.drafts SELECT/UPDATE       → tenancy.visible (sql/190, sql/196)
    //   - content.send_overrides INSERT/UPDATE → draft-join tenancy.visible
    //     (sql/197 — derived through the parent draft's owner_org_id)
    // Under today's superuser pool RLS is bypassed, so this is behavior-neutral;
    // post-flip it is what stops the override-audit INSERT from hard-denying and
    // the request_id backfill from silently no-opping (issue #561).
    //
    // /api/contracts/* is an org-shared route (route-tiers.js) — agent JWTs
    // legitimately reach here — so we resolve the principal and branch role
    // exactly as the DELETE handler does (see its long note ~L649 for the
    // board-vs-agent / adminBypass→CURRENT_ORG_READ_SCOPE rationale). Resolve
    // ONCE; each DB touch-point below opens its own SHORT scoped txn via
    // openScope(). External work (pre-send LLM scan, createSigningRequest,
    // signing emails) is deliberately kept OUTSIDE every scope — withAgentScope
    // holds an open BEGIN/COMMIT and a long external call must never sit inside
    // it. The INSERT commits in its own txn and is visible to the later backfill
    // txn keyed on its returned id.
    const principal = await resolvePrincipalFor(req);
    const orgIds = principal?.readOrgIds?.length
      ? principal.readOrgIds
      : (principal?.adminBypass ? CURRENT_ORG_READ_SCOPE : null);
    const openScope = () => withAgentScope(String(req.auth.sub).toLowerCase(), {
      role: req.auth?.role === 'board' ? 'board' : 'agent',
      user: principal?.userId ?? null,
      orgIds,
    });

    // Validate draft exists and is a contract — scoped so content.drafts'
    // tenancy.visible SELECT policy matches under autobot_agent.
    let draft;
    {
      const scoped = await openScope();
      try {
        draft = await scoped(
          `SELECT id, title, status, content_type, seo_metadata FROM content.drafts WHERE id = $1`,
          [draftId]
        );
      } finally {
        await scoped.release();
      }
    }

    if (!draft.rows[0]) {
      const err = new Error('Contract not found');
      err.statusCode = 404;
      throw err;
    }

    if (draft.rows[0].content_type !== 'contract') {
      const err = new Error('Draft is not a contract');
      err.statusCode = 400;
      throw err;
    }

    if (draft.rows[0].status !== 'approved') {
      const err = new Error('Contract must be approved before sending for signature');
      err.statusCode = 400;
      throw err;
    }

    // Get signers from body or fall back to draft metadata
    const meta = typeof draft.rows[0].seo_metadata === 'string'
      ? JSON.parse(draft.rows[0].seo_metadata)
      : (draft.rows[0].seo_metadata || {});

    let signers = body?.signers;
    if (!signers?.length && meta.signer_name && meta.signer_email) {
      signers = [{ name: meta.signer_name, email: meta.signer_email }];
    }

    if (!signers?.length) {
      const err = new Error('At least one signer (name + email) is required');
      err.statusCode = 400;
      throw err;
    }

    const boardUser = req.headers['x-board-user'] || 'unknown';

    // Re-run the G2/G7 pre-send scan server-side. We don't trust the
    // client's cached findings — a malicious caller could forge an empty
    // list. If block-severity findings exist AND the operator hasn't
    // supplied override_reason, refuse the send with the findings so the
    // UI can prompt. skip_governance_check bypasses this — reserved for
    // automated re-sends from the accept-and-resend flow where the check
    // already ran moments ago.
    let overrideRowId = null;
    if (!body?.skip_governance_check) {
      let findings = [];
      try {
        const { preSendCheck } = await import('../../../lib/contracts/pre-send-check.js');
        const check = await preSendCheck({ draftId });
        findings = check.findings || [];
        // STAQPRO-547: if the scan ran but its output was unparseable, the
        // G2/G7 evaluation did not actually happen. Don't proceed as if the
        // contract were clean — inject a sentinel warn-severity finding so the
        // operator is shown that the check was inconclusive. Warn (not block)
        // keeps the send unblocked (matching the LLM-outage policy) while
        // making the gap visible rather than silently fail-open.
        if (check.parseError) {
          console.warn(
            '[contracts/send] pre-send check returned unparseable output, surfacing inconclusive finding:',
            check.parseErrorMsg
          );
          findings = [
            ...findings,
            {
              gate: 'G2',
              severity: 'warn',
              title: 'Pre-send scan inconclusive',
              excerpt: '',
              reason: `The G2/G7 governance scan could not be evaluated (unparseable model output): ${check.parseErrorMsg || 'unknown parse error'}. Review the contract manually before sending.`,
            },
          ];
        }
      } catch (err) {
        // Check failure is non-fatal — don't block legitimate sends on an
        // LLM outage. Log loudly so the operator notices.
        console.warn('[contracts/send] pre-send check failed, proceeding without:', err.message);
      }

      const blockFindings = findings.filter((f) => f.severity === 'block');
      if (blockFindings.length > 0) {
        const reason = body?.override_reason?.trim();
        if (!reason || reason.length < 10) {
          const err = new Error(
            'Block-severity governance findings require an override_reason of at least 10 chars before sending.'
          );
          err.statusCode = 422;
          err.details = { findings, block_count: blockFindings.length };
          throw err;
        }
        // Log the override up-front so audit exists even if send subsequently
        // fails. Scoped: content.send_overrides' INSERT policy (sql/197) checks
        // the parent draft is tenancy-visible under app.org_ids — under
        // autobot_agent an unscoped INSERT hard-denies with a 500 (#561).
        const overrideScope = await openScope();
        let inserted;
        try {
          inserted = await overrideScope(
            `INSERT INTO content.send_overrides
               (draft_id, overridden_by, override_reason, findings)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id`,
            [draftId, boardUser, reason, JSON.stringify(findings)]
          );
        } finally {
          await overrideScope.release();
        }
        overrideRowId = inserted.rows[0].id;
      }
    }

    const result = await createSigningRequest({
      draftId,
      title: draft.rows[0].title,
      message: body?.message || `Please review and sign: ${draft.rows[0].title}`,
      signers,
      createdBy: boardUser,
      expiresInHours: body?.expiresInHours || 72,
    });

    // Backfill request_id on the override row now that the send succeeded.
    // The trigger allows exactly this one NULL → non-NULL transition; scoped so
    // content.send_overrides' UPDATE policy (sql/197) matches under
    // autobot_agent — else this silently no-ops post-flip (0 rows, no error,
    // request_id NULL forever: the #561 backfill bug). Its OWN scope so a
    // backfill error can't poison the drafts-status txn below.
    if (overrideRowId) {
      const backfillScope = await openScope();
      try {
        await backfillScope(
          `UPDATE content.send_overrides SET request_id = $1 WHERE id = $2`,
          [result.requestId, overrideRowId]
        );
      } catch (err) {
        console.warn('[contracts/send] override backfill failed:', err.message);
      } finally {
        await backfillScope.release();
      }
    }

    // Update draft status to reflect it's been sent. Scoped so content.drafts'
    // tenancy.visible UPDATE policy (sql/196) matches under autobot_agent.
    {
      const statusScope = await openScope();
      try {
        await statusScope(
          `UPDATE content.drafts SET status = 'published', updated_at = now() WHERE id = $1`,
          [draftId]
        );
      } finally {
        await statusScope.release();
      }
    }

    // Send signing emails via Resend (non-blocking)
    try {
      const { sendSigningEmail } = await import('../../../lib/signatures/notifier.js');
      for (const signer of result.signers) {
        await sendSigningEmail({
          signerName: signer.name,
          signerEmail: signer.email,
          signingUrl: signer.signingUrl,
          documentTitle: draft.rows[0].title,
          message: body?.message,
          senderName: boardUser,
          expiresAt: result.expiresAt,
        }).catch(err => console.warn(`[contracts] Email to ${signer.email} failed:`, err.message));
      }
    } catch (err) {
      console.warn('[contracts] Email notification failed:', err.message);
    }

    return result;
  });

  // POST /api/contracts/:id/edit — apply a natural-language edit to the contract body
  routes.set('POST /api/contracts/:id/edit', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    const { instruction, currentBody } = body || {};

    if (!instruction || !String(instruction).trim()) {
      const err = new Error('instruction is required');
      err.statusCode = 400;
      throw err;
    }

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session. Scoped per DB block —
    // this handler interleaves RAG retrieval and an LLM call, which must stay
    // strictly outside any acquired scope.
    const isBoardPrincipal = req.auth?.role === 'board';

    // Load current body if not supplied
    let workingBody = currentBody;
    if (!workingBody) {
      const boardScope1 = isBoardPrincipal ? await withBoardScope(req.auth) : null;
      let draft;
      try {
        draft = await (boardScope1 ?? query)(
          `SELECT body, content_type FROM content.drafts WHERE id = $1`,
          [draftId]
        );
      } finally {
        if (boardScope1) await boardScope1.release();
      }
      if (!draft.rows[0]) {
        const err = new Error('Contract not found');
        err.statusCode = 404;
        throw err;
      }
      if (draft.rows[0].content_type !== 'contract') {
        const err = new Error('Draft is not a contract');
        err.statusCode = 400;
        throw err;
      }
      workingBody = draft.rows[0].body;
    }

    // Legacy shim on input too — normalize {{}} → [] before giving to LLM
    const normalized = String(workingBody).replace(/\{\{([A-Z][A-Z0-9_]{1,59})\}\}/g, '[$1]');

    // Load client name from draft metadata for RAG search
    const boardScope2 = isBoardPrincipal ? await withBoardScope(req.auth) : null;
    let draftMeta;
    try {
      draftMeta = await (boardScope2 ?? query)(
        `SELECT seo_metadata FROM content.drafts WHERE id = $1`,
        [draftId]
      );
    } finally {
      if (boardScope2) await boardScope2.release();
    }
    const meta = typeof draftMeta.rows[0]?.seo_metadata === 'string'
      ? JSON.parse(draftMeta.rows[0].seo_metadata)
      : (draftMeta.rows[0]?.seo_metadata || {});
    const clientName = meta.client_name || '';

    // Pull RAG context — emails, meetings, KB docs about this client.
    // We keep the raw chunks too (not just the concatenated context string)
    // so the AI edit version row can store provenance for the board to audit.
    let ragContext = '';
    let ragChunks = [];
    try {
      const { retrieveContext } = await import('../../../lib/rag/retriever.js');
      const searchQuery = [
        clientName,
        instruction,
        'service proposal scope pricing objectives deliverables',
      ].filter(Boolean).join(' ');
      // Worktree 1 (RAG tenancy hardening) + Phase-2 org gate: derive retriever
      // scope from the authenticated request. retrieverScopeWithOrg enforces
      // "board members see only their own", "agent JWT must declare ownerId or
      // orgScope:true", attaches readOrgIds (fail-closed org gate), and rejects
      // unauthenticated requests with 401.
      const retrieverScope = await retrieverScopeWithOrg(req, body || {});
      const result = await retrieveContext(searchQuery, { topK: 10 }, retrieverScope);
      // retrieveContext returns { answer, citations, chunks } or null
      if (result?.chunks?.length) {
        // Trim each chunk to what the UI actually needs — full text + source
        // identifiers + similarity. Drop embedding vectors, giant metadata blobs.
        ragChunks = result.chunks.map((c, i) => ({
          ref: i + 1,
          text: typeof c.text === 'string' ? c.text.slice(0, 4000) : '',
          source: c.metadata?.source || c.metadata?.document_source || 'doc',
          documentId: c.documentId || c.metadata?.document_id || null,
          title: c.metadata?.title || null,
          similarity: typeof c.similarity === 'number' ? Number(c.similarity.toFixed(4)) : null,
          happenedAt: c.metadata?.happened_at || c.metadata?.created_at || null,
          participants: c.metadata?.document_participants || null,
        }));
      }
      if (result?.answer) {
        ragContext = result.answer;
      } else if (ragChunks.length) {
        ragContext = ragChunks.map(c => `[${c.source}] ${c.text}`).join('\n\n---\n\n');
      }
      if (ragContext) {
        console.log(`[contracts/edit] RAG context loaded: ${ragChunks.length} chunks, ${ragContext.length} chars`);
      } else {
        console.log('[contracts/edit] RAG returned no relevant context');
      }
    } catch (err) {
      console.warn('[contracts/edit] RAG retrieval failed:', err.message);
    }

    const { createLLMClient, callProvider, computeCost } = await import('../../../lib/llm/provider.js');
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const agentsConfigPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../config/agents.json'
    );
    const agentsConfig = JSON.parse(readFileSync(agentsConfigPath, 'utf-8'));
    const modelKey = 'claude-haiku-4-5-20251001';
    const llm = createLLMClient(modelKey, agentsConfig.models);

    const systemPrompt = `You are a contract editing assistant for UMB Advisors.

CRITICAL RULE: You MUST return the COMPLETE contract body every time. Your output replaces the entire document. If you return anything other than the full contract, the document is destroyed.

- If you can fulfill the instruction: return the full contract with edits applied.
- If you CANNOT fulfill the instruction (missing context, unclear request): return the contract UNCHANGED. Put your explanation in the SUMMARY line only. NEVER replace contract content with commentary or questions.

Editing guidelines:
- Fill [BRACKET_PLACEHOLDERS] with substantive, professional content when asked
- Two bracket shapes exist: legacy [NAME] and typed [TYPE:NAME] (e.g. [DATE:COMMENCEMENT_DATE], [CURRENCY:MONTHLY_FEE], [SIGNER:CLIENT_PRIMARY]). When filling a typed bracket, the replacement text should conform to the type (DATE → ISO date or natural date; CURRENCY → formatted dollar amount; SIGNER → full name + title). Remove the entire bracket including the type prefix when filling.
- Use the provided knowledge base context (emails, meetings, transcripts) to write specific, relevant content
- Write in UMB's tone: direct, practical, partner-oriented. Not legalese.
- When filling a bracket like [OBJECTIVES], write detailed bullet points based on available context
- Preserve all [BRACKET_PLACEHOLDERS] you were NOT asked to fill — including their type prefixes for typed brackets
- Preserve the exact format (HTML tags, structure) of the input
- Do NOT add commentary, preamble, or questions inside the contract body
- Do NOT wrap output in markdown fences

On the FINAL line (and only the final line), write "SUMMARY: " followed by a 10-15 word description of what changed. If you made no changes, write "SUMMARY: No changes — [reason]".`;

    const userPrompt = `${clientName ? `CLIENT: ${clientName}\n\n` : ''}${ragContext ? `CONTEXT FROM KNOWLEDGE BASE (emails, meetings, transcripts):\n${ragContext}\n\n---\n\n` : ''}CURRENT CONTRACT:
\`\`\`
${normalized}
\`\`\`

INSTRUCTION:
${instruction}

Use the knowledge base context above to write substantive, specific content — not generic placeholders. Return the full revised contract followed by exactly one SUMMARY: line.`;

    const response = await callProvider(llm, {
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 8192,
      temperature: 0.2,
    });

    const fullText = (response.text || '').trim();
    // Extract SUMMARY: line from the end
    const summaryMatch = fullText.match(/\n?SUMMARY:\s*(.+)$/m);
    const summary = summaryMatch ? summaryMatch[1].trim() : 'Applied edit';
    const newBody = (summaryMatch ? fullText.slice(0, summaryMatch.index) : fullText)
      .replace(/```(?:markdown|html)?\s*/g, '')
      .replace(/```\s*$/g, '')
      .trim();

    const costUsd = computeCost(
      response.inputTokens || 0,
      response.outputTokens || 0,
      llm.modelConfig
    );

    // Guardrail: reject if the LLM returned commentary instead of a contract.
    // A valid contract body should be at least 30% the length of the original
    // and should not start with conversational phrases.
    const lengthRatio = newBody.length / Math.max(normalized.length, 1);
    // Strip HTML tags before checking for conversational openers
    const plainStart = newBody.replace(/<[^>]+>/g, '').trim();
    const looksLikeCommentary = /^(I don't|I cannot|I can't|Unfortunately|I apologize|I'm sorry|I would need|To fill|Could you|I do not)/i.test(plainStart);
    if (looksLikeCommentary || lengthRatio < 0.3) {
      console.warn(`[contracts/edit] Guardrail triggered — LLM returned commentary or truncated output (ratio=${lengthRatio.toFixed(2)}, commentary=${looksLikeCommentary})`);
      return {
        newBody: null,
        summary: summary.startsWith('No changes') ? summary : `Could not apply: ${summary || 'LLM did not return a valid contract body'}`,
        costUsd,
        model: modelKey,
        rejected: true,
      };
    }

    // Persist the edit + snapshot as a version. Doing this server-side (rather than
    // relying on the editor's autosave) lets us attach the AI metadata — cost, model,
    // summary — to the version row. The debounced autosave that fires on the client
    // 1.5s later will dedup by hash.
    const boardUser = req.headers['x-board-user'] || 'unknown';
    const editWordCount = newBody.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const boardScope3 = isBoardPrincipal ? await withBoardScope(req.auth) : null;
    const scopedQuery3 = boardScope3 ?? query;
    let versionResult;
    try {
      await scopedQuery3(
        `UPDATE content.drafts
           SET body = $1, word_count = $2, cost_usd = COALESCE(cost_usd, 0) + $3, updated_at = now()
         WHERE id = $4`,
        [newBody, editWordCount, costUsd, draftId]
      );
      versionResult = await scopedQuery3(
        `SELECT * FROM content.append_draft_version($1, $2, 'ai_edit', $3, $4, $5, $6, $7)`,
        [
          draftId,
          newBody,
          summary,
          boardUser,
          costUsd,
          modelKey,
          ragChunks.length ? JSON.stringify(ragChunks) : null,
        ]
      );
    } finally {
      if (boardScope3) await boardScope3.release();
    }
    const versionRow = versionResult.rows[0] || {};

    return {
      newBody,
      summary,
      costUsd,
      model: modelKey,
      versionId: versionRow.version_id,
      versionNumber: versionRow.version_number,
      sourceCount: ragChunks.length,
    };
  });

  // POST /api/contracts/:id/attachments — upload a file (JSON base64 body)
  routes.set('POST /api/contracts/:id/attachments', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    const { filename, mime_type, content_base64 } = body || {};

    if (!filename || !mime_type || !content_base64) {
      const err = new Error('filename, mime_type, and content_base64 are required');
      err.statusCode = 400;
      throw err;
    }
    if (filename.length > 255) {
      const err = new Error('filename too long (max 255)');
      err.statusCode = 400;
      throw err;
    }

    // Decode base64 to buffer
    const buffer = Buffer.from(content_base64, 'base64');
    const sizeBytes = buffer.length;
    if (sizeBytes === 0) {
      const err = new Error('empty file');
      err.statusCode = 400;
      throw err;
    }
    if (sizeBytes > 25 * 1024 * 1024) {
      const err = new Error(`file too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, max 25 MB)`);
      err.statusCode = 413;
      throw err;
    }

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      // Verify draft exists + is a contract
      const draft = await scopedQuery(
        `SELECT id, content_type FROM content.drafts WHERE id = $1`,
        [draftId]
      );
      if (!draft.rows[0]) {
        const err = new Error('Contract not found');
        err.statusCode = 404;
        throw err;
      }
      if (draft.rows[0].content_type !== 'contract') {
        const err = new Error('Draft is not a contract');
        err.statusCode = 400;
        throw err;
      }

      const boardUser = req.headers['x-board-user'] || 'unknown';

      result = await scopedQuery(
        `INSERT INTO content.contract_attachments
           (draft_id, filename, mime_type, size_bytes, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, filename, mime_type, size_bytes, created_at`,
        [draftId, filename, mime_type, sizeBytes, buffer, boardUser]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { ok: true, attachment: result.rows[0] };
  });

  // GET /api/contracts/:id/attachments — list attachments (metadata only, no content)
  routes.set('GET /api/contracts/:id/attachments', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const result = await query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM content.contract_attachments
       WHERE draft_id = $1
       ORDER BY created_at ASC`,
      [draftId]
    );

    return { attachments: result.rows };
  });

  // GET /api/contracts/:id/attachments/:attId/download — stream file content
  // Returns a raw binary response — handled by the API layer via response.body.
  routes.set('GET /api/contracts/:id/attachments/:attId/download', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const attId = parts[parts.length - 2];

    const result = await query(
      `SELECT filename, mime_type, content
       FROM content.contract_attachments
       WHERE id = $1`,
      [attId]
    );

    if (!result.rows[0]) {
      const err = new Error('Attachment not found');
      err.statusCode = 404;
      throw err;
    }

    const row = result.rows[0];
    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '\\"')}"`,
        'Cache-Control': 'private, max-age=300',
      },
      body: row.content,  // Buffer
    };
  });

  // DELETE /api/contracts/:id/attachments/:attId — remove an attachment
  routes.set('DELETE /api/contracts/:id/attachments/:attId', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const attId = parts[parts.length - 1];

    const result = await query(
      `DELETE FROM content.contract_attachments WHERE id = $1 RETURNING id`,
      [attId]
    );

    if (!result.rows[0]) {
      const err = new Error('Attachment not found');
      err.statusCode = 404;
      throw err;
    }

    return { ok: true };
  });

  // GET /api/contracts/:id/versions — list version history (metadata only)
  routes.set('GET /api/contracts/:id/versions', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    let result;
    try {
      result = await (boardScope ?? query)(
        `SELECT id, version_number, word_count, change_source, change_summary,
                created_by, cost_usd, model, parent_version_id, created_at,
                COALESCE(jsonb_array_length(rag_chunks), 0) AS source_count
         FROM content.draft_versions
         WHERE draft_id = $1
         ORDER BY version_number DESC`,
        [draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { versions: result.rows };
  });

  // GET /api/contracts/:id/versions/diff?a=<versionId>&b=<versionId>
  // Word-level diff between two versions of this contract. Either side can
  // be a real version id or the sentinel "current" (resolves to the live
  // draft body, which may be ahead of the latest immutable version if there
  // are unsaved-as-version edits in flight).
  routes.set('GET /api/contracts/:id/versions/diff', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const draftId = parts[parts.length - 2];
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    if (!a || !b) {
      const err = new Error('Both `a` and `b` query params are required');
      err.statusCode = 400;
      throw err;
    }

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session. loadSide() is invoked
    // concurrently via Promise.all below, so each call acquires and releases
    // its own scope rather than sharing one connection across concurrent calls.
    async function loadSide(versionRef) {
      const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
      const scopedQuery = boardScope ?? query;
      try {
        if (versionRef === 'current') {
          const r = await scopedQuery(
            `SELECT body, updated_at AS created_at
               FROM content.drafts WHERE id = $1`,
            [draftId]
          );
          if (!r.rows[0]) {
            const err = new Error('Contract not found');
            err.statusCode = 404;
            throw err;
          }
          return {
            id: 'current',
            version_number: null,
            label: 'current draft',
            body: r.rows[0].body || '',
            created_at: r.rows[0].created_at,
          };
        }
        const r = await scopedQuery(
          `SELECT id, version_number, body, change_source, created_at
             FROM content.draft_versions
            WHERE id = $1 AND draft_id = $2`,
          [versionRef, draftId]
        );
        if (!r.rows[0]) {
          const err = new Error('Version not found');
          err.statusCode = 404;
          throw err;
        }
        return {
          id: r.rows[0].id,
          version_number: r.rows[0].version_number,
          label: `v${r.rows[0].version_number}`,
          change_source: r.rows[0].change_source,
          body: r.rows[0].body || '',
          created_at: r.rows[0].created_at,
        };
      } finally {
        if (boardScope) await boardScope.release();
      }
    }

    const [aSide, bSide] = await Promise.all([loadSide(a), loadSide(b)]);
    const { diffContractBodies } = await import('../../../lib/contracts/diff.js');
    const { blocks, stats } = diffContractBodies(aSide.body, bSide.body);

    // Bodies are already in the version snapshots; don't echo them back —
    // the diff blocks carry every word the UI needs.
    const stripBody = ({ _body, ...rest }) => rest;
    return {
      a: stripBody(aSide),
      b: stripBody(bSide),
      blocks,
      stats,
    };
  });

  // GET /api/contracts/:id/versions/:versionId — fetch a specific version's body
  routes.set('GET /api/contracts/:id/versions/:versionId', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const versionId = parts[parts.length - 1];
    const draftId = parts[parts.length - 3];

    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    let result;
    try {
      result = await (boardScope ?? query)(
        `SELECT id, draft_id, version_number, body, word_count, change_source,
                change_summary, created_by, cost_usd, model, created_at, rag_chunks
         FROM content.draft_versions
         WHERE id = $1 AND draft_id = $2`,
        [versionId, draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    if (!result.rows[0]) {
      const err = new Error('Version not found');
      err.statusCode = 404;
      throw err;
    }

    return { version: result.rows[0] };
  });

  // POST /api/contracts/:id/revert/:versionId — revert the draft body to a prior version
  // Appends a new version with source='revert' so history stays linear and no version is lost.
  routes.set('POST /api/contracts/:id/revert/:versionId', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const versionId = parts[parts.length - 1];
    const draftId = parts[parts.length - 3];

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let versionRow;
    let targetBody;
    try {
      // Load the target version (must belong to this draft)
      const target = await scopedQuery(
        `SELECT body, version_number FROM content.draft_versions
         WHERE id = $1 AND draft_id = $2`,
        [versionId, draftId]
      );
      if (!target.rows[0]) {
        const err = new Error('Version not found');
        err.statusCode = 404;
        throw err;
      }

      // Block revert on locked drafts — same lock as /body (can't edit sent/rejected)
      const draft = await scopedQuery(
        `SELECT status FROM content.drafts WHERE id = $1`,
        [draftId]
      );
      if (!draft.rows[0]) {
        const err = new Error('Contract not found');
        err.statusCode = 404;
        throw err;
      }
      if (['published', 'rejected'].includes(draft.rows[0].status)) {
        const err = new Error('Cannot revert a contract that has been sent for signature or rejected');
        err.statusCode = 409;
        throw err;
      }

      targetBody = target.rows[0].body;
      const targetNum = target.rows[0].version_number;
      const wordCount = targetBody.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      const boardUser = req.headers['x-board-user'] || 'unknown';

      // Update the live draft body
      await scopedQuery(
        `UPDATE content.drafts
           SET body = $1, word_count = $2, updated_at = now()
         WHERE id = $3`,
        [targetBody, wordCount, draftId]
      );

      // Append a new version marking this as a revert (dedup may short-circuit
      // if the body happens to equal the latest version — that's fine)
      const result = await scopedQuery(
        `SELECT * FROM content.append_draft_version($1, $2, 'revert', $3, $4, NULL, NULL)`,
        [draftId, targetBody, `Reverted to v${targetNum}`, boardUser]
      );
      versionRow = result.rows[0] || {};
    } finally {
      if (boardScope) await boardScope.release();
    }

    return {
      ok: true,
      body: targetBody,
      version_id: versionRow.version_id,
      version_number: versionRow.version_number,
      deduplicated: versionRow.deduplicated,
    };
  });

  // GET /api/contracts/:id/pdf — render the contract body + audit trail to PDF.
  // Playwright cold-starts Chromium (~1-2s); not fast enough to render on a
  // list page, but fine for an on-demand Download action.
  routes.set('GET /api/contracts/:id/pdf', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const { renderContractPdf } = await import('../../../lib/contracts/pdf-render.js');
    let pdfBuffer;
    try {
      pdfBuffer = await renderContractPdf({ draftId });
    } catch (err) {
      if (err.message?.includes('not found')) {
        err.statusCode = 404;
      }
      throw err;
    }

    // Slug derived from the draft title for a friendly filename
    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    let titleRow;
    try {
      titleRow = await (boardScope ?? query)(
        `SELECT title FROM content.drafts WHERE id = $1`,
        [draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    const titleSlug = (titleRow.rows[0]?.title || 'contract')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80) || 'contract';

    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${titleSlug}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
      body: pdfBuffer,
    };
  });

  // PATCH /api/contracts/:id/brand-profile — assign or clear the brand
  // profile that drives the renderer for this specific contract.
  // Body: { brand_profile_id: uuid | null }. NULL re-enables the default
  // fallback chain (counterparty's profile → system default).
  routes.set('PATCH /api/contracts/:id/brand-profile', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    const newId = body?.brand_profile_id ?? null;

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let r;
    try {
      if (newId !== null) {
        const ok = await scopedQuery(
          `SELECT 1 FROM content.brand_profiles WHERE id = $1 AND archived_at IS NULL`,
          [newId]
        );
        if (!ok.rows[0]) {
          const err = new Error('Brand profile not found or archived');
          err.statusCode = 400;
          throw err;
        }
      }

      r = await scopedQuery(
        `UPDATE content.drafts SET brand_profile_id = $1, updated_at = now()
          WHERE id = $2 AND content_type = 'contract'
          RETURNING id, brand_profile_id`,
        [newId, draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    if (!r.rows[0]) {
      const err = new Error('Contract not found');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true, brand_profile_id: r.rows[0].brand_profile_id };
  });

  // GET /api/contracts/:id/docx — render the contract body + audit trail to a
  // Word .docx. Hand-built via the `docx` library so Word output matches the
  // PDF's structure (header, body, audit block) rather than passing through
  // generic HTML-to-DOCX conversion. Operator-only download.
  routes.set('GET /api/contracts/:id/docx', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const { renderContractDocx } = await import('../../../lib/contracts/docx-render.js');
    let docxBuffer;
    try {
      docxBuffer = await renderContractDocx({ draftId });
    } catch (err) {
      if (err.message?.includes('not found')) {
        err.statusCode = 404;
      }
      throw err;
    }

    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    let titleRow;
    try {
      titleRow = await (boardScope ?? query)(
        `SELECT title FROM content.drafts WHERE id = $1`,
        [draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    const titleSlug = (titleRow.rows[0]?.title || 'contract')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80) || 'contract';

    return {
      __raw_response: true,
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${titleSlug}.docx"`,
        'Cache-Control': 'private, no-store',
      },
      body: docxBuffer,
    };
  });

  // GET /api/contracts/:id/verify — full verification payload for the latest
  // signing request: stored document_hash anchor, currently-computed hash
  // (recomputed via signatures.compute_document_hash for the request's
  // hash_version), per-signer chain verification, and the raw event sequence
  // with hash_chain_current rendered as hex. Board-only.
  routes.set('GET /api/contracts/:id/verify', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const reqRow = await query(
      `SELECT id, draft_id, document_hash, hash_version, status, signing_mode,
              title, message, expires_at, created_by, created_at, updated_at
         FROM signatures.signature_requests
        WHERE draft_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [draftId]
    );
    if (!reqRow.rows[0]) {
      return { request: null };
    }
    const request = reqRow.rows[0];

    // Recompute the current hash under the request's formula version. If it
    // doesn't match document_hash, the body or attachments have drifted.
    const currentHash = await query(
      `SELECT signatures.compute_document_hash($1, $2) AS hash`,
      [request.draft_id, request.hash_version]
    );
    const tamperDetected = currentHash.rows[0].hash !== request.document_hash;

    const signers = await query(
      `SELECT id, display_name, email, status, signing_order, completed_at, created_at
         FROM signatures.signers
        WHERE request_id = $1
        ORDER BY signing_order NULLS LAST, email ASC`,
      [request.id]
    );

    // Per-signer chain verification
    const chainResults = [];
    for (const s of signers.rows) {
      try {
        const v = await query(`SELECT * FROM signatures.verify_signature_chain($1)`, [s.id]);
        chainResults.push({ signer_id: s.id, ...v.rows[0] });
      } catch (err) {
        chainResults.push({ signer_id: s.id, error: err.message });
      }
    }

    // Events with hashes exposed as hex so the UI can render them
    const events = await query(
      `SELECT se.id, se.event_type, se.typed_name, se.consent_text,
              se.document_hash_at_event,
              encode(se.hash_chain_prev, 'hex')    AS hash_chain_prev_hex,
              encode(se.hash_chain_current, 'hex') AS hash_chain_current_hex,
              se.ip_address, se.user_agent, se.created_at,
              s.display_name AS signer_name, s.email AS signer_email
         FROM signatures.signature_events se
         JOIN signatures.signers s ON s.id = se.signer_id
        WHERE se.request_id = $1
        ORDER BY se.created_at ASC, se.id ASC`,
      [request.id]
    );

    return {
      request: {
        ...request,
        computed_hash: currentHash.rows[0].hash,
        tamper_detected: tamperDetected,
      },
      signers: signers.rows,
      chain_results: chainResults,
      events: events.rows,
    };
  });

  // GET /api/contracts/:id/work-items — list agent_graph.work_items that were
  // spawned from this signed contract. Uses the idx_work_items_contract
  // partial index on metadata->>'contract_draft_id'.
  routes.set('GET /api/contracts/:id/work-items', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    let result;
    try {
      result = await (boardScope ?? query)(
        `SELECT id, type, title, description, status, assigned_to,
                priority, deadline, created_at,
                metadata->>'signature_request_id' AS signature_request_id
           FROM agent_graph.work_items
          WHERE metadata->>'contract_draft_id' = $1
          ORDER BY created_at ASC`,
        [draftId]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { work_items: result.rows };
  });

  // POST /api/contracts/:id/pre-send-check — run G2 (Legal / commitment) and
  // G7 (Precedent) scans against the current draft body. Non-blocking — the
  // board uses findings to decide whether to proceed with Send for Signature.
  routes.set('POST /api/contracts/:id/pre-send-check', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    const { preSendCheck } = await import('../../../lib/contracts/pre-send-check.js');
    try {
      const result = await preSendCheck({ draftId });
      // STAQPRO-547: propagate parseError so the UI can warn the operator that
      // the G2/G7 scan could not be evaluated (unparseable model output). An
      // empty findings list with parseError:true must NOT be presented as a
      // clean pass — `ok` is gated on the scan having actually run.
      return { ok: !result.parseError, ...result };
    } catch (err) {
      if (err.message?.includes('not found')) {
        err.statusCode = 404;
      }
      throw err;
    }
  });

  // GET /api/contracts/:id/suggested-recipients — four candidate lists for
  // the send-for-signature picker. Populated from the counterparty primary,
  // emails extracted from the engagement's source documents, signal contacts
  // sharing the counterparty's domain, and active board members for the
  // UMB countersign step. Used by the send form on the contracts page.
  routes.set('GET /api/contracts/:id/suggested-recipients', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];
    const { suggestRecipientsForContract } = await import('../../../lib/engagements/recipient-discovery.js');
    try {
      return await suggestRecipientsForContract(draftId);
    } catch (err) {
      if (err.message?.includes('not found')) err.statusCode = 404;
      throw err;
    }
  });

  // GET /api/contracts/:id/proposals — list signer proposals for this contract.
  // Scopes to the latest signing request; older requests' proposals aren't
  // actionable anyway (the doc and signers change per-request).
  routes.set('GET /api/contracts/:id/proposals', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    const reqRow = await query(
      `SELECT id FROM signatures.signature_requests
        WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [draftId]
    );
    if (!reqRow.rows[0]) return { proposals: [] };

    const result = await query(
      `SELECT p.id, p.proposal_type, p.quoted_text, p.proposed_text, p.note,
              p.status, p.resolved_by, p.resolved_at, p.resolution_note,
              p.applied_version_id, p.draft_version_id, p.created_at,
              s.display_name AS signer_name, s.email AS signer_email
         FROM signatures.signer_proposals p
         JOIN signatures.signers s ON s.id = p.signer_id
        WHERE p.request_id = $1
        ORDER BY p.status = 'open' DESC, p.created_at DESC`,
      [reqRow.rows[0].id]
    );
    if (result.rows.length === 0) return { proposals: [] };

    // Batch-fetch replies so the panel can render threads inline.
    const ids = result.rows.map(p => p.id);
    const replies = await query(
      `SELECT id, proposal_id, actor, actor_identity, actor_display, message, created_at
         FROM signatures.proposal_replies
        WHERE proposal_id = ANY($1::uuid[])
        ORDER BY created_at ASC`,
      [ids]
    );
    const byProposal = {};
    for (const r of replies.rows) {
      (byProposal[r.proposal_id] ||= []).push(r);
    }

    return {
      proposals: result.rows.map(p => ({ ...p, replies: byProposal[p.id] || [] })),
    };
  });

  // POST /api/contracts/:id/proposals/:proposalId/accept
  // Applies a redline to the live body and appends a counter_proposal version.
  // Auto-revokes the current signing request so the tamper chain stays truthful —
  // the operator re-approves + re-sends once they've reviewed the new body.
  // Comments can also be 'accepted' (acknowledged) but don't mutate the body.
  routes.set('POST /api/contracts/:id/proposals/:proposalId/accept', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const proposalId = parts[parts.length - 2];
    const draftId = parts[parts.length - 4];
    const boardUser = req.headers['x-board-user'] || 'unknown';
    // OPT-166 P3: authed-any route — non-board principals keep the legacy pool
    // (INERT pre-flip; RLS fail-closed post-flip). Board principals (incl legacy
    // api_secret → role 'board') get a scoped session. This handler interleaves
    // several external calls (LLM reconcile, revokeRequest, createSigningRequest,
    // sendSigningEmail), so each DB touch-point acquires and releases its own
    // short-lived scope rather than holding one connection across the handler.
    const isBoardPrincipal = req.auth?.role === 'board';

    const boardScopeA = isBoardPrincipal ? await withBoardScope(req.auth) : null;
    let prop;
    try {
      prop = await (boardScopeA ?? query)(
        `SELECT p.*, sr.draft_id, sr.id AS request_id, sr.status AS request_status, sr.created_by
           FROM signatures.signer_proposals p
           JOIN signatures.signature_requests sr ON sr.id = p.request_id
          WHERE p.id = $1`,
        [proposalId]
      );
    } finally {
      if (boardScopeA) await boardScopeA.release();
    }
    if (!prop.rows[0]) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }
    if (prop.rows[0].draft_id !== draftId) {
      const err = new Error('Proposal does not belong to this contract');
      err.statusCode = 400;
      throw err;
    }
    if (prop.rows[0].status !== 'open') {
      const err = new Error(`Proposal already ${prop.rows[0].status}`);
      err.statusCode = 409;
      throw err;
    }

    let appliedVersionId = null;

    // Redline: attempt exact-substring replace. If the quoted text no longer
    // appears verbatim (board already edited around it), fail loudly rather
    // than mangling the doc.
    let usedFuzzyReconcile = false;
    if (prop.rows[0].proposal_type === 'redline') {
      const boardScopeB = isBoardPrincipal ? await withBoardScope(req.auth) : null;
      let draft;
      try {
        draft = await (boardScopeB ?? query)(
          `SELECT body FROM content.drafts WHERE id = $1`,
          [draftId]
        );
      } finally {
        if (boardScopeB) await boardScopeB.release();
      }
      if (!draft.rows[0]) {
        const err = new Error('Draft not found');
        err.statusCode = 404;
        throw err;
      }

      const currentBody = draft.rows[0].body;
      const quoted = prop.rows[0].quoted_text;
      const proposed = prop.rows[0].proposed_text;

      let newBody = null;

      // Fast path: exact-substring replace. Only first occurrence so a
      // common phrase doesn't get rewritten globally.
      if (currentBody.includes(quoted)) {
        newBody = currentBody.replace(quoted, proposed);
      } else if (body?.reconcile === true) {
        // Fuzzy path: the board edited around the quoted section after the
        // signer viewed it, so exact match fails. Ask Haiku to produce a
        // full revised body with the signer's proposed change integrated
        // into the current text. Only triggered when the operator explicitly
        // asks for reconciliation (body.reconcile === true) — otherwise we
        // fail loudly with the 409 below.
        try {
          const { llmReconcileRedline } = await import('../../../lib/contracts/redline-reconcile.js');
          const reconciled = await llmReconcileRedline({
            currentBody, quoted, proposed,
          });
          if (reconciled && reconciled.trim().length > currentBody.length * 0.3) {
            newBody = reconciled;
            usedFuzzyReconcile = true;
          }
        } catch (err) {
          console.warn('[contracts/accept] Fuzzy reconcile LLM failed:', err.message);
        }
      }

      if (!newBody) {
        const err = new Error(
          'Cannot apply redline — quoted text no longer appears in the current draft ' +
          '(it was probably edited after the signer viewed it). Retry with {"reconcile": true} ' +
          'to ask the model to integrate the change, or dismiss and handle manually.'
        );
        err.statusCode = 409;
        err.details = { suggest_reconcile: !usedFuzzyReconcile };
        throw err;
      }

      const wordCount = newBody.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

      const boardScopeC = isBoardPrincipal ? await withBoardScope(req.auth) : null;
      const scopedQueryC = boardScopeC ?? query;
      try {
        await scopedQueryC(
          `UPDATE content.drafts SET body = $1, word_count = $2, updated_at = now() WHERE id = $3`,
          [newBody, wordCount, draftId]
        );
        const summary = usedFuzzyReconcile
          ? `Accepted proposal ${proposalId.slice(0,8)} (fuzzy reconcile — quoted text had drifted)`
          : `Accepted proposal ${proposalId.slice(0,8)}`;
        const verResult = await scopedQueryC(
          `SELECT * FROM content.append_draft_version($1, $2, 'counter_proposal', $3, $4, NULL, NULL)`,
          [draftId, newBody, summary, boardUser]
        );
        appliedVersionId = verResult.rows[0]?.version_id || null;
      } finally {
        if (boardScopeC) await boardScopeC.release();
      }
    }

    // Mark proposal resolved
    const boardScopeD = isBoardPrincipal ? await withBoardScope(req.auth) : null;
    try {
      await (boardScopeD ?? query)(
        `UPDATE signatures.signer_proposals
            SET status = 'accepted',
                resolved_by = $1,
                resolved_at = now(),
                resolution_note = $2,
                applied_version_id = $3
          WHERE id = $4`,
        [boardUser, body?.note || null, appliedVersionId, proposalId]
      );
    } finally {
      if (boardScopeD) await boardScopeD.release();
    }

    // Auto-revoke the current request IF the body changed. Comments don't
    // mutate the body so the original signing chain remains valid.
    let revokedRequest = false;
    let newRequest = null;
    if (prop.rows[0].proposal_type === 'redline'
        && ['pending', 'in_progress'].includes(prop.rows[0].request_status)) {
      const { revokeRequest } = await import('../../../lib/signatures/index.js');
      await revokeRequest(prop.rows[0].request_id, `Auto-revoked on acceptance of proposal ${proposalId}`);
      // Supersede any other open proposals on this request — they're based on
      // a body that no longer exists. Operator can re-raise if still relevant.
      const boardScopeE = isBoardPrincipal ? await withBoardScope(req.auth) : null;
      const scopedQueryE = boardScopeE ?? query;
      try {
        await scopedQueryE(
          `UPDATE signatures.signer_proposals
              SET status = 'superseded',
                  resolved_by = $1,
                  resolved_at = now(),
                  resolution_note = 'Superseded by counter-proposal accept'
            WHERE request_id = $2 AND status = 'open' AND id != $3`,
          [boardUser, prop.rows[0].request_id, proposalId]
        );
        // Flip the draft back to review so the operator can re-approve.
        await scopedQueryE(
          `UPDATE content.drafts SET status = 'review', updated_at = now() WHERE id = $1`,
          [draftId]
        );
      } finally {
        if (boardScopeE) await boardScopeE.release();
      }
      revokedRequest = true;

      // Auto-resend: recreate the signing request with the same signers against
      // the new body. Caller opts in via body.auto_resend=true. Skipped if
      // fuzzy reconcile was used — the board should eyeball what the LLM did
      // before re-sending. Skipped if there are other open proposals on
      // OTHER requests (unlikely but defensive) because re-sending would
      // create races.
      if (body?.auto_resend === true && !usedFuzzyReconcile) {
        try {
          const boardScopeF1 = isBoardPrincipal ? await withBoardScope(req.auth) : null;
          const scopedQueryF1 = boardScopeF1 ?? query;
          let oldSigners;
          let oldReq;
          try {
            oldSigners = await scopedQueryF1(
              `SELECT display_name, email, signing_order
                 FROM signatures.signers
                WHERE request_id = $1
                ORDER BY signing_order NULLS LAST, email`,
              [prop.rows[0].request_id]
            );
            oldReq = await scopedQueryF1(
              `SELECT title, message, signing_mode
                 FROM signatures.signature_requests
                WHERE id = $1`,
              [prop.rows[0].request_id]
            );
            if (oldSigners.rows.length && oldReq.rows[0]) {
              // Flip to approved so the conceptual state matches — the draft
              // IS approved by virtue of the operator accepting the proposal
              // and opting to auto-resend.
              await scopedQueryF1(
                `UPDATE content.drafts SET status = 'approved', updated_at = now() WHERE id = $1`,
                [draftId]
              );
            }
          } finally {
            if (boardScopeF1) await boardScopeF1.release();
          }
          if (oldSigners.rows.length && oldReq.rows[0]) {
            const { createSigningRequest } = await import('../../../lib/signatures/index.js');
            const { sendSigningEmail } = await import('../../../lib/signatures/notifier.js');
            const result = await createSigningRequest({
              draftId,
              title: oldReq.rows[0].title,
              message: oldReq.rows[0].message || `Please review and sign: ${oldReq.rows[0].title}`,
              signers: oldSigners.rows.map(s => ({
                name: s.display_name,
                email: s.email,
                order: s.signing_order,
              })),
              createdBy: boardUser,
              expiresInHours: 72,
              signingMode: oldReq.rows[0].signing_mode,
            });

            // Flip draft status to published to match the /send endpoint's
            // post-send convention.
            const boardScopeF2 = isBoardPrincipal ? await withBoardScope(req.auth) : null;
            try {
              await (boardScopeF2 ?? query)(
                `UPDATE content.drafts SET status = 'published', updated_at = now() WHERE id = $1`,
                [draftId]
              );
            } finally {
              if (boardScopeF2) await boardScopeF2.release();
            }

            // Send new signing emails — don't block on failures
            for (const s of result.signers) {
              sendSigningEmail({
                signerName: s.name,
                signerEmail: s.email,
                signingUrl: s.signingUrl,
                documentTitle: oldReq.rows[0].title,
                message: oldReq.rows[0].message,
                senderName: boardUser,
                expiresAt: result.expiresAt,
              }).catch(err => console.warn(`[contracts/accept] resend email to ${s.email} failed:`, err.message));
            }

            newRequest = {
              request_id: result.requestId,
              signer_count: result.signers.length,
              expires_at: result.expiresAt,
            };
          }
        } catch (err) {
          // Auto-resend failure is non-fatal — accept already succeeded,
          // operator can click Send manually.
          console.warn('[contracts/accept] auto-resend failed:', err.message);
          newRequest = { error: err.message };
        }
      }
    }

    return {
      ok: true,
      applied_version_id: appliedVersionId,
      revoked_request: revokedRequest,
      fuzzy_reconcile: usedFuzzyReconcile,
      new_request: newRequest,
    };
  });

  // GET /api/contracts/:id/proposals/:proposalId/replies — thread for one proposal
  routes.set('GET /api/contracts/:id/proposals/:proposalId/replies', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const proposalId = parts[parts.length - 2];

    const rows = await query(
      `SELECT id, actor, actor_identity, actor_display, message, created_at
         FROM signatures.proposal_replies
        WHERE proposal_id = $1
        ORDER BY created_at ASC`,
      [proposalId]
    );
    return { replies: rows.rows };
  });

  // POST /api/contracts/:id/proposals/:proposalId/reply — board posts a reply
  routes.set('POST /api/contracts/:id/proposals/:proposalId/reply', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const proposalId = parts[parts.length - 2];
    const draftId = parts[parts.length - 4];
    const boardUser = req.headers['x-board-user'] || 'unknown';

    const message = String(body?.message || '').trim();
    if (!message) {
      const err = new Error('message is required');
      err.statusCode = 400;
      throw err;
    }
    if (message.length > 5000) {
      const err = new Error('message too long (max 5000 chars)');
      err.statusCode = 400;
      throw err;
    }

    // Scope: proposal must belong to a request on this draft, and must still
    // be open (we don't want board replies to lock in a dismissed thread).
    const prop = await query(
      `SELECT p.id, p.status, p.signer_id, sr.draft_id, sr.title,
              s.display_name AS signer_name, s.email AS signer_email, s.signing_token
         FROM signatures.signer_proposals p
         JOIN signatures.signature_requests sr ON sr.id = p.request_id
         JOIN signatures.signers s ON s.id = p.signer_id
        WHERE p.id = $1`,
      [proposalId]
    );
    if (!prop.rows[0]) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }
    if (prop.rows[0].draft_id !== draftId) {
      const err = new Error('Proposal does not belong to this contract');
      err.statusCode = 400;
      throw err;
    }

    // Resolve board display name
    const bm = await query(
      `SELECT display_name FROM agent_graph.board_members
        WHERE lower(github_username) = lower($1) LIMIT 1`,
      [boardUser]
    );
    const actorDisplay = bm.rows[0]?.display_name || boardUser;

    const inserted = await query(
      `INSERT INTO signatures.proposal_replies
         (proposal_id, actor, actor_identity, actor_display, message)
       VALUES ($1, 'board', $2, $3, $4)
       RETURNING id, created_at`,
      [proposalId, boardUser, actorDisplay, message]
    );

    // Email the signer — fire-and-forget
    try {
      const { sendProposalReplyEmail } = await import('../../../lib/signatures/notifier.js');
      const signingBase = process.env.SIGNING_BASE_URL || 'https://board.staqs.io';
      sendProposalReplyEmail({
        recipientEmail: prop.rows[0].signer_email,
        recipientName: prop.rows[0].signer_name,
        documentTitle: prop.rows[0].title,
        authorLabel: `${actorDisplay} (UMB)`,
        message,
        signingUrl: `${signingBase}/sign/${prop.rows[0].signing_token}`,
      }).catch(err => console.warn('[contracts/reply] signer email failed:', err.message));
    } catch (err) {
      console.warn('[contracts/reply] notifier import failed:', err.message);
    }

    return { ok: true, reply_id: inserted.rows[0].id, created_at: inserted.rows[0].created_at };
  });

  // POST /api/contracts/:id/proposals/:proposalId/dismiss
  routes.set('POST /api/contracts/:id/proposals/:proposalId/dismiss', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const proposalId = parts[parts.length - 2];
    const draftId = parts[parts.length - 4];
    const boardUser = req.headers['x-board-user'] || 'unknown';

    // Scope check: proposal must belong to a request on this draft
    const check = await query(
      `SELECT p.status, sr.draft_id
         FROM signatures.signer_proposals p
         JOIN signatures.signature_requests sr ON sr.id = p.request_id
        WHERE p.id = $1`,
      [proposalId]
    );
    if (!check.rows[0]) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }
    if (check.rows[0].draft_id !== draftId) {
      const err = new Error('Proposal does not belong to this contract');
      err.statusCode = 400;
      throw err;
    }
    if (check.rows[0].status !== 'open') {
      const err = new Error(`Proposal already ${check.rows[0].status}`);
      err.statusCode = 409;
      throw err;
    }

    await query(
      `UPDATE signatures.signer_proposals
          SET status = 'dismissed',
              resolved_by = $1,
              resolved_at = now(),
              resolution_note = $2
        WHERE id = $3`,
      [boardUser, body?.note || null, proposalId]
    );
    return { ok: true };
  });

  // GET /api/contracts/:id/audit — get signing audit trail
  routes.set('GET /api/contracts/:id/audit', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const draftId = parts[parts.length - 2];

    // Get the latest signing request for this draft
    const reqResult = await query(
      `SELECT id, signing_mode FROM signatures.signature_requests WHERE draft_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [draftId]
    );

    if (!reqResult.rows[0]) {
      return { events: [], chainIntegrity: null, signers: [], signingMode: null };
    }

    const requestId = reqResult.rows[0].id;
    const signingMode = reqResult.rows[0].signing_mode;

    // Get events with signer identity
    const events = await query(
      `SELECT se.id, se.event_type, se.typed_name, se.consent_text,
        se.ip_address, se.user_agent, se.created_at,
        s.display_name AS signer_name, s.email AS signer_email
      FROM signatures.signature_events se
      JOIN signatures.signers s ON s.id = se.signer_id
      WHERE se.request_id = $1
      ORDER BY se.created_at ASC`,
      [requestId]
    );

    // Full per-signer summary — fuels the pipeline-strip per-signer display
    // and replaces the minimal id-only fetch we previously did for chain verification.
    const signersResult = await query(
      `SELECT id, display_name, email, status, signing_order, completed_at, created_at
         FROM signatures.signers
        WHERE request_id = $1
        ORDER BY signing_order NULLS LAST, email ASC`,
      [requestId]
    );

    // Verify chain integrity per signer
    let chainIntegrity = true;
    for (const signer of signersResult.rows) {
      try {
        const verification = await query(
          `SELECT * FROM signatures.verify_signature_chain($1)`,
          [signer.id]
        );
        if (verification.rows[0] && !verification.rows[0].is_valid) {
          chainIntegrity = false;
        }
      } catch {
        // verify function may not exist yet (migration not run)
        chainIntegrity = null;
        break;
      }
    }

    return {
      events: events.rows,
      chainIntegrity,
      signers: signersResult.rows,
      signingMode,
    };
  });
}
