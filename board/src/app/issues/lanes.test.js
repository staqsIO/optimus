// RED step of TDD cycle for computeLanes.
// Per ADR-004: pure-function frontend tests run under node:test, no RTL.
// Convention chosen: plain .test.js importing from ./lanes.js.
//   - Avoids adding tsx/ts-node deps for v1.
//   - GREEN step will create lanes.ts; the build/dev pipeline (Next 15) emits
//     ESM that this test can import, OR GREEN can write a sibling lanes.js.
//   - Either way, the test stays framework-free per ADR-004.
// Node version on dev box: v24.14.0 (supports --experimental-strip-types,
// but we deliberately do not rely on it to keep the test command boring).
//
// Run: cd board && node --test src/app/board/lanes.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeLanes } from './lanes.js';

// ---------- fixtures ----------

const makeWorkItem = (overrides = {}) => ({
  kind: 'work_item',
  id: 'wi-1',
  type: 'directive',
  title: 'Example work item',
  status: 'in_progress',
  assigned_to: 'agent-a',
  created_by: 'board',
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-10T00:00:00.000Z',
  ...overrides,
});

const makeProposal = (overrides = {}) => ({
  kind: 'proposal',
  id: 'prop-1',
  title: 'Approve outbound email',
  action_type: 'send_email',
  work_item_id: 'wi-2',
  created_at: '2026-05-09T00:00:00.000Z',
  ...overrides,
});

const makeAttention = (overrides = {}) => ({
  kind: 'attention',
  id: 'att-1',
  title: 'Voice mismatch on draft',
  signature: 'voice_mismatch:wi-3',
  work_item_id: 'wi-3',
  created_at: '2026-05-09T00:00:00.000Z',
  ...overrides,
});

const makeHumanTask = (overrides = {}) => ({
  kind: 'human_task',
  id: 'htm-1',
  title: 'Eric to ship the migration',
  status: 'inbox',
  priority: 'normal',
  task_type: 'action',
  due_date: null,
  assignee_contact_id: 'ct-eric',
  assignee_label: 'Eric Gang',
  assignee_confidence: 0.9,
  tags: [],
  next_action_hint: 'Open the PR',
  source_quote: 'Eric to ship the migration before EOW',
  needs_human: null,
  created_at: '2026-05-09T00:00:00.000Z',
  updated_at: '2026-05-10T00:00:00.000Z',
  ...overrides,
});

const emptyBoardData = () => ({
  lanes: {
    needs_you: [],
    created: [],
    assigned: [],
    in_progress: [],
    review: [],
    completed: [],
  },
});

const populatedBoardData = () => ({
  lanes: {
    needs_you: [makeProposal(), makeAttention()],
    created: [makeWorkItem({ id: 'wi-c1', status: 'created' })],
    assigned: [makeWorkItem({ id: 'wi-a1', status: 'assigned' })],
    in_progress: [makeWorkItem({ id: 'wi-ip1', status: 'in_progress' })],
    review: [makeWorkItem({ id: 'wi-r1', status: 'review' })],
    completed: [makeWorkItem({ id: 'wi-d1', status: 'completed' })],
  },
});

const EXPECTED_ORDER = [
  'needs_you',
  'created',
  'assigned',
  'in_progress',
  'review',
  'completed',
];

// ---------- tests ----------

