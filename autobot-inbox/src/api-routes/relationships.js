/**
 * Relationship strength + health endpoints (Phase 5).
 *
 *   GET /api/contacts/:id/strength    — score + breakdown for one contact
 *   GET /api/relationship-health      — top decaying relationships
 *                                       (?staleAfterDays=14, ?limit=10)
 */

import { query, withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import {
  scoreContact,
  findDecayingRelationships,
} from '../../../lib/graph/relationship-strength.js';

function pathParts(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.pathname.split('/').filter(Boolean);
}

export function registerRelationshipsRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608: both endpoints read signal.contacts (owner_org_id, mig 134).
  // scoreContact() operates on a row the route fetches, so the route's own
  // SELECT must be scoped; findDecayingRelationships() runs its own SELECT, so
  // it takes the principal and scopes internally. Both fail-closed: unresolved
  // viewer → null principal → visibleClause 'FALSE' → zero rows.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('GET /api/contacts/:id/strength', async (req) => {
    const parts = pathParts(req);
    // /api/contacts/<id>/strength → id at parts.length - 2
    const contactId = decodeURIComponent(parts[parts.length - 2]);
    const principal = await resolvePrincipalFor(req);
    // Tenancy scope (fail-closed): the addressed contact must be visible. A
    // hidden contact is indistinguishable from a missing one (404), so there is
    // no cross-tenant enumeration oracle. Placeholders start at $2 ($1 = id).
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let r;
    try {
      r = await scopedQuery(
        `SELECT id, name, email_address, tier, is_vip,
                last_received_at, last_sent_at
           FROM signal.contacts WHERE id = $1 AND ${v.sql}`,
        [contactId, ...v.params],
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    if (r.rows.length === 0) {
      throw Object.assign(new Error('contact not found'), { statusCode: 404 });
    }
    const result = await scoreContact(r.rows[0]);
    return { contactId, ...result };
  });

  routes.set('GET /api/relationship-health', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const staleAfterDays = Math.min(
      365,
      Math.max(1, parseInt(url.searchParams.get('staleAfterDays') || '14', 10)),
    );
    const limit = Math.min(
      50,
      Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10)),
    );
    const principal = await resolvePrincipalFor(req);
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let decaying;
    try {
      decaying = await findDecayingRelationships(scopedQuery, { staleAfterDays, limit, principal });
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { decaying, staleAfterDays, limit };
  });
}
