/**
 * OPT-72 — per-viewer prioritization of org-shared signal.contacts
 *
 * signal.contacts is intentionally org-shared (UNIQUE on email_address; no per-owner
 * column). OPT-72 keeps it org-shared but annotates + reorders it per the requesting
 * viewer's personal interaction history from inbox.messages.
 *
 * Tests:
 *   (a) Two viewers receive the SAME contact set, in DIFFERENT order (viewer-personal-first).
 *   (b) viewer_affinity counts inbound + outbound messages correctly.
 *   (c) viewer_engaged = true only for contacts the viewer has personally corresponded with.
 *   (d) No leak: a viewer's affinity derivation never exposes another viewer's private rows.
 *   (e) No-email viewer (adminBypass / no accounts) gets contacts in global recency order.
 *
 * Harness: mirrors the SQL in GET /api/contacts rather than importing src/api.js
 * directly (importing api.js pulls docx + other undeclared deps, crashing the runner).
 * This mirrors the established pattern in staqpro-531-viewer-scoping.test.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

// Fixture IDs — namespaced to avoid collision with other PGlite test suites.
const ERIC_EMAIL = 'eric-opt72@staqs.io';
const DUSTIN_EMAIL = 'dustin-opt72@umb.io';

// Three org-shared contacts
const CONTACT_ALICE = 'contact-alice-opt72'; // Eric has 3 messages with Alice
const CONTACT_BOB   = 'contact-bob-opt72';   // Dustin has 5 messages with Bob, Eric has 0
const CONTACT_CAROL = 'contact-carol-opt72'; // Neither has messages with Carol (global fallback)

const ALICE_EMAIL = 'alice-opt72@example.com';
const BOB_EMAIL   = 'bob-opt72@example.com';
const CAROL_EMAIL = 'carol-opt72@example.com';

// org shared for tenancy
const ORG_ID = '00000000-0000-0000-0000-000000072000';

describe('OPT-72 per-viewer contact prioritization', () => {
  let db;

  /**
   * Mirror of the per-viewer affinity query in GET /api/contacts (OPT-72).
   * Returns contacts ordered by viewer_affinity DESC, global recency DESC.
   * viewerEmails = [] means no-email viewer → all affinities = 0 → pure global order.
   */
  async function contactsForViewer(viewerEmails) {
    // visibleClause for org-shared (signal.contacts has owner_org_id = ORG_ID)
    // We use a simplified version here: show all contacts with matching owner_org_id.
    const emailsParam = viewerEmails;
    const r = await db.query(
      `SELECT c.id, c.email_address,
              COALESCE((
                SELECT COUNT(*)::int
                FROM inbox.messages m
                WHERE (
                  (lower(m.from_address) = lower(c.email_address)
                   AND EXISTS (
                     SELECT 1 FROM unnest(
                       COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                     ) AS addr WHERE lower(addr) = ANY($1::text[])
                   ))
                  OR
                  (lower(m.from_address) = ANY($1::text[])
                   AND EXISTS (
                     SELECT 1 FROM unnest(
                       COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                     ) AS addr WHERE lower(addr) = lower(c.email_address)
                   ))
                )
              ), 0) AS viewer_affinity,
              COALESCE((
                SELECT COUNT(*) > 0
                FROM inbox.messages m
                WHERE (
                  (lower(m.from_address) = lower(c.email_address)
                   AND EXISTS (
                     SELECT 1 FROM unnest(
                       COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                     ) AS addr WHERE lower(addr) = ANY($1::text[])
                   ))
                  OR
                  (lower(m.from_address) = ANY($1::text[])
                   AND EXISTS (
                     SELECT 1 FROM unnest(
                       COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                     ) AS addr WHERE lower(addr) = lower(c.email_address)
                   ))
                )
              ), false) AS viewer_engaged
       FROM signal.contacts c
       WHERE c.owner_org_id = $2
       ORDER BY
         COALESCE((
           SELECT COUNT(*)::int
           FROM inbox.messages m
           WHERE (
             (lower(m.from_address) = lower(c.email_address)
              AND EXISTS (
                SELECT 1 FROM unnest(
                  COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                ) AS addr WHERE lower(addr) = ANY($1::text[])
              ))
             OR
             (lower(m.from_address) = ANY($1::text[])
              AND EXISTS (
                SELECT 1 FROM unnest(
                  COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
                ) AS addr WHERE lower(addr) = lower(c.email_address)
              ))
           )
         ), 0) DESC,
         COALESCE(c.last_received_at, c.created_at) DESC`,
      [emailsParam, ORG_ID]
    );
    return r.rows;
  }

  before(async () => {
    db = new PGlite();

    // Minimal schema — only what this test needs.
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS signal;
      CREATE SCHEMA IF NOT EXISTS inbox;

      CREATE TABLE signal.contacts (
        id              TEXT PRIMARY KEY,
        email_address   TEXT NOT NULL UNIQUE,
        name            TEXT,
        contact_type    TEXT DEFAULT 'unknown',
        is_vip          BOOLEAN NOT NULL DEFAULT false,
        emails_received INTEGER NOT NULL DEFAULT 0,
        emails_sent     INTEGER NOT NULL DEFAULT 0,
        last_received_at TIMESTAMPTZ,
        last_sent_at     TIMESTAMPTZ,
        owner_org_id    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE inbox.messages (
        id            TEXT PRIMARY KEY,
        from_address  TEXT NOT NULL,
        to_addresses  TEXT[] NOT NULL DEFAULT '{}',
        cc_addresses  TEXT[] NOT NULL DEFAULT '{}',
        subject       TEXT,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Seed 3 org-shared contacts. Carol was created first (oldest), then Bob, then Alice.
    await db.query(
      `INSERT INTO signal.contacts (id, email_address, name, owner_org_id, created_at)
       VALUES
         ($1, $4, 'Alice Opt72', $7, now() - interval '1 day'),
         ($2, $5, 'Bob Opt72',   $7, now() - interval '2 days'),
         ($3, $6, 'Carol Opt72', $7, now() - interval '3 days')`,
      [CONTACT_ALICE, CONTACT_BOB, CONTACT_CAROL, ALICE_EMAIL, BOB_EMAIL, CAROL_EMAIL, ORG_ID]
    );

    // Eric ↔ Alice: 3 messages (2 inbound Alice→Eric, 1 outbound Eric→Alice)
    await db.query(
      `INSERT INTO inbox.messages (id, from_address, to_addresses, received_at)
       VALUES
         ('msg-a1-opt72', $1, ARRAY[$2]::text[], now() - interval '5 hours'),
         ('msg-a2-opt72', $1, ARRAY[$2]::text[], now() - interval '4 hours'),
         ('msg-a3-opt72', $2, ARRAY[$1]::text[], now() - interval '3 hours')`,
      [ALICE_EMAIL, ERIC_EMAIL]
    );

    // Dustin ↔ Bob: 5 messages (3 inbound Bob→Dustin, 2 outbound Dustin→Bob)
    await db.query(
      `INSERT INTO inbox.messages (id, from_address, to_addresses, received_at)
       VALUES
         ('msg-b1-opt72', $1, ARRAY[$2]::text[], now() - interval '5 hours'),
         ('msg-b2-opt72', $1, ARRAY[$2]::text[], now() - interval '4 hours'),
         ('msg-b3-opt72', $1, ARRAY[$2]::text[], now() - interval '3 hours'),
         ('msg-b4-opt72', $2, ARRAY[$1]::text[], now() - interval '2 hours'),
         ('msg-b5-opt72', $2, ARRAY[$1]::text[], now() - interval '1 hour')`,
      [BOB_EMAIL, DUSTIN_EMAIL]
    );

    // Carol: no messages with anyone → affinity = 0 for all viewers
  });

  it('(a) two viewers see the SAME contact set in DIFFERENT personal order', async () => {
    const ericContacts   = await contactsForViewer([ERIC_EMAIL]);
    const dustinContacts = await contactsForViewer([DUSTIN_EMAIL]);

    // Both see all 3 contacts
    const ericIds   = ericContacts.map(c => c.id);
    const dustinIds = dustinContacts.map(c => c.id);
    assert.deepEqual([...ericIds].sort(), [...dustinIds].sort(),
      'both viewers must see the same org-shared contact set');

    // Eric's most-engaged contact is Alice (3 messages); Bob appears before Carol
    assert.equal(ericIds[0], CONTACT_ALICE, 'Eric: Alice first (3 messages)');
    // Carol has 0 affinity; Bob also 0 for Eric → Carol and Bob in recency order (Bob newer)
    assert.equal(ericIds[1], CONTACT_BOB,   'Eric: Bob second (newer than Carol, same 0 affinity)');
    assert.equal(ericIds[2], CONTACT_CAROL, 'Eric: Carol last');

    // Dustin's most-engaged contact is Bob (5 messages)
    assert.equal(dustinIds[0], CONTACT_BOB,   'Dustin: Bob first (5 messages)');
    // Alice has 0 affinity for Dustin; Carol also 0 → Alice newer than Carol
    assert.equal(dustinIds[1], CONTACT_ALICE, 'Dustin: Alice second (newer than Carol, 0 affinity)');
    assert.equal(dustinIds[2], CONTACT_CAROL, 'Dustin: Carol last');
  });

  it('(b) viewer_affinity counts inbound + outbound messages correctly', async () => {
    const ericContacts = await contactsForViewer([ERIC_EMAIL]);
    const alice = ericContacts.find(c => c.id === CONTACT_ALICE);
    assert.ok(alice, 'Alice must be in results');
    assert.equal(alice.viewer_affinity, 3, 'Eric ↔ Alice: 2 inbound + 1 outbound = 3');

    const dustinContacts = await contactsForViewer([DUSTIN_EMAIL]);
    const bob = dustinContacts.find(c => c.id === CONTACT_BOB);
    assert.ok(bob, 'Bob must be in results');
    assert.equal(bob.viewer_affinity, 5, 'Dustin ↔ Bob: 3 inbound + 2 outbound = 5');
  });

  it('(c) viewer_engaged = true only for personally-corresponded contacts', async () => {
    const ericContacts = await contactsForViewer([ERIC_EMAIL]);
    const alice = ericContacts.find(c => c.id === CONTACT_ALICE);
    const bob   = ericContacts.find(c => c.id === CONTACT_BOB);
    const carol = ericContacts.find(c => c.id === CONTACT_CAROL);

    assert.equal(alice.viewer_engaged, true,  'Eric IS engaged with Alice');
    assert.equal(bob.viewer_engaged,   false, 'Eric is NOT engaged with Bob');
    assert.equal(carol.viewer_engaged, false, 'Eric is NOT engaged with Carol');
  });

  it('(d) no cross-viewer leak — Eric affinity scores are 0 for Dustin-only contacts', async () => {
    // Bob has 5 messages with Dustin. Eric has 0. Eric must see affinity=0 for Bob.
    const ericContacts = await contactsForViewer([ERIC_EMAIL]);
    const bob = ericContacts.find(c => c.id === CONTACT_BOB);
    assert.equal(bob.viewer_affinity, 0, 'Eric must see affinity=0 for Bob (Dustin-only contact)');
    assert.equal(bob.viewer_engaged, false, 'Eric must see viewer_engaged=false for Bob');
  });

  it('(e) no-email viewer (adminBypass / empty emails) gets contacts in global recency order', async () => {
    // [] = no viewer emails → all affinities = 0 → order by recency only
    const contacts = await contactsForViewer([]);
    const ids = contacts.map(c => c.id);
    // Alice newest, Bob middle, Carol oldest
    assert.deepEqual(ids, [CONTACT_ALICE, CONTACT_BOB, CONTACT_CAROL],
      'no-email viewer must see contacts in global recency order (Alice > Bob > Carol)');
    for (const c of contacts) {
      assert.equal(c.viewer_affinity, 0, 'all affinities must be 0 for no-email viewer');
      assert.equal(c.viewer_engaged, false, 'viewer_engaged must be false for no-email viewer');
    }
  });
});
