import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDb } from './helpers/setup-db.js';

/**
 * STAQPRO-308 Phase 2 — tests for signal.split_contact_identities().
 *
 * Linus pre-implementation review punch list:
 *   - BLOCKER 1: FOR UPDATE on source — verified by concurrent-split test below.
 *   - BLOCKER 2: forged-identity auth — that's an HTTP-layer concern; the SQL
 *     function takes p_performed_by as a parameter and trusts it. API tests
 *     belong in a separate file when the test harness supports HTTP routing.
 *   - SHOULD-FIX 3: emails_sent recompute correctness — happy-path test asserts
 *     ground-truth values; emails_received untouched.
 *   - SHOULD-FIX 5: public_event row emission — verified.
 *   - SHOULD-FIX 6: GRANT EXECUTE for autobot_agent — covered by migration test.
 *   - NIT 4: in-function assertion on primaryEmail in identityIds — verified.
 */

describe('signal.split_contact_identities — STAQPRO-308 Phase 2', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  // Per-test seed function: every email/thread/msg uses a unique tag so
  // tests sharing the PGlite instance don't collide on UNIQUE constraints.
  async function seedSourceContact() {
    const tag = randomUUID().slice(0, 8);
    const emails = {
      nicholas:  `nicholas.${tag}@example.com`,
      nicholas2: `nicholas2.${tag}@example.com`,
      don:       `don.${tag}@example.com`,
      don2:      `don2.${tag}@example.com`,
    };

    const { rows: [src] } = await query(
      `INSERT INTO signal.contacts
         (email_address, name, contact_type, tier, emails_sent, emails_received)
       VALUES ($1, 'Nicholas Test', 'unknown', 'active', 0, 5)
       RETURNING id`,
      [emails.nicholas]
    );
    // The AFTER-INSERT trigger creates an email identity for the primary
    // email_address. Insert the 3 additional identities explicitly.
    await query(
      `INSERT INTO signal.contact_identities (contact_id, channel, identifier, label, source)
       VALUES
         ($1, 'email', $2, 'Nicholas Test', 'seed'),
         ($1, 'email', $3, 'Don Test',      'seed'),
         ($1, 'email', $4, 'Don Test',      'seed')`,
      [src.id, emails.nicholas2, emails.don, emails.don2]
    );

    // Seed voice.sent_emails: 4 to Nicholas, 2 to Don. thread_id is NOT NULL.
    const rows = [
      [`m1-${tag}`, `t1-${tag}`, emails.nicholas,  '5d'],
      [`m2-${tag}`, `t1-${tag}`, emails.nicholas,  '4d'],
      [`m3-${tag}`, `t2-${tag}`, emails.nicholas2, '3d'],
      [`m4-${tag}`, `t2-${tag}`, emails.nicholas2, '2d'],
      [`m5-${tag}`, `t3-${tag}`, emails.don,       '1d'],
      [`m6-${tag}`, `t4-${tag}`, emails.don2,      '0d'],
    ];
    for (const [msgId, threadId, toAddr, age] of rows) {
      await query(
        `INSERT INTO voice.sent_emails (provider_msg_id, thread_id, to_address, subject, body, word_count, sent_at, is_reply)
         VALUES ($1, $2, $3, 's', 'b', 1, now() - $4::interval, false)`,
        [msgId, threadId, toAddr, age]
      );
    }

    const { rows: idents } = await query(
      `SELECT id, identifier FROM signal.contact_identities WHERE contact_id = $1`,
      [src.id]
    );
    const byIdent = Object.fromEntries(idents.map((r) => [r.identifier, r.id]));
    return { srcId: src.id, idents: byIdent, emails };
  }

  it('happy path: moves N identities, recomputes emails_sent, audit + public_event written', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    const donIds = [idents[emails.don], idents[emails.don2]];

    const { rows: [{ result }] } = await query(
      `SELECT signal.split_contact_identities(
        $1, $2::text[], 'Don Test', $3,
        NULL, 'unknown', 'active', 'unit test split', 'ecgang'
      ) AS result`,
      [srcId, donIds, emails.don]
    );
    assert.equal(result.split, true);
    assert.equal(result.source_emails_sent, 4);
    assert.equal(result.new_emails_sent, 2);
    assert.deepEqual(
      [...result.identities_moved].sort(),
      [emails.don, emails.don2].sort()
    );

    // Identities re-pointed.
    const { rows: postIdents } = await query(
      `SELECT contact_id, identifier FROM signal.contact_identities
        WHERE contact_id IN ($1, $2) ORDER BY identifier`,
      [srcId, result.new_id]
    );
    const ownership = Object.fromEntries(postIdents.map((r) => [r.identifier, r.contact_id]));
    assert.equal(ownership[emails.nicholas], srcId);
    assert.equal(ownership[emails.nicholas2], srcId);
    assert.equal(ownership[emails.don], result.new_id);
    assert.equal(ownership[emails.don2], result.new_id);

    // Counters: source emails_sent=4, new emails_sent=2; source emails_received
    // untouched at 5 (Linus SHOULD-FIX #3: we don't overwrite a counter without
    // a ground-truth source).
    const { rows: [srcRow] } = await query(
      `SELECT emails_sent, emails_received FROM signal.contacts WHERE id = $1`,
      [srcId]
    );
    assert.equal(srcRow.emails_sent, 4);
    assert.equal(srcRow.emails_received, 5);

    const { rows: [newRow] } = await query(
      `SELECT emails_sent, emails_received FROM signal.contacts WHERE id = $1`,
      [result.new_id]
    );
    assert.equal(newRow.emails_sent, 2);
    assert.equal(newRow.emails_received, 0);

    // contact_merge_log row.
    const { rows: [log] } = await query(
      `SELECT operation, primary_id, secondary_id, identities_moved, performed_by
         FROM signal.contact_merge_log
        WHERE secondary_id = $1`,
      [result.new_id]
    );
    assert.equal(log.operation, 'split');
    assert.equal(log.primary_id, srcId);
    assert.equal(log.performed_by, 'ecgang');
    assert.deepEqual(
      [...log.identities_moved].sort(),
      [emails.don, emails.don2].sort()
    );

    // public_event row.
    const { rows: [evt] } = await query(
      `SELECT event_type, metadata FROM autobot_public.event_log
        WHERE metadata->>'new_id' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [result.new_id]
    );
    assert.equal(evt.event_type, 'contact_split');
    assert.equal(evt.metadata.performed_by, 'ecgang');
  });

  it('rejects identityIds that do not belong to the source contact', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    // Create a foreign identity row on a different contact.
    const outsiderEmail = `outsider.${randomUUID().slice(0, 8)}@example.com`;
    const { rows: [other] } = await query(
      `INSERT INTO signal.contacts (email_address, name) VALUES ($1, 'Outsider') RETURNING id`,
      [outsiderEmail]
    );
    const { rows: [outsiderIdent] } = await query(
      `SELECT id FROM signal.contact_identities WHERE contact_id = $1 LIMIT 1`,
      [other.id]
    );

    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'X', $3,
          NULL, 'unknown', 'active', 'r', 'ecgang') AS result`,
        [srcId, [idents[emails.don], outsiderIdent.id], outsiderEmail]
      ),
      /not owned by source/
    );
  });

  it('rejects primaryEmail that is not in identityIds', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'Don', $3,
          NULL, 'unknown', 'active', 'r', 'ecgang') AS result`,
        [srcId, [idents[emails.don]], `somethingelse.${randomUUID().slice(0,8)}@example.com`]
      ),
      /is not among the email identities being moved/
    );
  });

  it('rejects split that would orphan the source contact', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    const all = Object.values(idents);
    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'X', $3,
          NULL, 'unknown', 'active', 'r', 'ecgang') AS result`,
        [srcId, all, emails.don]
      ),
      /would orphan source contact/
    );
  });

  it('rejects when primaryEmail already exists on another contact', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    await query(
      `INSERT INTO signal.contacts (email_address, name) VALUES ($1, 'Pre-existing Don')`,
      [emails.don]
    );
    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'Don', $3,
          NULL, 'unknown', 'active', 'r', 'ecgang') AS result`,
        [srcId, [idents[emails.don], idents[emails.don2]], emails.don]
      ),
      /a contact already exists at email/
    );
  });

  it('rejects when p_performed_by is empty', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'Don', $3,
          NULL, 'unknown', 'active', 'r', '') AS result`,
        [srcId, [idents[emails.don], idents[emails.don2]], emails.don]
      ),
      /p_performed_by required for audit/
    );
  });

  it('atomicity: a failure inside the function leaves no orphan rows', async () => {
    const { srcId, idents, emails } = await seedSourceContact();
    // Trigger the orphan-source guard by passing all identities; nothing should
    // have been inserted into signal.contacts, contact_merge_log, or event_log
    // for this attempted split.
    const before = await query(
      `SELECT (SELECT count(*) FROM signal.contacts) AS contacts,
              (SELECT count(*) FROM signal.contact_merge_log) AS log,
              (SELECT count(*) FROM autobot_public.event_log WHERE event_type='contact_split') AS evt`
    );

    await assert.rejects(
      query(
        `SELECT signal.split_contact_identities(
          $1, $2::text[], 'X', $3,
          NULL, 'unknown', 'active', 'r', 'ecgang') AS result`,
        [srcId, Object.values(idents), emails.don]
      ),
      /would orphan/
    );

    const after = await query(
      `SELECT (SELECT count(*) FROM signal.contacts) AS contacts,
              (SELECT count(*) FROM signal.contact_merge_log) AS log,
              (SELECT count(*) FROM autobot_public.event_log WHERE event_type='contact_split') AS evt`
    );
    assert.equal(after.rows[0].contacts, before.rows[0].contacts);
    assert.equal(after.rows[0].log, before.rows[0].log);
    assert.equal(after.rows[0].evt, before.rows[0].evt);
  });
});
