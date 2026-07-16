/**
 * Deals + tag endpoints — Phase 4 of the CRM upgrade.
 *
 *   GET    /api/deals                         — list (filter by ?stage / ?contactId / ?orgId)
 *   POST   /api/deals                         — create
 *   PATCH  /api/deals/:id                     — partial update (stage, value, notes, etc.)
 *   DELETE /api/deals/:id                     — drop a deal
 *   GET    /api/contacts/:id/deals            — deals for one contact
 *   GET    /api/contacts/:id/tags             — tags for one contact
 *   POST   /api/contacts/:id/tags             — add tag
 *   DELETE /api/contacts/:id/tags/:tag        — remove tag
 *   GET    /api/tags                          — distinct tags + usage counts
 */

import { query, withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

function parsePathParts(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.pathname.split('/').filter(Boolean);
}

function parseQS(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

const ALLOWED_DEAL_FIELDS = new Set([
  'title', 'stage', 'value_usd', 'expected_close', 'notes',
  'organization_id', 'contact_id', 'closed_reason', 'metadata',
]);

const ALLOWED_STAGES = new Set([
  'prospect', 'qualified', 'proposal', 'negotiation',
  'won', 'lost', 'churned',
]);

export function registerDealsRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608 r2a: signal.deals carries owner_org_id (migration 149, backfilled
  // via contact_id -> signal.contacts). The reads below scope on it fail-closed.
  // withViewer is injected by api.js (board_members ↔ viewer ↔ principal bridge);
  // when absent/throwing the principal is null → visibleClause emits FALSE → zero
  // rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('GET /api/deals', async (req) => {
    const qs = parseQS(req);
    const conditions = [];
    const values = [];

    // Tenancy scope (fail-closed): owner_org_id ∈ visible orgs. Placeholder
    // indices are managed off the running values length.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: values.length + 1 });
    conditions.push(v.sql);
    values.push(...v.params);

    if (qs.stage && ALLOWED_STAGES.has(qs.stage)) {
      values.push(qs.stage);
      conditions.push(`d.stage = $${values.length}`);
    }
    if (qs.contactId) {
      values.push(qs.contactId);
      conditions.push(`d.contact_id = $${values.length}`);
    }
    if (qs.orgId) {
      values.push(qs.orgId);
      conditions.push(`d.organization_id = $${values.length}`);
    }
    if (qs.open === 'true') {
      conditions.push(`d.stage NOT IN ('won', 'lost', 'churned')`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT d.*,
                c.name        AS contact_name,
                c.email_address AS contact_email,
                o.name        AS organization_name
           FROM signal.deals d
           LEFT JOIN signal.contacts c ON c.id = d.contact_id
           LEFT JOIN signal.organizations o ON o.id = d.organization_id
           ${whereClause}
           ORDER BY d.last_activity_at DESC
           LIMIT 200`,
        values,
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { deals: result.rows };
  });

  routes.set('POST /api/deals', async (req, body) => {
    const { contact_id, title } = body || {};
    if (!contact_id || !title) {
      throw Object.assign(new Error('contact_id and title required'), { statusCode: 400 });
    }

    const stage = ALLOWED_STAGES.has(body.stage) ? body.stage : 'prospect';
    const createdBy = req.auth?.sub || req.headers['x-board-user'] || 'board';

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      // Default org_id from contact if not specified.
      let orgId = body.organization_id || null;
      if (!orgId) {
        const r = await scopedQuery(
          'SELECT organization_id FROM signal.contacts WHERE id = $1',
          [contact_id],
        );
        orgId = r.rows[0]?.organization_id || null;
      }

      result = await scopedQuery(
        `INSERT INTO signal.deals
           (contact_id, organization_id, title, stage, value_usd, expected_close, notes, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          contact_id,
          orgId,
          String(title).slice(0, 500),
          stage,
          body.value_usd || null,
          body.expected_close || null,
          body.notes || null,
          body.metadata || null,
          createdBy,
        ],
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { deal: result.rows[0] };
  });

  routes.set('PATCH /api/deals/:id', async (req, body) => {
    const parts = parsePathParts(req);
    const id = decodeURIComponent(parts[parts.length - 1]);
    if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 });

    const sets = [];
    const values = [id];
    for (const [key, value] of Object.entries(body || {})) {
      if (!ALLOWED_DEAL_FIELDS.has(key)) continue;
      if (key === 'stage' && !ALLOWED_STAGES.has(value)) continue;
      values.push(value);
      sets.push(`${key} = $${values.length}`);
    }
    if (sets.length === 0) {
      throw Object.assign(new Error('no recognized fields to update'), { statusCode: 400 });
    }

    const result = await query(
      `UPDATE signal.deals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    );
    if (result.rows.length === 0) {
      throw Object.assign(new Error('deal not found'), { statusCode: 404 });
    }
    return { deal: result.rows[0] };
  });

  routes.set('DELETE /api/deals/:id', async (req) => {
    const parts = parsePathParts(req);
    const id = decodeURIComponent(parts[parts.length - 1]);
    const r = await query(
      'DELETE FROM signal.deals WHERE id = $1 RETURNING id',
      [id],
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('deal not found'), { statusCode: 404 });
    }
    return { ok: true, id: r.rows[0].id };
  });

  routes.set('GET /api/contacts/:id/deals', async (req) => {
    const parts = parsePathParts(req);
    // /api/contacts/<id>/deals → id is at parts.length - 2
    const contactId = decodeURIComponent(parts[parts.length - 2]);

    // Tenancy scope (fail-closed): a hidden contact's deals must not leak via
    // this per-contact view either. $1 is contactId; visible clause starts at $2.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: 2 });
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT d.*, o.name AS organization_name
           FROM signal.deals d
           LEFT JOIN signal.organizations o ON o.id = d.organization_id
          WHERE d.contact_id = $1 AND ${v.sql}
          ORDER BY d.last_activity_at DESC`,
        [contactId, ...v.params],
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { deals: result.rows };
  });

  // Tags
  routes.set('GET /api/contacts/:id/tags', async (req) => {
    const parts = parsePathParts(req);
    const contactId = decodeURIComponent(parts[parts.length - 2]);
    const result = await query(
      `SELECT tag, created_by, created_at FROM signal.contact_tags
        WHERE contact_id = $1 ORDER BY created_at DESC`,
      [contactId],
    );
    return { tags: result.rows };
  });

  routes.set('POST /api/contacts/:id/tags', async (req, body) => {
    const parts = parsePathParts(req);
    const contactId = decodeURIComponent(parts[parts.length - 2]);
    const tag = String((body && body.tag) || '').trim().toLowerCase();
    if (!tag || tag.length > 64) {
      throw Object.assign(new Error('tag required (1-64 chars)'), { statusCode: 400 });
    }
    const createdBy = req.auth?.sub || req.headers['x-board-user'] || 'board';
    const result = await query(
      `INSERT INTO signal.contact_tags (contact_id, tag, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (contact_id, tag) DO NOTHING
       RETURNING tag, created_by, created_at`,
      [contactId, tag, createdBy],
    );
    return { tag: result.rows[0] || { tag, alreadyPresent: true } };
  });

  routes.set('DELETE /api/contacts/:id/tags/:tag', async (req) => {
    const parts = parsePathParts(req);
    // /api/contacts/<id>/tags/<tag>
    const contactId = decodeURIComponent(parts[parts.length - 3]);
    const tag = decodeURIComponent(parts[parts.length - 1]).toLowerCase();
    const r = await query(
      'DELETE FROM signal.contact_tags WHERE contact_id = $1 AND tag = $2 RETURNING tag',
      [contactId, tag],
    );
    if (r.rows.length === 0) {
      throw Object.assign(new Error('tag not found'), { statusCode: 404 });
    }
    return { ok: true };
  });

  routes.set('GET /api/tags', async () => {
    const result = await query(
      `SELECT tag, count(*)::int AS contact_count
         FROM signal.contact_tags
        GROUP BY tag ORDER BY count(*) DESC, tag`,
    );
    return { tags: result.rows };
  });
}
