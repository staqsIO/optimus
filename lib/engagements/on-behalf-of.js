// lib/engagements/on-behalf-of.js — OPT-5 authoring-org ("on behalf of") resolution.
//
// Generated artifacts (engagement / proposal / contract) are authored ON BEHALF
// OF one of Optimus' own orgs (Staqs, UMB Advisors, …). That authoring org drives
//   (a) the owner_org_id stamp (tenancy), and
//   (b) the per-org branding applied to the rendered proposal/contract.
//
// This is DISTINCT from `engagements.organization_id` (the *client's* signal-graph
// org, matched by lib/engagements/auto-build.js matchOrganization()). The authoring
// org is one of OUR tenancy orgs; the client org is the counterparty we're pitching.
//
// Resolution (P1 deny-by-default):
//   resolved = explicit override (if the writer is a member of it)
//           ?? the writer's own org (owner-stamp.js writerOrgId)
//
// An explicit override the writer is NOT a member of is REJECTED (403) — you can
// only author on behalf of an org you belong to. This mirrors the engagements-route
// rule that owner_org_id is never blindly accepted from the body; the override is a
// *selection among orgs you already own*, validated server-side, not a free-form set.

import { writerOrgId } from '../tenancy/owner-stamp.js';

/**
 * @param {{readOrgIds?: string[], adminBypass?: boolean}|null|undefined} principal
 * @param {string} orgId
 * @returns {boolean} true if the principal may author on behalf of orgId.
 */
export function principalMemberOf(principal, orgId) {
  if (!principal || !orgId) return false;
  // adminBypass carries no concrete org membership (readOrgIds: []) but is allowed
  // to author on behalf of any org — it is the board/system principal.
  if (principal.adminBypass) return true;
  const orgs = Array.isArray(principal.readOrgIds) ? principal.readOrgIds : [];
  return orgs.includes(orgId);
}

/**
 * Resolve the authoring ("on behalf of") org for a generated artifact.
 *
 * @param {object} args
 * @param {string|null|undefined} args.explicitOrgId  on_behalf_of_org_id from the payload (optional override)
 * @param {object|null|undefined} args.principal      verified writer principal
 * @returns {string|null} the resolved org id, or null → let the column DEFAULT apply
 *   (single-org-correct today; same semantics as writerOrgId()).
 * @throws {Error} (statusCode 403) if an explicit override is supplied that the
 *   principal is not a member of.
 */
export function resolveOnBehalfOfOrg({ explicitOrgId = null, principal = null } = {}) {
  const override = explicitOrgId ? String(explicitOrgId).trim() : null;
  if (override) {
    if (!principalMemberOf(principal, override)) {
      const err = new Error(
        'on_behalf_of_org_id must be an org you are a member of — ' +
        'you can only author on behalf of an org you belong to',
      );
      err.statusCode = 403;
      throw err;
    }
    return override;
  }
  // No explicit override → default to the writer's own org (the confident default).
  return writerOrgId(principal);
}
