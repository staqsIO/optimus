// Plan 016 Step 2 regression: the budget reservation (estimated portion) is
// released at most ONCE per task, so a handler calling callLLM multiple times
// does not double-decrement reserved_usd. callLLM computes the amount to
// release via reservationEstimateToRelease(this._budgetCommitted, estimate);
// this pins that decision. (The heavy agent-loop graph pulls googleapis and is
// not unit-importable, so the decision lives in a pure helper — mirrors the
// wall-budget.test.js pattern of testing extracted budget logic directly.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reservationEstimateToRelease } from '../../lib/runtime/budget-commit.js';

describe('reservationEstimateToRelease (Plan 016 — release the reservation estimate once per task)', () => {
  it('first commit (not yet committed) releases the full estimate', () => {
    assert.equal(reservationEstimateToRelease(false, 0.042), 0.042);
  });

  it('subsequent commit (already committed) releases 0 — no double-decrement', () => {
    assert.equal(reservationEstimateToRelease(true, 0.042), 0);
  });

  it('models a handler calling callLLM twice: estimate released once, total = one estimate', () => {
    const estimate = 0.042;
    let committed = false;

    // Call 1
    const release1 = reservationEstimateToRelease(committed, estimate);
    committed = true; // callLLM sets this._budgetCommitted = true after the commit
    // Call 2
    const release2 = reservationEstimateToRelease(committed, estimate);

    assert.equal(release1 + release2, estimate, 'reservation is released exactly once across two calls');
    assert.equal(release2, 0);
  });

  it('a zero estimate stays zero on the first call (no spurious release)', () => {
    assert.equal(reservationEstimateToRelease(false, 0), 0);
  });
});
