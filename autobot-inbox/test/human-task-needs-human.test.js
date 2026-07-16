/**
 * RED step (TDD) — lib/runtime/human-task-needs-human.js does not exist.
 *
 * PRD §8 defines six triggers for the "Needs you" lane. Each is pure-function
 * computable from a task row + now() — no DB needed for the unit tests.
 *
 * Output shape (per PRD §8): `needs_human: { trigger, since, hint }` or null
 * when no trigger fires. Triggers are checked in priority order; the first
 * to fire wins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNeedsHuman,
  NEEDS_HUMAN_TRIGGERS,
} from '../../lib/runtime/human-task-needs-human.js';

const NOW = new Date('2026-05-18T12:00:00Z');
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

function task(overrides = {}) {
  return {
    id: 'htm-needs-1',
    status: 'todo',
    priority: 'normal',
    assignee_contact_id: 'ct-eric',
    due_date: null,
    extraction_confidence: 0.9,
    created_at: new Date(NOW.getTime() - 1 * DAYS).toISOString(),
    updated_at: new Date(NOW.getTime() - 1 * DAYS).toISOString(),
    ...overrides,
  };
}

describe('computeNeedsHuman — no trigger', () => {
  it('returns null for a fresh, well-formed, mid-state task', () => {
    assert.equal(computeNeedsHuman(task(), NOW), null);
  });

  it('returns null for done/skipped/not_for_us (terminal)', () => {
    for (const status of ['done', 'skipped', 'not_for_us']) {
      assert.equal(
        computeNeedsHuman(task({ status, updated_at: new Date(NOW.getTime() - 30 * DAYS).toISOString() }), NOW),
        null,
        `${status} must not surface needs_human`,
      );
    }
  });
});

describe('computeNeedsHuman — individual triggers (PRD §8)', () => {
  it('urgent_in_inbox: priority=urgent AND status=inbox → immediate', () => {
    const r = computeNeedsHuman(task({ priority: 'urgent', status: 'inbox' }), NOW);
    assert.ok(r);
    assert.equal(r.trigger, 'urgent_in_inbox');
  });

  it('low_confidence: extraction_confidence < 0.5 → immediate', () => {
    const r = computeNeedsHuman(task({ extraction_confidence: 0.45 }), NOW);
    assert.ok(r);
    assert.equal(r.trigger, 'low_confidence');
  });

  it('no_assignee: assignee NULL for > 24h since creation', () => {
    const r = computeNeedsHuman(
      task({
        assignee_contact_id: null,
        created_at: new Date(NOW.getTime() - 36 * HOURS).toISOString(),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'no_assignee');
  });

  it('no_assignee: NOT fired within first 24h', () => {
    const r = computeNeedsHuman(
      task({
        assignee_contact_id: null,
        created_at: new Date(NOW.getTime() - 2 * HOURS).toISOString(),
      }),
      NOW,
    );
    assert.equal(r, null);
  });

  it('due_approaching: due_date within 3 days (default for normal priority)', () => {
    const r = computeNeedsHuman(
      task({
        due_date: new Date(NOW.getTime() + 2 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'due_approaching');
  });

  it('due_approaching: urgent priority uses 5-day window', () => {
    const r = computeNeedsHuman(
      task({
        priority: 'urgent',
        status: 'todo', // not inbox, so urgent_in_inbox does not fire
        due_date: new Date(NOW.getTime() + 4 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'due_approaching');
  });

  it('due_approaching: low priority uses 1-day window', () => {
    const r4d = computeNeedsHuman(
      task({
        priority: 'low',
        due_date: new Date(NOW.getTime() + 4 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.equal(r4d, null, 'low priority 4 days out is NOT close enough');

    const r12h = computeNeedsHuman(
      task({
        priority: 'low',
        due_date: new Date(NOW.getTime() + 12 * HOURS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.ok(r12h);
    assert.equal(r12h.trigger, 'due_approaching');
  });

  it('stalled: in_progress > 5 days', () => {
    const r = computeNeedsHuman(
      task({
        status: 'in_progress',
        updated_at: new Date(NOW.getTime() - 6 * DAYS).toISOString(),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'stalled');
  });

  it('stalled: proposed > 2 days', () => {
    const r = computeNeedsHuman(
      task({
        status: 'proposed',
        updated_at: new Date(NOW.getTime() - 3 * DAYS).toISOString(),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'stalled');
  });

  it('stalled: default 7 days for other non-terminal states', () => {
    const r = computeNeedsHuman(
      task({
        status: 'todo',
        updated_at: new Date(NOW.getTime() - 8 * DAYS).toISOString(),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'stalled');
  });
});

describe('computeNeedsHuman — priority order', () => {
  it('urgent_in_inbox wins over low_confidence', () => {
    const r = computeNeedsHuman(
      task({
        priority: 'urgent',
        status: 'inbox',
        extraction_confidence: 0.3,
      }),
      NOW,
    );
    assert.equal(r.trigger, 'urgent_in_inbox');
  });

  it('low_confidence wins over no_assignee', () => {
    const r = computeNeedsHuman(
      task({
        assignee_contact_id: null,
        created_at: new Date(NOW.getTime() - 48 * HOURS).toISOString(),
        extraction_confidence: 0.4,
      }),
      NOW,
    );
    assert.equal(r.trigger, 'low_confidence');
  });

  it('due_approaching wins over stalled', () => {
    const r = computeNeedsHuman(
      task({
        status: 'todo',
        updated_at: new Date(NOW.getTime() - 30 * DAYS).toISOString(),
        due_date: new Date(NOW.getTime() + 1 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.equal(r.trigger, 'due_approaching');
  });
});

describe('computeNeedsHuman — boundary + edge cases', () => {
  it('due_approaching: overdue surfaces with "Overdue by" hint', () => {
    const r = computeNeedsHuman(
      task({
        due_date: new Date(NOW.getTime() - 3 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.ok(r);
    assert.equal(r.trigger, 'due_approaching');
    assert.match(r.hint, /overdue/i);
  });

  it('no_assignee > due_approaching priority order', () => {
    const r = computeNeedsHuman(
      task({
        assignee_contact_id: null,
        created_at: new Date(NOW.getTime() - 36 * HOURS).toISOString(),
        // Also has a due_date within the window — no_assignee must win.
        due_date: new Date(NOW.getTime() + 1 * DAYS).toISOString().slice(0, 10),
      }),
      NOW,
    );
    assert.equal(r.trigger, 'no_assignee');
  });

  it('NULL created_at does not crash no_assignee path', () => {
    const r = computeNeedsHuman(
      task({ assignee_contact_id: null, created_at: null }),
      NOW,
    );
    // No fire — falls through to other triggers (none of which match here).
    assert.equal(r, null);
  });

  it('NULL updated_at does not crash stalled path', () => {
    const r = computeNeedsHuman(task({ updated_at: null }), NOW);
    assert.equal(r, null);
  });

  it('threshold overrides via opts.thresholds', () => {
    const r = computeNeedsHuman(
      task({ extraction_confidence: 0.6 }),
      NOW,
      { thresholds: { lowConfidence: 0.7 } },
    );
    assert.ok(r);
    assert.equal(r.trigger, 'low_confidence');
  });
});

describe('computeNeedsHuman — since carries the trigger-specific timestamp', () => {
  it('no_assignee.since is created_at', () => {
    const created = new Date(NOW.getTime() - 48 * HOURS);
    const r = computeNeedsHuman(
      task({ assignee_contact_id: null, created_at: created.toISOString() }),
      NOW,
    );
    assert.equal(new Date(r.since).getTime(), created.getTime());
  });

  it('stalled.since is updated_at', () => {
    const updated = new Date(NOW.getTime() - 9 * DAYS);
    const r = computeNeedsHuman(
      task({ updated_at: updated.toISOString() }),
      NOW,
    );
    assert.equal(r.trigger, 'stalled');
    assert.equal(new Date(r.since).getTime(), updated.getTime());
  });
});

describe('computeNeedsHuman — payload shape', () => {
  it('always returns {trigger, since, hint} when fired', () => {
    const r = computeNeedsHuman(task({ priority: 'urgent', status: 'inbox' }), NOW);
    assert.equal(typeof r.trigger, 'string');
    assert.ok(r.since, 'since timestamp');
    assert.equal(typeof r.hint, 'string');
  });

  it('NEEDS_HUMAN_TRIGGERS exports the trigger list (for /api/board contract docs)', () => {
    assert.ok(Array.isArray(NEEDS_HUMAN_TRIGGERS));
    assert.ok(NEEDS_HUMAN_TRIGGERS.includes('stalled'));
    assert.ok(NEEDS_HUMAN_TRIGGERS.includes('no_assignee'));
    assert.ok(NEEDS_HUMAN_TRIGGERS.includes('urgent_in_inbox'));
    assert.ok(NEEDS_HUMAN_TRIGGERS.includes('due_approaching'));
    assert.ok(NEEDS_HUMAN_TRIGGERS.includes('low_confidence'));
  });
});
