/**
 * Tests for lib/runtime/verifier.js — OPT-3.
 *
 * Covers:
 *   1. Failing criterion caught + looped: verifier loops until max, reports failureMode.
 *   2. Eventually-passing: fails on first probe, passes on second — verify returns passed.
 *   3. gateFlowCompletion (USE SITE 1): gates flow completion on output criteria.
 *   4. devCheck (USE SITE 2): same primitive reused unchanged for a dev-side check.
 *   5. Declarative criterion operators.
 *   6. Function-based criterion.
 *   7. Bounds enforcement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Relative path from autobot-inbox/test/ to lib/runtime/verifier.js
import {
  verify,
  gateFlowCompletion,
  devCheck,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_ITERATION_TIMEOUT_MS,
} from '../../lib/runtime/verifier.js';

// ---------------------------------------------------------------------------
// Helpers — mock targets for offline tests (no real HTTP / CLI / Playwright)
// ---------------------------------------------------------------------------

/**
 * A mock target whose observation changes call-by-call.
 * failCount controls how many times it returns the failing observation before
 * switching to the passing one.
 */
function buildSequencedMock(failCount, failObs, passObs) {
  let calls = 0;
  return {
    type: 'mock',
    observation: () => {
      calls++;
      return calls > failCount ? passObs : failObs;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Failing criterion caught + looped (all iterations exhausted)
// ---------------------------------------------------------------------------

describe('verify — failing criterion caught and reported', () => {
  it('exhausts maxIterations and returns passed=false with failureMode', async () => {
    const criteria = [
      { text: 'score must be >= 0.9', field: 'score', operator: '>=', value: 0.9 },
    ];
    // Observation always fails (score=0.5 < 0.9)
    const target = { type: 'mock', observation: { score: 0.5 } };

    const result = await verify({ successCriteria: criteria, target, maxIterations: 3 });

    assert.equal(result.passed, false, 'should not pass when criterion always fails');
    assert.equal(result.iterations, 3, 'should exhaust all iterations');
    assert.ok(result.failureMode.includes('score must be >= 0.9'), 'failureMode should name the failing criterion');
    assert.ok(result.failureMode.includes('0.5 >= 0.9'), 'failureMode should include the comparison');
    assert.equal(result.gateResults.length, 1);
    assert.equal(result.gateResults[0].passed, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Eventually-passing — fails first N, then passes
// ---------------------------------------------------------------------------

describe('verify — loops until criterion passes', () => {
  it('fails on first 2 iterations, passes on 3rd', async () => {
    const criteria = [
      { text: 'score >= 0.9', field: 'score', operator: '>=', value: 0.9 },
    ];
    // 2 failing calls (score=0.3), then passing (score=1.0)
    const target = buildSequencedMock(2, { score: 0.3 }, { score: 1.0 });

    const result = await verify({ successCriteria: criteria, target, maxIterations: 5 });

    assert.equal(result.passed, true, 'should pass once criterion is met');
    assert.equal(result.iterations, 3, 'should stop at 3rd iteration when it passes');
    assert.equal(result.gateResults[0].passed, true);
  });
});

// ---------------------------------------------------------------------------
// 3. gateFlowCompletion — USE SITE 1: flow completion gate
// ---------------------------------------------------------------------------

describe('gateFlowCompletion — flow/runner task completion gate', () => {
  it('passes when output satisfies all criteria', async () => {
    const successCriteria = [
      { text: 'has output_url', field: 'output_url', operator: 'exists' },
      { text: 'quality_score >= 0.8', field: 'quality_score', operator: '>=', value: 0.8 },
    ];
    const outputPayload = { output_url: 'https://example.com/page', quality_score: 0.92 };

    const result = await gateFlowCompletion({ successCriteria, outputPayload });

    assert.equal(result.passed, true);
    assert.equal(result.gateResults.length, 2);
    assert.ok(result.gateResults.every((g) => g.passed));
  });

  it('fails when output does not satisfy a criterion', async () => {
    const successCriteria = [
      { text: 'quality_score >= 0.8', field: 'quality_score', operator: '>=', value: 0.8 },
    ];
    const outputPayload = { quality_score: 0.5 };

    const result = await gateFlowCompletion({ successCriteria, outputPayload, maxIterations: 1 });

    assert.equal(result.passed, false);
    assert.ok(result.failureMode.includes('quality_score >= 0.8'));
  });

  it('passes through (no gate) when successCriteria is empty', async () => {
    const result = await gateFlowCompletion({ successCriteria: [], outputPayload: {} });
    assert.equal(result.passed, true);
    assert.equal(result.iterations, 0);
  });

  it('passes through when successCriteria is null/undefined', async () => {
    const result = await gateFlowCompletion({ successCriteria: null, outputPayload: {} });
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// 4. devCheck — USE SITE 2: same primitive reused unchanged
// ---------------------------------------------------------------------------

describe('devCheck — dev-side check using the same primitive', () => {
  it('passes for a healthy observation (mock target)', async () => {
    // This is exactly what a developer would write as a pre-merge check
    const result = await devCheck({
      successCriteria: [
        { text: 'id exists', field: 'id', operator: 'exists' },
        { text: 'status is ok', field: 'status', operator: 'eq', value: 'ok' },
      ],
      target: { type: 'mock', observation: { id: 'abc123', status: 'ok' } },
    });

    assert.equal(result.passed, true);
    assert.equal(result.iterations, 1);
  });

  it('fails for a bad observation (mock target)', async () => {
    const result = await devCheck({
      successCriteria: [
        { text: 'status is ok', field: 'status', operator: 'eq', value: 'ok' },
      ],
      target: { type: 'mock', observation: { status: 'error' } },
      maxIterations: 2,
    });

    assert.equal(result.passed, false);
    assert.ok(result.failureMode.includes('status is ok'));
  });

  it('is the same function as verify() — not a re-implemented wrapper', async () => {
    // Prove structural identity: devCheck delegates to verify(), same result shape
    const criteria = [{ text: 'x >= 1', field: 'x', operator: '>=', value: 1 }];
    const target = { type: 'mock', observation: { x: 2 } };

    const [r1, r2] = await Promise.all([
      verify({ successCriteria: criteria, target, maxIterations: 1 }),
      devCheck({ successCriteria: criteria, target, maxIterations: 1 }),
    ]);

    assert.equal(r1.passed, r2.passed);
    assert.equal(r1.gateResults.length, r2.gateResults.length);
    assert.equal(r1.gateResults[0].criterion, r2.gateResults[0].criterion);
  });
});

// ---------------------------------------------------------------------------
// 5. Declarative criterion operators
// ---------------------------------------------------------------------------

describe('evaluateCriterion — declarative operators', () => {
  const makeTarget = (obs) => ({ type: 'mock', observation: obs });

  it('eq passes when equal', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'x', operator: 'eq', value: 5 }], target: makeTarget({ x: 5 }), maxIterations: 1 });
    assert.equal(r.passed, true);
  });

  it('eq fails when not equal', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'x', operator: 'eq', value: 5 }], target: makeTarget({ x: 6 }), maxIterations: 1 });
    assert.equal(r.passed, false);
  });

  it('contains passes when string includes value', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'msg', operator: 'contains', value: 'hello' }], target: makeTarget({ msg: 'say hello world' }), maxIterations: 1 });
    assert.equal(r.passed, true);
  });

  it('exists passes when field present', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'id', operator: 'exists' }], target: makeTarget({ id: 'xyz' }), maxIterations: 1 });
    assert.equal(r.passed, true);
  });

  it('exists fails when field absent', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'id', operator: 'exists' }], target: makeTarget({}), maxIterations: 1 });
    assert.equal(r.passed, false);
  });

  it('nested dot-path field access', async () => {
    const r = await verify({ successCriteria: [{ text: 't', field: 'body.status', operator: 'eq', value: 200 }], target: makeTarget({ body: { status: 200 } }), maxIterations: 1 });
    assert.equal(r.passed, true);
  });

  it('unknown criterion shape fails closed', async () => {
    const r = await verify({ successCriteria: [{ text: 'mystery', unknownKey: 'x' }], target: makeTarget({}), maxIterations: 1 });
    assert.equal(r.passed, false);
    assert.ok(r.gateResults[0].reason.includes('failing closed'));
  });
});

