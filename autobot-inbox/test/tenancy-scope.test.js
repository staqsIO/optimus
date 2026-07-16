/**
 * Characterization tests for tenancy isolation invariants (OPT-137 / plan 001).
 *
 * Pins the fail-closed contract of visibleClause() and resolvePrincipal():
 *   (a) org-A rows are invisible to an org-B-only principal
 *   (b) syntheticPrincipal scopes a SELECT to exactly one org
 *   (c) unidentified caller (userId=null, no adminBypass) → visibleClause produces
 *       'FALSE' → zero rows returned, never an unfiltered result
 *   (d) adminBypass principal sees across orgs (the legitimate bypass path)
 *   (e) visibleClause nextIndex advances correctly so callers can safely append
 *       additional positional params
 *
 * Runs on PGlite (no DATABASE_URL required).
 * Uses signal.contacts as the tenant-scoped table — it has owner_org_id (UUID)
 * added by migration 134 and minimal FK requirements.
 *
 * Strategy: use the seeded Staqs org (slug='staqs') as ORG_A, and insert a
 * second test org as ORG_B with a generated UUID. All row IDs use gen_random_uuid().
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  visibleClause,
  resolvePrincipal,
  syntheticPrincipal,
} from '../../lib/tenancy/scope.js';

let query;
let ORG_A; // Staqs org UUID (seeded by migration 133)
let ORG_B; // synthetic second org UUID (inserted here)

before(async () => {
  ({ query } = await getDb());

  // Resolve the seeded Staqs org — migration 133 inserts slug='staqs'
  const staqsRow = await query(
    `SELECT id FROM tenancy.orgs WHERE slug = 'staqs' LIMIT 1`
  );
  if (staqsRow.rows.length === 0) {
    throw new Error('tenancy.orgs has no staqs row — migration 133 did not run');
  }
  ORG_A = staqsRow.rows[0].id;

  // Insert a second test org for isolation assertions.
  const orgBRow = await query(`
    INSERT INTO tenancy.orgs (slug, name)
    VALUES ('org-b-tenancy-scope-test', 'Org B (tenancy-scope test)')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  ORG_B = orgBRow.rows[0].id;

  // Insert tenancy.memberships for ORG_B so resolvePrincipal can query it.
  // (ORG_A memberships are already seeded by migration 133/134 for real board members.)
  const ericRow = await query(
    `SELECT id FROM agent_graph.board_members WHERE github_username = 'ecgang' LIMIT 1`
  );
  if (ericRow.rows.length > 0) {
    await query(`
      INSERT INTO tenancy.memberships (user_id, org_id, role, is_active)
      VALUES ($1, $2, 'member', true)
      ON CONFLICT (user_id, org_id) DO NOTHING
    `, [ericRow.rows[0].id, ORG_A]);
  }

  // Seed one contact per org (signal.contacts has owner_org_id added by migration 134).
  // Use gen_random_uuid() to get proper UUIDs.
  await query(`
    INSERT INTO signal.contacts (email_address, name, owner_org_id)
    VALUES ('scope-test-a@example.com', 'Scope Test A', $1)
    ON CONFLICT (email_address) DO UPDATE SET owner_org_id = $1
  `, [ORG_A]);

  await query(`
    INSERT INTO signal.contacts (email_address, name, owner_org_id)
    VALUES ('scope-test-b@example.com', 'Scope Test B', $1)
    ON CONFLICT (email_address) DO UPDATE SET owner_org_id = $1
  `, [ORG_B]);
});

// Sentinel email addresses seeded for this suite — use email_address (text) to
// filter rows, avoiding UUID cast issues with PGlite's strict type checking.
const EMAIL_A = 'scope-test-a@example.com';
const EMAIL_B = 'scope-test-b@example.com';

describe('tenancy isolation — visibleClause', () => {
  it('(a) org-A principal sees org-A row but not org-B row', async () => {
    const principal = syntheticPrincipal(ORG_A);
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });

    const result = await query(
      `SELECT email_address FROM signal.contacts
       WHERE ${v.sql}
         AND email_address IN ($${v.nextIndex}, $${v.nextIndex + 1})`,
      [...v.params, EMAIL_A, EMAIL_B]
    );
    const emails = result.rows.map((r) => r.email_address);
    assert.ok(emails.includes(EMAIL_A), 'org-A principal must see org-A contact');
    assert.equal(emails.includes(EMAIL_B), false, 'org-A principal must NOT see org-B contact');
  });

  it('(b) syntheticPrincipal scopes SELECT to exactly one org', async () => {
    const principal = syntheticPrincipal(ORG_B);
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });

    const result = await query(
      `SELECT email_address FROM signal.contacts
       WHERE ${v.sql}
         AND email_address IN ($${v.nextIndex}, $${v.nextIndex + 1})`,
      [...v.params, EMAIL_A, EMAIL_B]
    );
    const emails = result.rows.map((r) => r.email_address);
    assert.equal(emails.includes(EMAIL_A), false, 'org-B principal must NOT see org-A contact');
    assert.ok(emails.includes(EMAIL_B), 'org-B principal must see org-B contact');
  });

  it('(c) unidentified caller (empty principal) → visibleClause FALSE → zero rows', async () => {
    // An empty principal has no readOrgIds → visibleClause must produce 'FALSE'
    const principal = { userId: null, readOrgIds: [], roles: {}, adminBypass: false };
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });

    // The SQL produced must be 'FALSE' — not an empty string that degrades to a full scan.
    assert.equal(v.sql.trim().toUpperCase(), 'FALSE',
      'unidentified principal must yield FALSE clause, not empty/passthrough');

    // 'FALSE' produces no params, so nextIndex == startIndex (1) and v.params is empty.
    // We just assert zero rows without appending filter params for cleanliness.
    const result = await query(
      `SELECT email_address FROM signal.contacts WHERE ${v.sql}`,
      v.params
    );
    assert.equal(result.rows.length, 0, 'unidentified principal must return zero rows');
  });

  it('(d) adminBypass principal sees across orgs', async () => {
    const principal = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });

    const result = await query(
      `SELECT email_address FROM signal.contacts
       WHERE ${v.sql}
         AND email_address IN ($${v.nextIndex}, $${v.nextIndex + 1})`,
      [...v.params, EMAIL_A, EMAIL_B]
    );
    const emails = result.rows.map((r) => r.email_address);
    assert.ok(emails.includes(EMAIL_A) && emails.includes(EMAIL_B),
      'adminBypass must see contacts from both orgs');
  });

  it('(e) nextIndex advances correctly so callers can append extra params', async () => {
    const principal = syntheticPrincipal(ORG_A);
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    // nextIndex must be strictly greater than startIndex (params were consumed).
    assert.ok(v.nextIndex > 1, 'nextIndex must advance past startIndex=1');
    // The appended param at nextIndex must be usable in a real query.
    const result = await query(
      `SELECT email_address FROM signal.contacts
       WHERE ${v.sql} AND email_address = $${v.nextIndex}`,
      [...v.params, EMAIL_A]
    );
    assert.equal(result.rows.length, 1, 'extra param at nextIndex must work correctly');
  });
});

describe('tenancy isolation — resolvePrincipal fail-closed semantics', () => {
  it('resolves userId=null to empty readOrgIds (no bypass)', async () => {
    const principal = await resolvePrincipal({ userId: null, adminBypass: false }, { query });
    assert.deepEqual(principal.readOrgIds, [],
      'null userId must resolve to empty readOrgIds — fail closed');
    assert.equal(principal.adminBypass, false);
    assert.equal(principal.userId, null);
  });

  it('resolves adminBypass identity without membership DB lookup', async () => {
    // adminBypass is granted by infrastructure (JWT), not derived from memberships.
    // The principal returned must have adminBypass=true regardless of readOrgIds.
    const principal = await resolvePrincipal({ adminBypass: true }, { query });
    assert.equal(principal.adminBypass, true,
      'adminBypass flag must pass through from identity');
    // adminBypass has no readOrgIds — bypass is structural, not membership-scoped.
    assert.deepEqual(principal.readOrgIds, [],
      'adminBypass principal has no readOrgIds (bypass supersedes org scope)');
  });
});
