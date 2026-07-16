// api-routes/tenancy-orgs.js — the caller's OWN operational orgs (tenancy.orgs):
// the set that is valid for `owner_org_id` attribution on a capture source.
//
// Distinct from /api/organizations, which lists signal.organizations (the CRM:
// external companies/contacts the org TRACKS — vendors, customers, partners).
// The capture-source OWNING-ORG picker needs the TENANCY boundary, not the CRM:
// owner_org_id is validated against tenancy.orgs AND the caller's membership
// (capture-sources.js assertKnownOrg + assertCallerInOrg), so a signal.org id
// could never satisfy the create path. Feeding the picker from the CRM showed
// orgs that don't exist as tenancies (and hid the caller's real org, e.g. Staqs).

import { query as defaultQuery } from '../db.js';

export function registerTenancyOrgsRoutes(routes, { withViewer } = {}) {
  // Resolve the tenancy principal. null (withViewer absent or a resolution
  // throw) -> zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/tenancy/orgs — the active tenancy orgs the caller belongs to. This
  // is the ONLY set valid for capture-source owner_org_id, so scoping the picker
  // to it means the create path can never reject the user's selection.
  //
  // Scoped to principal.readOrgIds (the caller's active memberships, resolved by
  // resolvePrincipal from tenancy.memberships). Fail-closed: an unresolved
  // principal, an adminBypass/agent principal (readOrgIds === []), or a member of
  // no orgs all yield []. (A board-admin attributing to an org they aren't a
  // member of is the assertCallerInOrg admin bypass — a rare control-plane path,
  // intentionally not surfaced in the self-serve picker.)
  routes.set('GET /api/tenancy/orgs', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const orgIds = principal?.readOrgIds || [];
    if (orgIds.length === 0) return { organizations: [] };
    const result = await defaultQuery(
      `SELECT id, name, slug
         FROM tenancy.orgs
        WHERE id = ANY($1::uuid[]) AND is_active = true
        ORDER BY name`,
      [orgIds],
    );
    return { organizations: result.rows };
  });
}
