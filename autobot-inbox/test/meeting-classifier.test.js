/**
 * Meeting → work classifier (STAQPRO-612).
 *
 * Deterministic + offline: the classify/extract/ticket/org-match deps are
 * injected fakes — no real LLM, no Linear, no network. Runs on PGlite
 * (FORCE_PGLITE=true is the setup-db.js default).
 *
 * Acceptance covered (spec/features/003-meeting-to-work.md §Acceptance):
 *   - informational transcript → 0 tasks/tickets, KB doc untouched
 *   - action-bearing (decision + action + follow-up) → tasks, each stamped
 *     with source_meeting_id
 *   - classifier-vs-detector overlap → exactly 1 task per action (dedup_key)
 *   - edited-transcript re-run supersedes prior tasks (no dupes)
 *   - provenance fields present on all derived records
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { handleMeetingReceived } from '../../lib/runtime/meeting-classifier.js';
import { computeDedupKey } from '../../lib/runtime/meeting-identity.js';

const MEETING_ID = 'cal:meeting-612-test';

// --- Fake dep builders -----------------------------------------------------

function depsFor({ category, entities = [], orgId = null }) {
  return {
    classify: async () => ({ category, confidence: 0.95, rationale: 'fake' }),
    extract: async () => ({ entities }),
    matchEngagement: async () => orgId,
    // NOTE: there is intentionally no createTicket dep — the classifier never
    // creates Linear issues inline (echo-loop guard). The Linear mirror, when
    // enabled, stamps push_status='pending' for the push worker.
  };
}

async function seedDoc(query, { id, sourceId, rawText, title = 'Test Meeting' }) {
  await query(
    `INSERT INTO content.documents (id, source, source_id, title, raw_text, format)
     VALUES ($1, 'tldv', $2, $3, $4, 'tldv')
     ON CONFLICT (id) DO UPDATE SET raw_text = EXCLUDED.raw_text`,
    [id, sourceId, title, rawText],
  );
}

function makeSignal(documentId, overrides = {}) {
  return {
    signal_type: 'meeting.received',
    payload: {
      document_id: documentId,
      source_meeting_id: MEETING_ID,
      transcript_source: 'tldv',
      title: 'Test Meeting',
      origin: 'meeting',
      ...overrides,
    },
  };
}

async function liveTasksForMeeting(query, meetingId) {
  const { rows } = await query(
    `SELECT id, title, task_type, signal_meeting_id, origin, dedup_key, deleted_at
       FROM inbox.human_tasks
      WHERE signal_meeting_id = $1 AND deleted_at IS NULL
      ORDER BY created_at`,
    [meetingId],
  );
  return rows;
}

describe('meeting-classifier', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE signal_meeting_id = $1`, [MEETING_ID]);
    await query(`DELETE FROM content.documents WHERE source = 'tldv' AND source_id LIKE 'mc-612-%'`);
  });

  it('informational transcript → 0 tasks/tickets, KB doc untouched', async () => {
    const docId = '11111111-1111-1111-1111-111111111111';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-info', rawText: 'We discussed the weather. No actions.' });

    const result = await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({ category: 'informational' }),
      mirrorToLinear: true,
    });

    assert.equal(result.status, 'informational');
    assert.equal(result.tasks.length, 0);

    const tasks = await liveTasksForMeeting(query, MEETING_ID);
    assert.equal(tasks.length, 0, 'zero human_tasks for informational meeting');

    // KB doc still present (classifier never touches it).
    const { rows: docs } = await query(`SELECT id FROM content.documents WHERE id = $1`, [docId]);
    assert.equal(docs.length, 1, 'transcript doc remains in KB');
  });

  it('action-bearing → tasks created, each stamped with source_meeting_id', async () => {
    const docId = '22222222-2222-2222-2222-222222222222';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-action', rawText: 'Decisions and actions discussed.' });

    const entities = [
      { type: 'decision', value: 'Adopt the new pricing tier' },
      { type: 'action_item', value: 'Send the proposal to Acme' },
      { type: 'follow_up', value: 'Check in with legal next week' },
    ];

    const result = await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({ category: 'action-bearing', entities }),
      // no targetRepo → board-task-only, no Linear
    });

    assert.equal(result.status, 'action-bearing');
    const created = result.tasks.filter((t) => t.created);
    assert.equal(created.length, 3, 'one task per extracted action');

    const tasks = await liveTasksForMeeting(query, MEETING_ID);
    assert.equal(tasks.length, 3);
    for (const t of tasks) {
      assert.equal(t.signal_meeting_id, MEETING_ID, 'every task stamped with source_meeting_id');
      assert.equal(t.origin, 'meeting');
      assert.ok(t.dedup_key, 'dedup_key present');
    }
    // task_type mapping: decision → decision_followup, action/follow_up → action.
    const byType = tasks.map((t) => t.task_type).sort();
    assert.deepEqual(byType, ['action', 'action', 'decision_followup']);
  });

  it('classifier-vs-detector overlap → exactly 1 task for the same action', async () => {
    const docId = '33333333-3333-3333-3333-333333333333';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-overlap', rawText: 'Action discussed.' });

    const actionText = 'Send the proposal to Acme';
    const dedupKey = computeDedupKey(MEETING_ID, actionText);

    // Simulate the ambient signal-detector already created a card with the SAME
    // dedup_key (different wording/casing collapses to the same normalized key).
    await query(
      `INSERT INTO inbox.human_tasks (title, status, signal_meeting_id, origin, dedup_key, created_by)
       VALUES ($1, 'inbox', $2, 'meeting', $3, 'signal_detector')`,
      ['pre-existing card', MEETING_ID, dedupKey],
    );

    const result = await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({ category: 'action-bearing', entities: [{ type: 'action_item', value: actionText }] }),
    });

    // Classifier insert is a no-op (ON CONFLICT) — reports created:false.
    const created = result.tasks.filter((t) => t.created);
    assert.equal(created.length, 0, 'classifier did not double-create');

    const tasks = await liveTasksForMeeting(query, MEETING_ID);
    assert.equal(tasks.length, 1, 'exactly one live card for the action');
    assert.equal(tasks[0].dedup_key, dedupKey);
  });

  it('edited-transcript re-run supersedes prior tasks (no dupes)', async () => {
    const docId = '44444444-4444-4444-4444-444444444444';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-edit', rawText: 'v1 transcript.' });

    // First run → 2 tasks.
    await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({
        category: 'action-bearing',
        entities: [
          { type: 'action_item', value: 'Original action one' },
          { type: 'action_item', value: 'Original action two' },
        ],
      }),
    });
    assert.equal((await liveTasksForMeeting(query, MEETING_ID)).length, 2);

    // Edited transcript re-run with a DIFFERENT action set.
    const result = await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({
        category: 'action-bearing',
        entities: [{ type: 'action_item', value: 'Revised single action' }],
      }),
    });

    assert.ok(result.superseded >= 2, 'prior open cards superseded');
    const live = await liveTasksForMeeting(query, MEETING_ID);
    assert.equal(live.length, 1, 'only the revised action remains live — no duplicates');
    assert.equal(live[0].title, 'Revised single action');

    // Superseded cards are soft-deleted, not gone.
    const { rows: all } = await query(
      `SELECT count(*)::int AS n FROM inbox.human_tasks
        WHERE signal_meeting_id = $1 AND deleted_at IS NOT NULL`,
      [MEETING_ID],
    );
    assert.equal(all[0].n, 2, 'prior cards retained as soft-deleted history');
  });

  it('Linear mirror OFF by default → cards are NOT queued for push', async () => {
    const docId = '55555555-5555-5555-5555-555555555555';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-nomirror', rawText: 'Action.' });

    await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({ category: 'action-bearing', entities: [{ type: 'action_item', value: 'Ship the thing' }] }),
      // no mirrorToLinear → board-task-only
    });

    const { rows } = await query(
      `SELECT push_status FROM inbox.human_tasks
        WHERE signal_meeting_id = $1 AND deleted_at IS NULL`,
      [MEETING_ID],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].push_status, null, 'no inline Linear; push_status stays NULL by default');
  });

  it('Linear mirror ON → action cards are queued via push_status=pending (no inline create)', async () => {
    const docId = '66666666-6666-6666-6666-666666666666';
    await seedDoc(query, { id: docId, sourceId: 'mc-612-mirror', rawText: 'Action.' });

    const result = await handleMeetingReceived(makeSignal(docId), {
      query,
      deps: depsFor({
        category: 'action-bearing',
        entities: [
          { type: 'action_item', value: 'Ship the thing' },
          { type: 'follow_up', value: 'Ping legal later' },
        ],
      }),
      mirrorToLinear: true,
    });

    // Only the true action mirrors; the follow-up stays board-only.
    assert.equal(result.queued_for_linear, 1);

    const { rows } = await query(
      `SELECT title, push_status FROM inbox.human_tasks
        WHERE signal_meeting_id = $1 AND deleted_at IS NULL
        ORDER BY title`,
      [MEETING_ID],
    );
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.push_status]));
    assert.equal(byTitle['Ship the thing'], 'pending', 'action queued for push worker');
    assert.equal(byTitle['Ping legal later'], null, 'follow-up not mirrored');
  });

  it('skips when provenance is missing', async () => {
    const result = await handleMeetingReceived(
      { signal_type: 'meeting.received', payload: { document_id: null } },
      { query, deps: depsFor({ category: 'action-bearing' }) },
    );
    assert.equal(result.status, 'skipped');
  });
});
