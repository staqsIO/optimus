// migration-142.test.js
// Backfill test for STAQPRO-555 (P0.5 — contact enrichment / snapshot fix).
//
// Migration 142 re-runs the 081 email-identity backfill to catch contacts
// that are missing their signal.contact_identities email row (the "No
// identities linked" symptom on the contact detail page).
//
// TESTING MODEL NOTE: PGlite applies ALL migrations at getDb() time, including
// migration 081's AFTER INSERT/UPDATE trigger (signal.sync_contact_email_identity).
// That trigger auto-creates the email identity on INSERT, so a freshly-inserted
// contact is never missing its identity in PGlite. To stage the straggler the
// migration is meant to repair, we INSERT a contact and then DELETE its
// auto-created email identity — simulating a contact that predates 081 or whose
// write path bypassed the trigger. We then execute the 142 backfill SQL and
// assert the identity is restored, and that a second execution is a no-op
// (idempotency).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb } from './helpers/setup-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_142 = readFileSync(
  resolve(__dirname, '../sql/142-contacts-identity-backfill-rerun.sql'),
  'utf8',
);

describe('migration-142: contact email-identity backfill rerun', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  it('restores a missing email identity for a contact with email_address', async () => {
    const email = 'berkowitz-142@example.com';
    const { rows } = await query(
      `INSERT INTO signal.contacts (email_address, name)
       VALUES ($1, 'David Berkowitz') RETURNING id`,
      [email],
    );
    const contactId = rows[0].id;

    // Simulate a straggler: remove the trigger-created email identity so the
    // contact has email_address but no matching identity row.
    await query(
      `DELETE FROM signal.contact_identities
        WHERE contact_id = $1 AND channel = 'email'`,
      [contactId],
    );

    const before = await query(
      `SELECT count(*)::int AS n FROM signal.contact_identities
        WHERE contact_id = $1 AND channel = 'email' AND identifier = lower($2)`,
      [contactId, email],
    );
    assert.equal(before.rows[0].n, 0, 'precondition: identity should be missing');

    // Run the backfill.
    await query(MIGRATION_142);

    const after = await query(
      `SELECT source FROM signal.contact_identities
        WHERE contact_id = $1 AND channel = 'email' AND identifier = lower($2)`,
      [contactId, email],
    );
    assert.equal(after.rows.length, 1, 'identity should be backfilled');
    assert.equal(after.rows[0].source, 'migration_backfill_142');
  });

  it('is idempotent — running twice does not duplicate or error', async () => {
    const email = 'idempotent-142@example.com';
    const { rows } = await query(
      `INSERT INTO signal.contacts (email_address, name)
       VALUES ($1, 'Idem Test') RETURNING id`,
      [email],
    );
    const contactId = rows[0].id;
    await query(
      `DELETE FROM signal.contact_identities
        WHERE contact_id = $1 AND channel = 'email'`,
      [contactId],
    );

    await query(MIGRATION_142);
    await query(MIGRATION_142); // second run must be a no-op, not a unique-violation

    const after = await query(
      `SELECT count(*)::int AS n FROM signal.contact_identities
        WHERE contact_id = $1 AND channel = 'email' AND identifier = lower($2)`,
      [contactId, email],
    );
    assert.equal(after.rows[0].n, 1, 'exactly one identity after two backfill runs');
  });

  it('does not create identities for contacts with NULL/empty email_address', async () => {
    // email_address is NOT NULL UNIQUE in baseline, so an empty-string contact
    // is the only "no usable email" shape reachable. It must be skipped.
    const { rows } = await query(
      `INSERT INTO signal.contacts (email_address, name)
       VALUES ('', 'No Email') RETURNING id`,
    );
    const contactId = rows[0].id;
    await query(
      `DELETE FROM signal.contact_identities WHERE contact_id = $1`,
      [contactId],
    );

    await query(MIGRATION_142);

    const after = await query(
      `SELECT count(*)::int AS n FROM signal.contact_identities
        WHERE contact_id = $1`,
      [contactId],
    );
    assert.equal(after.rows[0].n, 0, 'empty-email contact gets no identity');
  });
});
