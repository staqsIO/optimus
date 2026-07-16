// Tests for /today pure helpers.
// Per ADR-004: pure-function frontend tests run under node:test.
//
// Run: cd board && node --test src/app/today/today-helpers.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortMyTasks,
  filterQuickWins,
  formatTodayInLinearItem,
} from './today-helpers.js';

// ---------- fixtures ----------

// Fixed "now" used by every test for deterministic overdue / due-today checks.
const NOW = new Date('2026-05-21T12:00:00.000Z');

const ISO_TODAY = '2026-05-21';
const ISO_YESTERDAY = '2026-05-20';
const ISO_TOMORROW = '2026-05-22';
const ISO_NEXT_WEEK = '2026-05-28';

function makeTask(overrides = {}) {
  return {
    id: 't-1',
    title: 'Example task',
    status: 'todo',
    priority: 'normal',
    size: null,
    due_date: null,
    assignee_contact_id: null,
    relevance_score: 0.5,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// sortMyTasks
// ============================================================================

describe('sortMyTasks', () => {
  it('empty input returns []', () => {
    assert.deepEqual(sortMyTasks([], NOW), []);
    assert.deepEqual(sortMyTasks(null, NOW), []);
    assert.deepEqual(sortMyTasks(undefined, NOW), []);
  });

  it('puts overdue tasks before due-today tasks', () => {
    const overdue = makeTask({ id: 'overdue', due_date: ISO_YESTERDAY, priority: 'low' });
    const dueToday = makeTask({ id: 'today', due_date: ISO_TODAY, priority: 'urgent' });
    const sorted = sortMyTasks([dueToday, overdue], NOW);
    assert.equal(sorted[0].id, 'overdue');
    assert.equal(sorted[1].id, 'today');
  });

  it('puts due-today before priority-sorted future tasks', () => {
    const future = makeTask({ id: 'future', due_date: ISO_TOMORROW, priority: 'urgent' });
    const dueToday = makeTask({ id: 'today', due_date: ISO_TODAY, priority: 'low' });
    const sorted = sortMyTasks([future, dueToday], NOW);
    assert.equal(sorted[0].id, 'today');
    assert.equal(sorted[1].id, 'future');
  });

  it('within same urgency bucket: urgent > high > normal > low', () => {
    const low = makeTask({ id: 'low', priority: 'low', due_date: ISO_TOMORROW });
    const normal = makeTask({ id: 'normal', priority: 'normal', due_date: ISO_TOMORROW });
    const high = makeTask({ id: 'high', priority: 'high', due_date: ISO_TOMORROW });
    const urgent = makeTask({ id: 'urgent', priority: 'urgent', due_date: ISO_TOMORROW });
    const sorted = sortMyTasks([low, normal, urgent, high], NOW);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ['urgent', 'high', 'normal', 'low'],
    );
  });

  it('within same priority: in_progress sorts first', () => {
    const todo = makeTask({ id: 'a', status: 'todo', priority: 'high', due_date: ISO_TOMORROW });
    const inProgress = makeTask({ id: 'b', status: 'in_progress', priority: 'high', due_date: ISO_TOMORROW });
    const sorted = sortMyTasks([todo, inProgress], NOW);
    assert.equal(sorted[0].id, 'b');
    assert.equal(sorted[1].id, 'a');
  });

  it('within same status: created_at ascending (older first)', () => {
    const newer = makeTask({ id: 'new', created_at: '2026-05-10T00:00:00.000Z', priority: 'normal', due_date: ISO_TOMORROW });
    const older = makeTask({ id: 'old', created_at: '2026-05-01T00:00:00.000Z', priority: 'normal', due_date: ISO_TOMORROW });
    const sorted = sortMyTasks([newer, older], NOW);
    assert.equal(sorted[0].id, 'old');
    assert.equal(sorted[1].id, 'new');
  });

  it('caps at 8 items', () => {
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(makeTask({ id: `t-${i}`, due_date: ISO_TOMORROW }));
    }
    const sorted = sortMyTasks(tasks, NOW);
    assert.equal(sorted.length, 8);
  });

  it('no due_date is treated as later than due-today', () => {
    const noDate = makeTask({ id: 'nodate', priority: 'urgent', due_date: null });
    const dueToday = makeTask({ id: 'today', priority: 'low', due_date: ISO_TODAY });
    const sorted = sortMyTasks([noDate, dueToday], NOW);
    assert.equal(sorted[0].id, 'today');
    assert.equal(sorted[1].id, 'nodate');
  });
});

// ============================================================================
// filterQuickWins
// ============================================================================

