// lib/tenancy/owner-stamp.js — ADR-012 §6 write-path owner stamp (STAQPRO-593).
//
// The READ side appends visibleClause() (scope.js). The WRITE side is the mirror
// obligation: every INSERT into a federated tenant table must stamp owner_org_id
// (+ owner_user_id where the table has one) from the verified WRITER, instead of
// relying on the migration-134 Staqs column DEFAULT. The DEFAULT is correct only
// while Optimus is single-org; the moment a second org writes, an un-stamped row
// is permanently mis-attributed to Staqs — a wrong owner no read-side code can
// repair without a re-migration.
//
// This helper derives the owner columns from a principal (HTTP: withViewer →
// resolvePrincipal; agent-runtime: syntheticPrincipal). It is intentionally
// small: callers splice the returned value(s) into their positional INSERT.
//
// Scope of the STAQPRO-593 increment: HTTP-handler writes (owner = the caller's
// org) are stamped now — that is the externally-reachable mis-attribution window.
// Agent-runtime writes (~65 sites) remain on the single-org DEFAULT and are
// tracked by the audit ratchet (audit-unscoped-tenant-reads.mjs --check covers
// un-stamped INSERTs); they are stamped in a follow-up coupled with the
// multi-org agent runtime, when an agent loop carries a non-Staqs org context.

/**
 * The writer's primary org id, or null if the principal is unresolved.
 * For a board user this is their single membership org; for an agent it is the
 * org passed to syntheticPrincipal(). adminBypass principals carry no org
 * (readOrgIds: []) → null → the INSERT falls through to the column DEFAULT,
 * which is correct for the single-org agent runtime today.
 *
 * @param {{readOrgIds?: string[]}|null|undefined} principal
 * @returns {string|null}
 */
export function writerOrgId(principal) {
  const orgs = principal?.readOrgIds;
  if (!Array.isArray(orgs) || orgs.length === 0) return null;
  // Single-org invariant today: a board user has exactly one membership. When
  // multi-org arrives, picking orgs[0] silently could mis-attribute a write —
  // make that audible so the maintainer wires an explicit write-org first.
  if (orgs.length > 1) {
    console.warn(
      `[owner-stamp] writerOrgId: principal has ${orgs.length} orgs; defaulting to orgs[0]. ` +
      `Multi-org writers must pass an explicit target org (STAQPRO-593 follow-up).`,
    );
  }
  return orgs[0];
}

/**
 * Owner columns to stamp on an INSERT, derived from the writer principal.
 * Returns both owner_org_id and owner_user_id; a caller adds whichever columns
 * its target table actually has (most tenant tables are org-only). A null value
 * means "let the column DEFAULT apply" (single-org-correct today).
 *
 * @param {{readOrgIds?: string[], userId?: string|null}|null|undefined} principal
 * @returns {{owner_org_id: string|null, owner_user_id: string|null}}
 */
export function ownerStamp(principal) {
  return {
    owner_org_id: writerOrgId(principal),
    owner_user_id: principal?.userId || null,
  };
}
