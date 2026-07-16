/**
 * RED step (TDD) — lib/runtime/signal-task-promoter.js does not exist.
 *
 * Tests the promoter end-to-end against PGlite, exercising the contract
 * users will observe on the board:
 *
 *   - Promote-able signal types (action_item / commitment / request /
 *     decision) from a webhook-channel message produce an inbox.human_tasks
 *     row when relevance >= 0.6.
 *   - Mid-confidence (0.3..0.6) signals produce a 'proposed' row.
 *   - Low-confidence (<0.3) signals leave no human_tasks row and stamp
 *     relevance_skipped on the signal's metadata.
 *   - Non-meeting signals (channel='email') are not promoted at all.
 *   - Non-promotable signal types (info, deadline, question, etc.) are
 *     not promoted.
 *   - Promoter is idempotent (re-running on the same signal does not
 *     create a duplicate row).
 *   - Provenance is preserved: signal_id, message_id, source_quote, title
 *     all land on the human_tasks row.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { promoteSignal, extractObligor } from '../../lib/runtime/signal-task-promoter.js';

const KNOWN_BOARD = [
  { id: 'bm-eric', display_name: 'Eric Gang', aliases: ['Eric', 'Eric Gang', 'ecgang'] },
  { id: 'bm-isaias', display_name: 'Isaias Valle', aliases: ['Isaias', 'Isaias Valle'] },
  { id: 'bm-dustin', display_name: 'Dustin Powers', aliases: ['Dustin', 'Dustin Powers'] },
];
const PROJECTS = [{ id: 'proj-staqs', name: 'StaqsPro', domain: 'general' }];

// Test-isolated sentinel ids.
const ACC = 'acc-promoter-test';
const MSG_WEBHOOK = 'msg-promoter-webhook';
const MSG_EMAIL = 'msg-promoter-email';

describe('signal-task-promoter — extractObligor (helper)', () => {
  // The meeting-prompt enforces third-person format
  // '<Speaker> to <verb>' / '<Speaker> committed to <verb>' /
  // '<Speaker> asked <other> to <verb>'. The promoter needs to lift the
  // obligor cheaply for the relevance gate.
  it('extracts subject from "<Name> to <verb>" form', () => {
    assert.equal(extractObligor('Eric to deploy on Friday'), 'Eric');
    assert.equal(extractObligor('Eric Gang to deploy on Friday'), 'Eric Gang');
  });

  it('extracts subject from "<Name> committed to <verb>"', () => {
    assert.equal(extractObligor('Eric committed to sending the deck'), 'Eric');
  });

  it('extracts subject from "<Name> asked <other> to <verb>"', () => {
    assert.equal(extractObligor('Dustin asked Eric to look at the Jetson board'), 'Eric');
  });

  it('returns null when the content does not match a known form', () => {
    assert.equal(extractObligor('Nothing actionable here'), null);
    assert.equal(extractObligor(''), null);
    assert.equal(extractObligor(null), null);
  });

  it('handles Unicode names (José, Müller, O\'Brien)', () => {
    assert.equal(extractObligor('José to file the invoice'), 'José');
    assert.equal(extractObligor('Müller committed to reviewing the PR'), 'Müller');
    assert.equal(extractObligor("O'Brien to send the deck"), "O'Brien");
  });

  it('does not span newlines when picking the obligor', () => {
    // A signal whose content is malformed across lines should not stitch
    // tokens across the pivot ("To" verb).
    const multi = 'Eric drew the diagram\nSomeone to follow up later';
    // The first line has no "to" verb pivot → no obligor.
    assert.equal(extractObligor(multi), null);
  });
});

describe('signal-task-promoter — promote (auto / propose / skip)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // Set up an account + one webhook (meeting) message + one email message.
    // inbox.accounts CHECK disallows channel='webhook'; the message's
    // channel is what the promoter inspects. Account is incidental here.
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'isaias', 'tldv-webhook', 'tldv@webhook', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    // Webhook messages require channel_id (CHECK
    // messages_require_provider_id in 001-baseline.sql).
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'wh-promoter-w', 't-promoter-w',
               'mid-promoter-w', 'tldv@webhook', now(),
               ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG_WEBHOOK, ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, thread_id,
          message_id, from_address, received_at)
       VALUES ($1, $2, 'email', 'gmail', 'pm-promoter-e', 't-promoter-e',
               'mid-promoter-e', 'sender@example.com', now())
       ON CONFLICT DO NOTHING`,
      [MSG_EMAIL, ACC],
    );
  });

  beforeEach(async () => {
    // Clear human_tasks + signals created by this suite. Tests are not
    // ordered; each must seed its own signal row.
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-promoter-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-promoter-%'`);
  });

  async function insertSignal({
    id,
    messageId = MSG_WEBHOOK,
    type = 'action_item',
    content,
    confidence = 0.9,
    direction = 'outbound',
    domain = 'general',
  }) {
    await query(
      `INSERT INTO inbox.signals
         (id, message_id, signal_type, content, confidence, direction, domain)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, messageId, type, content, confidence, direction, domain],
    );
    return id;
  }

  // -------------------- Auto-promote --------------------

  it('action_item with known obligor + known speakers → status=inbox', async () => {
    const sigId = 'sig-promoter-1';
    await insertSignal({
      id: sigId,
      type: 'action_item',
      content: 'Eric to update the Jetson setup next sprint',
    });

    const result = await promoteSignal({
      query,
      signalId: sigId,
      knownPeople: KNOWN_BOARD,
      projects: PROJECTS,
      meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
    });

    assert.equal(result.decision, 'auto');
    assert.ok(result.task_id, 'a human_tasks row id is returned');

    const r = await query(
      `SELECT status, signal_id, message_id, title, source_quote,
              assignee_label, relevance_score
         FROM inbox.human_tasks WHERE id = $1`,
      [result.task_id],
    );
    const task = r.rows[0];
    assert.equal(task.status, 'inbox');
    assert.equal(task.signal_id, sigId);
    assert.equal(task.message_id, MSG_WEBHOOK);
    assert.ok(task.title && task.title.length > 0);
    assert.equal(task.source_quote, 'Eric to update the Jetson setup next sprint');
    assert.equal(task.assignee_label, 'Eric');
    assert.ok(task.relevance_score >= 0.6);
  });

  // -------------------- Propose --------------------

  it('signal with known speaker but unknown obligor → status=proposed', async () => {
    const sigId = 'sig-promoter-2';
    await insertSignal({
      id: sigId,
      type: 'action_item',
      // Known speaker (Eric is in the meeting metadata) but the action
      // falls to a stranger — relevance should land in the propose band.
      content: 'Random Vendor Rep to send the contract',
    });

    const result = await promoteSignal({
      query,
      signalId: sigId,
      knownPeople: KNOWN_BOARD,
      projects: PROJECTS,
      // Speakers passed explicitly to override metadata in this test.
      meta: { speakers: ['Eric Gang'] },
    });

    assert.equal(result.decision, 'propose');
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [result.task_id],
    );
    assert.equal(r.rows[0].status, 'proposed');
  });

  // -------------------- Skip --------------------

  it('signal with no known obligor/speaker → skip, no row, signal stamped', async () => {
    const sigId = 'sig-promoter-3';
    await insertSignal({
      id: sigId,
      type: 'action_item',
      content: 'Random Vendor Rep to send the contract',
    });

    const result = await promoteSignal({
      query,
      signalId: sigId,
      knownPeople: [], // empty: nobody known
      projects: [],
      meta: { speakers: ['Random Vendor Rep'] },
    });

    assert.equal(result.decision, 'skip');
    assert.equal(result.task_id, null);

    // No human_tasks row.
    const r = await query(
      `SELECT id FROM inbox.human_tasks WHERE signal_id = $1`,
      [sigId],
    );
    assert.equal(r.rows.length, 0);

    // Signal carries an audit trail.
    const s = await query(
      `SELECT metadata FROM inbox.signals WHERE id = $1`,
      [sigId],
    );
    const meta = typeof s.rows[0].metadata === 'string'
      ? JSON.parse(s.rows[0].metadata)
      : s.rows[0].metadata;
    assert.equal(meta.relevance_skipped, true);
    assert.ok(typeof meta.relevance_score === 'number');
    assert.ok(meta.relevance_score < 0.3);
  });

  // -------------------- Channel coverage (ADR-008 Stream A) --------------------

  it('email-channel signal IS promoted through the same relevance gate', async () => {
    // ADR-008 Stream A extends promotion from meeting-only to all channels.
    // An email obligation whose obligor is a known person scores via the gate
    // exactly like a meeting one and lands on the board.
    const sigId = 'sig-promoter-4';
    await insertSignal({
      id: sigId,
      messageId: MSG_EMAIL, // email channel
      type: 'action_item',
      content: 'Eric to deploy on Friday',
    });

    const result = await promoteSignal({
      query,
      signalId: sigId,
      knownPeople: KNOWN_BOARD,
      projects: PROJECTS,
    });

    // Known obligor ("Eric") => obligor match => auto-promote, regardless of channel.
    assert.equal(result.decision, 'auto');
    const r = await query(
      `SELECT id FROM inbox.human_tasks WHERE signal_id = $1`,
      [sigId],
    );
    assert.equal(r.rows.length, 1);
  });

  // -------------------- Signal-type filter --------------------

  it('info signal is never promoted', async () => {
    const sigId = 'sig-promoter-5';
    await insertSignal({
      id: sigId,
      type: 'info',
      content: 'Jetson board has 8GB RAM',
    });
    const result = await promoteSignal({
      query,
      signalId: sigId,
      knownPeople: KNOWN_BOARD,
      projects: PROJECTS,
    });
    assert.equal(result.decision, 'not_applicable');
    assert.equal(result.reason, 'unpromotable_type');
  });

  for (const t of ['deadline', 'question', 'approval_needed', 'introduction']) {
    it(`${t} signal is never promoted`, async () => {
      const sigId = `sig-promoter-typefilter-${t}`;
      await insertSignal({ id: sigId, type: t, content: 'x' });
      const r = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      });
      assert.equal(r.decision, 'not_applicable');
    });
  }

  for (const t of ['action_item', 'commitment', 'request', 'decision']) {
    it(`${t} signal IS promotable`, async () => {
      const sigId = `sig-promoter-promotable-${t}`;
      await insertSignal({
        id: sigId,
        type: t,
        content: 'Eric to look into this',
      });
      const r = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      });
      assert.notEqual(r.decision, 'not_applicable');
    });
  }

  // -------------------- Idempotence --------------------

  it('promoting the same signal twice produces only one row', async () => {
    const sigId = 'sig-promoter-idem';
    await insertSignal({
      id: sigId,
      type: 'action_item',
      content: 'Isaias to ship the migration',
    });

    const first = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
    });
    const second = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang', 'Isaias Valle'] },
    });

    assert.equal(first.task_id, second.task_id, 'second call returns the existing row');
    assert.equal(second.decision, 'already_promoted');

    const r = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks WHERE signal_id = $1`,
      [sigId],
    );
    assert.equal(r.rows[0].n, 1);
  });

  // -------------------- Title / size cap --------------------

  it('long signal content is truncated into a one-line title', async () => {
    const long =
      'Eric to write a really long and detailed report covering '
      + 'every aspect of the deployment, including the rollback plan, '
      + 'observability changes, and the open questions for legal. '
      + 'This sentence is intentionally long to exercise the cap.';
    const sigId = 'sig-promoter-long';
    await insertSignal({ id: sigId, type: 'action_item', content: long });

    const result = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang'] },
    });

    const r = await query(
      `SELECT title, source_quote FROM inbox.human_tasks WHERE id = $1`,
      [result.task_id],
    );
    assert.ok(r.rows[0].title.length <= 200, 'title capped');
    assert.equal(r.rows[0].source_quote, long, 'source_quote keeps the full verbatim');
  });

  // -------------------- task_type mapping --------------------

  it('signal_type maps to task_type (commitment/request → action, decision → decision_followup)', async () => {
    const cases = [
      ['action_item', 'action'],
      ['commitment', 'action'],
      ['request', 'request'],
      ['decision', 'decision_followup'],
    ];
    for (const [stype, expected] of cases) {
      const sigId = `sig-promoter-tt-${stype}`;
      await insertSignal({
        id: sigId,
        type: stype,
        content: 'Eric to follow up',
      });
      const result = await promoteSignal({
        query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
        meta: { speakers: ['Eric Gang'] },
      });
      const r = await query(
        `SELECT task_type FROM inbox.human_tasks WHERE id = $1`,
        [result.task_id],
      );
      assert.equal(r.rows[0].task_type, expected, `${stype} → ${expected}`);
    }
  });

  // -------------------- Decision lane status --------------------

  it('decision signal lands as status="done" (decisions are records, not work)', async () => {
    // PRD §3 "Decisions as tasks": decisions go to a done-from-creation
    // Decisions lane unless explicitly promoted.
    const sigId = 'sig-promoter-decision-done';
    await insertSignal({
      id: sigId,
      type: 'decision',
      content: 'Eric to record the decision: we are going with option B',
    });
    const result = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang'] },
    });

    const r = await query(
      `SELECT status, task_type FROM inbox.human_tasks WHERE id = $1`,
      [result.task_id],
    );
    assert.equal(r.rows[0].status, 'done');
    assert.equal(r.rows[0].task_type, 'decision_followup');
  });

  it('decision signal in propose band ALSO lands done (PRD §3 invariant)', async () => {
    const sigId = 'sig-promoter-decision-propose';
    await insertSignal({
      id: sigId,
      type: 'decision',
      // Known speaker, unknown obligor → propose band normally; but decisions
      // override status regardless of gate column.
      content: 'Random Vendor Rep to confirm the contract terms',
    });
    const r = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang'] },
    });
    const row = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [r.task_id],
    );
    assert.equal(row.rows[0].status, 'done');
  });

  it('speakers containing null/undefined entries do not crash', async () => {
    const sigId = 'sig-promoter-bad-speakers';
    await insertSignal({
      id: sigId,
      type: 'action_item',
      content: 'Eric to clean up',
    });
    // Defensive: bad meta should not throw.
    const r = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: [null, undefined, 'Eric Gang', ''] },
    });
    assert.notEqual(r.decision, undefined);
  });

  it('empty content stays out of the auto lane (no obligor → at most propose)', async () => {
    const sigId = 'sig-promoter-empty';
    // Edge: extractor may yield empty content. Promoter must not crash and
    // must not auto-promote an empty card.
    await insertSignal({
      id: sigId,
      type: 'action_item',
      content: ' ',
    });
    const r = await promoteSignal({
      query, signalId: sigId, knownPeople: KNOWN_BOARD, projects: PROJECTS,
      meta: { speakers: ['Eric Gang'] },
    });
    // No known obligor → never auto-promote. Other lanes are fine.
    assert.notEqual(r.decision, 'auto');
    if (r.task_id) {
      const row = await query(
        `SELECT title FROM inbox.human_tasks WHERE id = $1`,
        [r.task_id],
      );
      assert.equal(typeof row.rows[0].title, 'string');
    }
  });
});
