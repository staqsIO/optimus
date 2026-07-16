/**
 * RED step (TDD) — lib/runtime/human-task-sticky.js does not exist yet.
 *
 * Tests the sticky-override helper that guards re-enrichment.
 *
 * Contract (FR-3, AD-5):
 *   getStickyFields(feedback_history) → Set<string>
 *
 *   Returns the distinct set of `field` values across all feedback_history
 *   entries with `verb === 'edited'`. Other verbs (done, skip, later,
 *   not_for_me, transition, linear_pull, linear_push, llm_decision) do not
 *   contribute. Malformed entries are skipped silently. Non-array inputs
 *   yield an empty Set. The input array is never mutated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStickyFields } from '../../lib/runtime/human-task-sticky.js';

describe('getStickyFields', () => {
  it('returns an empty Set for an empty feedback_history array', () => {
    const result = getStickyFields([]);
    assert.ok(result instanceof Set);
    assert.deepStrictEqual(result, new Set());
  });

  it('returns an empty Set when feedback_history is null', () => {
    const result = getStickyFields(null);
    assert.ok(result instanceof Set);
    assert.deepStrictEqual(result, new Set());
  });

  it('returns an empty Set when feedback_history is undefined', () => {
    const result = getStickyFields(undefined);
    assert.ok(result instanceof Set);
    assert.deepStrictEqual(result, new Set());
  });

  it('returns the single edited field name for a one-entry history', () => {
    const history = [
      { verb: 'edited', field: 'project_id', value: 'proj-staqs', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set(['project_id']));
  });

  it('returns the set of fields the operator manually edited across multiple entries', () => {
    const history = [
      { verb: 'edited', field: 'project_id', value: 'proj-staqs', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'size', value: 'small', by: 'ct-eric', at: '2026-05-14T11:00:00Z' },
      { verb: 'edited', field: 'priority', value: 'high', by: 'ct-isaias', at: '2026-05-15T09:00:00Z' },
    ];
    assert.deepStrictEqual(
      getStickyFields(history),
      new Set(['project_id', 'size', 'priority']),
    );
  });

  it('dedupes repeated edits to the same field', () => {
    const history = [
      { verb: 'edited', field: 'description', value: 'v1', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'description', value: 'v2', by: 'ct-eric', at: '2026-05-14T11:00:00Z' },
      { verb: 'edited', field: 'description', value: 'v3', by: 'ct-isaias', at: '2026-05-15T09:00:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set(['description']));
  });

  it('ignores non-edited verbs (done, transition, linear_pull) and keeps only edits', () => {
    const history = [
      { verb: 'edited', field: 'assignee_contact_id', value: 'ct-eric', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
      { verb: 'done', by: 'ct-isaias', at: '2026-05-14T11:00:00Z' },
      { verb: 'transition', field: 'status', from_status: 'todo', to_status: 'in_progress', by: 'ct-eric', at: '2026-05-14T12:00:00Z' },
      { verb: 'linear_pull', field: 'assignee_contact_id', value: 'ct-someone', at: '2026-05-14T13:00:00Z' },
      { verb: 'edited', field: 'tags', value: ['urgent'], by: 'ct-isaias', at: '2026-05-14T14:00:00Z' },
    ];
    assert.deepStrictEqual(
      getStickyFields(history),
      new Set(['assignee_contact_id', 'tags']),
    );
  });

  it('skips entries missing a field key without throwing', () => {
    const history = [
      { verb: 'edited', value: 'orphan', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'size', value: 'small', by: 'ct-eric', at: '2026-05-14T11:00:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set(['size']));
  });

  it('skips entries where verb is missing without throwing', () => {
    const history = [
      { field: 'project_id', value: 'proj-x', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'priority', value: 'high', by: 'ct-isaias', at: '2026-05-14T11:00:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set(['priority']));
  });

  it('returns an empty Set for non-array inputs without throwing', () => {
    assert.deepStrictEqual(getStickyFields('not an array'), new Set());
    assert.deepStrictEqual(getStickyFields(42), new Set());
    assert.deepStrictEqual(getStickyFields({ verb: 'edited', field: 'project_id' }), new Set());
    assert.deepStrictEqual(getStickyFields(true), new Set());
  });

  it('returns a Set instance, never an Array or string', () => {
    const result = getStickyFields([
      { verb: 'edited', field: 'size', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
    ]);
    assert.ok(result instanceof Set, 'expected a Set');
    assert.ok(!Array.isArray(result), 'must not be an Array');
    assert.notStrictEqual(typeof result, 'string', 'must not be a string');
  });

  it('does not mutate its input array', () => {
    const history = [
      { verb: 'edited', field: 'project_id', value: 'proj-staqs', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
      { verb: 'done', by: 'ct-eric', at: '2026-05-14T11:00:00Z' },
      { verb: 'edited', field: 'size', value: 'small', by: 'ct-eric', at: '2026-05-14T12:00:00Z' },
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    const originalLength = history.length;
    const originalRef = history;

    getStickyFields(history);

    assert.strictEqual(history, originalRef, 'reference must be identical');
    assert.strictEqual(history.length, originalLength, 'length must be unchanged');
    assert.deepStrictEqual(history, snapshot, 'entries must be unchanged');
  });

  it('does not throw on malformed entries (null, non-object, missing keys)', () => {
    const history = [
      null,
      undefined,
      'string entry',
      42,
      [],
      { verb: 'edited', field: 'description', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
    ];
    assert.doesNotThrow(() => getStickyFields(history));
    assert.deepStrictEqual(getStickyFields(history), new Set(['description']));
  });

  // Real-scenario regression tests ------------------------------------------

  it('makes project_id and size sticky when the operator edited both in the panel', () => {
    const history = [
      { verb: 'edited', field: 'project_id', value: 'proj-staqs', by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'size', value: 'small', label: 'S', by: 'ct-isaias', at: '2026-05-14T10:01:00Z' },
    ];
    const sticky = getStickyFields(history);
    assert.ok(sticky.has('project_id'));
    assert.ok(sticky.has('size'));
    assert.strictEqual(sticky.size, 2);
  });

  it('treats two consecutive edits on description as a single sticky field', () => {
    const history = [
      { verb: 'edited', field: 'description', value: 'First draft', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'description', value: 'Second draft, clearer', by: 'ct-eric', at: '2026-05-14T10:30:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set(['description']));
  });

  it('does not make status sticky from a lifecycle transition verb', () => {
    const history = [
      { verb: 'transition', field: 'status', from_status: 'todo', to_status: 'in_progress', by: 'ct-eric', at: '2026-05-14T10:00:00Z' },
    ];
    const sticky = getStickyFields(history);
    assert.ok(!sticky.has('status'));
    assert.strictEqual(sticky.size, 0);
  });

  it('does not make assignee_contact_id sticky from a linear_pull update', () => {
    const history = [
      { verb: 'linear_pull', field: 'assignee_contact_id', value: 'ct-eric', at: '2026-05-14T10:00:00Z' },
      { verb: 'linear_pull', field: 'priority', value: 'high', at: '2026-05-14T10:01:00Z' },
    ];
    assert.deepStrictEqual(getStickyFields(history), new Set());
  });

  it('returns an empty Set for a never-touched task', () => {
    assert.deepStrictEqual(getStickyFields([]), new Set());
    assert.deepStrictEqual(getStickyFields(null), new Set());
  });
});
