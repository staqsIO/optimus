/**
 * RED — board/src/app/governance/guardrails/state-mapper.js does not exist.
 *
 * FR-22 + FR-25 (Settings → LLM Guardrails / state mapping editor).
 *
 *   - buildMapperRows(workflowStates, mapping)
 *       → [{ state_id, state_name, state_type, current_status, suggested_status }]
 *
 *       suggested_status follows FR-25 defaults (matches
 *       lib/linear/team-cache.js → bootstrapDefaultMapping):
 *         backlog   → inbox
 *         unstarted → todo
 *         started   → in_progress
 *         completed → done
 *         canceled  → not_for_us
 *         other     → inbox
 *
 *       Sort by `position` ascending if present on all states,
 *       else by `name` ascending.
 *
 *   - mapperRowsToMapping(rows) → {state_id: status}
 *
 *       Rows with null/undefined current_status are dropped from the
 *       output mapping (key absent, not set to null).
 *
 * ADR-004: pure JS + JSDoc, node:test only, no RTL.
 * Run: cd board && node --test src/app/governance/guardrails/state-mapper.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMapperRows,
  mapperRowsToMapping,
} from './state-mapper.js';

// ---------- fixtures ----------

const states = () => [
  { id: 's-backlog',   name: 'Backlog',          type: 'backlog',   position: 0 },
  { id: 's-todo',      name: 'Todo',             type: 'unstarted', position: 1 },
  { id: 's-doing',     name: 'In Progress',      type: 'started',   position: 2 },
  { id: 's-done',      name: 'Done',             type: 'completed', position: 3 },
  { id: 's-cancelled', name: 'Cancelled',        type: 'canceled',  position: 4 },
];

// ---------------------------------------------------------------------------
// buildMapperRows
// ---------------------------------------------------------------------------

describe('buildMapperRows', () => {
  it('emits one row per workflow state', () => {
    const rows = buildMapperRows(states(), {});
    assert.equal(rows.length, 5);
  });

  it('emits a row with all five contract fields', () => {
    const rows = buildMapperRows(states(), {});
    const row = rows[0];
    assert.ok('state_id' in row);
    assert.ok('state_name' in row);
    assert.ok('state_type' in row);
    assert.ok('current_status' in row);
    assert.ok('suggested_status' in row);
  });

  it('pulls current_status from the mapping arg', () => {
    const mapping = { 's-backlog': 'inbox', 's-doing': 'in_progress' };
    const rows = buildMapperRows(states(), mapping);
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-backlog'].current_status, 'inbox');
    assert.equal(byId['s-doing'].current_status, 'in_progress');
  });

  it('sets current_status to null when the state is not in the mapping', () => {
    const rows = buildMapperRows(states(), { 's-backlog': 'inbox' });
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-todo'].current_status, null);
    assert.equal(byId['s-doing'].current_status, null);
  });

  it('sets suggested_status from FR-25 default for type=backlog → inbox', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-backlog'].suggested_status, 'inbox');
  });

  it('sets suggested_status from FR-25 default for type=unstarted → todo', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-todo'].suggested_status, 'todo');
  });

  it('sets suggested_status from FR-25 default for type=started → in_progress', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-doing'].suggested_status, 'in_progress');
  });

  it('sets suggested_status from FR-25 default for type=completed → done', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-done'].suggested_status, 'done');
  });

  it('sets suggested_status from FR-25 default for type=canceled → not_for_us', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-cancelled'].suggested_status, 'not_for_us');
  });

  it('falls back to inbox for unknown/custom state types', () => {
    const rows = buildMapperRows(
      [{ id: 's-weird', name: 'Custom', type: 'triage', position: 0 }],
      {},
    );
    assert.equal(rows[0].suggested_status, 'inbox');
  });

  it('falls back to inbox when state.type is null or absent', () => {
    const rows = buildMapperRows(
      [
        { id: 's-no-type', name: 'No Type', type: null, position: 0 },
        { id: 's-missing', name: 'Missing Type', position: 1 },
      ],
      {},
    );
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-no-type'].suggested_status, 'inbox');
    assert.equal(byId['s-missing'].suggested_status, 'inbox');
  });

  it('sorts by position ascending when position is present on all states', () => {
    const shuffled = [
      { id: 's-d', name: 'Zebra', type: 'completed', position: 3 },
      { id: 's-a', name: 'Yak',   type: 'backlog',   position: 0 },
      { id: 's-c', name: 'Wolf',  type: 'started',   position: 2 },
      { id: 's-b', name: 'Bear',  type: 'unstarted', position: 1 },
    ];
    const rows = buildMapperRows(shuffled, {});
    assert.deepEqual(
      rows.map((r) => r.state_id),
      ['s-a', 's-b', 's-c', 's-d'],
    );
  });

  it('sorts by name ascending when position is missing on any state', () => {
    const noPos = [
      { id: 's-zebra', name: 'Zebra', type: 'backlog' },
      { id: 's-apple', name: 'Apple', type: 'unstarted' },
      { id: 's-mango', name: 'Mango', type: 'started' },
    ];
    const rows = buildMapperRows(noPos, {});
    assert.deepEqual(
      rows.map((r) => r.state_name),
      ['Apple', 'Mango', 'Zebra'],
    );
  });

  it('preserves state_name and state_type verbatim', () => {
    const rows = buildMapperRows(states(), {});
    const byId = Object.fromEntries(rows.map((r) => [r.state_id, r]));
    assert.equal(byId['s-backlog'].state_name, 'Backlog');
    assert.equal(byId['s-backlog'].state_type, 'backlog');
    assert.equal(byId['s-doing'].state_name, 'In Progress');
    assert.equal(byId['s-doing'].state_type, 'started');
  });

  it('returns an empty array when no workflow states are supplied', () => {
    assert.deepEqual(buildMapperRows([], {}), []);
  });
});

// ---------------------------------------------------------------------------
// mapperRowsToMapping
// ---------------------------------------------------------------------------

describe('mapperRowsToMapping', () => {
  it('extracts current mapping from rows whose current_status is set', () => {
    const rows = [
      { state_id: 's1', state_name: 'A', state_type: 'backlog',
        current_status: 'inbox',       suggested_status: 'inbox' },
      { state_id: 's2', state_name: 'B', state_type: 'started',
        current_status: 'in_progress', suggested_status: 'in_progress' },
    ];
    assert.deepEqual(mapperRowsToMapping(rows), {
      s1: 'inbox',
      s2: 'in_progress',
    });
  });

  it('omits rows whose current_status is null', () => {
    const rows = [
      { state_id: 's1', state_name: 'A', state_type: 'backlog',
        current_status: 'inbox', suggested_status: 'inbox' },
      { state_id: 's2', state_name: 'B', state_type: 'started',
        current_status: null,    suggested_status: 'in_progress' },
    ];
    const out = mapperRowsToMapping(rows);
    assert.deepEqual(out, { s1: 'inbox' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 's2'), false);
  });

  it('omits rows whose current_status is undefined', () => {
    const rows = [
      { state_id: 's1', state_name: 'A', state_type: 'backlog',
        current_status: 'todo', suggested_status: 'todo' },
      { state_id: 's2', state_name: 'B', state_type: 'unstarted',
        suggested_status: 'todo' }, // current_status undefined
    ];
    const out = mapperRowsToMapping(rows);
    assert.deepEqual(out, { s1: 'todo' });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 's2'), false);
  });

  it('returns an empty object for an empty rows list', () => {
    assert.deepEqual(mapperRowsToMapping([]), {});
  });

  it('round-trips: buildMapperRows → mapperRowsToMapping preserves the original mapping', () => {
    const mapping = {
      's-backlog':   'inbox',
      's-doing':     'in_progress',
      's-cancelled': 'not_for_us',
    };
    const rows = buildMapperRows(states(), mapping);
    assert.deepEqual(mapperRowsToMapping(rows), mapping);
  });
});
