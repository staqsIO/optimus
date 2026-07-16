// lib/tenancy/scope.js — ADR-012 §5.2 / §6 Layer A (PRIMARY enforcement).
//
// The single tenant-read chokepoint. Every tenant-scoped READ appends
// visibleClause() to its WHERE. This is byte-for-byte the same three branches
// as the SQL function tenancy.visible() (migration 133 §5.1); the parity test
// (test/tenancy-parity.test.js) is the anti-divergence guarantee.
//
// FAIL-CLOSED is the whole point (harvested from lib/rag/scope.js): an
// unresolved / empty scope must yield NO rows, never an unfiltered query. The
// month-long leak was exactly an unscoped SELECT; a clause that silently
// degrades to TRUE would reintroduce it. So:
//   * unauthenticated / unresolved principal  → 'FALSE' (zero rows)
//   * authenticated principal                 → own ∪ org-shared ∪ federation
//   * adminBypass (verified agent JWT only)   → 'TRUE'  (trusted org-wide)
//
// adminBypass is NOT spoofable from a request: it is set only by
// resolveViewerEmails() for source==='agent_jwt' (a verified RS256 token), and
// resolvePrincipal() never derives it from user-controllable input.

import { query as defaultQuery } from '../db.js';
import { ROLE_CAPS, readsOrgShared } from './rbac.js';

/**
 * The single org Optimus operates as today (Staqs Internal). Centralised here so
 * the multi-org transition flips ONE constant instead of the ~8 inline UUIDs that
 * were scattered across RAG/agent call sites (STAQPRO-594). A new agent RAG call
 * site that copies the literal gets single-org scoping that only *looks* correct;
 * importing this makes the single-org assumption explicit and greppable.
 */
export const CURRENT_ORG_ID = '7c164445-43f2-4802-a7d3-5cab06611e99';

/**
 * Default read scope for agent-runtime / RAG callers that have no request viewer:
 * the current org only. Equivalent to syntheticPrincipal(CURRENT_ORG_ID).readOrgIds.
 * Frozen so a shared reference cannot be mutated by a caller.
 */
export const CURRENT_ORG_READ_SCOPE = Object.freeze([CURRENT_ORG_ID]);

/**
 * Resolve a request/identity into a read principal.
 *
 * ADR-017 (knowledge sharing) adds `readGroupIds` — the caller's
 * tenancy.group_memberships — to the principal so share-aware retrievers
 * (lib/rag/retriever.js) can match share_grants with target_type='group'.
 * The visibleClause()/tenancy.visible() federation tier is unchanged
 * (still backed by tenancy.federation_grants); share-grant visibility is
 * opt-in per resource kind at the retriever layer, never generic, so
 * signals/briefings/contracts don't accidentally leak across grants.
 *
 * @param {{userId?: string|null, adminBypass?: boolean}} identity
 * @param {{query?: Function}} [deps]
 * @returns {Promise<{userId: string|null, readOrgIds: string[], readGroupIds: string[], roles: Object, adminBypass: boolean}>}
 */