describe('filterQuickWins', () => {
  const ME = 'user-me';

  it('empty input returns []', () => {
    assert.deepEqual(filterQuickWins([], ME, NOW), []);
    assert.deepEqual(filterQuickWins(null, ME, NOW), []);
    assert.deepEqual(filterQuickWins(undefined, ME, NOW), []);
  });

  it('includes my task with size=quick', () => {
    const task = makeTask({ id: 'q', size: 'quick', assignee_contact_id: ME });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'q');
  });

  it('includes my task with size=small', () => {
    const task = makeTask({ id: 's', size: 'small', assignee_contact_id: ME });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 1);
  });

  it('excludes my task with size=medium', () => {
    const task = makeTask({ id: 'm', size: 'medium', assignee_contact_id: ME });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 0);
  });

  it('includes unassigned with relevance >= 0.6', () => {
    const task = makeTask({ id: 'u', size: 'quick', assignee_contact_id: null, relevance_score: 0.6 });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 1);
  });

  it('excludes unassigned with relevance < 0.6', () => {
    const task = makeTask({ id: 'u', size: 'quick', assignee_contact_id: null, relevance_score: 0.59 });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 0);
  });

  it('excludes someone-else-assigned tasks', () => {
    const task = makeTask({ id: 'o', size: 'quick', assignee_contact_id: 'user-other', relevance_score: 0.9 });
    const out = filterQuickWins([task], ME, NOW);
    assert.equal(out.length, 0);
  });

  it('excludes terminal status tasks (done/skipped/not_for_us)', () => {
    const done = makeTask({ id: 'd', size: 'quick', assignee_contact_id: ME, status: 'done' });
    const skipped = makeTask({ id: 's', size: 'quick', assignee_contact_id: ME, status: 'skipped' });
    const notForUs = makeTask({ id: 'n', size: 'quick', assignee_contact_id: ME, status: 'not_for_us' });
    const out = filterQuickWins([done, skipped, notForUs], ME, NOW);
    assert.equal(out.length, 0);
  });

  it('caps at 5 items', () => {
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(makeTask({ id: `q-${i}`, size: 'quick', assignee_contact_id: ME }));
    }
    const out = filterQuickWins(tasks, ME, NOW);
    assert.equal(out.length, 5);
  });

  it('sorts by priority desc, then due_date asc, then created_at desc', () => {
    const low = makeTask({ id: 'low', size: 'quick', assignee_contact_id: ME, priority: 'low', due_date: ISO_TODAY });
    const highLate = makeTask({ id: 'highLate', size: 'quick', assignee_contact_id: ME, priority: 'high', due_date: ISO_NEXT_WEEK });
    const highEarly = makeTask({ id: 'highEarly', size: 'quick', assignee_contact_id: ME, priority: 'high', due_date: ISO_TODAY });
    const out = filterQuickWins([low, highLate, highEarly], ME, NOW);
    assert.deepEqual(out.map((t) => t.id), ['highEarly', 'highLate', 'low']);
  });
});

// ============================================================================
// formatTodayInLinearItem
// ============================================================================

describe('formatTodayInLinearItem', () => {
  it('returns {summary, link}', () => {
    const issue = {
      id: 'lin-1',
      identifier: 'OPT-123',
      title: 'Fix the bug',
      url: 'https://linear.app/staqs/issue/OPT-123',
      priority: 'high',
      dueDate: '2026-05-25',
    };
    const out = formatTodayInLinearItem(issue);
    assert.ok(typeof out.summary === 'string', 'summary is a string');
    assert.ok(out.summary.length > 0, 'summary is non-empty');
    assert.equal(out.link, 'https://linear.app/staqs/issue/OPT-123');
  });

  it('omits due_date in summary when empty', () => {
    const issue = {
      id: 'lin-1',
      identifier: 'OPT-124',
      title: 'Plain title',
      url: 'https://linear.app/staqs/issue/OPT-124',
      priority: null,
      dueDate: null,
    };
    const out = formatTodayInLinearItem(issue);
    assert.ok(
      !/\bdue\s+\d{4}-\d{2}-\d{2}\b/i.test(out.summary),
      `summary should not include a "due YYYY-MM-DD" tag: got "${out.summary}"`,
    );
  });

  it('includes priority when set', () => {
    const issue = {
      id: 'lin-1',
      identifier: 'OPT-125',
      title: 'Urgent work',
      url: 'https://linear.app/staqs/issue/OPT-125',
      priority: 'urgent',
      dueDate: null,
    };
    const out = formatTodayInLinearItem(issue);
    assert.ok(/urgent/i.test(out.summary), `summary should include priority: got "${out.summary}"`);
  });
});
