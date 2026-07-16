/**
 * Counterparty API Routes
 *
 * Minimal endpoints for the Contracts flow: list, create, update, archive.
 * Detail pages and cross-contract rollups come later (Phase 2+).
 */

import { query, withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

export function registerCounterpartyRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608 r2a: content.counterparties carries owner_org_id (migration 149).
  // Counterparties are org-agnostic by design (mig 065, single-UMB-tenant), so
  // existing rows backfill -> Staqs; visibleClause scopes the reads fail-closed.
  // withViewer is injected by api.js; absent/throwing → null principal →
  // visibleClause emits FALSE → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/counterparties — list active counterparties with contract counts
  // Supports ?q=acme for substring search (case-insensitive) to power pickers.
  routes.set('GET /api/counterparties', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const search = (url.searchParams.get('q') || '').trim();
    const includeArchived = url.searchParams.get('include_archived') === 'true';

    const params = [];
    let where = includeArchived ? 'WHERE 1=1' : 'WHERE cp.archived_at IS NULL';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND lower(cp.name) LIKE $${params.length}`;
    }

    // Tenancy scope (fail-closed): owner_org_id ∈ visible orgs.
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'cp.owner_org_id', startIndex: params.length + 1 });
    where += ` AND ${v.sql}`;
    params.push(...v.params);

    // OPT-166 P3-B3: content.counterparties + content.drafts are RLS-enforced.
    // authed-any route — board gets a scoped session; non-board keeps the
    // legacy pool (INERT pre-flip, RLS fail-closed post-flip).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT cp.id, cp.name, cp.domain,
                cp.primary_signer_name, cp.primary_signer_email, cp.primary_signer_title,
                cp.address, cp.notes,
                cp.created_by, cp.created_at, cp.updated_at, cp.archived_at,
                (SELECT count(*) FROM content.drafts d
                  WHERE d.counterparty_id = cp.id AND d.content_type = 'contract')::int AS contract_count
           FROM content.counterparties cp
           ${where}
           ORDER BY cp.name ASC
           LIMIT 200`,
        params
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { counterparties: result.rows };
  });

  // GET /api/counterparties/:id — counterparty + all contracts + rollup stats
  routes.set('GET /api/counterparties/:id', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 1];

    // Tenancy scope (fail-closed): a counterparty hidden to the principal is
    // indistinguishable from a missing one (404), so there is no cross-tenant
    // enumeration oracle. $1 is id; visible clause starts at $2.
    const principal = await resolvePrincipalFor(req);
    const cv = visibleClause(principal, { ownerOrgCol: 'cp.owner_org_id', startIndex: 2 });

    // OPT-166 P3-B3: content.counterparties + content.drafts are
    // RLS-enforced (signatures.* is not, but rides the same scoped
    // connection for this handler's lifecycle — sequential, no network
    // calls between queries).
    // authed-any route — board gets a scoped session; non-board keeps the
    // legacy pool (INERT pre-flip, RLS fail-closed post-flip).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let cp, contracts, rollup;
    try {
      cp = await scopedQuery(
        `SELECT cp.id, cp.name, cp.domain,
                cp.primary_signer_name, cp.primary_signer_email, cp.primary_signer_title,
                cp.address, cp.notes, cp.created_by, cp.created_at, cp.updated_at, cp.archived_at
           FROM content.counterparties cp
          WHERE cp.id = $1 AND ${cv.sql}`,
        [id, ...cv.params]
      );
      if (!cp.rows[0]) {
        const err = new Error('Counterparty not found');
        err.statusCode = 404;
        throw err;
      }

      // All contracts for this counterparty, with the latest signing request
      // joined (same shape as the main list endpoint so UI columns match).
      contracts = await scopedQuery(
        `SELECT d.id, d.title, d.status AS draft_status, d.created_at, d.updated_at,
                d.word_count, d.cost_usd, d.template_id,
                sr.id AS request_id, sr.status AS signing_status, sr.expires_at,
                sr.created_at AS sent_at,
                COALESCE((SELECT count(*) FROM signatures.signers s
                           WHERE s.request_id = sr.id AND s.status = 'signed'), 0)::int AS signed_count,
                COALESCE((SELECT count(*) FROM signatures.signers s
                           WHERE s.request_id = sr.id), 0)::int AS total_signers
           FROM content.drafts d
           LEFT JOIN LATERAL (
             SELECT * FROM signatures.signature_requests
              WHERE draft_id = d.id ORDER BY created_at DESC LIMIT 1
           ) sr ON true
          WHERE d.content_type = 'contract' AND d.counterparty_id = $1
          ORDER BY d.created_at DESC`,
        [id]
      );

      // Rollup stats — derived in SQL so counts stay consistent with the list.
      rollup = await scopedQuery(
        `SELECT
           count(*) FILTER (WHERE d.content_type = 'contract')::int AS total,
           count(*) FILTER (WHERE sr.status = 'completed')::int AS signed,
           count(*) FILTER (WHERE sr.status IN ('pending', 'in_progress'))::int AS out_for_signature,
           count(*) FILTER (WHERE sr.status = 'declined')::int AS declined,
           count(*) FILTER (WHERE d.status = 'draft' AND sr.id IS NULL)::int AS drafting,
           COALESCE(sum(d.cost_usd)::float, 0) AS total_llm_cost_usd
         FROM content.drafts d
         LEFT JOIN LATERAL (
           SELECT id, status FROM signatures.signature_requests
            WHERE draft_id = d.id ORDER BY created_at DESC LIMIT 1
         ) sr ON true
         WHERE d.content_type = 'contract' AND d.counterparty_id = $1`,
        [id]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return {
      counterparty: cp.rows[0],
      contracts: contracts.rows,
      rollup: rollup.rows[0],
    };
  });

  // POST /api/counterparties — create a new counterparty
  routes.set('POST /api/counterparties', async (req, body) => {
    const {
      name,
      domain,
      primary_signer_name,
      primary_signer_email,
      primary_signer_title,
      address,
      notes,
    } = body || {};

    if (!name || !String(name).trim()) {
      const err = new Error('name is required');
      err.statusCode = 400;
      throw err;
    }

    const boardUser = req.headers['x-board-user'] || 'unknown';
    const cleanName = String(name).trim();

    // OPT-166 P3-B3: content.counterparties is RLS-enforced.
    // authed-any route — board gets a scoped session; non-board keeps the
    // legacy pool (INERT pre-flip, RLS fail-closed post-flip).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      // Check for existing active counterparty with the same case-folded name.
      // Return it rather than erroring so the picker's "create" path is idempotent.
      const existing = await scopedQuery(
        `SELECT id FROM content.counterparties
          WHERE lower(name) = lower($1) AND archived_at IS NULL
          LIMIT 1`,
        [cleanName]
      );
      if (existing.rows[0]) {
        return { ok: true, counterparty_id: existing.rows[0].id, already_existed: true };
      }

      result = await scopedQuery(
        `INSERT INTO content.counterparties
           (name, domain, primary_signer_name, primary_signer_email, primary_signer_title,
            address, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          cleanName,
          domain || null,
          primary_signer_name || null,
          primary_signer_email || null,
          primary_signer_title || null,
          address || null,
          notes || null,
          boardUser,
        ]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { ok: true, counterparty_id: result.rows[0].id };
  });

  // PATCH /api/counterparties/:id — update fields
  routes.set('PATCH /api/counterparties/:id', async (req, body) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 1];

    // Only allow known columns — anything else is rejected rather than ignored.
    const allowed = [
      'name', 'domain', 'primary_signer_name', 'primary_signer_email',
      'primary_signer_title', 'address', 'notes', 'brand_profile_id',
    ];
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

    // OPT-166 P3-B3: content.counterparties is RLS-enforced.
    // authed-any route — board gets a scoped session; non-board keeps the
    // legacy pool (INERT pre-flip, RLS fail-closed post-flip).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `UPDATE content.counterparties SET ${sets.join(', ')}
          WHERE id = $${values.length} AND archived_at IS NULL
          RETURNING id`,
        values
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    if (!result.rows[0]) {
      const err = new Error('Counterparty not found or archived');
      err.statusCode = 404;
      throw err;
    }

    return { ok: true };
  });

  // POST /api/counterparties/:id/archive — soft-delete
  // Archived rows stay referenced by historical drafts but disappear from
  // active pickers. Un-archive is intentionally not exposed via API — do it
  // by SQL to force a conversation about the duplicate name this will produce.
  routes.set('POST /api/counterparties/:id/archive', async (req) => {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = parts[parts.length - 2];

    // OPT-166 P3-B3: content.counterparties is RLS-enforced.
    // authed-any route — board gets a scoped session; non-board keeps the
    // legacy pool (INERT pre-flip, RLS fail-closed post-flip).
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `UPDATE content.counterparties
            SET archived_at = now()
          WHERE id = $1 AND archived_at IS NULL
          RETURNING id`,
        [id]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    if (!result.rows[0]) {
      const err = new Error('Counterparty not found or already archived');
      err.statusCode = 404;
      throw err;
    }

    return { ok: true };
  });
}
