/**
 * RED — lib/runtime/meeting-promotion-summary.js does not exist.
 *
 * PRD §11.2: "/meetings page gets two new affordances:
 *   - X actions promoted to board
 *   - Y actions filtered out (expand)."
 *
 * Pure helper takes a message_id + DB query fn and returns counts +
 * the filtered signals' details (so the UI can expand the list).
 *
 *   getMeetingPromotionSummary({ query, messageId }) =>
 *     {
 *       promoted: { count, task_ids: [...] },
 *       filtered: { count, signals: [{id, content, relevance_score}] },
 *       not_applicable: { count }   // signals whose type was never promotable
 *     }
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { getMeetingPromotionSummary } from '../../lib/runtime/meeting-promotion-summary.js';

const ACC = 'acc-mtg-summary';
const MSG = 'msg-mtg-summary';

describe('getMeetingPromotionSummary', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'isaias', 'mtg', 'mtg@webhook', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'ch-mtg', 't-mtg',
               'mid-mtg', 'mtg@webhook', now(),
               ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG, ACC],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-mtg-%' OR signal_id LIKE 'sig-mtg-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-mtg-%'`);
  });

  it('counts promoted, filtered, and not_applicable separately', async () => {
    // Promoted signal → has a human_tasks row.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ('sig-mtg-promoted', $1, 'action_item', 'Eric to ship',
               0.9, 'outbound', 'general')`,
      [MSG],
    );
    await query(
      `INSERT INTO inbox.human_tasks (id, signal_id, message_id, title, status)
       VALUES ('htm-mtg-promoted', 'sig-mtg-promoted', $1, 'Eric to ship', 'inbox')`,
      [MSG],
    );

    // Filtered signal → relevance_skipped=true on metadata.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain, metadata)
       VALUES ('sig-mtg-filtered', $1, 'action_item', 'Random Vendor Rep to send a quote',
               0.7, 'outbound', 'general',
               jsonb_build_object('relevance_skipped', true, 'relevance_score', 0.2))`,
      [MSG],
    );

    // Not applicable: an `info` signal that was never promotable.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ('sig-mtg-info', $1, 'info', 'Jetson board has 8GB RAM',
               0.5, 'outbound', 'general')`,
      [MSG],
    );

    const summary = await getMeetingPromotionSummary({ query, messageId: MSG });

    assert.equal(summary.promoted.count, 1);
    assert.deepEqual(summary.promoted.task_ids, ['htm-mtg-promoted']);

    assert.equal(summary.filtered.count, 1);
    assert.equal(summary.filtered.signals[0].id, 'sig-mtg-filtered');
    assert.match(
      summary.filtered.signals[0].content,
      /random vendor rep/i,
    );
    assert.ok(typeof summary.filtered.signals[0].relevance_score === 'number');

    assert.equal(summary.not_applicable.count, 1);
  });

  it('returns zeroes when the message has no signals', async () => {
    const summary = await getMeetingPromotionSummary({
      query,
      messageId: 'msg-no-such-thing',
    });
    assert.equal(summary.promoted.count, 0);
    assert.equal(summary.filtered.count, 0);
    assert.equal(summary.not_applicable.count, 0);
    assert.deepEqual(summary.promoted.task_ids, []);
    assert.deepEqual(summary.filtered.signals, []);
  });

  it('a signal that has neither a task NOR a relevance_skipped stamp counts as not_applicable', async () => {
    // Edge: action_item signal but the promoter has not yet run on it.
    // The summary surfaces it as not_applicable rather than dropping it
    // (so the count is conservative + the UX is honest).
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ('sig-mtg-pending', $1, 'action_item', 'Pending', 0.9,
               'outbound', 'general')`,
      [MSG],
    );
    const summary = await getMeetingPromotionSummary({ query, messageId: MSG });
    assert.equal(summary.not_applicable.count >= 1, true);
  });
});
