/**
 * RED step (TDD) — src/api-routes/human-tasks.js does not yet exist.
 *
 * Verifies the API contract a board member's browser will hit:
 *
 *   GET  /api/human-tasks                       — list current tasks
 *   GET  /api/human-tasks?status=inbox          — filter by status
 *   GET  /api/human-tasks?assignee=:id          — filter by assignee
 *   POST /api/human-tasks/:id/action            — Done / Skip / Later / Not-for-me
 *   POST /api/human-tasks/:id/inline-answer     — answer the inline question
 *
 * All routes require the board JWT (role='board') and write feedback to
 * inbox.human_tasks.feedback_history (append-only).
 *
 * The handlers are pure functions of (req, body) → result; tests build
 * mockReq() objects and inspect the returned shape + the database.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  listHumanTasks,
  actHumanTask,
  inlineAnswerHumanTask,
  lifecycleHumanTask,
  patchHumanTaskFields,
  forcePushHumanTask,
  getHumanTask,
  forceEnrichHumanTask,
  forceResyncHumanTask,
} from '../src/api-routes/human-tasks.js';
import { getStickyFields } from '../../lib/runtime/human-task-sticky.js';
import { _getPgLiteForTest } from '../../lib/db.js';

const BOARD = {
  role: 'board',
  sub: 'isaias',
  github_username: 'cboone',
  scope: ['*'],
};

function boardReq(url, extra = {}) {
  return { url, headers: {}, auth: BOARD, ...extra };
}

function publicReq(url) {
  return { url, headers: {} }; // no auth
}

// STAQPRO-608: listHumanTasks now takes an explicit tenancy principal (the
// production route resolves it via withViewer; null → visibleClause FALSE →
// zero rows, fail-closed). These unit tests exercise the board/admin surface,
// so they pass an adminBypass principal (visibleClause → TRUE) — the same
// org-wide visibility a verified board/agent caller gets. The error-path tests
// (invalid status/size, publicReq) throw before the query and don't need it.
const ADMIN_PRINCIPAL = { userId: null, readOrgIds: [], roles: {}, adminBypass: true };

const HT = (k) => `htm-api-${k}`;

describe('GET /api/human-tasks', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-%'`);

    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, assignee_contact_id, relevance_score)
       VALUES
         ($1, 'Inbox task', 'inbox',   'normal', 'ct-eric', 0.7),
         ($2, 'Proposed',   'proposed','normal', NULL,      0.4),
         ($3, 'Todo',       'todo',    'high',   'ct-isaias', 0.8),
         ($4, 'Skipped',    'skipped', 'normal', 'ct-eric', 0.7),
         ($5, 'Done',       'done',    'normal', 'ct-eric', 0.7)`,
      [HT('inbox'), HT('proposed'), HT('todo'), HT('skipped'), HT('done')],
    );
  });

  it('returns active tasks (excludes terminal: skipped, not_for_us, done)', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id);
    assert.ok(ids.includes(HT('inbox')));
    assert.ok(ids.includes(HT('proposed')));
    assert.ok(ids.includes(HT('todo')));
    assert.equal(ids.includes(HT('skipped')), false);
    assert.equal(ids.includes(HT('done')), false);
  });

  it('?status=skipped includes terminal rows on demand', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks?status=skipped'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id);
    assert.ok(ids.includes(HT('skipped')));
    assert.equal(ids.includes(HT('inbox')), false);
  });

  it('?assignee=:id filters', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks?assignee=ct-isaias'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id);
    assert.ok(ids.includes(HT('todo')));
    assert.equal(ids.includes(HT('inbox')), false);
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => listHumanTasks(publicReq('/api/human-tasks')),
      /board|forbidden|401|403/i,
    );
  });
});

describe('POST /api/human-tasks/:id/action', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-act-%'`);
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
       VALUES ($1, 'Action target', 'inbox', 'normal')`,
      ['htm-api-act-1'],
    );
  });

  // Each action verb maps to a status transition + a feedback_history entry.
  const cases = [
    ['done',       'done',       'done'],
    ['skip',       'skipped',    'skip'],
    ['not_for_me', 'not_for_us', 'not_for_me'],
  ];

  for (const [verb, expectedStatus, expectedFeedback] of cases) {
    it(`verb=${verb} → status=${expectedStatus}`, async () => {
      const id = 'htm-api-act-1';
      const res = await actHumanTask(
        boardReq(`/api/human-tasks/${id}/action`),
        { verb, reason: 'because' },
      );
      assert.equal(res.ok, true);
      assert.equal(res.status, expectedStatus);

      const r = await query(
        `SELECT status, last_feedback, feedback_history
           FROM inbox.human_tasks WHERE id = $1`,
        [id],
      );
      assert.equal(r.rows[0].status, expectedStatus);
      assert.equal(r.rows[0].last_feedback, expectedFeedback);

      const hist = typeof r.rows[0].feedback_history === 'string'
        ? JSON.parse(r.rows[0].feedback_history)
        : r.rows[0].feedback_history;
      assert.equal(Array.isArray(hist), true);
      assert.equal(hist.length, 1);
      assert.equal(hist[0].verb, verb);
      assert.equal(hist[0].reason, 'because');
      assert.equal(hist[0].by, BOARD.github_username);
      assert.ok(hist[0].at, 'feedback entry timestamp');
    });
  }

  it('verb=later snoozes the card', async () => {
    const id = 'htm-api-act-1';
    const res = await actHumanTask(
      boardReq(`/api/human-tasks/${id}/action`),
      { verb: 'later', until: '2026-06-01' },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 'later');

    const r = await query(
      `SELECT status, snoozed_until FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'later');
    assert.ok(r.rows[0].snoozed_until, 'snoozed_until must be set');
  });

  it('verb=later defaults snooze to ~7 days when until is omitted', async () => {
    const id = 'htm-api-act-1';
    const res = await actHumanTask(
      boardReq(`/api/human-tasks/${id}/action`),
      { verb: 'later' },
    );
    assert.equal(res.status, 'later');
    const r = await query(
      `SELECT snoozed_until FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const dayDiff =
      (new Date(r.rows[0].snoozed_until).getTime() - Date.now())
      / (24 * 60 * 60 * 1000);
    assert.ok(dayDiff > 6 && dayDiff < 8, `expected ~7d, got ${dayDiff}`);
  });

  it('unknown verb → 400', async () => {
    await assert.rejects(
      () =>
        actHumanTask(
          boardReq('/api/human-tasks/htm-api-act-1/action'),
          { verb: 'eat' },
        ),
      /verb|400|invalid/i,
    );
  });

  it('unknown id → 404', async () => {
    await assert.rejects(
      () =>
        actHumanTask(
          boardReq('/api/human-tasks/htm-api-not-here/action'),
          { verb: 'done' },
        ),
      /not.found|404/i,
    );
  });

  it('terminal-state row rejects further actions (409)', async () => {
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
       VALUES ('htm-api-act-terminal', 'done already', 'done', 'normal')`,
    );
    await assert.rejects(
      () =>
        actHumanTask(
          boardReq('/api/human-tasks/htm-api-act-terminal/action'),
          { verb: 'done' },
        ),
      /terminal|409|already/i,
    );
  });

  it('rejects unauthenticated callers', async () => {
    await assert.rejects(
      () =>
        actHumanTask(
          { url: '/api/human-tasks/htm-api-act-1/action', headers: {} },
          { verb: 'done' },
        ),
      /board|403/i,
    );
  });

  it('appends to feedback_history without overwriting prior entries', async () => {
    const id = 'htm-api-act-1';
    // Two consecutive snoozes — second appends, first survives.
    await actHumanTask(boardReq(`/api/human-tasks/${id}/action`), { verb: 'later' });
    // Action on a 'later' card should remain mutable (board can snooze
    // again or escalate).
    await actHumanTask(boardReq(`/api/human-tasks/${id}/action`), { verb: 'later', reason: 'still busy' });

    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = typeof r.rows[0].feedback_history === 'string'
      ? JSON.parse(r.rows[0].feedback_history)
      : r.rows[0].feedback_history;
    assert.equal(hist.length, 2);
  });
});

describe('POST /api/human-tasks/:id/inline-answer', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-inline-%'`);
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, assignee_contact_id, assignee_label, size)
       VALUES
         ($1, 'Who owns', 'inbox', 'normal', NULL, NULL, NULL)`,
      ['htm-api-inline-1'],
    );
  });

  it('answer "who owns this" sets assignee_contact_id + label', async () => {
    const res = await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'assignee', value: 'bm-eric', label: 'Eric Gang' },
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT assignee_contact_id, assignee_label, assignee_confidence
         FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(r.rows[0].assignee_contact_id, 'bm-eric');
    assert.equal(r.rows[0].assignee_label, 'Eric Gang');
    // Manual answers carry full confidence.
    assert.equal(Number(r.rows[0].assignee_confidence), 1);
  });

  it('answer "size" sets the size field', async () => {
    const res = await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'size', value: 'medium' },
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT size FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(r.rows[0].size, 'medium');
  });

  it('answer "is_this_ours"=no marks not_for_us terminal', async () => {
    const res = await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'is_this_ours', value: 'no' },
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(r.rows[0].status, 'not_for_us');
  });

  it('answer "is_this_ours"=yes promotes proposed → inbox', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'proposed' WHERE id = 'htm-api-inline-1'`,
    );
    const res = await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'is_this_ours', value: 'yes' },
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(r.rows[0].status, 'inbox');
  });

  it('unknown field → 400', async () => {
    await assert.rejects(
      () =>
        inlineAnswerHumanTask(
          boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
          { field: 'eyeColor', value: 'blue' },
        ),
      /field|400|invalid/i,
    );
  });

  it('bad size value → 400', async () => {
    await assert.rejects(
      () =>
        inlineAnswerHumanTask(
          boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
          { field: 'size', value: 'humongous' },
        ),
      /400|invalid|size/i,
    );
  });

  it('rejects unauthenticated callers', async () => {
    await assert.rejects(
      () =>
        inlineAnswerHumanTask(
          { url: '/api/human-tasks/htm-api-inline-1/inline-answer', headers: {} },
          { field: 'size', value: 'small' },
        ),
      /board|403/i,
    );
  });

  it('answer "when" sets due_date and appends feedback_history', async () => {
    const res = await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'when', value: '2026-06-15' },
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT due_date, feedback_history
         FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(
      new Date(r.rows[0].due_date).toISOString().slice(0, 10),
      '2026-06-15',
    );
    const hist = typeof r.rows[0].feedback_history === 'string'
      ? JSON.parse(r.rows[0].feedback_history) : r.rows[0].feedback_history;
    assert.equal(hist.length >= 1, true);
    assert.equal(hist[hist.length - 1].field, 'when');
  });

  it('answer "when" with bad date → 400', async () => {
    await assert.rejects(
      () =>
        inlineAnswerHumanTask(
          boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
          { field: 'when', value: 'never' },
        ),
      /400|invalid/i,
    );
  });

  it('answer "is_this_ours"=defer leaves status untouched', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'proposed' WHERE id = 'htm-api-inline-1'`,
    );
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'is_this_ours', value: 'defer' },
    );
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    assert.equal(r.rows[0].status, 'proposed', 'defer preserves status');
  });

  it('inline-answer appends to feedback_history (shape: field/value/by/at)', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
      { field: 'size', value: 'medium' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-inline-1'`,
    );
    const hist = typeof r.rows[0].feedback_history === 'string'
      ? JSON.parse(r.rows[0].feedback_history) : r.rows[0].feedback_history;
    assert.equal(Array.isArray(hist), true);
    const last = hist[hist.length - 1];
    assert.equal(last.field, 'size');
    assert.equal(last.value, 'medium');
    assert.equal(last.by, BOARD.github_username);
    assert.ok(last.at);
  });

  it('terminal-state row rejects inline-answer (409)', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'done' WHERE id = 'htm-api-inline-1'`,
    );
    await assert.rejects(
      () =>
        inlineAnswerHumanTask(
          boardReq('/api/human-tasks/htm-api-inline-1/inline-answer'),
          { field: 'size', value: 'small' },
        ),
      /terminal|409/i,
    );
  });
});

describe('GET /api/human-tasks — input validation', () => {
  before(async () => { await getDb(); });
  it('unknown ?status= → 400', async () => {
    await assert.rejects(
      () => listHumanTasks(boardReq('/api/human-tasks?status=garbage')),
      /status|400|unknown/i,
    );
  });
});

// ===========================================================================
// POST /api/human-tasks/:id/lifecycle — FR-27, FR-28, FR-29
//
// NOTE: The Linear push trigger from FR-27 ("Transitions ... trigger a push
// to Linear to mirror the corresponding state") is NOT asserted here —
// these are handler-only tests. Push enqueue is tested in Task 10
// (two-tier push trigger logic).
// ===========================================================================

function parseHistory(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function seedLifecycleTask(query, id, status, extra = {}) {
  const cols = ['id', 'title', 'status', 'priority'];
  const vals = [id, `Lifecycle ${status}`, status, 'normal'];
  for (const [k, v] of Object.entries(extra)) {
    cols.push(k);
    vals.push(v);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  await query(
    `INSERT INTO inbox.human_tasks (${cols.join(', ')}) VALUES (${placeholders})`,
    vals,
  );
}

describe('POST /api/human-tasks/:id/lifecycle', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-lc-%'`);
  });

  it('verb=start on inbox → status=todo and appends transition entry', async () => {
    const id = 'htm-api-lc-inbox-start';
    await seedLifecycleTask(query, id, 'inbox');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    assert.equal(res.ok, true);
    assert.equal(res.id, id);
    assert.equal(res.status, 'todo');
    assert.equal(res.last_feedback, 'transition');

    const r = await query(
      `SELECT status, last_feedback, feedback_history
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'todo');
    const hist = parseHistory(r.rows[0].feedback_history);
    assert.equal(Array.isArray(hist), true);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'transition');
    assert.equal(last.from_status, 'inbox');
    assert.equal(last.to_status, 'todo');
    assert.equal(last.by, BOARD.github_username);
    assert.ok(last.at, 'transition entry carries timestamp');
  });

  it('verb=start on todo → status=in_progress', async () => {
    const id = 'htm-api-lc-todo-start';
    await seedLifecycleTask(query, id, 'todo');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    assert.equal(res.status, 'in_progress');
  });

  it('verb=start on later → status=in_progress', async () => {
    const id = 'htm-api-lc-later-start';
    await seedLifecycleTask(query, id, 'later');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    assert.equal(res.status, 'in_progress');
  });

  it('verb=block on in_progress → status=blocked', async () => {
    const id = 'htm-api-lc-block';
    await seedLifecycleTask(query, id, 'in_progress');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'block' },
    );
    assert.equal(res.status, 'blocked');
  });

  it('verb=unblock on blocked → status=in_progress', async () => {
    const id = 'htm-api-lc-unblock';
    await seedLifecycleTask(query, id, 'blocked');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'unblock' },
    );
    assert.equal(res.status, 'in_progress');
  });

  it('verb=to_review on in_progress → status=review', async () => {
    const id = 'htm-api-lc-to-review';
    await seedLifecycleTask(query, id, 'in_progress');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_review' },
    );
    assert.equal(res.status, 'review');
  });

  it('verb=to_todo on blocked → status=todo', async () => {
    const id = 'htm-api-lc-to-todo';
    await seedLifecycleTask(query, id, 'blocked');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_todo' },
    );
    assert.equal(res.status, 'todo');
  });

  it('verb=to_todo on in_progress → status=todo', async () => {
    const id = 'htm-api-lc-ip-to-todo';
    await seedLifecycleTask(query, id, 'in_progress');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_todo' },
    );
    assert.equal(res.status, 'todo');
  });

  it('verb=to_in_progress on review → status=in_progress', async () => {
    const id = 'htm-api-lc-review-to-ip';
    await seedLifecycleTask(query, id, 'review');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_in_progress' },
    );
    assert.equal(res.status, 'in_progress');
  });

  it('verb=to_in_progress on inbox → status=in_progress', async () => {
    const id = 'htm-api-lc-inbox-to-ip';
    await seedLifecycleTask(query, id, 'inbox');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_in_progress' },
    );
    assert.equal(res.status, 'in_progress');
  });

  it('verb=to_inbox on todo → status=inbox', async () => {
    const id = 'htm-api-lc-todo-to-inbox';
    await seedLifecycleTask(query, id, 'todo');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_inbox' },
    );
    assert.equal(res.status, 'inbox');
  });

  it('verb=to_inbox on later → status=inbox', async () => {
    const id = 'htm-api-lc-later-to-inbox';
    await seedLifecycleTask(query, id, 'later');
    const res = await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'to_inbox' },
    );
    assert.equal(res.status, 'inbox');
  });

  it('verb=start on proposed → 409 (proposed must clear is_this_ours first)', async () => {
    // Per the canonical lifecycle transition table in
    // meeting-actions-to-kanban-v0.2-tech-spec.md (near FR-27):
    // `proposed` rows have NO valid verbs on this endpoint — they must
    // answer `is_this_ours` via /inline-answer first, which promotes them
    // to `inbox` (or terminates them as `not_for_us`). This preserves the
    // relevance gate as the entry checkpoint.
    const id = 'htm-api-lc-proposed-start';
    await seedLifecycleTask(query, id, 'proposed');
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'start' },
        ),
      (err) => err.statusCode === 409,
    );
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'proposed', 'status unchanged');
  });

  it('rejects invalid verb for current status with 409', async () => {
    const id = 'htm-api-lc-invalid-verb';
    await seedLifecycleTask(query, id, 'inbox');
    // 'block' is not valid from inbox — only valid from in_progress.
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'block' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects unknown verb with 400 or 409', async () => {
    const id = 'htm-api-lc-bad-verb';
    await seedLifecycleTask(query, id, 'todo');
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'teleport' },
        ),
      (err) => err.statusCode === 400 || err.statusCode === 409,
    );
  });

  for (const status of ['done', 'skipped', 'not_for_us']) {
    it(`rejects lifecycle on terminal=${status} row with 409`, async () => {
      const id = `htm-api-lc-terminal-${status.replace(/_/g, '-')}`;
      await seedLifecycleTask(query, id, status);
      await assert.rejects(
        () =>
          lifecycleHumanTask(
            boardReq(`/api/human-tasks/${id}/lifecycle`),
            { verb: 'start' },
          ),
        (err) => err.statusCode === 409,
      );
    });
  }

  it('returns 404 for unknown id', async () => {
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq('/api/human-tasks/htm-api-lc-missing/lifecycle'),
          { verb: 'start' },
        ),
      (err) => err.statusCode === 404,
    );
  });

  it('rejects unauthenticated callers (403)', async () => {
    const id = 'htm-api-lc-unauth';
    await seedLifecycleTask(query, id, 'inbox');
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          { url: `/api/human-tasks/${id}/lifecycle`, headers: {} },
          { verb: 'start' },
        ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });

  it('captures optional reason in feedback_history transition entry', async () => {
    const id = 'htm-api-lc-with-reason';
    await seedLifecycleTask(query, id, 'in_progress');
    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'block', reason: 'Waiting on vendor' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'transition');
    assert.equal(last.from_status, 'in_progress');
    assert.equal(last.to_status, 'blocked');
    assert.equal(last.reason, 'Waiting on vendor');
  });

  it('after lifecycle: last_feedback="transition" AND last_feedback_at advanced', async () => {
    const id = 'htm-api-lc-feedback-at';
    await seedLifecycleTask(query, id, 'inbox');
    // Snapshot last_feedback_at before the call (likely NULL on fresh insert).
    const before = await query(
      `SELECT last_feedback_at FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const beforeAt = before.rows[0].last_feedback_at;
    const beforeMs = beforeAt ? new Date(beforeAt).getTime() : 0;

    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );

    const after = await query(
      `SELECT last_feedback, last_feedback_at FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(after.rows[0].last_feedback, 'transition');
    assert.ok(after.rows[0].last_feedback_at, 'last_feedback_at must be set');
    const afterMs = new Date(after.rows[0].last_feedback_at).getTime();
    assert.ok(afterMs > beforeMs, 'last_feedback_at must advance');
  });

  it('lifecycle on row with feedback_history=null → array of length 1', async () => {
    const id = 'htm-api-lc-null-history';
    await seedLifecycleTask(query, id, 'inbox');
    // Force feedback_history to NULL (seedLifecycleTask leaves the column default).
    await query(
      `UPDATE inbox.human_tasks SET feedback_history = NULL WHERE id = $1`,
      [id],
    );
    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    assert.equal(Array.isArray(hist), true, 'feedback_history must be an array');
    assert.equal(hist.length, 1, 'first entry must be the transition');
    assert.equal(hist[0].verb, 'transition');
  });

  it('feedback_history is append-only: prior entries survive transitions', async () => {
    const id = 'htm-api-lc-append-only';
    await seedLifecycleTask(query, id, 'inbox');
    // Seed a prior entry to simulate previous activity.
    await query(
      `UPDATE inbox.human_tasks
         SET feedback_history = '[{"verb":"edited","field":"size","value":"small","by":"ct-eric","at":"2026-05-14T10:00:00Z"}]'::jsonb
       WHERE id = $1`,
      [id],
    );
    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    assert.equal(hist.length, 2, 'old entry survived');
    assert.equal(hist[0].verb, 'edited');
    assert.equal(hist[0].field, 'size');
    assert.equal(hist[1].verb, 'transition');
    assert.equal(hist[1].to_status, 'todo');
  });
});

// ===========================================================================
// inline-answer verb fix — Task 2 unblock
// FR-3, AD-5: edits must carry verb='edited' for getStickyFields()
// ===========================================================================

describe('POST /api/human-tasks/:id/inline-answer — verb="edited" sticky integration', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-sticky-%'`);
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority)
       VALUES ($1, 'Sticky test', 'inbox', 'normal')`,
      ['htm-api-sticky-1'],
    );
  });

  it('inline-answer for assignee writes verb="edited" into feedback_history', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'assignee', value: 'ct-eric', label: 'Eric' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'edited', 'assignee inline-answer must carry verb=edited');
    assert.equal(last.field, 'assignee');
    assert.equal(last.value, 'ct-eric');
    assert.equal(last.by, BOARD.github_username);
    assert.ok(last.at);
  });

  it('inline-answer for size writes verb="edited" into feedback_history', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'size', value: 'small' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'edited');
    assert.equal(last.field, 'size');
    assert.equal(last.value, 'small');
  });

  it('inline-answer for is_this_ours writes verb="edited"', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'is_this_ours', value: 'yes' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'edited');
    assert.equal(last.field, 'is_this_ours');
  });

  it('inline-answer for when writes verb="edited"', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'when', value: '2026-06-15' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'edited');
    assert.equal(last.field, 'when');
  });

  it('after inline-answer, getStickyFields returns the edited field (end-to-end)', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'size', value: 'medium' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const sticky = getStickyFields(hist);
    assert.ok(sticky.has('size'), 'size must be sticky after inline-answer');
  });

  it('multiple inline-answers accumulate as distinct sticky fields', async () => {
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'assignee', value: 'ct-isaias' },
    );
    await inlineAnswerHumanTask(
      boardReq('/api/human-tasks/htm-api-sticky-1/inline-answer'),
      { field: 'size', value: 'large' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-sticky-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const sticky = getStickyFields(hist);
    assert.ok(sticky.has('assignee'));
    assert.ok(sticky.has('size'));
  });
});

// ===========================================================================
// PATCH /api/human-tasks/:id/fields — FR-18 card-details panel edits
// ===========================================================================

const PATCH_ALLOWED_FIELDS = [
  'title',
  'description',
  'due_date',
  'priority',
  'size',
  'tags',
  'project_id',
  'engagement_id',
  'next_action_hint',
  'assignee_contact_id',
];

describe('PATCH /api/human-tasks/:id/fields', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-patch-%'`);
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
       VALUES ($1, 'Patch target', 'inbox', 'normal')`,
      ['htm-api-patch-1'],
    );
  });

  it('patches title and appends verb="edited" entry', async () => {
    const res = await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'title', value: 'Renamed task' },
    );
    assert.equal(res.ok, true);
    assert.equal(res.id, 'htm-api-patch-1');
    assert.equal(res.field, 'title');

    const r = await query(
      `SELECT title, feedback_history
         FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].title, 'Renamed task');
    const hist = parseHistory(r.rows[0].feedback_history);
    const last = hist[hist.length - 1];
    assert.equal(last.verb, 'edited');
    assert.equal(last.field, 'title');
    assert.equal(last.value, 'Renamed task');
    assert.equal(last.by, BOARD.github_username);
    assert.ok(last.at);
  });

  it('patches description', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'description', value: 'New description body' },
    );
    const r = await query(
      `SELECT description FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].description, 'New description body');
  });

  it('patches due_date with an ISO date', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'due_date', value: '2026-07-01' },
    );
    const r = await query(
      `SELECT due_date FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(
      new Date(r.rows[0].due_date).toISOString().slice(0, 10),
      '2026-07-01',
    );
  });

  it('patches priority to a valid value', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'priority', value: 'urgent' },
    );
    const r = await query(
      `SELECT priority FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].priority, 'urgent');
  });

  it('patches size to a valid value', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'size', value: 'large' },
    );
    const r = await query(
      `SELECT size FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].size, 'large');
  });

  it('patches tags array', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'tags', value: ['urgent', 'vendor'] },
    );
    const r = await query(
      `SELECT tags FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    // tags may be returned as Postgres array.
    const tags = Array.isArray(r.rows[0].tags) ? r.rows[0].tags : r.rows[0].tags;
    assert.deepEqual(tags, ['urgent', 'vendor']);
  });

  it('patches project_id', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'project_id', value: 'proj-staqs' },
    );
    const r = await query(
      `SELECT project_id FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].project_id, 'proj-staqs');
  });

  it('patches engagement_id with any string (no existence check at PATCH time)', async () => {
    // Policy: PATCH /fields accepts any string for engagement_id and treats
    // it as an operator-set trust value. The spec (FR-2) requires validation
    // against `engagements.engagements` ONLY at enrichment time, not at
    // PATCH time. Operator-driven edits bypass the active-engagements check
    // so the operator can override the LLM's pick with a known id even if
    // the row is mid-flight or temporarily archived. The enrichment worker
    // is the single source of truth for engagement existence validation.
    const uuid = '00000000-0000-0000-0000-0000000000aa';
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'engagement_id', value: uuid },
    );
    const r = await query(
      `SELECT engagement_id FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(String(r.rows[0].engagement_id), uuid);
  });

  it('patches next_action_hint', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'next_action_hint', value: 'Email vendor by Friday' },
    );
    const r = await query(
      `SELECT next_action_hint FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].next_action_hint, 'Email vendor by Friday');
  });

  it('patches assignee_contact_id', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'assignee_contact_id', value: 'ct-eric' },
    );
    const r = await query(
      `SELECT assignee_contact_id FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    assert.equal(r.rows[0].assignee_contact_id, 'ct-eric');
  });

  it('rejects non-allow-listed field (created_at) with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'created_at', value: '2026-01-01' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects status field via PATCH (lifecycle endpoint owns status) with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'status', value: 'done' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects linear_issue_id (system field) with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'linear_issue_id', value: 'LIN-123' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects relevance_score (system field) with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'relevance_score', value: 0.9 },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects invalid size value with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'size', value: 'humongous' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects invalid priority value with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'priority', value: 'ludicrous' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects invalid due_date with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'due_date', value: 'not-a-date' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects tags value that is not an array with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'tags', value: 'urgent,vendor' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects assignee_contact_id value that is not a string with 400', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'assignee_contact_id', value: 12345 },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects engagement_id value that is not a string with 400 (type-only check)', async () => {
    // Per policy: PATCH /fields only type-checks engagement_id — existence
    // validation against engagements.engagements is enrichment-time (FR-2).
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'engagement_id', value: { not: 'a string' } },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('rejects PATCH on terminal=done row with 409', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'done' WHERE id = 'htm-api-patch-1'`,
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'title', value: 'Too late' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects PATCH on terminal=skipped row with 409', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'skipped' WHERE id = 'htm-api-patch-1'`,
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'title', value: 'No' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects PATCH on terminal=not_for_us row with 409', async () => {
    await query(
      `UPDATE inbox.human_tasks SET status = 'not_for_us' WHERE id = 'htm-api-patch-1'`,
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'title', value: 'No' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('returns 404 for unknown id', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-missing/fields'),
          { field: 'title', value: 'Nope' },
        ),
      (err) => err.statusCode === 404,
    );
  });

  it('returns 404 for soft-deleted row', async () => {
    await query(
      `UPDATE inbox.human_tasks
          SET deleted_at = now()
        WHERE id = 'htm-api-patch-1'`,
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq('/api/human-tasks/htm-api-patch-1/fields'),
          { field: 'title', value: 'Resurrect' },
        ),
      (err) => err.statusCode === 404,
    );
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          { url: '/api/human-tasks/htm-api-patch-1/fields', headers: {} },
          { field: 'title', value: 'No auth' },
        ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });

  it('after PATCH, getStickyFields returns the patched field (end-to-end)', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'project_id', value: 'proj-staqs' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    const sticky = getStickyFields(hist);
    assert.ok(sticky.has('project_id'), 'project_id must be sticky after PATCH');
  });

  it('feedback_history is append-only across PATCH calls', async () => {
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'title', value: 'First rename' },
    );
    await patchHumanTaskFields(
      boardReq('/api/human-tasks/htm-api-patch-1/fields'),
      { field: 'size', value: 'medium' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = 'htm-api-patch-1'`,
    );
    const hist = parseHistory(r.rows[0].feedback_history);
    assert.equal(hist.length, 2);
    assert.equal(hist[0].field, 'title');
    assert.equal(hist[1].field, 'size');
    assert.equal(hist[0].verb, 'edited');
    assert.equal(hist[1].verb, 'edited');
  });

  it('every allow-listed field can be patched without error', async () => {
    // Sanity sweep — picks a benign legal value per field, confirms no field
    // is accidentally rejected by the allow-list.
    const benignValues = {
      title: 'x',
      description: 'x',
      due_date: '2026-12-01',
      priority: 'low',
      size: 'quick',
      tags: ['x'],
      project_id: 'proj-x',
      engagement_id: '00000000-0000-0000-0000-0000000000bb',
      next_action_hint: 'x',
      assignee_contact_id: 'ct-x',
    };
    for (const field of PATCH_ALLOWED_FIELDS) {
      const id = `htm-api-patch-sweep-${field.replace(/_/g, '-')}`;
      await query(
        `INSERT INTO inbox.human_tasks (id, title, status, priority)
           VALUES ($1, 'sweep', 'todo', 'normal')`,
        [id],
      );
      const res = await patchHumanTaskFields(
        boardReq(`/api/human-tasks/${id}/fields`),
        { field, value: benignValues[field] },
      );
      assert.equal(res.ok, true, `field=${field} must succeed`);
      assert.equal(res.field, field);
    }
  });
});

// ===========================================================================
// End-to-end use cases (PRD §4)
// ===========================================================================

describe('human-tasks API — end-to-end use cases', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-e2e-%'`);
  });

  it('operator clicks Start on an inbox card → status=todo + audit entry appended', async () => {
    const id = 'htm-api-e2e-start';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Inbox card', 'inbox', 'normal')`,
      [id],
    );
    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'start' },
    );
    const r = await query(
      `SELECT status, feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'todo');
    const hist = parseHistory(r.rows[0].feedback_history);
    assert.equal(hist[hist.length - 1].verb, 'transition');
  });

  it('operator patches project_id → sticky-fields integration skips project_id next enrichment', async () => {
    const id = 'htm-api-e2e-sticky-project';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Project edit', 'todo', 'normal')`,
      [id],
    );
    await patchHumanTaskFields(
      boardReq(`/api/human-tasks/${id}/fields`),
      { field: 'project_id', value: 'proj-staqs' },
    );
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const sticky = getStickyFields(parseHistory(r.rows[0].feedback_history));
    assert.ok(sticky.has('project_id'),
      'enrichment will skip project_id on next run');
  });

  it('operator tries to skip a done card via lifecycle → 409', async () => {
    const id = 'htm-api-e2e-done-skip';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Done card', 'done', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'to_todo' },
        ),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects a verb when status has changed since the verb was decided', async () => {
    const id = 'htm-api-e2e-race';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Racing', 'in_progress', 'normal')`,
      [id],
    );
    // Operator A blocks it.
    await lifecycleHumanTask(
      boardReq(`/api/human-tasks/${id}/lifecycle`),
      { verb: 'block' },
    );
    // Operator B tries 'to_review' — only valid from in_progress, not from
    // blocked. Must reject because status already moved.
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'to_review' },
        ),
      (err) => err.statusCode === 409,
    );
    // Confirm status is blocked.
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'blocked');
  });
});

// ===========================================================================
// Negative / restricted: things lifecycle and PATCH must NOT permit
// ===========================================================================

describe('human-tasks API — restricted operations', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-neg-%'`);
  });

  it('lifecycle cannot transition inbox → done directly (use action endpoint)', async () => {
    const id = 'htm-api-neg-inbox-done';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'inbox', 'normal')`,
      [id],
    );
    // Even if caller sent a verb that names 'done', the verb set is closed.
    await assert.rejects(
      () =>
        lifecycleHumanTask(
          boardReq(`/api/human-tasks/${id}/lifecycle`),
          { verb: 'done' },
        ),
      (err) => err.statusCode === 400 || err.statusCode === 409,
    );
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    // Status must not have changed.
    assert.equal(r.rows[0].status, 'inbox');
  });

  it('PATCH /fields cannot set status directly', async () => {
    const id = 'htm-api-neg-patch-status';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'inbox', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq(`/api/human-tasks/${id}/fields`),
          { field: 'status', value: 'in_progress' },
        ),
      (err) => err.statusCode === 400,
    );
    const r = await query(
      `SELECT status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].status, 'inbox');
  });

  it('PATCH /fields cannot set linear_issue_id', async () => {
    const id = 'htm-api-neg-linear-id';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'todo', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq(`/api/human-tasks/${id}/fields`),
          { field: 'linear_issue_id', value: 'LIN-9' },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('PATCH /fields cannot set relevance_score', async () => {
    const id = 'htm-api-neg-relevance';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'todo', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq(`/api/human-tasks/${id}/fields`),
          { field: 'relevance_score', value: 0.95 },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('PATCH /fields cannot set extraction_confidence', async () => {
    const id = 'htm-api-neg-extr';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'todo', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq(`/api/human-tasks/${id}/fields`),
          { field: 'extraction_confidence', value: 0.9 },
        ),
      (err) => err.statusCode === 400,
    );
  });

  it('PATCH /fields cannot set signal_id (provenance)', async () => {
    const id = 'htm-api-neg-signal';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 't', 'todo', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        patchHumanTaskFields(
          boardReq(`/api/human-tasks/${id}/fields`),
          { field: 'signal_id', value: 'sig-1' },
        ),
      (err) => err.statusCode === 400,
    );
  });
});

// ===========================================================================
// POST /api/human-tasks/:id/push — force-push to Linear
//
// Contract (tech-spec FR-6, FR-9, FR-10):
//   - Used by the operator to push a proposed-band row (relevance 0.6–0.8)
//     past the confirm-push gate (FR-6).
//   - Used by the operator to retry a row that went to push_status='failed'
//     (FR-10, after exhausted attempts).
//   - Used by the operator to re-push a row already 'succeeded' (force resync
//     of the Linear payload from the latest local state).
//
// Behaviour:
//   1. requireBoard(req).
//   2. SELECT current row → 404 if missing/deleted.
//   3. Reject 409 if push_status='running' (in-flight, never interrupt).
//   4. Reject 409 if status terminal (done/skipped/not_for_us).
//   5. UPDATE: push_status='pending', push_attempts=0,
//      push_skip_reason=NULL, push_last_error=NULL, updated_at=now().
//   6. SELECT pg_notify('human_task_push_pending', $id).
//   7. Return { ok: true, id, push_status: 'pending' }.
//
// pg_notify channel uses underscores, not dots — same constraint as the
// existing human_task_enrichment_pending channel (see Task 3 note in the
// tech-spec implementation notes).
// ===========================================================================

const PUSH_CHANNEL = 'human_task_push_pending';

/**
 * Subscribe to the push-pending channel via the PGlite handle. Same idiom
 * as signal-task-promoter-notify.test.js — relies on PGlite (FORCE_PGLITE
 * default in setup-db.js).
 */
