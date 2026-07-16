import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-548: the unlinked_message detector in agent_graph.reconcile_schemas()
 * flagged EVERY inbox.message with work_item_id IS NULL in the last 24h. Most of
 * those are by-design Tier-3 'signal-only' rows (webhook awareness path) that
 * intentionally never get a work_item — they were polluting the
 * [runtime/infrastructure] alert.
 *
 * The fix adds `AND NOT ('signal-only' = ANY(m.labels))` to both unlinked_message
 * detection queries. These tests pin:
 *   1. A signal-only unlinked message is NOT reported as unlinked_message.
 *   2. A true (non-signal-only) unlinked message IS still reported.
 *   3. A linked message is never reported regardless of labels.
 *   4. Migration 139 marks true orphans triage_category='orphaned' but leaves
 *      signal-only rows untouched, and the CHECK constraint permits 'orphaned'.
 */
describe('unlinked_message excludes signal-only rows (STAQPRO-548)', () => {
  let queryFn;
  const RUN = `548-${Date.now()}`;
  const idFor = (k) => `msg-${RUN}-${k}`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-unlinked-548', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();
  });

  // Insert a webhook signal-only message (channel='webhook' needs channel_id,
  // and webhook is exempt from the account requirement).
  async function insertSignalOnly(id) {
    await queryFn(
      `INSERT INTO inbox.messages
         (id, channel, channel_id, thread_id, message_id, from_address,
          received_at, labels, work_item_id)
       VALUES ($1, 'webhook', $1, $1, $1, 'webhook@staqs.io',
               now() - interval '1 hour', ARRAY['signal-only','webhook:linear']::text[], NULL)
       ON CONFLICT (id) DO UPDATE SET labels = EXCLUDED.labels, work_item_id = NULL`,
      [id],
    );
  }

  // Insert a true orphan: an email message with no work_item and no signal-only
  // label (provider_msg_id required for channel='email').
  async function insertTrueOrphan(id) {
    await queryFn(
      `INSERT INTO inbox.messages
         (id, channel, provider, provider_msg_id, thread_id, message_id,
          from_address, received_at, labels, work_item_id)
       VALUES ($1, 'email', 'gmail', $1, $1, $1, 'someone@example.com',
               now() - interval '1 hour', ARRAY['INBOX']::text[], NULL)
       ON CONFLICT (id) DO UPDATE SET labels = EXCLUDED.labels, work_item_id = NULL`,
      [id],
    );
  }

  async function unlinkedIds() {
    const r = await queryFn(
      `SELECT record_id FROM agent_graph.reconcile_schemas()
        WHERE issue_type = 'unlinked_message'`,
    );
    return new Set(r.rows.map((row) => row.record_id));
  }

  it('does NOT report a signal-only unlinked message', async () => {
    const sigId = idFor('signal-only');
    await insertSignalOnly(sigId);
    const reported = await unlinkedIds();
    assert.ok(
      !reported.has(sigId),
      `signal-only message ${sigId} should be excluded from unlinked_message`,
    );
  });

  it('DOES report a true (non-signal-only) unlinked message', async () => {
    const orphanId = idFor('true-orphan');
    await insertTrueOrphan(orphanId);
    const reported = await unlinkedIds();
    assert.ok(
      reported.has(orphanId),
      `true orphan ${orphanId} should still be reported as unlinked_message`,
    );
  });

  it('never reports a linked message regardless of labels', async () => {
    const linkedId = idFor('linked');
    await queryFn(
      `INSERT INTO inbox.messages
         (id, channel, channel_id, thread_id, message_id, from_address,
          received_at, labels, work_item_id)
       VALUES ($1, 'webhook', $1, $1, $1, 'webhook@staqs.io',
               now() - interval '1 hour', ARRAY['INBOX']::text[], 'wi-linked-548')
       ON CONFLICT (id) DO UPDATE SET work_item_id = 'wi-linked-548'`,
      [linkedId],
    );
    const reported = await unlinkedIds();
    assert.ok(!reported.has(linkedId), 'linked message must never be reported');
  });

  it('migration 139: CHECK permits orphaned; true orphans marked, signal-only untouched', async () => {
    const sigId = idFor('mig-signal');
    const orphanId = idFor('mig-orphan');
    await insertSignalOnly(sigId);
    await insertTrueOrphan(orphanId);

    // Re-run migration 139's backfill UPDATE (idempotent — guarded by the
    // IS DISTINCT FROM 'orphaned' predicate). The CHECK constraint widening
    // from migration 139 was already applied by initializeDatabase(), so this
    // write must succeed.
    await queryFn(
      `UPDATE inbox.messages m
          SET triage_category = 'orphaned'
        WHERE m.work_item_id IS NULL
          AND NOT ('signal-only'::TEXT = ANY(m.labels))
          AND m.triage_category IS DISTINCT FROM 'orphaned'`,
    );

    const orphan = await queryFn(
      `SELECT triage_category FROM inbox.messages WHERE id = $1`,
      [orphanId],
    );
    assert.equal(
      orphan.rows[0].triage_category,
      'orphaned',
      'true orphan should be marked orphaned',
    );

    const sig = await queryFn(
      `SELECT triage_category FROM inbox.messages WHERE id = $1`,
      [sigId],
    );
    assert.notEqual(
      sig.rows[0].triage_category,
      'orphaned',
      'signal-only row must NOT be marked orphaned',
    );
  });
});