export async function resolvePrincipal(identity, deps = {}) {
  const query = deps.query || defaultQuery;
  const adminBypass = !!identity?.adminBypass;
  const userId = identity?.userId || null;

  if (adminBypass) {
    return { userId: null, readOrgIds: [], readGroupIds: [], roles: {}, adminBypass: true };
  }
  if (!userId) {
    return { userId: null, readOrgIds: [], readGroupIds: [], roles: {}, adminBypass: false };
  }

  const r = await query(
    `SELECT org_id, role FROM tenancy.memberships WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  const roles = {};
  const readOrgIds = [];
  for (const row of r.rows) {
    roles[row.org_id] = row.role;
    if (readsOrgShared(row.role)) readOrgIds.push(row.org_id);
  }

  // ADR-017: pull group memberships eagerly. Tolerant of pre-mig-181
  // databases — if tenancy.group_memberships doesn't exist yet, treat as
  // empty (the share-grant group target arm simply matches nothing).
  let readGroupIds = [];
  try {
    const g = await query(
      `SELECT group_id FROM tenancy.group_memberships WHERE user_id = $1`,
      [userId]
    );
    readGroupIds = g.rows.map((row) => row.group_id);
  } catch (err) {
    if (!/group_memberships|relation .* does not exist/i.test(err.message)) throw err;
  }
  return { userId, readOrgIds, readGroupIds, roles, adminBypass: false };
}

export function syntheticPrincipal(orgId, { userId = null } = {}) {
  if (!orgId) return { userId, readOrgIds: [], readGroupIds: [], roles: {}, adminBypass: false };
  return { userId, readOrgIds: [orgId], readGroupIds: [], roles: { [orgId]: 'member' }, adminBypass: false };
}

/**
 * The resolution predicate as a parameterized WHERE fragment (ADR §5.2).
 * Positional params, codebase convention. Returns the SQL fragment, the params
 * to append, and the next free placeholder index so callers can compose.
 *
 * @param {object} principal  from resolvePrincipal/syntheticPrincipal
 * @param {object} [opts]
 * @param {string} [opts.ownerUserCol='owner_user_id']  (qualify for joins, e.g. 'c.owner_user_id')
 * @param {string} [opts.ownerOrgCol='owner_org_id']
 * @param {number} [opts.startIndex=1]  first positional placeholder to use
 * @returns {{sql: string, params: any[], nextIndex: number}}
 */
export function visibleClause(principal, opts = {}) {
  // ownerUserCol is OPTIONAL. Most tenant tables in this codebase carry no
  // per-user owner column, so the default is ORG-ONLY scoping (Tier 2 + Tier 3).
  // Pass ownerUserCol explicitly (e.g. 'c.owner_user_id') only for tables that
  // actually have one, to also grant Tier-1 "own rows" visibility.
  const ownerUserCol = opts.ownerUserCol || null;
  const ownerOrgCol = opts.ownerOrgCol || 'owner_org_id';
  const startIndex = opts.startIndex || 1;

  if (principal?.adminBypass) {
    return { sql: 'TRUE', params: [], nextIndex: startIndex };
  }
  const userId = principal?.userId || null;
  const readOrgIds = principal?.readOrgIds || [];

  // Fail closed: a caller with no readable orgs and (no user col or no userId)
  // can match nothing — emit FALSE rather than a clause that errors or leaks.
  const hasUserBranch = !!(ownerUserCol && userId);
  if (readOrgIds.length === 0 && !hasUserBranch) {
    return { sql: 'FALSE', params: [], nextIndex: startIndex };
  }

  const parts = [];
  const params = [];
  let idx = startIndex;
  if (hasUserBranch) {
    parts.push(`${ownerUserCol} = $${idx}`);   // Tier 1: own
    params.push(userId);
    idx++;
  }
  const pOrgs = idx;                            // Tier 2 + Tier 3 share readOrgIds
  parts.push(`${ownerOrgCol} = ANY($${pOrgs}::uuid[])`);
  parts.push(
    `EXISTS (SELECT 1 FROM tenancy.federation_grants g` +
    ` WHERE g.grantee_org_id = ANY($${pOrgs}::uuid[])` +
    ` AND g.grantor_org_id = ${ownerOrgCol}` +
    ` AND g.revoked_at IS NULL` +
    ` AND (g.expires_at IS NULL OR g.expires_at > now()))`
  );
  params.push(readOrgIds);
  idx++;
  return { sql: `(${parts.join(' OR ')})`, params, nextIndex: idx };
}

/**
 * Convenience builder for simple scoped list reads. For reads with additional
 * filters, prefer visibleClause() directly and manage placeholder indices.
 *
 * @returns {{text: string, params: any[]}}
 */
export function scopedQuery(principal, {
  table, cols = '*', alias, ownerUserCol, ownerOrgCol,
  extraWhere, extraParams = [], order, limit,
}) {
  // extraWhere placeholders start AFTER the visible-clause params.
  const startIndex = 1 + extraParams.length;
  const v = visibleClause(principal, { ownerUserCol, ownerOrgCol, startIndex });
  const from = alias ? `${table} ${alias}` : table;
  const where = extraWhere ? `(${extraWhere}) AND ${v.sql}` : v.sql;
  let text = `SELECT ${cols} FROM ${from} WHERE ${where}`;
  if (order) text += ` ORDER BY ${order}`;
  if (limit) text += ` LIMIT ${Number(limit)}`;
  return { text, params: [...extraParams, ...v.params] };
}
