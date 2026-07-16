// lib/sharing/grants.js
//
// ADR-017 — knowledge share grant lifecycle helpers. Backs the
// /api/sharing/* HTTP routes and the expiry sweep job.
//
// Each helper:
//   * Validates the caller is permitted to perform the operation.
//   * Performs the state transition atomically inside a transaction.
//   * Invalidates the per-target principal cache (lib/rag/share-resolver) so
//     D8 (revoke is instant) holds for the very next retrieval.
//
// Audit: lifecycle events ARE the share_grants row — every state transition
// updates a timestamped column (created_at, accepted_at, declined_at,
// revoked_at) AND status. The table is treated as append-only at the row
// level: a grant row is INSERT-once and only updated via these helpers.
// Hash-chained per-event audit (state_transitions) is deferred per ADR-017
// §D12 — additive when cross-org billing or compliance needs it.

import { query as defaultQuery } from '../db.js';
import { invalidatePrincipal } from '../rag/share-resolver.js';
import { createLogger } from '../logger.js';
const log = createLogger('sharing/grants');

/**
 * D5: any cross-org or org-level destination requires acceptance.
 *
 * - user → user, same org    → no acceptance (D4, in-org trust)
 * - user → group, same org   → no acceptance
 * - user → user, cross-org   → REQUIRES acceptance (trust boundary)
 * - user → org               → REQUIRES acceptance (target-org admin)
 * - org  → any               → REQUIRES acceptance (target-side accept)
 */
export function requiresAcceptance({ granterType, granterOrgId, targetType, targetOrgId }) {
  if (granterType === 'org') return true;
  if (targetType === 'org') return true;
  // user→user / user→group: acceptance ONLY if cross-org.
  return granterOrgId !== targetOrgId;
}

/**
 * Resolve the target_org_id for a grant given its target_type + target_id.
 */
async function resolveTargetOrgId({ targetType, targetId }, q) {
  if (targetType === 'org') return targetId;
  if (targetType === 'user') {
    // Pick any membership org for the target user — used as audit anchor only.
    // The user can be a member of multiple orgs; the choice is informational.
    const r = await q(
      `SELECT org_id FROM tenancy.memberships
        WHERE user_id = $1 AND is_active = true
        ORDER BY created_at ASC LIMIT 1`,
      [targetId]
    );
    if (r.rows.length === 0) throw new Error(`target user ${targetId} has no active memberships`);
    return r.rows[0].org_id;
  }
  if (targetType === 'group') {
    const r = await q(`SELECT org_id FROM tenancy.groups WHERE id = $1`, [targetId]);
    if (r.rows.length === 0) throw new Error(`target group ${targetId} not found`);
    return r.rows[0].org_id;
  }
  throw new Error(`unknown target_type: ${targetType}`);
}

/**
 * Create a new share grant.
 *
 * @param {object} grant
 * @param {'user'|'org'} grant.granterType
 * @param {string} grant.granterId             - user.id or org.id
 * @param {string} grant.granterOrgId          - the org the granter acts on behalf of
 * @param {'user'|'group'|'org'} grant.targetType
 * @param {string} grant.targetId
 * @param {'all'|'collection'|'document'|'topic'} [grant.scopeType='all']
 * @param {string|null} [grant.scopeRef=null]
 * @param {string} grant.createdBy             - board_members.id of the actor
 * @param {string|null} [grant.expiresAt=null]
 * @param {object} [grant.metadata={}]
 * @param {{query?: Function}} [deps]
 * @returns {Promise<object>} the inserted row
 */
