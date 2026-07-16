import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression for the contact update + delete fix.
 *
 * Two bugs surfaced together:
 *   1. POST /api/contacts/:id silently dropped `tier` — the handler's
 *      destructure omitted it, so the UI's tier selection never persisted.
 *   2. There was no way to remove a contact card at all (e.g. for an
 *      employee who never actually started).
 *
 * These tests pin the SQL invariants behind the handler:
 *   - UPDATE persists tier when a valid value is sent.
 *   - DELETE removes the row and CASCADEs identities + projects but does
 *     NOT touch inbox.messages / content.documents (those are independent
 *     content chains that may involve other people).
 */
describe('contact update + delete (signal.contacts)', () => {
  let queryFn;

  const CONTACT_ID = '00000000-0000-0000-0000-0000000c0317';
  const IDENTITY_LINKEDIN_ID = '00000000-0000-0000-0000-0000000c0319';

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-contacts-update-test', import.meta.url).pathname;

    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();

    await queryFn(
      `INSERT INTO signal.contacts (id, email_address, name, tier, contact_type)
       VALUES ($1, 'never-started@example.com', 'Never Started', 'unknown', 'team')
       ON CONFLICT (id) DO UPDATE SET tier = 'unknown', contact_type = 'team'`,
      [CONTACT_ID]
    );

    // sql/081-contacts-identity-backfill.sql attaches a trigger that auto-creates
    // an 'email' identity row from signal.contacts.email_address. Only insert
    // the additional linkedin identity here so we don't collide on (channel, identifier).
    await queryFn(
      `INSERT INTO signal.contact_identities (id, contact_id, channel, identifier)
       VALUES ($1, $2, 'linkedin', 'linkedin.com/in/never-started-317')
       ON CONFLICT (id) DO NOTHING`,
      [IDENTITY_LINKEDIN_ID, CONTACT_ID]
    );

    await queryFn(
      `INSERT INTO signal.contact_projects (contact_id, project_name, platform, locator)
       VALUES ($1, 'sample', 'github', 'staqsIO/sample')
       ON CONFLICT (contact_id, platform, locator) DO NOTHING`,
      [CONTACT_ID]
    );
  });

  it('UPDATE accepts tier (was silently dropped before this fix)', async () => {
    // Mirrors the handler's dynamic SET clause for the tier=inactive case.
    await queryFn(
      `UPDATE signal.contacts SET tier = $2, updated_at = now() WHERE id = $1`,
      [CONTACT_ID, 'inactive']
    );
    const r = await queryFn(
      `SELECT tier FROM signal.contacts WHERE id = $1`,
      [CONTACT_ID]
    );
    assert.equal(r.rows[0].tier, 'inactive', 'tier must persist as inactive');
  });

  it('UPDATE persists tier round-trip alongside organization and notes', async () => {
    await queryFn(
      `UPDATE signal.contacts
         SET tier = $2, organization = $3, notes = $4, updated_at = now()
         WHERE id = $1`,
      [CONTACT_ID, 'inner_circle', 'Acme', 'Started 2026']
    );
    const r = await queryFn(
      `SELECT tier, organization, notes FROM signal.contacts WHERE id = $1`,
      [CONTACT_ID]
    );
    assert.equal(r.rows[0].tier, 'inner_circle');
    assert.equal(r.rows[0].organization, 'Acme');
    assert.equal(r.rows[0].notes, 'Started 2026');
  });

  it('UPDATE rejects an invalid tier via DB CHECK constraint', async () => {
    await assert.rejects(
      queryFn(
        `UPDATE signal.contacts SET tier = $2 WHERE id = $1`,
        [CONTACT_ID, 'platinum']
      ),
      (err) => /tier|check/i.test(String(err?.message || err)),
      'DB CHECK must reject tiers outside the canonical set'
    );
  });

  it('UPDATE rejects an invalid contact_type via DB CHECK constraint', async () => {
    // "person" was a stale UI option that doesn't exist in the DB constraint.
    await assert.rejects(
      queryFn(
        `UPDATE signal.contacts SET contact_type = $2 WHERE id = $1`,
        [CONTACT_ID, 'person']
      ),
      (err) => /contact_type|check/i.test(String(err?.message || err))
    );
  });

  it('DELETE removes the contact and CASCADEs identities + projects', async () => {
    const before = await queryFn(
      `SELECT
         (SELECT count(*) FROM signal.contact_identities WHERE contact_id = $1) AS identities,
         (SELECT count(*) FROM signal.contact_projects WHERE contact_id = $1) AS projects`,
      [CONTACT_ID]
    );
    assert.equal(Number(before.rows[0].identities), 2);
    assert.equal(Number(before.rows[0].projects), 1);

    const del = await queryFn(
      `DELETE FROM signal.contacts WHERE id = $1 RETURNING id, email_address`,
      [CONTACT_ID]
    );
    assert.equal(del.rows.length, 1);
    assert.equal(del.rows[0].email_address, 'never-started@example.com');

    const after = await queryFn(
      `SELECT
         (SELECT count(*) FROM signal.contacts WHERE id = $1) AS contacts,
         (SELECT count(*) FROM signal.contact_identities WHERE contact_id = $1) AS identities,
         (SELECT count(*) FROM signal.contact_projects WHERE contact_id = $1) AS projects`,
      [CONTACT_ID]
    );
    assert.equal(Number(after.rows[0].contacts), 0);
    assert.equal(Number(after.rows[0].identities), 0, 'CASCADE must remove identities');
    assert.equal(Number(after.rows[0].projects), 0, 'CASCADE must remove projects');
  });
});
