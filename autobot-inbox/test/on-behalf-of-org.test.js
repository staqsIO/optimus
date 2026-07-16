/**
 * OPT-5 — on-behalf-of authoring-org resolution + owner-stamp + per-org branding.
 *
 * Three layers, all offline (PGlite, no network, no LLM):
 *   1. resolveOnBehalfOfOrg() unit: explicit override (member) wins; default =
 *      writer org; override beats default; non-member override → 403.
 *   2. POST /api/engagements route: an explicit on_behalf_of_org_id stamps
 *      owner_org_id from THAT org; default (no override) uses the writer's org;
 *      override beats default; a non-member override is rejected 403.
 *   3. Branding: loadBrandProfileForDraft() resolves the brand profile whose
 *      owner_org_id == the draft's engagement.owner_org_id (the authoring org's
 *      brand kit), preferring it over the system default.
 *
 * Tenancy is asserted by STAMPED-VALUE equality, never a hardcoded Staqs UUID —
 * PGlite seeds a random Staqs org id per run.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { randomUUID } from 'crypto';
import { createEngagement } from '../../lib/engagements/db.js';
import { registerEngagementsRoutes } from '../src/api-routes/engagements.js';
import { resolveOnBehalfOfOrg, principalMemberOf } from '../../lib/engagements/on-behalf-of.js';
import { loadBrandProfileForDraft } from '../../lib/contracts/brand-profile.js';

function principalForOrg(orgId) {
  return { userId: null, readOrgIds: [orgId], roles: { [orgId]: 'member' }, adminBypass: false };
}
const ADMIN = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };

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

describe('OPT-5 on-behalf-of authoring org', () => {
  let query;
  let staqsOrg;   // seeded default (== the writer's org in these tests)
  let umbOrg;     // a second authoring org the writer is NOT a member of
  let staqsBrandId;
  let umbBrandId;

  before(async () => {
    ({ query } = await getDb());

    const staqs = await query(`SELECT id FROM tenancy.orgs WHERE slug = 'staqs'`);
    staqsOrg = staqs.rows[0].id;

    // A second authoring org (UMB), distinct from the writer's org.
    const umbId = randomUUID();
    await query(
      `INSERT INTO tenancy.orgs (id, slug, name) VALUES ($1, 'umb', 'UMB Advisors')
         ON CONFLICT (slug) DO NOTHING`,
      [umbId]
    );
    umbOrg = (await query(`SELECT id FROM tenancy.orgs WHERE slug = 'umb'`)).rows[0].id;

    // Migration 176 seeds a Staqs authoring brand profile keyed to the staqs org.
    const staqsBrand = await query(
      `SELECT id FROM content.brand_profiles WHERE owner_org_id = $1 AND archived_at IS NULL`,
      [staqsOrg]
    );
    staqsBrandId = staqsBrand.rows[0]?.id || null;

    // Seed a UMB authoring brand profile (migration only stamps umb-advisors IF a
    // 'umb' org pre-existed at migrate time; we created it after, so add explicitly).
    // Guarded insert — the migration-176 partial unique index allows only one active
    // profile per authoring org, so we insert only if none exists yet.
    const existingUmb = await query(
      `SELECT id FROM content.brand_profiles WHERE owner_org_id = $1 AND archived_at IS NULL`,
      [umbOrg]
    );
    if (existingUmb.rows[0]) {
      umbBrandId = existingUmb.rows[0].id;
    } else {
      const ins = await query(
        `INSERT INTO content.brand_profiles
           (name, slug, description, heading_font_family, body_font_family,
            brand_color_hex, show_logo_in_header, footer_left_text,
            footer_show_page_number, is_default, owner_org_id, created_by)
         VALUES ('UMB Advisors (OPT-5 test)', 'umb-opt5-test', 'test',
                 'Cormorant Garamond', 'DM Sans', 'D4AF6F', true, 'Confidential',
                 true, false, $1, 'system')
         RETURNING id`,
        [umbOrg]
      );
      umbBrandId = ins.rows[0].id;
    }
  });

  beforeEach(async () => {
    await query(`DELETE FROM engagements.engagements WHERE name LIKE 'opt5-%'`);
    await query(`DELETE FROM content.drafts WHERE title LIKE 'opt5-%'`);
  });

  // ───────────────────────── 1. resolver unit ─────────────────────────

  it('resolver: default (no override) = the writer org', () => {
    const resolved = resolveOnBehalfOfOrg({ principal: principalForOrg(staqsOrg) });
    assert.equal(resolved, staqsOrg);
  });

  it('resolver: explicit override the writer is a member of WINS over default', () => {
    // Writer is a member of BOTH staqs (default) and umb (override) here.
    const member = { ...principalForOrg(staqsOrg), readOrgIds: [staqsOrg, umbOrg] };
    const resolved = resolveOnBehalfOfOrg({ explicitOrgId: umbOrg, principal: member });
    assert.equal(resolved, umbOrg, 'override beats the writer-org default');
    assert.notEqual(resolved, staqsOrg);
  });

  it('resolver: explicit override the writer is NOT a member of → 403', () => {
    assert.throws(
      () => resolveOnBehalfOfOrg({ explicitOrgId: umbOrg, principal: principalForOrg(staqsOrg) }),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /member of/i);
        return true;
      },
    );
  });

  it('resolver: adminBypass may author on behalf of any org', () => {
    assert.equal(principalMemberOf(ADMIN, umbOrg), true);
    assert.equal(resolveOnBehalfOfOrg({ explicitOrgId: umbOrg, principal: ADMIN }), umbOrg);
  });

  // ───────────────────────── 2. route → owner_org_id stamp ─────────────────────────

  it('POST /api/engagements: default detection stamps the writer org as owner_org_id', async () => {
    const routes = routesWithPrincipal(principalForOrg(staqsOrg));
    const handler = routes.get('POST /api/engagements');
    const { engagement } = await handler(req('/api/engagements'), { name: 'opt5-default', client: 'Acme' });
    assert.equal(engagement.owner_org_id, staqsOrg, 'owner_org_id defaulted to the writer org');
  });

  it('POST /api/engagements: explicit on_behalf_of_org_id stamps THAT org + beats default', async () => {
    // Writer is a member of both staqs (default) and umb (override).
    const member = { ...principalForOrg(staqsOrg), readOrgIds: [staqsOrg, umbOrg] };
    const routes = routesWithPrincipal(member);
    const handler = routes.get('POST /api/engagements');
    const { engagement } = await handler(
      req('/api/engagements'),
      { name: 'opt5-override', client: 'Acme', on_behalf_of_org_id: umbOrg },
    );
    assert.equal(engagement.owner_org_id, umbOrg, 'override authoring org is stamped, not the writer default');
    assert.notEqual(engagement.owner_org_id, staqsOrg);
  });

  it('POST /api/engagements: on_behalf_of_org_id the writer is not a member of → 403', async () => {
    const routes = routesWithPrincipal(principalForOrg(staqsOrg));
    const handler = routes.get('POST /api/engagements');
    await assert.rejects(
      () => handler(req('/api/engagements'), { name: 'opt5-evil', on_behalf_of_org_id: umbOrg }),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /member of/i);
        return true;
      },
    );
  });

  it('POST /api/engagements: raw owner_org_id body key is still rejected 400 (unchanged guard)', async () => {
    const routes = routesWithPrincipal(principalForOrg(staqsOrg));
    const handler = routes.get('POST /api/engagements');
    await assert.rejects(
      () => handler(req('/api/engagements'), { name: 'opt5-raw', owner_org_id: umbOrg }),
      (err) => { assert.equal(err.statusCode, 400); return true; },
    );
  });

  // ───────────────────────── 3. per-org branding on the render path ─────────────────────────

  async function makeContractDraftForOrg(ownerOrgId, label) {
    const eng = await createEngagement({
      name: `opt5-brand-${label}`, client: 'Acme', kind: 'advisory',
      createdBy: 'ecgang', ownerOrgId,
    });
    const draftId = randomUUID();
    await query(
      `INSERT INTO content.drafts (id, content_type, status, title, body, author, engagement_id)
       VALUES ($1, 'contract', 'draft', $2, '# Service Agreement', 'system', $3)`,
      [draftId, `opt5-${label}`, eng.id],
    );
    return draftId;
  }

  it('branding: a contract authored on behalf of Staqs resolves the Staqs brand profile', async () => {
    // Skip gracefully if migration 176 did not seed a staqs brand (defensive).
    assert.ok(staqsBrandId, 'migration 176 should have seeded a Staqs authoring brand profile');
    const draftId = await makeContractDraftForOrg(staqsOrg, 'staqs');
    const resolved = await loadBrandProfileForDraft(draftId);
    assert.ok(resolved, 'a brand profile should resolve');
    assert.equal(resolved.profile.owner_org_id, staqsOrg, 'resolved the authoring org profile');
    assert.equal(resolved.profile.id, staqsBrandId);
    assert.equal(resolved.profile.heading_font_family, 'JetBrains Mono', 'Staqs brand fonts applied');
    assert.equal(resolved.profile.brand_color_hex, '4ADE80', 'Staqs terminal-green applied');
  });

  it('branding: a contract authored on behalf of UMB resolves the UMB brand profile (per-org, not the default)', async () => {
    const draftId = await makeContractDraftForOrg(umbOrg, 'umb');
    const resolved = await loadBrandProfileForDraft(draftId);
    assert.ok(resolved, 'a brand profile should resolve');
    assert.equal(resolved.profile.owner_org_id, umbOrg, 'resolved the UMB authoring org profile');
    assert.equal(resolved.profile.id, umbBrandId);
    assert.equal(resolved.profile.brand_color_hex, 'D4AF6F', 'UMB gold applied, not the system default');
  });

  it('branding: an explicit draft.brand_profile_id still overrides the authoring-org profile', async () => {
    // Authoring org is UMB, but the draft pins the Staqs profile explicitly →
    // the per-contract override (priority 0) must still win over the org profile.
    const eng = await createEngagement({
      name: 'opt5-brand-pin', client: 'Acme', kind: 'advisory', createdBy: 'ecgang', ownerOrgId: umbOrg,
    });
    const draftId = randomUUID();
    await query(
      `INSERT INTO content.drafts (id, content_type, status, title, body, author, engagement_id, brand_profile_id)
       VALUES ($1, 'contract', 'draft', 'opt5-pin', '# X', 'system', $2, $3)`,
      [draftId, eng.id, staqsBrandId],
    );
    const resolved = await loadBrandProfileForDraft(draftId);
    assert.equal(resolved.profile.id, staqsBrandId, 'explicit per-draft brand override still wins');
  });
});
