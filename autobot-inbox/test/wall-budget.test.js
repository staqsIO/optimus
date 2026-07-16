import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLoopDeadline, isWallBudgetExceeded } from '../../lib/runtime/campaign/wall-budget.js';

describe('wall-clock budget (Phase 2 durability)', () => {
  const HOUR = 3_600_000;

  it('first start: computes now + budget and flags new (caller persists)', () => {
    const now = 1_000_000;
    const r = resolveLoopDeadline({ existingDeadlineIso: null, wallBudgetMs: 18 * HOUR, now });
    assert.equal(r.isNew, true);
    assert.equal(r.deadlineAt, now + 18 * HOUR);
  });

  it('RESUME invariant: a persisted deadline is reused verbatim, NOT reset', () => {
    // Budget started 17h ago; a crash+restart must leave ~1h, not grant a fresh 18h.
    const startedAt = 1_000_000;
    const persisted = new Date(startedAt + 18 * HOUR).toISOString();
    const nowAfterRestart = startedAt + 17 * HOUR;
    const r = resolveLoopDeadline({ existingDeadlineIso: persisted, wallBudgetMs: 18 * HOUR, now: nowAfterRestart });
    assert.equal(r.isNew, false, 'must not re-persist on resume');
    assert.equal(r.deadlineAt, startedAt + 18 * HOUR, 'deadline unchanged across restart');
    // ~1h of budget remains, not 18h.
    assert.equal(r.deadlineAt - nowAfterRestart, HOUR);
  });

  it('garbage persisted deadline falls back to a fresh budget', () => {
    const now = 5_000_000;
    const r = resolveLoopDeadline({ existingDeadlineIso: 'not-a-date', wallBudgetMs: HOUR, now });
    assert.equal(r.isNew, true);
    assert.equal(r.deadlineAt, now + HOUR);
  });

  it('isWallBudgetExceeded: true only at/after the deadline', () => {
    assert.equal(isWallBudgetExceeded(1000, 999), false);
    assert.equal(isWallBudgetExceeded(1000, 1000), true);
    assert.equal(isWallBudgetExceeded(1000, 1001), true);
  });
});
