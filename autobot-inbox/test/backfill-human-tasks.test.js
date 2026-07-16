/**
 * RED step (TDD) — scripts/backfill-human-tasks.js does not exist.
 *
 * Tests the backfill behavior as a library: scripts/backfill-human-tasks.js
 * delegates to a callable `backfillHumanTasks({query, knownPeople,
 * projects, dryRun, since})` from lib/runtime/. Tests exercise the
 * library; the script is a thin CLI wrapper.
 *
 * Contract:
 *   - Iterates promotable signals on webhook messages.
 *   - dryRun=true never writes (no human_tasks, no signal metadata stamps).
 *   - dryRun=false writes idempotently — re-running yields zero new rows.
 *   - Returns a summary {scanned, promoted_auto, promoted_proposed,
 *     skipped, already_promoted, not_applicable}.
 *   - `since` filter accepts a Date / ISO string and only considers signals
 *     created at-or-after it.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { backfillHumanTasks } from '../../lib/runtime/backfill-human-tasks.js';
import { parseArgs } from '../scripts/backfill-human-tasks.js';

const KNOWN = [
  { id: 'bm-eric', display_name: 'Eric Gang', aliases: ['Eric', 'Eric Gang'] },
  { id: 'bm-isaias', display_name: 'Isaias Valle', aliases: ['Isaias', 'Isaias Valle'] },
];
const PROJECTS = [{ id: 'proj-staqs', name: 'StaqsPro', domain: 'general' }];

const ACC = 'acc-backfill-test';
const MSG = 'msg-backfill-w';

describe('backfillHumanTasks', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // sync_status='setup' so this fixture account is never picked up by the
    // Gmail poller (pollAllAccounts excludes sync_status='setup'). Defense in
    // depth against a stray test row leaking into a real poll.
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider, sync_status)
       VALUES ($1, 'isaias', 'bf', 'bf@webhook', 'email', 'gmail', 'setup')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', 'ch-bf', 't-bf',
               'mid-bf', 'bf@webhook', now(),
               ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG, ACC],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-bf-%' OR signal_id LIKE 'sig-bf-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-bf-%'`);
  });

  after(async () => {
    // Tear down the fixture rows so the acc-backfill-test account (and its
    // message/signals) never survive a run and leak into a real Gmail poll.
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-bf-%' OR signal_id LIKE 'sig-bf-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-bf-%'`);
    await query(`DELETE FROM inbox.messages WHERE id = $1`, [MSG]);
    await query(`DELETE FROM inbox.accounts WHERE id = $1`, [ACC]);
  });

  async function insertPromotable(id, content = 'Eric to ship the migration') {
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ($1, $2, 'action_item', $3, 0.9, 'outbound', 'general')`,
      [id, MSG, content],
    );
  }

  it('promotes promotable signals when dryRun=false', async () => {
    await insertPromotable('sig-bf-1', 'Eric to ship the migration');
    await insertPromotable('sig-bf-2', 'Isaias to draft the migration');

    const summary = await backfillHumanTasks({
      query,
      knownPeople: KNOWN,
      projects: PROJECTS,
      dryRun: false,
      meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
    });

    assert.equal(summary.scanned, 2);
    assert.ok(summary.promoted_auto + summary.promoted_proposed >= 2);

    const r = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks WHERE signal_id LIKE 'sig-bf-%'`,
    );
    assert.equal(r.rows[0].n, 2);
  });

  it('dryRun=true never writes', async () => {
    await insertPromotable('sig-bf-dry-1');

    const summary = await backfillHumanTasks({
      query,
      knownPeople: KNOWN,
      projects: PROJECTS,
      dryRun: true,
      meta: { speakers: ['Eric Gang'] },
    });

    assert.equal(summary.scanned, 1);
    assert.equal(summary.dryRun, true);

    // No human_tasks rows...
    const rh = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks WHERE signal_id = 'sig-bf-dry-1'`,
    );
    assert.equal(rh.rows[0].n, 0);

    // ...and no relevance_skipped stamp on the signal either.
    const rs = await query(
      `SELECT metadata FROM inbox.signals WHERE id = 'sig-bf-dry-1'`,
    );
    const meta = typeof rs.rows[0].metadata === 'string'
      ? JSON.parse(rs.rows[0].metadata)
      : rs.rows[0].metadata;
    assert.notEqual(meta?.relevance_skipped, true);
  });

  it('dryRun=true still buckets signals (preview counts are real)', async () => {
    await insertPromotable('sig-bf-dry-bucket-1', 'Eric to ship the migration');
    await insertPromotable('sig-bf-dry-bucket-2', 'Random Vendor Rep to send the contract');

    const summary = await backfillHumanTasks({
      query, knownPeople: KNOWN, projects: PROJECTS, dryRun: true,
      meta: { speakers: ['Eric Gang'] },
    });

    assert.equal(summary.scanned, 2);
    // First signal: known obligor → auto (or propose with current weights)
    // Second signal: unknown obligor + known speaker → propose/skip
    assert.ok(
      summary.promoted_auto + summary.promoted_proposed + summary.skipped === 2,
      'dryRun must classify every scanned signal into auto/propose/skip — counts: '
        + JSON.stringify(summary),
    );
  });

  it('is idempotent: re-running adds zero rows', async () => {
    await insertPromotable('sig-bf-idem-1');

    const first = await backfillHumanTasks({
      query, knownPeople: KNOWN, projects: PROJECTS, dryRun: false,
      meta: { speakers: ['Eric Gang'] },
    });
    const second = await backfillHumanTasks({
      query, knownPeople: KNOWN, projects: PROJECTS, dryRun: false,
      meta: { speakers: ['Eric Gang'] },
    });

    assert.equal(second.already_promoted, first.promoted_auto + first.promoted_proposed);

    const r = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks WHERE signal_id = 'sig-bf-idem-1'`,
    );
    assert.equal(r.rows[0].n, 1);
  });

  it('does not scan unpromotable signal types (info/deadline/question/etc.)', async () => {
    // Backfill's SQL filter already restricts to action_item|commitment|
    // request|decision. info/deadline/etc. are silently excluded from
    // scanning — they were never going to produce tasks, so spending a
    // round-trip per row to mark them not_applicable is wasted work.
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ('sig-bf-info', $1, 'info', 'Eric mentioned the RAM size',
               0.6, 'outbound', 'general')`,
      [MSG],
    );

    const summary = await backfillHumanTasks({
      query, knownPeople: KNOWN, projects: PROJECTS, dryRun: false,
    });
    assert.equal(summary.scanned, 0, 'info signal must NOT be scanned');
    const r = await query(
      `SELECT id FROM inbox.human_tasks WHERE signal_id = 'sig-bf-info'`,
    );
    assert.equal(r.rows.length, 0, 'info signal must NOT produce a task');
  });

  it('`since` filter excludes older signals', async () => {
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain, created_at)
       VALUES ('sig-bf-old', $1, 'action_item', 'Eric to do thing',
               0.9, 'outbound', 'general', now() - interval '60 days')`,
      [MSG],
    );

    const summary = await backfillHumanTasks({
      query, knownPeople: KNOWN, projects: PROJECTS, dryRun: false,
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    // Should not scan the old signal at all.
    const ids = (
      await query(
        `SELECT id FROM inbox.human_tasks WHERE signal_id = 'sig-bf-old'`,
      )
    ).rows;
    assert.equal(ids.length, 0);
    assert.equal(summary.scanned, 0);
  });

  describe('parseArgs (CLI)', () => {
    it('no args → {dryRun: false, since: null}', () => {
      assert.deepEqual(parseArgs([]), { dryRun: false, since: null });
    });

    it('--dry-run flips dryRun', () => {
      assert.equal(parseArgs(['--dry-run']).dryRun, true);
    });

    it('--since 30d resolves to ~30 days ago', () => {
      const now = Date.now();
      const out = parseArgs(['--since', '30d']);
      const diffDays = (now - out.since.getTime()) / (24 * 60 * 60 * 1000);
      assert.ok(diffDays > 29.9 && diffDays < 30.1, `expected ~30, got ${diffDays}`);
    });

    it('--since <iso> parses absolute dates', () => {
      const out = parseArgs(['--since', '2026-01-15']);
      assert.equal(out.since.toISOString().slice(0, 10), '2026-01-15');
    });

    it('-s short flag works', () => {
      assert.ok(parseArgs(['-s', '7d']).since instanceof Date);
    });

    it('missing value after --since is ignored, not crashed', () => {
      assert.equal(parseArgs(['--since']).since, null);
    });

    it('combines flags', () => {
      const out = parseArgs(['--dry-run', '--since', '1d']);
      assert.equal(out.dryRun, true);
      assert.ok(out.since instanceof Date);
    });
  });

  it('counts cleanly when meta.speakers is unknown (skip path)', async () => {
    await insertPromotable('sig-bf-skip-1', 'Random Vendor Rep to send a thing');

    const summary = await backfillHumanTasks({
      query, knownPeople: [], projects: [], dryRun: false,
    });

    assert.equal(summary.skipped, 1);
    const s = await query(
      `SELECT metadata FROM inbox.signals WHERE id = 'sig-bf-skip-1'`,
    );
    const meta = typeof s.rows[0].metadata === 'string'
      ? JSON.parse(s.rows[0].metadata)
      : s.rows[0].metadata;
    assert.equal(meta.relevance_skipped, true);
  });
});