describe('computeLanes', () => {
  it('returns lanes in fixed display order', () => {
    const result = computeLanes(populatedBoardData());
    assert.deepEqual(
      result.map((l) => l.id),
      EXPECTED_ORDER,
    );
  });

  it('returns all six lanes even when every lane is empty', () => {
    const result = computeLanes(emptyBoardData());
    assert.equal(result.length, 6);
    assert.deepEqual(
      result.map((l) => l.id),
      EXPECTED_ORDER,
    );
    for (const lane of result) {
      assert.deepEqual(lane.cards, [], `lane ${lane.id} should have no cards`);
    }
  });

  it('marks needs_you as emphasis="human" and the rest as emphasis="flow"', () => {
    const result = computeLanes(populatedBoardData());
    const byId = Object.fromEntries(result.map((l) => [l.id, l]));
    assert.equal(byId.needs_you.emphasis, 'human');
    assert.equal(byId.created.emphasis, 'flow');
    assert.equal(byId.assigned.emphasis, 'flow');
    assert.equal(byId.in_progress.emphasis, 'flow');
    assert.equal(byId.review.emphasis, 'flow');
    assert.equal(byId.completed.emphasis, 'flow');
  });

  it('assigns human-readable lane titles', () => {
    const result = computeLanes(populatedBoardData());
    const byId = Object.fromEntries(result.map((l) => [l.id, l]));
    assert.equal(byId.needs_you.title, 'Needs you');
    assert.equal(byId.created.title, 'Created');
    assert.equal(byId.assigned.title, 'Assigned');
    assert.equal(byId.in_progress.title, 'In progress');
    assert.equal(byId.review.title, 'Review');
    assert.equal(byId.completed.title, 'Completed');
  });

  it('passes work_item cards through to the matching lane with all fields preserved', () => {
    const card = makeWorkItem({
      id: 'wi-ip-passthrough',
      type: 'workstream',
      title: 'Carry me through',
      status: 'in_progress',
      assigned_to: 'agent-b',
      created_by: 'eric',
      created_at: '2026-04-30T12:00:00.000Z',
      updated_at: '2026-05-10T08:30:00.000Z',
    });
    const data = emptyBoardData();
    data.lanes.in_progress = [card];

    const result = computeLanes(data);
    const lane = result.find((l) => l.id === 'in_progress');
    assert.ok(lane, 'in_progress lane should exist');
    assert.equal(lane.cards.length, 1);
    assert.deepEqual(lane.cards[0], card);
  });

  it('preserves both proposal and attention kinds in needs_you with no field loss', () => {
    const proposal = makeProposal({
      id: 'prop-keep',
      title: 'Keep me intact',
      action_type: 'send_slack',
      work_item_id: null,
      created_at: '2026-05-08T00:00:00.000Z',
    });
    const attention = makeAttention({
      id: 'att-keep',
      title: 'Also keep me',
      signature: 'sig:keep',
      work_item_id: 'wi-keep',
      created_at: '2026-05-09T00:00:00.000Z',
    });
    const data = emptyBoardData();
    data.lanes.needs_you = [proposal, attention];

    const result = computeLanes(data);
    const lane = result.find((l) => l.id === 'needs_you');
    assert.ok(lane);
    assert.equal(lane.cards.length, 2);

    const gotProposal = lane.cards.find((c) => c.kind === 'proposal');
    const gotAttention = lane.cards.find((c) => c.kind === 'attention');
    assert.ok(gotProposal, 'proposal card should be present');
    assert.ok(gotAttention, 'attention card should be present');
    assert.deepEqual(gotProposal, proposal);
    assert.deepEqual(gotAttention, attention);
  });

  it('does not mutate its input', () => {
    const input = populatedBoardData();
    const clone = JSON.parse(JSON.stringify(input));
    computeLanes(input);
    assert.deepStrictEqual(input, clone);
  });

  it('passes human_task cards through any lane (PRD meeting-actions-to-kanban §11.2)', () => {
    // computeLanes is pass-through. The API layer pre-buckets human_tasks
    // (see lib/runtime/board-human-tasks.js), so by the time data arrives
    // here every card is already on the right lane. This test guards
    // against a regression where someone "filters" human_task cards out
    // of any non-needs_you lane.
    const inboxHuman = makeHumanTask({ id: 'htm-created', status: 'inbox' });
    const todoHuman = makeHumanTask({ id: 'htm-assigned', status: 'todo' });
    const reviewHuman = makeHumanTask({ id: 'htm-review', status: 'review' });

    const data = emptyBoardData();
    data.lanes.created = [inboxHuman];
    data.lanes.assigned = [todoHuman];
    data.lanes.review = [reviewHuman];

    const result = computeLanes(data);
    const byId = Object.fromEntries(result.map((l) => [l.id, l]));
    assert.deepStrictEqual(byId.created.cards[0], inboxHuman);
    assert.deepStrictEqual(byId.assigned.cards[0], todoHuman);
    assert.deepStrictEqual(byId.review.cards[0], reviewHuman);
  });

  it('human_task cards coexist with work_item and proposal cards on the same lane', () => {
    const proposal = makeProposal({ id: 'prop-mix' });
    const human = makeHumanTask({ id: 'htm-mix', status: 'inbox' });
    const data = emptyBoardData();
    data.lanes.needs_you = [proposal, human];

    const lane = computeLanes(data).find((l) => l.id === 'needs_you');
    assert.equal(lane.cards.length, 2);
    assert.ok(lane.cards.some((c) => c.kind === 'proposal'));
    assert.ok(lane.cards.some((c) => c.kind === 'human_task'));
  });
});
