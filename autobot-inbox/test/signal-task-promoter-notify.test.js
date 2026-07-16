/**
 * RED step (TDD) — promoter does not yet emit pg_notify after insert.
 *
 * Contract (PRD §6, AD-1, FR-1):
 *
 *   After a successful auto-promote OR propose insert, promoteSignal MUST
 *   emit pg_notify on the enrichment-pending channel with task_id as the
 *   payload so the enrichment worker (Task 3) picks the row up without
 *   waiting for a poll cycle.
 *
 * Channel name: `human_task_enrichment_pending` (underscored — the PRD's
 * dotted form `human_task.enrichment_pending` doesn't survive Postgres
 * LISTEN parsing without double-quoting, and PGlite's listen() helper
 * doesn't quote. Underscores match existing convention (`autobot_events`,
 * `hitl_resolved`).
 *
 *   - decision='auto'         → notify
 *   - decision='propose'      → notify
 *   - decision='skip'         → NO notify (no row to enrich)
 *   - decision='not_applicable' → NO notify
 *   - decision='already_promoted' → NO notify (the original notify already
 *     fired; idempotent re-call does not duplicate)
 *
 * Test mechanics: subscribe to the channel via the PGlite handle's
 * native LISTEN. The fallback path (via _getPgLiteForTest) lives in
 * graph-sync-concurrency.test.js; we reuse the same subscription idiom.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { promoteSignal } from '../../lib/runtime/signal-task-promoter.js';
import { _getPgLiteForTest } from '../../lib/db.js';

const ACC = 'acc-promoter-notify-test';
const MSG_WEBHOOK = 'msg-promoter-notify-w';
const MSG_EMAIL = 'msg-promoter-notify-e';

const KNOWN_BOARD = [
  { id: 'bm-eric', display_name: 'Eric Gang', aliases: ['Eric', 'Eric Gang'] },
  { id: 'bm-isaias', display_name: 'Isaias Valle', aliases: ['Isaias'] },
];
const PROJECTS = [{ id: 'proj-staqs', name: 'StaqsPro', domain: 'general' }];
const CHANNEL = 'human_task_enrichment_pending';

/**
 * Subscribe to the enrichment-pending channel. Returns
 *   { received: string[], unsubscribe: () => Promise<void> }
 * Drains into `received` in order. If the PGlite handle is unavailable
 * (e.g. real Postgres in CI), skips by returning a no-op subscription
 * — the SELECT-based fallback would require a side-channel table the
 * promoter doesn't write to, so we keep the harness simple and rely
 * on PGlite for these tests (FORCE_PGLITE=true is the default).
 */
async function subscribe() {
  const handle = await _getPgLiteForTest();
  if (!handle || typeof handle.listen !== 'function') {
    throw new Error(
      'pg_notify capture requires PGlite handle with listen(); ' +
      'run with FORCE_PGLITE=true (default in setup-db.js).',
    );
  }
  const received = [];
  const unsubscribe = await handle.listen(CHANNEL, (payload) => {
    received.push(payload);
  });
  return {
    received,
    unsubscribe: async () => {
      if (typeof unsubscribe === 'function') await unsubscribe();
    },
  };
}

// Yield to the event loop so PGlite has time to deliver notifications.
async function tick(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('signal-task-promoter — pg_notify on successful promotion', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'isaias', 'tldv-webhook', 'tldv@webhook', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'wh-promnotify-w', 't-promnotify-w',
               'mid-promnotify-w', 'tldv@webhook', now(), ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG_WEBHOOK, ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-promnotify-e', 't-promnotify-e',
               'mid-promnotify-e', 'sender@example.com', now())
       ON CONFLICT DO NOTHING`,
      [MSG_EMAIL, ACC],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-promnotify-%' OR signal_id LIKE 'sig-promnotify-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-promnotify-%'`);
  });

  async function insertSignal({ id, type = 'action_item', content, messageId = MSG_WEBHOOK }) {
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ($1, $2, $3, $4, 0.9, 'outbound', 'general')`,
      [id, messageId, type, content],
    );
    return id;
  }

  it('emits pg_notify with task_id when decision=auto', async () => {
    const sub = await subscribe();
    try {
      const sigId = 'sig-promnotify-auto';
      await insertSignal({ id: sigId, content: 'Eric to ship the migration' });

      const result = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
        meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
      });
      assert.equal(result.decision, 'auto');
      assert.ok(result.task_id);

      await tick();
      assert.equal(sub.received.length, 1, 'one notify emitted');
      assert.equal(sub.received[0], result.task_id,
        'notify payload is the new task_id');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('emits pg_notify with task_id when decision=propose', async () => {
    const sub = await subscribe();
    try {
      const sigId = 'sig-promnotify-propose';
      // Known speaker, unknown obligor → propose band.
      await insertSignal({ id: sigId, content: 'Random Vendor Rep to send the contract' });

      const result = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
        meta: { speakers: ['Eric Gang'] },
      });
      assert.equal(result.decision, 'propose');
      assert.ok(result.task_id);

      await tick();
      assert.equal(sub.received.length, 1);
      assert.equal(sub.received[0], result.task_id);
    } finally {
      await sub.unsubscribe();
    }
  });

  it('does NOT emit pg_notify when decision=skip', async () => {
    const sub = await subscribe();
    try {
      const sigId = 'sig-promnotify-skip';
      await insertSignal({ id: sigId, content: 'Random Vendor Rep to send the contract' });

      const result = await promoteSignal({
        query, signalId: sigId, knownPeople: [], projects: [],
        meta: { speakers: ['Random Vendor Rep'] },
      });
      assert.equal(result.decision, 'skip');
      assert.equal(result.task_id, null);

      await tick(80);
      assert.equal(sub.received.length, 0, 'no notify for skip path');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('does NOT emit pg_notify when decision=not_applicable (unpromotable type)', async () => {
    // ADR-008 Stream A removed the meeting-only channel filter, so an email
    // obligation is now promotable. not_applicable now comes from an
    // unpromotable signal_type (e.g. 'info') — that path must still be silent.
    const sub = await subscribe();
    try {
      const sigId = 'sig-promnotify-info';
      await insertSignal({
        id: sigId, type: 'info', content: 'Jetson board has 8GB RAM', messageId: MSG_EMAIL,
      });

      const result = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      });
      assert.equal(result.decision, 'not_applicable');
      assert.equal(result.reason, 'unpromotable_type');

      await tick(80);
      assert.equal(sub.received.length, 0, 'no notify for non_applicable path');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('does NOT emit pg_notify on a second already_promoted call (idempotent)', async () => {
    const sub = await subscribe();
    try {
      const sigId = 'sig-promnotify-idem';
      await insertSignal({ id: sigId, content: 'Isaias to ship the migration' });

      const first = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
        meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
      });
      assert.equal(first.decision, 'auto');

      await tick();
      assert.equal(sub.received.length, 1, 'first call emitted one notify');

      // Clear the receipt buffer to make the second call's silence obvious.
      sub.received.length = 0;

      const second = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
        meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
      });
      assert.equal(second.decision, 'already_promoted');
      assert.equal(second.task_id, first.task_id);

      await tick(80);
      assert.equal(sub.received.length, 0,
        'already_promoted does not re-emit notify');
    } finally {
      await sub.unsubscribe();
    }
  });
});