// ---------------------------------------------------------------------------
// 6. Function-based criterion
// ---------------------------------------------------------------------------

describe('evaluateCriterion — function-based check', () => {
  it('passes when check function returns true', async () => {
    const criteria = [{ text: 'custom check', check: (obs) => obs.value > 10 }];
    const r = await verify({ successCriteria: criteria, target: { type: 'mock', observation: { value: 42 } }, maxIterations: 1 });
    assert.equal(r.passed, true);
  });

  it('fails when check function returns false', async () => {
    const criteria = [{ text: 'custom check', check: (obs) => obs.value > 10 }];
    const r = await verify({ successCriteria: criteria, target: { type: 'mock', observation: { value: 3 } }, maxIterations: 1 });
    assert.equal(r.passed, false);
  });

  it('fails closed when check function throws', async () => {
    const criteria = [{ text: 'throws', check: () => { throw new Error('boom'); } }];
    const r = await verify({ successCriteria: criteria, target: { type: 'mock', observation: {} }, maxIterations: 1 });
    assert.equal(r.passed, false);
    assert.ok(r.gateResults[0].reason.includes('check threw: boom'));
  });

  it('check returning { passed, reason } shape is respected', async () => {
    const criteria = [{ text: 'rich result', check: (obs) => ({ passed: obs.x > 5, reason: `x=${obs.x}` }) }];
    const r = await verify({ successCriteria: criteria, target: { type: 'mock', observation: { x: 7 } }, maxIterations: 1 });
    assert.equal(r.passed, true);
    assert.equal(r.gateResults[0].reason, 'x=7');
  });
});

