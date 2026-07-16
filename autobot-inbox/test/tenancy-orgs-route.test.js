/**
 * /api/tenancy/orgs — the owning-org picker source for capture sources.
 *
 * Contract: returns the ACTIVE tenancy.orgs the caller belongs to (scoped to
 * principal.readOrgIds), ordered by name. This is the set that
 * capture-sources.js assertKnownOrg + assertCallerInOrg accept, so the picker
 * can never offer an org the create path would reject. Distinct from
 * /api/organizations (the signal.organizations CRM).
 *
 *   - a member sees only their own org(s), ordered by name
 *   - inactive orgs are excluded
 *   - a no-org / unresolved principal sees [] (fail-closed)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

const { registerTenancyOrgsRoutes } = await import('../src/api-routes/tenancy-orgs.js');

const STAQS_ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';
const UMB_ORG = '22222222-2222-2222-2222-222222222222';
const INACTIVE_ORG = '33333333-3333-3333-3333-333333333333';

// Read principal (mirrors resolvePrincipal output for a board human).
const P = (orgs) => ({ userId: 'u1', readOrgIds: orgs, roles: {}, adminBypass: false });

let query;
let routes;

function call({ principal }) {
  const handler = routes.get('GET /api/tenancy/orgs');
  return handler({ url: '/api/tenancy/orgs', headers: {}, __principal: principal });
}

before(async () => {
  ({ query } = await getDb());

  await query(
    `INSERT INTO tenancy.orgs (id, slug, name, is_active) VALUES
       ($1, 'staqs-to-test', 'Staqs TO Test', true),
       ($2, 'umb-to-test', 'UMB TO Test', true),
       ($3, 'inactive-to-test', 'Inactive TO Test', false)
     ON CONFLICT (id) DO NOTHING`,
    [STAQS_ORG, UMB_ORG, INACTIVE_ORG],
  );

  routes = new Map();
  registerTenancyOrgsRoutes(routes, {
    withViewer: async (req) => ({ principal: req.__principal }),
  });
});

describe('GET /api/tenancy/orgs', () => {
  it('returns only the orgs the caller belongs to, ordered by name', async () => {
    const res = await call({ principal: P([UMB_ORG, STAQS_ORG]) });
    const names = res.organizations.map((o) => o.name);
    // Ordered by name: "Staqs TO Test" < "UMB TO Test".
    assert.deepEqual(names, ['Staqs TO Test', 'UMB TO Test']);
    assert.equal(res.organizations.every((o) => o.id && o.slug), true);
  });

  it('scopes to membership — a Staqs-only member never sees UMB', async () => {
    const res = await call({ principal: P([STAQS_ORG]) });
    assert.deepEqual(res.organizations.map((o) => o.id), [STAQS_ORG]);
  });

  it('excludes inactive orgs even when the caller is scoped to them', async () => {
    const res = await call({ principal: P([INACTIVE_ORG, STAQS_ORG]) });
    assert.deepEqual(res.organizations.map((o) => o.id), [STAQS_ORG]);
  });

  it('a no-org principal sees nothing (fail-closed)', async () => {
    const res = await call({ principal: P([]) });
    assert.deepEqual(res.organizations, []);
  });

  it('an unresolved principal (null) sees nothing (fail-closed)', async () => {
    const res = await call({ principal: null });
    assert.deepEqual(res.organizations, []);
  });
});
