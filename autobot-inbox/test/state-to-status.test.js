/**
 * STAQPRO-619-A: Linear workflow-state → human_tasks.status mapper.
 *
 * Pure-function unit tests — no DB. Pins the type→status contract for the
 * Linear-native import path (lib/linear/state-to-status.js). Every canonical
 * Linear state `type` is exercised, plus the fail-soft default and the
 * Optimus-native invariant.
 *
 * Run: node --test test/state-to-status.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapLinearStateToStatus,
  IMPORTABLE_STATUSES,
  TERMINAL_IMPORT_STATUSES,
} from '../../lib/linear/state-to-status.js';

describe('mapLinearStateToStatus — every Linear state type', () => {
  const cases = [
    ['triage',    'inbox',       'inbox',       false],
    ['backlog',   'inbox',       'inbox',       false],
    ['unstarted', 'todo',        'todo',        false],
    ['started',   'in_progress', 'in_progress', false],
    ['completed', 'done',        'done',        true],
    ['canceled',  'not_for_us',  'dropped',     true],
  ];

  for (const [type, status, lane, terminal] of cases) {
    it(`maps type='${type}' → status='${status}' lane='${lane}' terminal=${terminal}`, () => {
      const r = mapLinearStateToStatus({ type, name: `Some ${type}` });
      assert.equal(r.status, status);
      assert.equal(r.lane, lane);
      assert.equal(r.terminal, terminal);
    });
  }

  it("accepts British 'cancelled' spelling defensively → not_for_us", () => {
    const r = mapLinearStateToStatus({ type: 'cancelled' });
    assert.equal(r.status, 'not_for_us');
    assert.equal(r.terminal, true);
  });

  it('is case-insensitive on type', () => {
    assert.equal(mapLinearStateToStatus({ type: 'STARTED' }).status, 'in_progress');
  });
});

describe('mapLinearStateToStatus — fail-soft on bad input', () => {
  for (const bad of [null, undefined, {}, { type: null }, { type: 'wat' }, { type: 42 }]) {
    it(`unknown/missing type (${JSON.stringify(bad)}) → inbox (safe, non-terminal)`, () => {
      const r = mapLinearStateToStatus(bad);
      assert.equal(r.status, 'inbox');
      assert.equal(r.terminal, false);
    });
  }
});

describe('mapLinearStateToStatus — Optimus-native invariant', () => {
  it('never emits an Optimus-native status from any Linear type', () => {
    const native = new Set(['proposed', 'skipped', 'later', 'review', 'blocked']);
    const types = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'cancelled', 'unknown'];
    for (const type of types) {
      const { status } = mapLinearStateToStatus({ type });
      assert.ok(!native.has(status), `type='${type}' leaked native status '${status}'`);
      assert.ok(IMPORTABLE_STATUSES.includes(status), `type='${type}' produced non-importable '${status}'`);
    }
  });

  it('TERMINAL_IMPORT_STATUSES is exactly {done, not_for_us}', () => {
    assert.deepEqual([...TERMINAL_IMPORT_STATUSES].sort(), ['done', 'not_for_us']);
  });
});
