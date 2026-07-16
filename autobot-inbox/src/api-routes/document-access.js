/**
 * Multi–board-member access helpers for content.documents and RAG search.
 *
 * Org-wide rows: owner_id IS NULL (Drive watcher, explicit shared ingest).
 * Per-member rows: owner_id = agent_graph.board_members.id
 *
 * Board JWT callers are scoped to (shared ∪ their documents). Legacy API_SECRET
 * and agent JWT retain full visibility for operational tooling.
 *
 * Phase-2 tenancy (live read-leak): the per-USER owner gate above is NOT a
 * tenant boundary. retrieverScopeWithOrg() attaches `readOrgIds` (the viewer's
 * tenancy orgs) to the retriever scope so content.match_chunks fails closed on
 * owner_org_id. Board viewers → resolvePrincipal(their board-member id).
 * agent_jwt / api_secret operational tooling → syntheticPrincipal(STAQS).
 */

import { resolvePrincipal, syntheticPrincipal, CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

// Staqs org id — the home tenant. Agent/system/operational callers with no
// board viewer scope to this org (never adminBypass: a missed caller must
// fail CLOSED to a single org, not leak everything). Centralised constant
// (STAQPRO-594) so the multi-org flip happens in one place.
const STAQS_ORG_ID = CURRENT_ORG_ID;

/**
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @returns {{ restrict: boolean, memberId: string | null }}
 */
export function documentsReadableFilter(req) {
  const auth = req.auth;
  if (!auth) return { restrict: false, memberId: null };
  if (auth.source === 'agent_jwt' || auth.source === 'api_secret') {
    return { restrict: false, memberId: null };
  }
  if (auth.role === 'board' && auth.sub) {
    return { restrict: true, memberId: auth.sub };
  }
  return { restrict: false, memberId: null };
}

/**
 * Build options for content.match_chunks from an authenticated HTTP request.
 *
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @param {object} [body]
 * @returns {{ ownerId: string | null, includeOrgWide: boolean, sharedDocumentsOnly: boolean, error?: string }}
 */
export function ragSearchOptionsFromRequest(req, body = {}) {
  const includeOrgWide = body.includeOrgWide !== false;
  const sharedDocumentsOnly = body.sharedDocumentsOnly === true;
  const auth = req.auth;

  if (auth?.source === 'agent_jwt' || auth?.source === 'api_secret') {
    const ownerId = body.ownerId ?? null;
    return { ownerId, includeOrgWide, sharedDocumentsOnly };
  }

  if (auth?.role === 'board' && auth.sub) {
    if (sharedDocumentsOnly) {
      return { ownerId: null, includeOrgWide: true, sharedDocumentsOnly: true };
    }
    const requested = body.ownerId;
    if (requested != null && String(requested) !== String(auth.sub)) {
      return {
        ownerId: null,
        includeOrgWide: true,
        sharedDocumentsOnly: false,
        error: 'ownerId does not match authenticated board member',
      };
    }
    const ownerId = requested ?? auth.sub;
    return { ownerId, includeOrgWide, sharedDocumentsOnly: false };
  }

  const ownerId = body.ownerId ?? null;
  return { ownerId, includeOrgWide, sharedDocumentsOnly };
}

/**
 * STAQPRO-tenancy-A: derive the retriever `scope` arg from auth context.
 * Returns either { ownerId } or { org: true, agentId } per the new
 * lib/rag/scope.js contract. Throws with a 400/403 statusCode on
 * unresolvable scope — never returns a default-org bypass.
 *
 * agent_jwt / api_secret callers are operational tooling — they may pass
 * an explicit body.ownerId OR body.orgScope:true. Board callers always
 * scope to their authenticated member id. Unauthenticated requests are
 * rejected (the route's existing requireAuth should already catch this;
 * the throw here is the second wall).
 *
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @param {object} [body]
 * @returns {{ ownerId: string } | { org: true, agentId: string }}
 */
export function retrieverScopeFromRequest(req, body = {}) {
  const auth = req.auth;

  // Board users: always scoped to their member id. Caller-supplied
  // ownerId in the body must match auth.sub or we 403.
  if (auth?.role === 'board' && auth.sub) {
    const requested = body.ownerId;
    if (requested != null && String(requested) !== String(auth.sub)) {
      throw Object.assign(
        new Error('ownerId does not match authenticated board member'),
        { statusCode: 403 }
      );
    }
    return { ownerId: String(auth.sub) };
  }

  // Agent JWT / api_secret callers: operational tooling. They must
  // explicitly state scope — either { ownerId } or { orgScope: true }
  // plus a recognized agent identity for the tier gate.
  if (auth?.source === 'agent_jwt' || auth?.source === 'api_secret') {
    if (body.ownerId) {
      return { ownerId: String(body.ownerId) };
    }
    if (body.orgScope === true) {
      const agentId = body.agentId || auth.sub;
      if (!agentId) {
        throw Object.assign(
          new Error('orgScope requires agentId (auth.sub or body.agentId)'),
          { statusCode: 400 }
        );
      }
      return { org: true, agentId: String(agentId) };
    }
    throw Object.assign(
      new Error('agent/api_secret callers must pass ownerId or orgScope:true'),
      { statusCode: 400 }
    );
  }

  // OPT-37: external customer principal. Org-scoped to its single org with no
  // per-user owner of its own.
  //
  // Why ownerId = the customer's principal id (NOT null): validateScope() in
  // lib/rag/scope.js requires EITHER a UUID ownerId OR org:true (and org:true is
  // tier-gated to internal agents — a customer can't use it). So a customer MUST
  // present a UUID ownerId. We use its own principal id, which is SAFE BY
  // CONSTRUCTION: NO content.documents row can ever carry owner_id = <customer
  // id> — (1) the customer ingest path (api-routes/ingest.js + create-artifact.js)
  // always writes owner_id NULL for a customer, and (2) content.documents.owner_id
  // FKs agent_graph.board_members as a backstop. So the SQL filter
  // `owner_id = <customer> OR owner_id IS NULL` collapses to `owner_id IS NULL` —
  // the org-shared corpus only, never another principal's private docs. The hard
  // tenant boundary is the org gate (readOrgIds, attached in retrieverScopeWithOrg),
  // which fails closed (empty → 0 rows); ownerId here is intra-org narrowing only.
  // NOTE: layer (2) holds ONLY while content.documents.owner_id keeps its FK to
  // agent_graph.board_members (sql/012). If that constraint is ever relaxed, this
  // assumption evaporates — re-derive customer scope rather than trusting owner_id.
  if (auth?.source === 'customer_jwt' && auth.sub && auth.org_id) {
    return { ownerId: String(auth.sub) };
  }

  // No recognized auth shape — refuse rather than leak.
  throw Object.assign(
    new Error('cannot derive retriever scope from request (no auth)'),
    { statusCode: 401 }
  );
}

/**
 * Phase-2 tenancy: derive the FULL retriever scope (owner gate + org gate) from
 * an authenticated request. Wraps retrieverScopeFromRequest (which throws on
 * unresolvable scope) and attaches `readOrgIds` so content.match_chunks fails
 * closed on owner_org_id.
 *
 *   - Board viewer  → resolvePrincipal({ userId: <board-member id> }) yields the
 *     viewer's tenancy orgs. The board-member id is the same id the per-user
 *     owner gate already trusts (auth.sub), so the two gates stay consistent.
 *   - agent_jwt / api_secret → syntheticPrincipal(STAQS).readOrgIds. Operational
 *     tooling is org-scoped to Staqs, NOT adminBypass — a missed caller fails
 *     closed to one org rather than leaking cross-tenant.
 *
 * A board viewer with zero readable orgs yields readOrgIds:[] → 0 rows
 * (fail-closed), never an unfiltered read.
 *
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @param {object} [body]
 * @returns {Promise<{ ownerId: string, readOrgIds: string[] } | { org: true, agentId: string, readOrgIds: string[] }>}
 */
export async function retrieverScopeWithOrg(req, body = {}) {
  const base = retrieverScopeFromRequest(req, body); // throws 400/401/403 on bad scope
  const auth = req.auth;

  if (auth?.role === 'board' && auth.sub) {
    const principal = await resolvePrincipal({ userId: String(auth.sub) });
    return { ...base, readOrgIds: principal.readOrgIds || [] };
  }

  // OPT-37: customer principal — the org gate is its single bound org, taken
  // from the verified token (verifyCustomerToken re-checks the active
  // customer_principals row + org binding every request), never adminBypass.
  if (auth?.source === 'customer_jwt' && auth.org_id) {
    return { ...base, readOrgIds: [String(auth.org_id)] };
  }

  // agent_jwt / api_secret: operational tooling, org-scoped to Staqs.
  const principal = syntheticPrincipal(STAQS_ORG_ID);
  return { ...base, readOrgIds: principal.readOrgIds || [] };
}

/**
 * Resolve owner_id for POST /api/documents/ingest from auth + body.
 *
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @param {{ ownerId?: string | null, sharedWithOrg?: boolean }} body
 * @returns {{ ownerId: string | null, error?: string }}
 */
export function ingestOwnerIdFromRequest(req, body = {}) {
  if (body.sharedWithOrg === true) {
    return { ownerId: null };
  }
  const auth = req.auth;
  if (auth?.role === 'board' && auth.sub) {
    if (body.ownerId != null && String(body.ownerId) !== String(auth.sub)) {
      return { ownerId: null, error: 'ownerId does not match authenticated board member' };
    }
    if (body.ownerId != null) {
      return { ownerId: body.ownerId };
    }
    return { ownerId: auth.sub };
  }
  return { ownerId: body.ownerId ?? null };
}

/**
 * @param {import('http').IncomingMessage & { auth?: object }} req
 * @param {{ owner_id?: string | null }} docRow
 * @returns {boolean}
 */
export function canReadDocument(req, docRow) {
  const { restrict, memberId } = documentsReadableFilter(req);
  if (!restrict || !memberId) return true;
  const oid = docRow?.owner_id;
  if (oid == null) return true;
  return String(oid) === String(memberId);
}
