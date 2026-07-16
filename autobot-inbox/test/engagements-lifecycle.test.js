/**
 * STAQPRO-618 (ADR-015) Slice A — engagements deal lifecycle + tenancy.
 *
 * Handler/db-level tests (like ingest-route.test.js + human-tasks-api.test.js).
 * The route handlers are pure (req, body) → result functions; we register them
 * into a Map with a stubbed withViewer so each request carries a chosen
 * tenancy principal, then inspect the returned shape + the database.
 *
 * Tenancy is asserted by STAMPED-VALUE equality/inequality, never a hardcoded
 * Staqs UUID — PGlite seeds a random Staqs org id per run.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { randomUUID } from 'crypto';
import {
  createEngagement,
  listEngagements,
  getEngagement,
  updateEngagementStatus,
  markEngagementWon,
} from '../../lib/engagements/db.js';
import { registerEngagementsRoutes } from '../src/api-routes/engagements.js';

// Two synthetic single-org principals: org A and org B. syntheticPrincipal is
// the same primitive the agent runtime uses; readOrgIds=[org] → visibleClause
// scopes to that org only (not adminBypass, so cross-org reads are blocked).
function principalForOrg(orgId) {
  return { userId: null, readOrgIds: [orgId], roles: { [orgId]: 'member' }, adminBypass: false };
}
const ADMIN = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };

// Build a routes Map wired with a withViewer that returns a fixed principal,
// so route handlers resolve ownership/scope exactly like production.
function routesWithPrincipal(principal) {
  const routes = new Map();
  registerEngagementsRoutes(routes, {
    withViewer: async () => ({ principal, viewer: { ownerId: null, adminBypass: !!principal?.adminBypass } }),
  });
  return routes;
}
function req(url, headers = {}) {
  return { url, headers: { 'x-board-user': 'ecgang', ...headers } };
}

describe('STAQPRO-618 engagements lifecycle + tenancy', () => {
  let query;
  let orgA;
  let orgB;

  before(async () => {
    ({ query } = await getDb());
    // Two orgs. The seeded Staqs org is the DEFAULT owner; we add a second org
    // (org B) so an unstamped/Staqs-owned row is invisible to B and vice-versa.
    const staqs = await query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
    orgA = staqs.rows[0].id;
    const bId = randomUUID();
    await query(
      `INSERT INTO tenancy.orgs (id, slug, name) VALUES ($1, 'org-b-618', 'Org B 618')
         ON CONFLICT (slug) DO NOTHING`,
      [bId]
    );
    const bRow = await query(`SELECT id FROM tenancy.orgs WHERE slug = 'org-b-618'`);
    orgB = bRow.rows[0].id;
  });

  beforeEach(async () => {
    await query(`DELETE FROM engagements.engagements WHERE name LIKE '618-%'`);
  });

  // ── createEngagement stamps owner_org_id from a principal ──────────────────
  it('createEngagement stamps owner_org_id from the writer principal', async () => {
    const e = await createEngagement({
      name: '618-stamp', client: 'Acme', kind: 'website',
      createdBy: 'ecgang', ownerOrgId: orgA,
    });
    assert.equal(e.owner_org_id, orgA, 'owner_org_id should be the writer org');
    assert.equal(e.status, 'prospect', 'default status is prospect');
  });

  it('createEngagement with no ownerOrgId falls through to the column DEFAULT (Staqs)', async () => {
    const e = await createEngagement({ name: '618-default', createdBy: 'ecgang' });
    // DEFAULT is the seeded Staqs org id (orgA here), single-org-correct today.
    assert.equal(e.owner_org_id, orgA);
  });

  // ── route rejects body owner_org_id (400) ──────────────────────────────────
  it('POST /api/engagements rejects a body-supplied owner_org_id with 400', async () => {
    const routes = routesWithPrincipal(principalForOrg(orgA));
    const handler = routes.get('POST /api/engagements');
    await assert.rejects(
      () => handler(req('/api/engagements'), { name: '618-evil', owner_org_id: orgB }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /owner_org_id cannot be set/i);
        return true;
      },
    );
  });

  it('POST /api/engagements derives owner_org_id from the principal, ignoring identity spoof attempts', async () => {
    const routes = routesWithPrincipal(principalForOrg(orgB));
    const handler = routes.get('POST /api/engagements');
    const { engagement } = await handler(req('/api/engagements'), { name: '618-fromtoken', client: 'C' });
    assert.equal(engagement.owner_org_id, orgB, 'ownership comes from the token, not the body');
  });

  // ── create-as-active with NO proposal → status 'active' (proposal-optional) ─
  it('create-as-active produces an active engagement with no proposal attached', async () => {
    const routes = routesWithPrincipal(principalForOrg(orgA));
    const handler = routes.get('POST /api/engagements');
    const { engagement } = await handler(
      req('/api/engagements'),
      { name: '618-active', status: 'active', kind: 'advisory' },
    );
    assert.equal(engagement.status, 'active');
    assert.equal(engagement.kind, 'advisory', 'advisory kind is now valid');
    // No proposal rows exist for this engagement — proves the proposal-optional path.
    const props = await query(
      `SELECT count(*)::int AS n FROM engagements.proposals WHERE engagement_id = $1`,
      [engagement.id],
    );
    assert.equal(props.rows[0].n, 0);
  });

  // ── tenancy: org A's engagement is invisible to org B, visible to owner/admin ─
  it('listEngagements is org-scoped: A-owned row hidden from B, shown to owner + admin', async () => {
    const owned = await createEngagement({
      name: '618-tenancy', createdBy: 'ecgang', ownerOrgId: orgA,
    });

    const asB = await listEngagements({ principal: principalForOrg(orgB) });
    assert.ok(!asB.some((e) => e.id === owned.id), 'org B must NOT see org A engagement');

    const asA = await listEngagements({ principal: principalForOrg(orgA) });
    assert.ok(asA.some((e) => e.id === owned.id), 'owner org A sees its engagement');

    const asAdmin = await listEngagements({ principal: ADMIN });
    assert.ok(asAdmin.some((e) => e.id === owned.id), 'adminBypass sees all');
  });

  it('listEngagements with a null principal fails closed (zero rows)', async () => {
    await createEngagement({ name: '618-failclosed', createdBy: 'ecgang', ownerOrgId: orgA });
    const none = await listEngagements({ principal: null });
    assert.equal(none.length, 0, 'null principal → visibleClause FALSE → no rows');
  });

  it('getEngagement is org-scoped: B cannot read an A-owned engagement', async () => {
    const owned = await createEngagement({ name: '618-getscope', createdBy: 'ecgang', ownerOrgId: orgA });
    assert.equal(await getEngagement(owned.id, { principal: principalForOrg(orgB) }), null);
    const seen = await getEngagement(owned.id, { principal: principalForOrg(orgA) });
    assert.equal(seen?.id, owned.id);
  });

  // ── markEngagementWon: prospect→won, idempotent, non-downgrading ───────────
  it('markEngagementWon flips prospect → won and is idempotent', async () => {
    const e = await createEngagement({ name: '618-won', createdBy: 'ecgang', ownerOrgId: orgA });
    assert.equal(e.status, 'prospect');

    const won = await markEngagementWon(e.id);
    assert.equal(won.status, 'won');

    // Idempotent: re-running keeps it won, no error.
    const again = await markEngagementWon(e.id);
    assert.equal(again.status, 'won');
  });

  it('markEngagementWon does NOT downgrade an active or closed engagement', async () => {
    const active = await createEngagement({
      name: '618-noactive', status: 'active', createdBy: 'ecgang', ownerOrgId: orgA,
    });
    const r1 = await markEngagementWon(active.id);
    assert.equal(r1.status, 'active', 'active is not downgraded to won');

    const closed = await createEngagement({ name: '618-noclosed', createdBy: 'ecgang', ownerOrgId: orgA });
    await updateEngagementStatus(closed.id, 'closed');
    const r2 = await markEngagementWon(closed.id);
    assert.equal(r2.status, 'closed', 'closed is not downgraded to won');
  });

  it('markEngagementWon on a missing engagement returns null', async () => {
    assert.equal(await markEngagementWon(randomUUID()), null);
  });

  // ── lifecycle: prospect → active transition allowed (menu, not turnstile) ──
  it('updateEngagementStatus allows prospect → active', async () => {
    const e = await createEngagement({ name: '618-transition', createdBy: 'ecgang', ownerOrgId: orgA });
    const updated = await updateEngagementStatus(e.id, 'active');
    assert.equal(updated.status, 'active');
  });

  it('updateEngagementStatus rejects a value outside the lifecycle set', async () => {
    const e = await createEngagement({ name: '618-badstatus', createdBy: 'ecgang', ownerOrgId: orgA });
    await assert.rejects(() => updateEngagementStatus(e.id, 'draft'), /invalid status/);
  });
});
