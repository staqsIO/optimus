/**
 * /api/today endpoints — v0.2 tech-spec §4.1, FR-34..36.
 *
 *   GET /api/today/tasks   — { my_tasks, quick_wins } for the logged-in user.
 *   GET /api/today/linear  — live Linear pull, read-only.
 *
 * Each suite covers one happy-path test + one negative (auth) test per the
 * scope of this task. Server-side sort + filter logic is exercised
 * indirectly — the FR-34 priority/overdue ordering is unit-tested
 * exhaustively in board/today-helpers.test.js.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { getTodayTasks, makeGetTodayLinear } from '../src/api-routes/today.js';

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
  return { url, headers: {} };
}

describe('GET /api/today/tasks (FR-34, FR-36)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-today-%'`);
    // Five rows that cover both sections:
    //  - htm-today-1: assignee = me, due TODAY, high priority — my_tasks.
    //  - htm-today-2: assignee = me, overdue (CURRENT_DATE - 5) — my_tasks first.
    //  - htm-today-3: unassigned, size=quick, relevance=0.9 — quick_wins.
    //  - htm-today-4: assignee = me, size=small — both lanes.
    //  - htm-today-5: terminal (done) — neither lane.
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, size,
          assignee_contact_id, relevance_score, due_date)
       VALUES
         ('htm-today-1', 'today',  'inbox',       'high',   NULL,    'op-me', 0.7, CURRENT_DATE),
         ('htm-today-2', 'overdue','in_progress', 'normal', NULL,    'op-me', 0.7, CURRENT_DATE - 5),
         ('htm-today-3', 'quick',  'inbox',       'normal', 'quick', NULL,    0.9, NULL),
         ('htm-today-4', 'small',  'todo',        'normal', 'small', 'op-me', 0.7, NULL),
         ('htm-today-5', 'done',   'done',        'normal', 'small', 'op-me', 0.7, NULL)`,
    );
  });

  it('returns my_tasks ordered overdue-first, plus quick_wins', async () => {
    const res = await getTodayTasks(boardReq('/api/today/tasks?assignee=op-me'));
    assert.ok(Array.isArray(res.my_tasks), 'my_tasks is array');
    assert.ok(Array.isArray(res.quick_wins), 'quick_wins is array');

    const myIds = res.my_tasks.map((t) => t.id);
    // Overdue first per FR-34 ordering.
    assert.equal(myIds[0], 'htm-today-2');
    assert.ok(myIds.includes('htm-today-1'));
    assert.ok(myIds.includes('htm-today-4'));
    // Terminal row excluded.
    assert.equal(myIds.includes('htm-today-5'), false);

    const qwIds = res.quick_wins.map((t) => t.id);
    // Quick win: unassigned + relevance >= 0.6.
    assert.ok(qwIds.includes('htm-today-3'));
    // Assignee = me + size=small qualifies.
    assert.ok(qwIds.includes('htm-today-4'));
    // Terminal excluded.
    assert.equal(qwIds.includes('htm-today-5'), false);
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => getTodayTasks(publicReq('/api/today/tasks')),
      /board|403/i,
    );
  });
});

describe('GET /api/today/linear (FR-35)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-todaylin-%'`);
    // Seed one human_task that mirrors a Linear issue — this issue should
    // be EXCLUDED from /today/linear because it's Optimus-originated.
    await query(
      `INSERT INTO inbox.human_tasks
         (id, title, status, priority, assignee_contact_id, linear_issue_id)
       VALUES ('htm-todaylin-1', 'mirrored', 'inbox', 'normal', 'op-me', 'lin-mirrored-1')`,
    );
  });

  it('returns only Linear issues without a matching human_tasks row', async () => {
    const fakeClient = {
      async fetchIssues({ assigneeId }) {
        assert.equal(assigneeId, 'op-me');
        return [
          { id: 'lin-mirrored-1', identifier: 'LIN-1', title: 'mirrored',
            url: 'https://linear.app/x/issue/LIN-1', state: 'In Progress',
            priority: 2, dueDate: null },
          { id: 'lin-fresh-2',    identifier: 'LIN-2', title: 'linear only',
            url: 'https://linear.app/x/issue/LIN-2', state: 'Todo',
            priority: 3, dueDate: '2026-06-01' },
        ];
      },
    };
    const handler = makeGetTodayLinear({ getLinearClient: () => fakeClient });
    const res = await handler(boardReq('/api/today/linear?assignee=op-me'));
    assert.equal(Array.isArray(res), true);
    assert.equal(res.length, 1);
    assert.equal(res[0].identifier, 'LIN-2');
    assert.equal(res[0].title, 'linear only');
    assert.equal(res[0].url, 'https://linear.app/x/issue/LIN-2');
    assert.equal(res[0].state, 'Todo');
    assert.equal(res[0].dueDate, '2026-06-01');
  });

  it('rejects unauthenticated callers (403)', async () => {
    const handler = makeGetTodayLinear({ getLinearClient: () => null });
    await assert.rejects(
      () => handler(publicReq('/api/today/linear')),
      /board|403/i,
    );
  });
});