// ---------------------------------------------------------------------------
// 7. Bounds enforcement
// ---------------------------------------------------------------------------

describe('verify — bounds enforcement', () => {
  it('throws when successCriteria is empty', async () => {
    await assert.rejects(
      () => verify({ successCriteria: [], target: { type: 'mock', observation: {} } }),
      /successCriteria must be a non-empty array/,
    );
  });

  it('throws when maxIterations is 0', async () => {
    await assert.rejects(
      () => verify({ successCriteria: [{ text: 't', field: 'x', operator: 'exists' }], target: { type: 'mock', observation: {} }, maxIterations: 0 }),
      /maxIterations must be between 1 and 100/,
    );
  });

  it('throws when maxIterations > 100', async () => {
    await assert.rejects(
      () => verify({ successCriteria: [{ text: 't', field: 'x', operator: 'exists' }], target: { type: 'mock', observation: {} }, maxIterations: 101 }),
      /maxIterations must be between 1 and 100/,
    );
  });

  it('returns passed=false (not throw) when target has no type — probe errors are caught and retried', async () => {
    // The verifier catches probe errors and retries rather than throwing synchronously.
    // Intentional: a transient probe failure should exhaust maxIterations and report
    // passed=false, not crash the caller (P1: fail closed, not fail loud).
    const result = await verify({
      successCriteria: [{ text: 't', field: 'x', operator: 'exists' }],
      target: { observation: {} },  // missing `type` field
      maxIterations: 2,
    });
    assert.equal(result.passed, false);
    assert.equal(result.iterations, 2);
    assert.ok(result.gateResults.every((g) => g.reason.includes('probe error')));
  });

  it('exports expected defaults', () => {
    assert.equal(DEFAULT_MAX_ITERATIONS, 5);
    assert.equal(DEFAULT_ITERATION_TIMEOUT_MS, 10_000);
  });
});
