/**
 * RED — board/src/app/board/human-task-card.js does not exist yet.
 *
 * Pure-function tests for the visual contract of a human_task card
 * (PRD meeting-actions-to-kanban §7):
 *
 *   - Assignee chip text: initials from assignee_label; "?" when unknown.
 *   - Left-border accent class: amber for human-owned, blue for agent-owned,
 *     and dashed amber for unassigned human cards.
 *   - Card action set: always 4 verbs (done/skip/later/not_for_me) for
 *     non-terminal human_task cards; empty array for terminal.
 *   - Inline question selection: picks ONE missing field per PRD §7
 *     ("at most one inline question per card at a time"), prioritising
 *     assignee > due > size.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assigneeChip,
  cardAccentClass,
  cardActions,
  inlineQuestionFor,
  formatNeedsHuman,
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
  created_at: '2026-05-09T00:00:00.000Z',
  updated_at: '2026-05-10T00:00:00.000Z',
  ...overrides,
});

describe('assigneeChip', () => {
  it('initials from a full name', () => {
    assert.equal(assigneeChip(card()).initials, 'EG');
  });

  it('single name → first letter only', () => {
    assert.equal(assigneeChip(card({ assignee_label: 'Eric' })).initials, 'E');
  });

  it('handles three+ tokens by using first + last', () => {
    assert.equal(
      assigneeChip(card({ assignee_label: 'Mary Ann Bishop' })).initials,
      'MB',
    );
  });

  it('no assignee → "?" placeholder + dashed style flag', () => {
    const chip = assigneeChip(
      card({ assignee_contact_id: null, assignee_label: null }),
    );
    assert.equal(chip.initials, '?');
    assert.equal(chip.dashed, true);
  });

  it('strips non-letter characters when computing initials', () => {
    assert.equal(
      assigneeChip(card({ assignee_label: "Eric O'Brien" })).initials,
      'EO',
    );
  });

  it('agent cards (kind="work_item") return a glyph chip instead of initials', () => {
    const chip = assigneeChip({
      kind: 'work_item',
      assigned_to: 'architect',
    });
    assert.equal(chip.glyph, '⌬');
    assert.equal(chip.label, 'architect');
    assert.equal(chip.initials, null);
  });
});

describe('cardAccentClass', () => {
  it('human_task with assignee → amber accent', () => {
    const c = cardAccentClass(card());
    assert.match(c, /amber/);
    assert.equal(/blue/.test(c), false);
  });

  it('human_task with NO assignee → dashed amber', () => {
    const c = cardAccentClass(card({ assignee_contact_id: null, assignee_label: null }));
    assert.match(c, /amber/);
    assert.match(c, /dashed/);
  });

  it('agent card (work_item) → blue accent', () => {
    const c = cardAccentClass({ kind: 'work_item' });
    assert.match(c, /blue/);
  });

  it('proposal / attention → human-leaning accent (amber)', () => {
    assert.match(cardAccentClass({ kind: 'proposal' }), /amber/);
    assert.match(cardAccentClass({ kind: 'attention' }), /amber/);
  });
});

describe('cardActions', () => {
  it('returns the four PRD §7 verbs on a non-terminal human_task', () => {
    const a = cardActions(card());
    assert.deepEqual(a, ['done', 'skip', 'later', 'not_for_me']);
  });

  it('returns [] on terminal statuses (done/skipped/not_for_us)', () => {
    for (const status of ['done', 'skipped', 'not_for_us']) {
      assert.deepEqual(cardActions(card({ status })), []);
    }
  });

  it('returns [] for non-human kinds (proposal/work_item/attention)', () => {
    for (const kind of ['proposal', 'work_item', 'attention']) {
      assert.deepEqual(cardActions({ kind }), []);
    }
  });
});

describe('inlineQuestionFor — at most one question per card', () => {
  it('no assignee → asks "who_owns" first (PRD §7: assignee > due > size)', () => {
    const q = inlineQuestionFor(card({ assignee_contact_id: null, assignee_label: null }));
    assert.equal(q.field, 'assignee');
  });

  it('proposed status with no question → asks "is_this_ours" first', () => {
    const q = inlineQuestionFor(
      card({ status: 'proposed', assignee_contact_id: 'ct-eric' }),
    );
    assert.equal(q.field, 'is_this_ours');
  });

  it('missing due_date but has assignee → asks "when"', () => {
    const q = inlineQuestionFor(card({ due_date: null, assignee_contact_id: 'ct-eric' }));
    assert.equal(q.field, 'when');
  });

  it('missing size but has assignee + due → asks "size"', () => {
    const q = inlineQuestionFor(
      card({ assignee_contact_id: 'ct-eric', due_date: '2026-06-01', size: null }),
    );
    assert.equal(q.field, 'size');
  });

  it('all fields present → no question', () => {
    assert.equal(
      inlineQuestionFor(card({
        assignee_contact_id: 'ct-eric',
        due_date: '2026-06-01',
        size: 'small',
      })),
      null,
    );
  });

  it('terminal status → no question (PRD: terminals are immutable)', () => {
    assert.equal(inlineQuestionFor(card({ status: 'done', size: null })), null);
  });
});

describe('formatNeedsHuman', () => {
  it('renders an empty string when needs_human is null', () => {
    assert.equal(formatNeedsHuman(card({ needs_human: null })), '');
  });

  it('renders the trigger label + hint when needs_human is set', () => {
    const out = formatNeedsHuman(
      card({
        needs_human: {
          trigger: 'urgent_in_inbox',
          since: '2026-05-10T00:00:00Z',
          hint: 'Urgent — confirm and act',
        },
      }),
    );
    assert.match(out, /urgent/i);
    assert.match(out, /confirm/i);
  });
});