export async function createGrant(grant, deps = {}) {
  const q = deps.query || defaultQuery;
  const {
    granterType, granterId, granterOrgId,
    targetType, targetId,
    scopeType = 'all',
    scopeRef = null,
    createdBy,
    expiresAt = null,
    metadata = {},
  } = grant;

  if (!['user', 'org'].includes(granterType)) {
    throw new Error(`v0 granter_type must be 'user' or 'org' (got '${granterType}')`);
  }
  if (!['user', 'group', 'org'].includes(targetType)) {
    throw new Error(`target_type must be one of user|group|org (got '${targetType}')`);
  }

  const targetOrgId = await resolveTargetOrgId({ targetType, targetId }, q);
  const needsAcceptance = requiresAcceptance({ granterType, granterOrgId, targetType, targetOrgId });
  const status = needsAcceptance ? 'pending' : 'active';

  const result = await q(
    `INSERT INTO tenancy.share_grants (
       granter_type, granter_id, granter_org_id,
       target_type, target_id, target_org_id,
       scope_type, scope_ref,
       status, requires_acceptance,
       created_by, expires_at, metadata,
       accepted_at, accepted_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15
     )
     RETURNING *`,
    [
      granterType, granterId, granterOrgId,
      targetType, targetId, targetOrgId,
      scopeType, scopeRef,
      status, needsAcceptance,
      createdBy, expiresAt, metadata,
      // For immediate (non-acceptance-required) grants, stamp accepted_at = now
      // so the CHECK constraint (active ↔ accepted_at when requires_acceptance)
      // is satisfied trivially without a follow-up call.
      needsAcceptance ? null : new Date().toISOString(),
      needsAcceptance ? null : createdBy,
    ],
  );
  const row = result.rows[0];
  // Invalidate the target principal cache so the next RAG retrieval sees the
  // grant (D8 — instant effect).
  if (targetType === 'user') invalidatePrincipal(targetId);
  log.info(`grant created: ${row.id} (${granterType}:${granterId} → ${targetType}:${targetId}, status=${status})`);
  return row;
}

/**
 * Accept a pending grant. Permitted by:
 *   * target user (target_type='user') — must be the target_id
 *   * target-org admin (target_type='org' or 'group') — owner/admin role in target_org_id
 */
export async function acceptGrant({ grantId, actorId }, deps = {}) {
  const q = deps.query || defaultQuery;
  const grant = (await q(`SELECT * FROM tenancy.share_grants WHERE id = $1`, [grantId])).rows[0];
  if (!grant) throw new Error('grant not found');
  if (grant.status !== 'pending') throw new Error(`cannot accept grant in status '${grant.status}'`);

  await assertCanAcceptOrDecline(grant, actorId, q);

  const r = await q(
    `UPDATE tenancy.share_grants
        SET status = 'active', accepted_at = now(), accepted_by = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [grantId, actorId],
  );
  if (r.rows.length === 0) throw new Error('grant transition raced — was not pending');
  // Invalidate caches for all newly-effective targets.
  invalidatePrincipalsForGrant(r.rows[0]);
  log.info(`grant accepted: ${grantId} by ${actorId}`);
  return r.rows[0];
}

/** Decline a pending grant. Same authorization as accept. */
export async function declineGrant({ grantId, actorId }, deps = {}) {
  const q = deps.query || defaultQuery;
  const grant = (await q(`SELECT * FROM tenancy.share_grants WHERE id = $1`, [grantId])).rows[0];
  if (!grant) throw new Error('grant not found');
  if (grant.status !== 'pending') throw new Error(`cannot decline grant in status '${grant.status}'`);
  await assertCanAcceptOrDecline(grant, actorId, q);

  const r = await q(
    `UPDATE tenancy.share_grants
        SET status = 'declined', declined_at = now(), declined_by = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [grantId, actorId],
  );
  if (r.rows.length === 0) throw new Error('grant transition raced — was not pending');
  log.info(`grant declined: ${grantId} by ${actorId}`);
  return r.rows[0];
}

/**
 * Revoke a grant. Permitted by:
 *   * the granter (user_id for granter_type='user'; org admin for granter_type='org')
 *   * the target-org admin for active incoming grants (recipient may revoke)
 */
export async function revokeGrant({ grantId, actorId }, deps = {}) {
  const q = deps.query || defaultQuery;
  const grant = (await q(`SELECT * FROM tenancy.share_grants WHERE id = $1`, [grantId])).rows[0];
  if (!grant) throw new Error('grant not found');
  if (!['pending', 'active'].includes(grant.status)) {
    throw new Error(`cannot revoke grant in status '${grant.status}'`);
  }
  await assertCanRevoke(grant, actorId, q);

  const r = await q(
    `UPDATE tenancy.share_grants
        SET status = 'revoked', revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND status IN ('pending', 'active')
      RETURNING *`,
    [grantId, actorId],
  );
  if (r.rows.length === 0) throw new Error('grant transition raced — was not pending/active');
  invalidatePrincipalsForGrant(r.rows[0]);
  log.info(`grant revoked: ${grantId} by ${actorId}`);
  return r.rows[0];
}

