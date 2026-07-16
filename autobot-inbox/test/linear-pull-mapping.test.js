/**
 * RED step (TDD) — lib/linear/pull-mapping.js does not exist yet.
 *
 * Pure-function tests for the Linear webhook → human_tasks patch mapper.
 *
 * Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-13, FR-17,
 * FR-18, FR-19, NFR-4; sequencing §7 Week 3 task 12):
 *
 *   mapLinearEventToPatch({ payload, mappingFromGuardrail })
 *     → { patch, status_changed, terminal }
 *
 *   - Issue event with state change → translate state id via guardrail
 *     mapping; if state id is NOT in the mapping, status stays unset and
 *     a warn is logged.
 *   - Issue event with assignee change → patch.linear_assignee_id.
 *   - Issue event with project change → patch.linear_project_id.
 *   - Issue title change → patch.title.
 *   - Issue description change → patch.description.
 *   - Linear priority 1→urgent, 2→high, 3→normal, 4→low; priority 0
 *     yields no priority field in patch.
 *   - Comment event → empty patch, status_changed=false, terminal=false.
 *   - Issue remove event → patch.status='not_for_us', terminal=true.
 *   - terminal=true iff the patch sets status to 'done' or 'not_for_us'.
 *   - linear_last_event_at is always set on issue events.
 *   - Empty / null payload → empty patch (defensive, no throw).
 *
 * Style: pure-function action sentences. No DB, no I/O.
 *
 * Run:
 *   cd autobot-inbox && node --test test/linear-pull-mapping.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapLinearEventToPatch } from '../../lib/linear/pull-mapping.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A guardrail mapping aligned with FR-25 defaults plus a custom "review".
const MAPPING = {
  'st-backlog':   'inbox',
  'st-todo':      'todo',
  'st-progress':  'in_progress',
  'st-review':    'review',
  'st-done':      'done',
  'st-cancelled': 'not_for_us',
};

function makeIssueUpdatePayload(overrides = {}) {
  return {
    action: 'update',
    type: 'Issue',
    data: {
      id: 'lin-issue-pm-1',
      title: 'Eric to review the proposal',
      description: 'Body content.',
      assigneeId: 'u-eric',
      projectId: 'p-staqspro',
      priority: 3,
      state: { id: 'st-progress', name: 'In Progress', type: 'started' },
      stateId: 'st-progress',
      ...overrides.data,
    },
    updatedFrom: overrides.updatedFrom ?? {},
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== 'data' && k !== 'updatedFrom'),
    ),
  };
}

function makeIssueCreatePayload(overrides = {}) {
  return { ...makeIssueUpdatePayload(overrides), action: 'create' };
}

function makeIssueRemovePayload(overrides = {}) {
  return { ...makeIssueUpdatePayload(overrides), action: 'remove' };
}

function makeCommentPayload(overrides = {}) {
  return {
    action: 'create',
    type: 'Comment',
    data: {
      id: 'cmt-pm-1',
      body: '@optimus done',
      issueId: 'lin-issue-pm-1',
      issue: { id: 'lin-issue-pm-1' },
      user: { id: 'u-eric', name: 'Eric Gang' },
      ...overrides.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Issue state change
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — Issue state change', () => {
  it('maps a known state id to the patched status', () => {
    const payload = makeIssueUpdatePayload({
      data: { state: { id: 'st-progress', name: 'In Progress', type: 'started' } },
      updatedFrom: { stateId: 'st-todo' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.status, 'in_progress');
    assert.equal(result.patch.linear_state_id, 'st-progress');
    assert.equal(result.patch.linear_state_name, 'In Progress');
    assert.equal(result.status_changed, true);
    assert.equal(result.terminal, false);
  });

  it('sets terminal=true when the new mapped status is "done"', () => {
    const payload = makeIssueUpdatePayload({
      data: { state: { id: 'st-done', name: 'Done', type: 'completed' } },
      updatedFrom: { stateId: 'st-progress' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.status, 'done');
    assert.equal(result.status_changed, true);
    assert.equal(result.terminal, true);
  });

  it('sets terminal=true when the new mapped status is "not_for_us"', () => {
    const payload = makeIssueUpdatePayload({
      data: { state: { id: 'st-cancelled', name: 'Cancelled', type: 'canceled' } },
      updatedFrom: { stateId: 'st-progress' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.status, 'not_for_us');
    assert.equal(result.terminal, true);
    assert.equal(result.status_changed, true);
  });

  it('omits status from patch when the state id is not in the guardrail mapping', () => {
    const payload = makeIssueUpdatePayload({
      data: { state: { id: 'st-UNKNOWN', name: 'Custom', type: 'started' } },
      updatedFrom: { stateId: 'st-todo' },
    });

    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => { warned.push(args); };
    let result;
    try {
      result = mapLinearEventToPatch({
        payload,
        mappingFromGuardrail: MAPPING,
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'status'),
      false,
      'unknown state id must NOT set status in patch',
    );
    // linear_state_id/name should still be mirrored for observability.
    assert.equal(result.patch.linear_state_id, 'st-UNKNOWN');
    assert.equal(result.status_changed, false);
    assert.equal(result.terminal, false);
    assert.ok(
      warned.length >= 1,
      'a warn must surface when the state id is not in the mapping',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue scalar field changes
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — Issue scalar fields', () => {
  it('captures an assignee change as linear_assignee_id in the patch', () => {
    const payload = makeIssueUpdatePayload({
      data: { assigneeId: 'u-isaias' },
      updatedFrom: { assigneeId: 'u-eric' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.linear_assignee_id, 'u-isaias');
  });

  it('captures a project change as linear_project_id in the patch', () => {
    const payload = makeIssueUpdatePayload({
      data: { projectId: 'p-formul8' },
      updatedFrom: { projectId: 'p-staqspro' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.linear_project_id, 'p-formul8');
  });

  it('captures a title change as patch.title', () => {
    const payload = makeIssueUpdatePayload({
      data: { title: 'Renamed by Eric in Linear' },
      updatedFrom: { title: 'Eric to review the proposal' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.title, 'Renamed by Eric in Linear');
  });

  it('captures a description change as patch.description', () => {
    const payload = makeIssueUpdatePayload({
      data: { description: 'Updated body content.' },
      updatedFrom: { description: 'Body content.' },
    });

    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.description, 'Updated body content.');
  });
});

// ---------------------------------------------------------------------------
// Priority mapping (Linear 0-4 → our urgent/high/normal/low)
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — Priority mapping', () => {
  it('maps Linear priority 1 to "urgent"', () => {
    const payload = makeIssueUpdatePayload({
      data: { priority: 1 },
      updatedFrom: { priority: 2 },
    });
    const { patch } = mapLinearEventToPatch({ payload, mappingFromGuardrail: MAPPING });
    assert.equal(patch.priority, 'urgent');
  });

  it('maps Linear priority 2 to "high"', () => {
    const payload = makeIssueUpdatePayload({
      data: { priority: 2 },
      updatedFrom: { priority: 3 },
    });
    const { patch } = mapLinearEventToPatch({ payload, mappingFromGuardrail: MAPPING });
    assert.equal(patch.priority, 'high');
  });

  it('maps Linear priority 3 to "normal"', () => {
    const payload = makeIssueUpdatePayload({
      data: { priority: 3 },
      updatedFrom: { priority: 4 },
    });
    const { patch } = mapLinearEventToPatch({ payload, mappingFromGuardrail: MAPPING });
    assert.equal(patch.priority, 'normal');
  });

  it('maps Linear priority 4 to "low"', () => {
    const payload = makeIssueUpdatePayload({
      data: { priority: 4 },
      updatedFrom: { priority: 3 },
    });
    const { patch } = mapLinearEventToPatch({ payload, mappingFromGuardrail: MAPPING });
    assert.equal(patch.priority, 'low');
  });

  it('omits priority from patch when Linear priority is 0 (no priority)', () => {
    const payload = makeIssueUpdatePayload({
      data: { priority: 0 },
      updatedFrom: { priority: 2 },
    });
    const { patch } = mapLinearEventToPatch({ payload, mappingFromGuardrail: MAPPING });
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, 'priority'),
      false,
      'Linear priority 0 must NOT add a priority field to the patch',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue remove (terminal)
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — Issue remove', () => {
  it('treats a remove event as terminal not_for_us', () => {
    const payload = makeIssueRemovePayload({});
    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    assert.equal(result.patch.status, 'not_for_us');
    assert.equal(result.terminal, true);
    assert.equal(result.status_changed, true);
  });
});

// ---------------------------------------------------------------------------
// Comment events
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — Comment events', () => {
  it('produces an empty patch for comment events (no Issue fields touched)', () => {
    const payload = makeCommentPayload({});
    const result = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });

    // No status, title, description, project, assignee, priority changes.
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'status'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'title'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'description'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'linear_assignee_id'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'linear_project_id'),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'priority'),
      false,
    );

    assert.equal(result.status_changed, false);
    assert.equal(result.terminal, false);
  });
});

// ---------------------------------------------------------------------------
// linear_last_event_at stamp
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — linear_last_event_at', () => {
  it('always stamps linear_last_event_at on issue update events', () => {
    const payload = makeIssueUpdatePayload({
      data: { assigneeId: 'u-isaias' },
      updatedFrom: { assigneeId: 'u-eric' },
    });

    const before = Date.now();
    const { patch } = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });
    const after = Date.now();

    assert.ok(patch.linear_last_event_at, 'linear_last_event_at must be set');
    const stamped = new Date(patch.linear_last_event_at).getTime();
    assert.ok(
      stamped >= before - 1000 && stamped <= after + 5000,
      `linear_last_event_at (${patch.linear_last_event_at}) must be ~now`,
    );
  });

  it('always stamps linear_last_event_at on issue create events', () => {
    const payload = makeIssueCreatePayload({});
    const { patch } = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });
    assert.ok(patch.linear_last_event_at);
  });

  it('always stamps linear_last_event_at on issue remove events', () => {
    const payload = makeIssueRemovePayload({});
    const { patch } = mapLinearEventToPatch({
      payload,
      mappingFromGuardrail: MAPPING,
    });
    assert.ok(patch.linear_last_event_at);
  });
});

// ---------------------------------------------------------------------------
// Defensive / null inputs
// ---------------------------------------------------------------------------

describe('mapLinearEventToPatch — defensive paths', () => {
  it('returns an empty patch for a null payload (no throw)', () => {
    const result = mapLinearEventToPatch({
      payload: null,
      mappingFromGuardrail: MAPPING,
    });
    assert.deepEqual(result.patch, {});
    assert.equal(result.status_changed, false);
    assert.equal(result.terminal, false);
  });

  it('returns an empty patch for an undefined payload (no throw)', () => {
    const result = mapLinearEventToPatch({
      payload: undefined,
      mappingFromGuardrail: MAPPING,
    });
    assert.deepEqual(result.patch, {});
    assert.equal(result.status_changed, false);
    assert.equal(result.terminal, false);
  });

  it('returns an empty patch for a payload with no data block', () => {
    const result = mapLinearEventToPatch({
      payload: { action: 'update', type: 'Issue' },
      mappingFromGuardrail: MAPPING,
    });
    assert.deepEqual(result.patch, {});
    assert.equal(result.status_changed, false);
  });

  it('tolerates a missing/empty mapping (no status change, no throw)', () => {
    const payload = makeIssueUpdatePayload({
      data: { state: { id: 'st-progress', name: 'In Progress', type: 'started' } },
      updatedFrom: { stateId: 'st-todo' },
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = mapLinearEventToPatch({
        payload,
        mappingFromGuardrail: {},
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(
      Object.prototype.hasOwnProperty.call(result.patch, 'status'),
      false,
    );
    assert.equal(result.status_changed, false);
  });
});
