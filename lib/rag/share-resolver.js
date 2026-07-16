// lib/rag/share-resolver.js
//
// ADR-017 — compute the caller's principal set for share_grants matching, used
// as input to content.match_chunks() and lexicalChunkSearch's WHERE clause.
//
// A caller's principal set is the triple { userId, orgIds, groupIds }:
//   - userId    : their board_members.id (or null for synthetic/agent callers)
//   - orgIds    : tenancy.memberships where readsOrgShared(role) (already on principal)
//   - groupIds  : tenancy.group_memberships (resolved by resolvePrincipal as of ADR-017)
//
// This module wraps the principal into the exact argument shape match_chunks
// expects, and exposes a tiny cache so the SAME principal is not re-resolved
// for every chunk lookup within a single request. Invalidation is by
// userId — when the API mutates a share_grant, it calls invalidatePrincipal()
// for the affected target user(s). That is sufficient because:
//   * D8 says revoke is instant — the cache invalidation is in the same call
//     as the status update.
//   * The principal set itself doesn't include grant rows — only the caller's
//     identity. Cached principals stay valid across grant changes; what we
//     invalidate is the EFFECT of the grants, which is queried fresh each call
//     since the SQL function reads share_grants live.
// So this cache is actually safe even without invalidation; we keep the
// invalidation hook anyway for future cases where the principal grows to
// include cross-org effective permissions.

const TTL_MS = 30_000;
const cache = new Map(); // userId → { principal, expiresAt }

/**
 * Convert a resolved tenancy principal into the (filter_owner_id,
 * filter_org_ids, filter_group_ids) triple match_chunks needs.
 *
 * @param {{userId: string|null, readOrgIds: string[], readGroupIds?: string[], adminBypass?: boolean}} principal
 * @returns {{filterOwnerId: string|null, filterOrgIds: string[], filterGroupIds: string[]}}
 */
export function principalToShareArgs(principal) {
  if (!principal) {
    return { filterOwnerId: null, filterOrgIds: [], filterGroupIds: [] };
  }
  return {
    filterOwnerId: principal.userId || null,
    filterOrgIds: Array.isArray(principal.readOrgIds) ? principal.readOrgIds : [],
    filterGroupIds: Array.isArray(principal.readGroupIds) ? principal.readGroupIds : [],
  };
}

/**
 * Cache a resolved principal by userId. The principal record already includes
 * orgIds/groupIds, so cache lookups are O(1) and bypass two queries.
 */
export function cachePrincipal(principal) {
  if (!principal?.userId) return;
  cache.set(principal.userId, {
    principal,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function getCachedPrincipal(userId) {
  if (!userId) return null;
  const hit = cache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return hit.principal;
}

/**
 * Drop a cached principal — call after creating, accepting, declining, revoking,
 * or expiring a share_grant that affects this user. D8 (revoke is instant)
 * relies on this being called inside the same lifecycle helper that flips
 * status.
 */
export function invalidatePrincipal(userId) {
  if (!userId) return;
  cache.delete(userId);
}

export function _clearAll() {
  cache.clear();
}