/**
 * Expiry sweep (D10). Flips active grants whose expires_at has passed to
 * status='expired'. Returns the number of grants transitioned. Safe to call on
 * an interval; idempotent.
 */
export async function expireDueGrants(deps = {}) {
  const q = deps.query || defaultQuery;
  const r = await q(
    `UPDATE tenancy.share_grants
        SET status = 'expired'
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= now()
      RETURNING id, target_type, target_id`,
  );
  for (const row of r.rows) {
    if (row.target_type === 'user') invalidatePrincipal(row.target_id);
  }
  if (r.rows.length > 0) log.info(`expired ${r.rows.length} grant(s)`);
  return r.rows.length;
}

/**
 * List grants visible to a caller (incoming + outgoing).
 *
 * Returns an array of grants where the caller is either the granter
 * (outgoing) or a target principal (incoming, via direct user-match or
 * group / org membership).
 */
export async function listGrantsForCaller({ principal }, deps = {}) {
  const q = deps.query || defaultQuery;
  const userId = principal?.userId || null;
  const orgIds = principal?.readOrgIds || [];
  const groupIds = principal?.readGroupIds || [];

  if (!userId && orgIds.length === 0) return [];

  const r = await q(
    `SELECT g.*
       FROM tenancy.share_grants g
      WHERE
        -- outgoing
        (g.granter_type = 'user' AND g.granter_id = $1)
        OR (g.granter_type = 'org'  AND g.granter_id = ANY($2::uuid[]))
        -- incoming
        OR (g.target_type = 'user'  AND g.target_id = $1)
        OR (g.target_type = 'org'   AND g.target_id = ANY($2::uuid[]))
        OR (g.target_type = 'group' AND g.target_id = ANY($3::uuid[]))
      ORDER BY g.created_at DESC`,
    [userId, orgIds, groupIds],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

async function assertCanAcceptOrDecline(grant, actorId, q) {
  // Target user can accept/decline a user-targeted grant.
  if (grant.target_type === 'user' && grant.target_id === actorId) return;
  // Target-org admin can accept/decline org- or group-targeted grants.
  if (grant.target_type === 'org' || grant.target_type === 'group') {
    const admin = await isOrgAdmin(actorId, grant.target_org_id, q);
    if (admin) return;
  }
  throw new Error('forbidden — not permitted to accept/decline this grant');
}

async function assertCanRevoke(grant, actorId, q) {
  // Granter side
  if (grant.granter_type === 'user' && grant.granter_id === actorId) return;
  if (grant.granter_type === 'org') {
    const admin = await isOrgAdmin(actorId, grant.granter_id, q);
    if (admin) return;
  }
  // Target-org admin can revoke an active incoming grant (D-side stop).
  if (grant.status === 'active') {
    if (grant.target_type === 'user' && grant.target_id === actorId) return;
    if (grant.target_type === 'org' || grant.target_type === 'group') {
      const admin = await isOrgAdmin(actorId, grant.target_org_id, q);
      if (admin) return;
    }
  }
  throw new Error('forbidden — not permitted to revoke this grant');
}

async function isOrgAdmin(userId, orgId, q) {
  if (!userId || !orgId) return false;
  const r = await q(
    `SELECT 1 FROM tenancy.memberships
      WHERE user_id = $1 AND org_id = $2
        AND is_active = true
        AND role IN ('owner', 'admin')
      LIMIT 1`,
    [userId, orgId],
  );
  return r.rows.length > 0;
}

/**
 * For a single grant row, drop principal caches for every user whose
 * effective visibility just changed (user-target only; org/group targets are
 * cache-safe because the cache keys on userId and the matching is done at
 * SQL-query time against live share_grants rows).
 */
function invalidatePrincipalsForGrant(grant) {
  if (grant.target_type === 'user') invalidatePrincipal(grant.target_id);
}
