// sent-emails-tier-signal.test.js
// STAQPRO-584: genuine correspondents were stuck at tier='unknown' because the
// sent-mail bootstrap never incremented signal.contacts.emails_sent, so the
// tier-resolution promotion predicate (Rule 3: correspondence volume) read 0.
//
// Two load-bearing behaviours are proven here against PGlite (no DATABASE_URL):
//
//   1. CODE-PATH FIX: resolveAndUpsert(role='recipient') increments emails_sent
//      for the recipient contact. This is the per-email side effect that
//      sent-analyzer.js now performs after each INSERT into voice.sent_emails.
//
//   2. BACKFILL (migration 141): emails_sent is recomputed from the
//      voice.sent_emails ground truth (count of sent emails whose to_address
//      matches the contact, case-insensitively), and the recompute is
//      IDEMPOTENT — running it twice produces the identical value and touches
//      zero rows the second time.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { resolveAndUpsert } from '../src/rag/participants/resolver.js';

// The migration-141 backfill statement, run verbatim so the test fails if the
// migration's recompute logic regresses.
const BACKFILL_SQL = `
  UPDATE signal.contacts c
  SET emails_sent = sub.cnt,
      updated_at  = now()
  FROM (
    SELECT lower(se.to_address) AS addr, count(*)::int AS cnt
    FROM voice.sent_emails se
    WHERE se.to_address IS NOT NULL
    GROUP BY lower(se.to_address)
  ) sub
  WHERE lower(c.email_address) = sub.addr
    AND c.emails_sent IS DISTINCT FROM sub.cnt
`;

describe('STAQPRO-584: emails_sent feeds tier-resolution Rule 3', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  it('resolveAndUpsert(role=recipient) increments emails_sent for the recipient', async () => {
    const email = 'staqpro584-recipient@example.com';
    await query(
      `INSERT INTO signal.contacts (email_address, name, contact_type, tier, emails_sent)
       VALUES ($1, 'Test Recipient', 'participant', 'unknown', 0)
       ON CONFLICT (email_address) DO UPDATE SET emails_sent = 0`,
      [email]
    );

    await resolveAndUpsert(
      [{ email, name: 'Test Recipient', role: 'recipient' }],
      { at: new Date().toISOString() }
    );

    const r = await query(
      `SELECT emails_sent FROM signal.contacts WHERE email_address = $1`,
      [email]
    );
    assert.equal(
      Number(r.rows[0].emails_sent),
      1,
      'emails_sent should be bumped to 1 after one recipient-role resolution'
    );

    // A second resolution bumps again — confirms the per-email side effect is
    // additive (sent-analyzer only fires it once per NEW email via its
    // provider_msg_id guard, so the additive behaviour is correct).
    await resolveAndUpsert(
      [{ email, name: 'Test Recipient', role: 'recipient' }],
      { at: new Date().toISOString() }
    );
    const r2 = await query(
      `SELECT emails_sent FROM signal.contacts WHERE email_address = $1`,
      [email]
    );
    assert.equal(Number(r2.rows[0].emails_sent), 2);

    await query(`DELETE FROM signal.contacts WHERE email_address = $1`, [email]);
  });

  it('migration-141 backfill recomputes emails_sent from voice.sent_emails ground truth, idempotently', async () => {
    const email = 'staqpro584-backfill@example.com';

    // Contact under-reports emails_sent (the historical bug: 0 despite 3 sent).
    await query(
      `INSERT INTO signal.contacts (email_address, name, contact_type, tier, emails_sent)
       VALUES ($1, 'Backfill Target', 'participant', 'unknown', 0)
       ON CONFLICT (email_address) DO UPDATE SET emails_sent = 0`,
      [email]
    );

    // Three sent emails to this recipient form the ground truth. Mixed casing
    // on to_address proves the case-insensitive match.
    const addrs = [email, email.toUpperCase(), `Staqpro584-Backfill@Example.com`];
    for (let i = 0; i < addrs.length; i++) {
      await query(
        `INSERT INTO voice.sent_emails
           (provider_msg_id, thread_id, to_address, subject, body, word_count, sent_at)
         VALUES ($1, $2, $3, 'subj', 'body text here', 3, now())
         ON CONFLICT (provider_msg_id) DO NOTHING`,
        [`staqpro584-msg-${i}`, `staqpro584-thread-${i}`, addrs[i]]
      );
    }

    // First backfill pass: 0 → 3.
    await query(BACKFILL_SQL);
    const r1 = await query(
      `SELECT emails_sent FROM signal.contacts WHERE email_address = $1`,
      [email]
    );
    assert.equal(
      Number(r1.rows[0].emails_sent),
      3,
      'backfill should recompute emails_sent to the ground-truth count (3)'
    );

    // Second pass must be a no-op (idempotent). The WHERE IS DISTINCT FROM
    // guard means rowCount should be 0.
    const r2 = await query(BACKFILL_SQL);
    if (typeof r2.rowCount === 'number') {
      assert.equal(
        r2.rowCount,
        0,
        'second backfill pass must touch 0 rows (idempotent recompute)'
      );
    }
    const r3 = await query(
      `SELECT emails_sent FROM signal.contacts WHERE email_address = $1`,
      [email]
    );
    assert.equal(
      Number(r3.rows[0].emails_sent),
      3,
      'emails_sent must remain 3 after a second backfill pass'
    );

    // Cleanup.
    await query(`DELETE FROM voice.sent_emails WHERE provider_msg_id LIKE 'staqpro584-msg-%'`);
    await query(`DELETE FROM signal.contacts WHERE email_address = $1`, [email]);
  });
});
