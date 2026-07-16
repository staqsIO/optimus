/**
 * RED → GREEN — pure-function tests for the v0.2 extensions to
 * human-task-card.js:
 *
 *   - lifecycleTransitionsFor(card): valid verbs per status (FR-27, canonical
 *     transition table near FR-27 in the tech spec).
 *   - linearChipFor(card): chip render data (FR-30).
 *   - isFieldSticky(card, fieldName): sticky-marker presence in details panel
 *     (FR-3, AD-5, mirrors lib/runtime/human-task-sticky.js).
 *
 * Per ADR-004 these helpers are pure JS — node:test exercises them without RTL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lifecycleTransitionsFor,
  linearChipFor,
  isFieldSticky,
} from './human-task-card.js';

const card = (overrides = {}) => ({
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
  size: null,
  tags: [],
  next_action_hint: 'Open the PR',
  source_quote: 'Eric to ship the migration before EOW',
  needs_human: null,
  linear_issue_id: null,
  linear_issue_url: null,
  feedback_history: [],
  created_at: '2026-05-09T00:00:00.000Z',
  updated_at: '2026-05-10T00:00:00.000Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// lifecycleTransitionsFor
// ---------------------------------------------------------------------------

describe('lifecycleTransitionsFor', () => {
  const expectShape = (transitions) => {
    for (const t of transitions) {
      assert.equal(typeof t.verb, 'string');
      assert.equal(typeof t.label, 'string');
      assert.equal(typeof t.to_status, 'string');
    }
  };

  it('inbox → start (todo) + to_in_progress (in_progress)', () => {
    const t = lifecycleTransitionsFor(card({ status: 'inbox' }));
    assert.deepEqual(t, [
      { verb: 'start', label: 'Start', to_status: 'todo' },
      { verb: 'to_in_progress', label: 'Send to in-progress', to_status: 'in_progress' },
    ]);
    expectShape(t);
  });

  it('todo → start (in_progress) + to_inbox (inbox)', () => {
    const t = lifecycleTransitionsFor(card({ status: 'todo' }));
    assert.deepEqual(t, [
      { verb: 'start', label: 'Start', to_status: 'in_progress' },
      { verb: 'to_inbox', label: 'Return to inbox', to_status: 'inbox' },
    ]);
    expectShape(t);
  });

  it('later → start (in_progress) + to_inbox (inbox)', () => {
    const t = lifecycleTransitionsFor(card({ status: 'later' }));
    assert.deepEqual(t, [
      { verb: 'start', label: 'Start', to_status: 'in_progress' },
      { verb: 'to_inbox', label: 'Return to inbox', to_status: 'inbox' },
    ]);
    expectShape(t);
  });

  it('in_progress → block + to_review + to_todo', () => {
    const t = lifecycleTransitionsFor(card({ status: 'in_progress' }));
    assert.deepEqual(t, [
      { verb: 'block', label: 'Block', to_status: 'blocked' },
      { verb: 'to_review', label: 'Send to review', to_status: 'review' },
      { verb: 'to_todo', label: 'Return to todo', to_status: 'todo' },
    ]);
    expectShape(t);
  });

  it('blocked → unblock (in_progress) + to_todo (todo)', () => {
    const t = lifecycleTransitionsFor(card({ status: 'blocked' }));
    assert.deepEqual(t, [
      { verb: 'unblock', label: 'Unblock', to_status: 'in_progress' },
      { verb: 'to_todo', label: 'Return to todo', to_status: 'todo' },
    ]);
    expectShape(t);
  });

  it('review → to_in_progress only', () => {
    const t = lifecycleTransitionsFor(card({ status: 'review' }));
    assert.deepEqual(t, [
      { verb: 'to_in_progress', label: 'Return to in-progress', to_status: 'in_progress' },
    ]);
    expectShape(t);
  });

  it('proposed → [] (must clear is_this_ours gate first)', () => {
    assert.deepEqual(lifecycleTransitionsFor(card({ status: 'proposed' })), []);
  });

  it('terminal statuses (done / skipped / not_for_us) → []', () => {
    for (const status of ['done', 'skipped', 'not_for_us']) {
      assert.deepEqual(lifecycleTransitionsFor(card({ status })), []);
    }
  });

  it('non-human_task cards → []', () => {
    for (const kind of ['proposal', 'work_item', 'attention']) {
      assert.deepEqual(lifecycleTransitionsFor({ kind, status: 'inbox' }), []);
    }
  });

  it('falsy card → []', () => {
    assert.deepEqual(lifecycleTransitionsFor(null), []);
    assert.deepEqual(lifecycleTransitionsFor(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// linearChipFor
// ---------------------------------------------------------------------------

describe('linearChipFor', () => {
  it('human_task with linear_issue_id → chip with identifier + url + accent', () => {
    const chip = linearChipFor(
      card({
        linear_issue_id: 'abc123def456',
        linear_issue_url: 'https://linear.app/staqs/issue/STA-42',
      }),
    );
    assert.ok(chip);
    assert.equal(typeof chip.identifier, 'string');
    assert.ok(chip.identifier.length > 0);
    assert.equal(chip.url, 'https://linear.app/staqs/issue/STA-42');
    assert.equal(chip.accent, 'linear');
  });

  it('chip url matches card.linear_issue_url exactly', () => {
    const url = 'https://linear.app/staqs/issue/STA-99';
    const chip = linearChipFor(
      card({ linear_issue_id: 'xyz789', linear_issue_url: url }),
    );
    assert.equal(chip.url, url);
  });

  it('human_task without linear_issue_id → null', () => {
    assert.equal(linearChipFor(card({ linear_issue_id: null })), null);
    assert.equal(linearChipFor(card({ linear_issue_id: '' })), null);
    assert.equal(linearChipFor(card({ linear_issue_id: undefined })), null);
  });

  it('work_item card → null', () => {
    assert.equal(
      linearChipFor({ kind: 'work_item', linear_issue_id: 'whatever', linear_issue_url: 'x' }),
      null,
    );
  });

  it('proposal card → null', () => {
    assert.equal(
      linearChipFor({ kind: 'proposal', linear_issue_id: 'whatever', linear_issue_url: 'x' }),
      null,
    );
  });

  it('attention card → null', () => {
    assert.equal(
      linearChipFor({ kind: 'attention', linear_issue_id: 'whatever', linear_issue_url: 'x' }),
      null,
    );
  });

  it('falsy card → null', () => {
    assert.equal(linearChipFor(null), null);
    assert.equal(linearChipFor(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// isFieldSticky
// ---------------------------------------------------------------------------

describe('isFieldSticky', () => {
  it('feedback_history with {verb:"edited", field:"project_id"} → true for project_id', () => {
    const c = card({
      feedback_history: [
        { verb: 'edited', field: 'project_id', value: 'p-1', by: 'eric', at: '2026-05-10' },
      ],
    });
    assert.equal(isFieldSticky(c, 'project_id'), true);
  });

  it('an edited entry for one field does not stick other fields', () => {
    const c = card({
      feedback_history: [
        { verb: 'edited', field: 'project_id', value: 'p-1', by: 'eric', at: '2026-05-10' },
      ],
    });
    assert.equal(isFieldSticky(c, 'assignee_contact_id'), false);
    assert.equal(isFieldSticky(c, 'size'), false);
    assert.equal(isFieldSticky(c, 'engagement_id'), false);
  });

  it('no feedback_history → false', () => {
    assert.equal(isFieldSticky(card({ feedback_history: null }), 'project_id'), false);
    assert.equal(isFieldSticky(card({ feedback_history: undefined }), 'project_id'), false);
    assert.equal(isFieldSticky(card({ feedback_history: [] }), 'project_id'), false);
  });

  it('non-edited verbs (transition, linear_pull, linear_push, llm_decision) → not sticky', () => {
    const c = card({
      feedback_history: [
        { verb: 'transition', from_status: 'inbox', to_status: 'todo' },
        { verb: 'linear_pull', field: 'project_id' },
        { verb: 'linear_push', field: 'project_id' },
        { verb: 'llm_decision', field: 'project_id', guardrail_id: 'g-1' },
      ],
    });
    assert.equal(isFieldSticky(c, 'project_id'), false);
  });

  it('multiple edits across fields → each is sticky', () => {
    const c = card({
      feedback_history: [
        { verb: 'edited', field: 'project_id' },
        { verb: 'transition', from_status: 'inbox', to_status: 'todo' },
        { verb: 'edited', field: 'size' },
      ],
    });
    assert.equal(isFieldSticky(c, 'project_id'), true);
    assert.equal(isFieldSticky(c, 'size'), true);
    assert.equal(isFieldSticky(c, 'assignee_contact_id'), false);
  });

  it('malformed history entries are ignored', () => {
    const c = card({
      feedback_history: [
        null,
        'not-an-object',
        { verb: 'edited' /* missing field */ },
        { verb: 'edited', field: 123 /* wrong type */ },
        { verb: 'edited', field: 'project_id' },
      ],
    });
    assert.equal(isFieldSticky(c, 'project_id'), true);
    assert.equal(isFieldSticky(c, 'size'), false);
  });

  it('falsy card → false', () => {
    assert.equal(isFieldSticky(null, 'project_id'), false);
    assert.equal(isFieldSticky(undefined, 'project_id'), false);
  });

  it('falsy fieldName → false', () => {
    const c = card({
      feedback_history: [{ verb: 'edited', field: 'project_id' }],
    });
    assert.equal(isFieldSticky(c, null), false);
    assert.equal(isFieldSticky(c, ''), false);
    assert.equal(isFieldSticky(c, undefined), false);
  });
});