async function subscribePush() {
  const handle = await _getPgLiteForTest();
  if (!handle || typeof handle.listen !== 'function') {
    throw new Error(
      'pg_notify capture requires PGlite handle with listen(); ' +
      'run with FORCE_PGLITE=true (default in setup-db.js).',
    );
  }
  const received = [];
  const unsubscribe = await handle.listen(PUSH_CHANNEL, (payload) => {
    received.push(payload);
  });
  return {
    received,
    unsubscribe: async () => {
      if (typeof unsubscribe === 'function') await unsubscribe();
    },
  };
}

async function tick(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('POST /api/human-tasks/:id/push (force-push)', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-api-push-%'`);
  });

  it('row with push_status=NULL → forcePush sets push_status=pending and returns ok', async () => {
    const id = 'htm-api-push-null';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Proposed-band row', 'inbox', 'normal')`,
      [id],
    );
    const res = await forcePushHumanTask(
      boardReq(`/api/human-tasks/${id}/push`),
    );
    assert.equal(res.ok, true);
    assert.equal(res.id, id);
    assert.equal(res.push_status, 'pending');

    const r = await query(
      `SELECT push_status, push_attempts, push_skip_reason, push_last_error
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending');
    assert.equal(Number(r.rows[0].push_attempts), 0);
    assert.equal(r.rows[0].push_skip_reason, null);
    assert.equal(r.rows[0].push_last_error, null);
  });

  it('row with push_status=failed and push_attempts=3 → resets attempts=0, clears last_error, sets pending', async () => {
    const id = 'htm-api-push-retry-failed';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_attempts, push_last_error)
       VALUES ($1, 'Failed row', 'inbox', 'normal', 'failed', 3, 'Linear 5xx')`,
      [id],
    );
    const res = await forcePushHumanTask(
      boardReq(`/api/human-tasks/${id}/push`),
    );
    assert.equal(res.ok, true);
    assert.equal(res.push_status, 'pending');

    const r = await query(
      `SELECT push_status, push_attempts, push_last_error
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending');
    assert.equal(Number(r.rows[0].push_attempts), 0, 'attempts reset to 0');
    assert.equal(r.rows[0].push_last_error, null, 'last_error cleared');
  });

  it('row with push_status=skipped and skip_reason set → clears skip_reason and resets to pending', async () => {
    const id = 'htm-api-push-skipped';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_skip_reason)
       VALUES ($1, 'Skipped by LLM', 'inbox', 'normal',
               'skipped', 'LLM said no relevant project')`,
      [id],
    );
    const res = await forcePushHumanTask(
      boardReq(`/api/human-tasks/${id}/push`),
    );
    assert.equal(res.ok, true);
    assert.equal(res.push_status, 'pending');

    const r = await query(
      `SELECT push_status, push_skip_reason
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending');
    assert.equal(r.rows[0].push_skip_reason, null, 'skip_reason cleared');
  });

  it('row with push_status=succeeded → forcePush allows re-push (clears succeeded → pending)', async () => {
    // Operator clicks "Force resync" on a row already in Linear. The push
    // worker rebuilds the payload from the current row state. This is the
    // intentional re-push path — succeeded is NOT a terminal push_status.
    const id = 'htm-api-push-resync';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_attempts)
       VALUES ($1, 'In Linear', 'in_progress', 'normal', 'succeeded', 1)`,
      [id],
    );
    const res = await forcePushHumanTask(
      boardReq(`/api/human-tasks/${id}/push`),
    );
    assert.equal(res.ok, true);
    assert.equal(res.push_status, 'pending');

    const r = await query(
      `SELECT push_status, push_attempts
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending');
    assert.equal(Number(r.rows[0].push_attempts), 0, 'attempts reset for re-push');
  });

  it('emits pg_notify on channel human_task_push_pending with task_id payload', async () => {
    const sub = await subscribePush();
    try {
      const id = 'htm-api-push-notify';
      await query(
        `INSERT INTO inbox.human_tasks (id, title, status, priority)
           VALUES ($1, 'Notify test', 'inbox', 'normal')`,
        [id],
      );
      await forcePushHumanTask(
        boardReq(`/api/human-tasks/${id}/push`),
      );

      await tick();
      assert.equal(sub.received.length, 1, 'one notify emitted');
      assert.equal(sub.received[0], id, 'notify payload is the task id');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('updates updated_at on every successful forcePush', async () => {
    const id = 'htm-api-push-updated-at';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'updated_at test', 'inbox', 'normal')`,
      [id],
    );
    const before = await query(
      `SELECT updated_at FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const beforeMs = new Date(before.rows[0].updated_at).getTime();

    await tick(10);
    await forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`));

    const after = await query(
      `SELECT updated_at FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const afterMs = new Date(after.rows[0].updated_at).getTime();
    assert.ok(afterMs >= beforeMs, 'updated_at advances');
  });

  // -- Restricted (negative) cases ------------------------------------------

  it('row with push_status=running → 409 (already in flight)', async () => {
    const id = 'htm-api-push-running';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_attempts)
       VALUES ($1, 'In flight', 'inbox', 'normal', 'running', 1)`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 409,
    );
    // Row state untouched.
    const r = await query(
      `SELECT push_status, push_attempts
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'running');
    assert.equal(Number(r.rows[0].push_attempts), 1, 'attempts not reset');
  });

  it('row with status=done → 409 (terminal status cannot be pushed)', async () => {
    const id = 'htm-api-push-done';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Already done', 'done', 'normal')`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 409,
    );
  });

  it('row with status=skipped (terminal status, not push_status) → 409', async () => {
    const id = 'htm-api-push-status-skipped';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Status skipped', 'skipped', 'normal')`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 409,
    );
  });

  it('row with status=not_for_us → 409', async () => {
    const id = 'htm-api-push-not-for-us';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Not ours', 'not_for_us', 'normal')`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 409,
    );
  });

  it('returns 404 for unknown id', async () => {
    await assert.rejects(
      () =>
        forcePushHumanTask(
          boardReq('/api/human-tasks/htm-api-push-missing/push'),
        ),
      (err) => err.statusCode === 404,
    );
  });

  it('returns 404 for soft-deleted row', async () => {
    const id = 'htm-api-push-deleted';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority, deleted_at)
         VALUES ($1, 'Deleted', 'inbox', 'normal', now())`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 404,
    );
  });

  it('rejects unauthenticated callers (401/403)', async () => {
    const id = 'htm-api-push-unauth';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'No auth', 'inbox', 'normal')`,
      [id],
    );
    await assert.rejects(
      () =>
        forcePushHumanTask(
          { url: `/api/human-tasks/${id}/push`, headers: {} },
        ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
    // Row state untouched.
    const r = await query(
      `SELECT push_status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, null);
  });

  // -- End-to-end use cases (PRD §4) ----------------------------------------

  it('use case 1: operator clicks "Push to Linear" on proposed-band card → row enters push queue', async () => {
    const id = 'htm-api-push-uc-confirm';
    // Proposed-band: relevance 0.6–0.8, awaiting operator confirmation.
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, relevance_score)
       VALUES ($1, 'Confirm-push tier', 'inbox', 'normal', 0.65)`,
      [id],
    );
    const res = await forcePushHumanTask(
      boardReq(`/api/human-tasks/${id}/push`),
    );
    assert.equal(res.push_status, 'pending');
    const r = await query(
      `SELECT push_status FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending', 'row entered push queue');
  });

  it('use case 2: operator clicks "Retry" on a failed row → attempts reset, queued', async () => {
    const id = 'htm-api-push-uc-retry';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_attempts, push_last_error)
       VALUES ($1, 'Retry me', 'inbox', 'normal',
               'failed', 3, 'network timeout')`,
      [id],
    );
    await forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`));
    const r = await query(
      `SELECT push_status, push_attempts, push_last_error
         FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows[0].push_status, 'pending');
    assert.equal(Number(r.rows[0].push_attempts), 0);
    assert.equal(r.rows[0].push_last_error, null);
  });

  it('use case 3: operator tries to re-push a row currently being pushed → 409', async () => {
    const id = 'htm-api-push-uc-race';
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, push_status, push_attempts)
       VALUES ($1, 'Mid-flight', 'inbox', 'normal', 'running', 1)`,
      [id],
    );
    await assert.rejects(
      () => forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`)),
      (err) => err.statusCode === 409,
    );
  });

  // -- Audit (P3 — transparency by structure) --------------------------------

  it('appends a force_push entry to feedback_history with verb and actor', async () => {
    const id = 'htm-api-push-audit-append';
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
         VALUES ($1, 'Audit append', 'inbox', 'normal')`,
      [id],
    );
    await forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`));
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = r.rows[0].feedback_history;
    assert.ok(Array.isArray(hist), 'feedback_history is an array');
    assert.equal(hist.length, 1, 'one entry appended');
    const entry = hist[0];
    assert.equal(entry.verb, 'force_push');
    assert.equal(entry.by, BOARD.github_username);
    assert.ok(typeof entry.at === 'string' && entry.at.length > 0, 'at timestamp present');
    assert.equal(entry.field, undefined, 'no field — operator retry, not edit');
    assert.equal(entry.value, undefined, 'no value — operator retry, not edit');
  });

  it('feedback_history is append-only — prior entries preserved across force-push', async () => {
    const id = 'htm-api-push-audit-preserve';
    const prior = [
      { verb: 'edited', field: 'title', value: 'Old title',
        by: 'someone-else', at: '2026-05-01T00:00:00.000Z' },
      { verb: 'transition', from_status: 'inbox', to_status: 'in_progress',
        reason: null, by: 'someone-else', at: '2026-05-02T00:00:00.000Z' },
    ];
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, feedback_history)
       VALUES ($1, 'Preserve audit', 'inbox', 'normal', $2::jsonb)`,
      [id, JSON.stringify(prior)],
    );
    await forcePushHumanTask(boardReq(`/api/human-tasks/${id}/push`));
    const r = await query(
      `SELECT feedback_history FROM inbox.human_tasks WHERE id = $1`,
      [id],
    );
    const hist = r.rows[0].feedback_history;
    assert.equal(hist.length, 3, 'two prior entries + one new');
    // Prior entries unchanged.
    assert.deepEqual(hist[0], prior[0], 'first prior entry intact');
    assert.deepEqual(hist[1], prior[1], 'second prior entry intact');
    // New entry appended at the end.
    assert.equal(hist[2].verb, 'force_push');
    assert.equal(hist[2].by, BOARD.github_username);
  });
});

// ===========================================================================
// v0.2 tech-spec §4.1 — extended list filters + single-row fetch + enrich + resync
// ===========================================================================

describe('GET /api/human-tasks — extended filters (v0.2 §4.1)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-v2-list-%'`);
    await query(`DELETE FROM inbox.signals WHERE id LIKE 'sig-v2-list-%'`);
    await query(`DELETE FROM inbox.messages WHERE id LIKE 'msg-v2-list-%'`);
    // Build the FK chain: messages → signals → human_tasks.
    // NOTE: migration 128 added a partial unique index
    // (human_tasks_signal_unique_live) that enforces at-most-one live
    // (non-deleted) human_task per signal_id. Each test row must therefore
    // reference a DISTINCT signal — sharing signal_id='sig-v2-list-1' across
    // two live rows (the original setup) violates the constraint with 23505.
    await query(
      `INSERT INTO inbox.messages
         (id, provider_msg_id, provider, thread_id, message_id,
          from_address, subject, received_at, channel)
       VALUES
         ('msg-v2-list-1', 'msg-v2-list-1', 'gmail', 't-v2-1', 'msg-v2-list-1',
          'a@b.co', 's1', now(), 'email'),
         ('msg-v2-list-2', 'msg-v2-list-2', 'gmail', 't-v2-2', 'msg-v2-list-2',
          'a@b.co', 's2', now(), 'email'),
         ('msg-v2-list-3', 'msg-v2-list-3', 'gmail', 't-v2-3', 'msg-v2-list-3',
          'a@b.co', 's3', now(), 'email')`,
    );
    await query(
      `INSERT INTO inbox.signals (id, message_id, signal_type, content, confidence)
       VALUES
         ('sig-v2-list-1', 'msg-v2-list-1', 'action_item', 'm1', 0.9),
         ('sig-v2-list-2', 'msg-v2-list-2', 'action_item', 'm2', 0.9),
         ('sig-v2-list-3', 'msg-v2-list-3', 'action_item', 'm3', 0.9)`,
    );

    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, size, project_id, push_status, signal_id)
       VALUES
         ($1, 'Quick proj-a',  'inbox',  'normal', 'quick',  'proj-a', 'pending', 'sig-v2-list-1'),
         ($2, 'Small proj-a',  'inbox',  'normal', 'small',  'proj-a', NULL,      'sig-v2-list-2'),
         ($3, 'Medium proj-b', 'todo',   'normal', 'medium', 'proj-b', 'pending', 'sig-v2-list-3')`,
      ['htm-v2-list-1', 'htm-v2-list-2', 'htm-v2-list-3'],
    );
  });

  it('?project=proj-a filters by project_id', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks?project=proj-a'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id).filter((id) => id.startsWith('htm-v2-list-'));
    assert.deepEqual(ids.sort(), ['htm-v2-list-1', 'htm-v2-list-2']);
  });

  it('?size=quick filters by size', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks?size=quick'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id).filter((id) => id.startsWith('htm-v2-list-'));
    assert.deepEqual(ids, ['htm-v2-list-1']);
  });

  it('?push_status=pending filters by push_status', async () => {
    const res = await listHumanTasks(boardReq('/api/human-tasks?push_status=pending'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id).filter((id) => id.startsWith('htm-v2-list-'));
    assert.deepEqual(ids.sort(), ['htm-v2-list-1', 'htm-v2-list-3']);
  });

  it('?signal_meeting_id=sig-v2-list-1 filters by signal_id', async () => {
    // migration 128: one live task per signal, so this filter returns exactly
    // the one task that owns sig-v2-list-1 and excludes the others.
    const res = await listHumanTasks(boardReq('/api/human-tasks?signal_meeting_id=sig-v2-list-1'), ADMIN_PRINCIPAL);
    const ids = res.tasks.map((t) => t.id).filter((id) => id.startsWith('htm-v2-list-'));
    assert.deepEqual(ids, ['htm-v2-list-1']);
  });

  it('?size=bogus → 400', async () => {
    await assert.rejects(
      () => listHumanTasks(boardReq('/api/human-tasks?size=enormous')),
      /size|400/i,
    );
  });
});

describe('GET /api/human-tasks/:id — single-row + sync_log tail', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_task_sync_log WHERE task_id LIKE 'htm-v2-get-%'`);
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-v2-get-%'`);
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority)
       VALUES ('htm-v2-get-1', 'Single fetch', 'inbox', 'normal')`,
    );
    // Seed a couple of sync_log entries so the tail is non-trivial.
    for (let i = 0; i < 3; i++) {
      await query(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome)
         VALUES ('htm-v2-get-1', 'push', 'success')`,
      );
    }
  });

  it('returns the row + last 20 sync_log entries', async () => {
    const res = await getHumanTask(boardReq('/api/human-tasks/htm-v2-get-1'));
    assert.equal(res.task.id, 'htm-v2-get-1');
    assert.equal(res.task.title, 'Single fetch');
    assert.equal(Array.isArray(res.sync_log), true);
    assert.equal(res.sync_log.length, 3);
  });

  it('unknown id → 404', async () => {
    await assert.rejects(
      () => getHumanTask(boardReq('/api/human-tasks/htm-v2-get-missing')),
      /not.found|404/i,
    );
  });
});

describe('POST /api/human-tasks/:id/enrich — force re-enrichment', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-v2-enr-%'`);
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority, enrichment_status, enrichment_at)
       VALUES
         ('htm-v2-enr-1', 'Re-enrich', 'inbox', 'normal', 'completed', now()),
         ('htm-v2-enr-2', 'Running',  'inbox', 'normal', 'running',   now())`,
    );
  });

  it('resets enrichment_status to pending and clears enrichment_at', async () => {
    const res = await forceEnrichHumanTask(
      boardReq('/api/human-tasks/htm-v2-enr-1/enrich'),
      {},
    );
    assert.equal(res.ok, true);
    assert.equal(res.enrichment_status, 'pending');
    const r = await query(
      `SELECT enrichment_status, enrichment_at, feedback_history
         FROM inbox.human_tasks WHERE id = 'htm-v2-enr-1'`,
    );
    assert.equal(r.rows[0].enrichment_status, 'pending');
    assert.equal(r.rows[0].enrichment_at, null);
    const hist = typeof r.rows[0].feedback_history === 'string'
      ? JSON.parse(r.rows[0].feedback_history)
      : r.rows[0].feedback_history;
    assert.ok(Array.isArray(hist) && hist.some((e) => e.verb === 'force_enrich'),
      'feedback_history must include force_enrich');
  });

  it('rejects in-flight enrichment with 409', async () => {
    await assert.rejects(
      () => forceEnrichHumanTask(
        boardReq('/api/human-tasks/htm-v2-enr-2/enrich'),
        {},
      ),
      /flight|running|409/i,
    );
  });
});

describe('POST /api/human-tasks/:id/resync — force pull from Linear', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-v2-rs-%'`);
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, linear_issue_id, linear_last_event_at)
       VALUES ('htm-v2-rs-1', 'Resync me', 'inbox', 'normal', 'lin-xyz', now())`,
    );
  });

  it('clears linear_last_event_at + appends force_resync to history', async () => {
    const res = await forceResyncHumanTask(
      boardReq('/api/human-tasks/htm-v2-rs-1/resync'),
      {},
    );
    assert.equal(res.ok, true);
    const r = await query(
      `SELECT linear_last_event_at, feedback_history
         FROM inbox.human_tasks WHERE id = 'htm-v2-rs-1'`,
    );
    assert.equal(r.rows[0].linear_last_event_at, null);
    const hist = typeof r.rows[0].feedback_history === 'string'
      ? JSON.parse(r.rows[0].feedback_history)
      : r.rows[0].feedback_history;
    assert.ok(Array.isArray(hist) && hist.some((e) => e.verb === 'force_resync'),
      'feedback_history must include force_resync');
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => forceResyncHumanTask(
        { url: '/api/human-tasks/htm-v2-rs-1/resync', headers: {} },
        {},
      ),
      /board|403/i,
    );
  });
});
