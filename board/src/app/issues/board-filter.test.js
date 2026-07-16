/**
 * RED — board/src/app/board/board-filter.js does not exist.
 *
 * PRD §7 "Telling agent cards apart from human cards":
 *   - 4-way filter (Mine / Humans / Agents / All)
 *   - default = Humans for board members, All for staff/admin
 *   - persists in URL (?view=) and localStorage
 *   - filters affect *population*, not *columns* — lanes stay
 *
 * Pure logic is testable as functions:
 *   - matchesFilter(card, view, me) — predicate
 *   - filterLanes(lanes, view, me)  — applies predicate to every lane
 *   - countByView(lanes, me)        — counts per view (for the segmented chips)
 *   - resolveInitialView(opts)      — picks the view from URL/localStorage/default
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesFilter,
  filterLanes,
  countByView,
  resolveInitialView,
  BOARD_VIEWS,
  BOARD_SIZES,
  composeFilter,
  composeFilterLanes,
  parseFiltersFromUrl,
} from './board-filter.js';

const ME = 'ct-isaias';

const human = (id, assignee = 'ct-eric') => ({
  kind: 'human_task', id, status: 'inbox', priority: 'normal',
  assignee_contact_id: assignee, assignee_label: 'Eric Gang',
  needs_human: null, tags: [], next_action_hint: null, due_date: null,
  source_quote: null, signal_id: null, message_id: null,
  relevance_score: null, extraction_confidence: 0.9,
  created_at: '2026-05-09T00:00:00Z', updated_at: '2026-05-09T00:00:00Z',
});
const work = (id) => ({
  kind: 'work_item', id, type: 'directive', title: 'wi', status: 'in_progress',
  assigned_to: 'orchestrator', created_by: 'board',
  created_at: '2026-05-09T00:00:00Z', updated_at: '2026-05-09T00:00:00Z',
});
const proposal = (id) => ({
  kind: 'proposal', id, title: 'draft', action_type: 'send_email',
  work_item_id: null, created_at: '2026-05-09T00:00:00Z',
});
const attention = (id) => ({
  kind: 'attention', id, title: 'a', signature: 's',
  work_item_id: null, created_at: '2026-05-09T00:00:00Z',
});

const lanes = () => ({
  needs_you:  [proposal('p1'), attention('a1'), human('hm-needsyou-1', ME)],
  created:    [human('hm-c1', 'ct-eric')],
  assigned:   [work('wi-a1'), human('hm-a1', ME)],
  in_progress:[work('wi-ip1'), human('hm-ip1', 'ct-eric')],
  review:     [],
  completed:  [],
});

describe('BOARD_VIEWS export', () => {
  it('exposes the 4 filter options', () => {
    assert.ok(BOARD_VIEWS.includes('mine'));
    assert.ok(BOARD_VIEWS.includes('humans'));
    assert.ok(BOARD_VIEWS.includes('agents'));
    assert.ok(BOARD_VIEWS.includes('all'));
  });
});

describe('matchesFilter (predicate)', () => {
  it('view=all → every card passes', () => {
    assert.equal(matchesFilter(human('h'), 'all', ME), true);
    assert.equal(matchesFilter(work('w'), 'all', ME), true);
    assert.equal(matchesFilter(proposal('p'), 'all', ME), true);
  });

  it('view=humans → human_task + proposal + attention (the human-owned kinds)', () => {
    assert.equal(matchesFilter(human('h'), 'humans', ME), true);
    assert.equal(matchesFilter(proposal('p'), 'humans', ME), true);
    assert.equal(matchesFilter(attention('a'), 'humans', ME), true);
    assert.equal(matchesFilter(work('w'), 'humans', ME), false);
  });

  it('view=agents → work_item only', () => {
    assert.equal(matchesFilter(work('w'), 'agents', ME), true);
    assert.equal(matchesFilter(human('h'), 'agents', ME), false);
    assert.equal(matchesFilter(proposal('p'), 'agents', ME), false);
  });

  it('view=mine → human_task cards assigned to me', () => {
    assert.equal(matchesFilter(human('h-mine', ME), 'mine', ME), true);
    assert.equal(matchesFilter(human('h-eric', 'ct-eric'), 'mine', ME), false);
    // Other kinds are NOT mine.
    assert.equal(matchesFilter(work('w'), 'mine', ME), false);
    assert.equal(matchesFilter(proposal('p'), 'mine', ME), false);
  });

  it('unknown view → defaults to all (no filter)', () => {
    assert.equal(matchesFilter(human('h'), 'whatever', ME), true);
  });
});

describe('filterLanes — affects population, not lane set', () => {
  it('returns the same 6 lane ids regardless of view', () => {
    const out = filterLanes(lanes(), 'humans', ME);
    assert.deepEqual(
      Object.keys(out).sort(),
      ['assigned','completed','created','in_progress','needs_you','review'],
    );
  });

  it('view=agents leaves only work_items', () => {
    const out = filterLanes(lanes(), 'agents', ME);
    for (const lane of Object.values(out)) {
      for (const c of lane) assert.equal(c.kind, 'work_item');
    }
  });

  it('view=mine keeps only my human_tasks', () => {
    const out = filterLanes(lanes(), 'mine', ME);
    const all = Object.values(out).flat();
    for (const c of all) {
      assert.equal(c.kind, 'human_task');
      assert.equal(c.assignee_contact_id, ME);
    }
  });

  it('view=all is identity', () => {
    const input = lanes();
    const out = filterLanes(input, 'all', ME);
    const before = Object.values(input).flat().length;
    const after = Object.values(out).flat().length;
    assert.equal(before, after);
  });
});

describe('countByView (segmented-chip counts)', () => {
  it('counts each view independently', () => {
    const c = countByView(lanes(), ME);
    assert.equal(c.all, c.humans + c.agents);
    assert.ok(c.mine <= c.humans, 'mine ⊆ humans');
    assert.ok(c.mine >= 0);
  });

  it('mine includes only my human_task cards', () => {
    const c = countByView(lanes(), ME);
    // From the fixture: hm-needsyou-1 + hm-a1 = 2 of mine.
    assert.equal(c.mine, 2);
  });
});

describe('resolveInitialView', () => {
  it('URL ?view= wins over localStorage and default', () => {
    const v = resolveInitialView({
      urlView: 'agents',
      storedView: 'humans',
      role: 'board',
    });
    assert.equal(v, 'agents');
  });

  it('falls back to localStorage when URL is empty', () => {
    const v = resolveInitialView({ urlView: null, storedView: 'mine', role: 'board' });
    assert.equal(v, 'mine');
  });

  it('default for board members is "humans" (PRD §7)', () => {
    const v = resolveInitialView({ urlView: null, storedView: null, role: 'board' });
    assert.equal(v, 'humans');
  });

  it('default for staff/admin is "all" (PRD §7)', () => {
    const v = resolveInitialView({ urlView: null, storedView: null, role: 'staff' });
    assert.equal(v, 'all');
  });

  it('rejects unknown values silently → falls through', () => {
    const v = resolveInitialView({ urlView: 'whatever', storedView: null, role: 'board' });
    assert.equal(v, 'humans'); // unknown URL value ignored → role-default
  });
});

// ---------------------------------------------------------------------------
// v0.2 — composable filters (FR-32 + FR-13/FR-14)
// ---------------------------------------------------------------------------

const humanRich = (id, overrides = {}) => ({
  ...human(id, ME),
  project_id: 'p-default',
  size: 'small',
  signal_meeting_id: 'sm-1',
  message_id: 'msg-1',
  ...overrides,
});

const lanesV02 = () => ({
  needs_you: [
    humanRich('hm-1', { project_id: 'p-alpha', size: 'quick', signal_meeting_id: 'sm-A', message_id: 'msg-A' }),
    humanRich('hm-2', { project_id: null, size: null, signal_meeting_id: null, message_id: null }),
    proposal('p1'),
    attention('a1'),
  ],
  created: [
    humanRich('hm-3', { project_id: 'p-alpha', size: 'medium', signal_meeting_id: 'sm-B', message_id: 'msg-B' }),
    work('wi-c1'),
  ],
  assigned: [
    humanRich('hm-4', { project_id: 'p-beta', size: 'large', signal_meeting_id: 'sm-C', message_id: 'msg-C', assignee_contact_id: 'ct-eric' }),
    work('wi-a1'),
  ],
  in_progress: [
    humanRich('hm-5', { project_id: 'p-alpha', size: 'quick', signal_meeting_id: 'sm-A', message_id: 'msg-A' }),
  ],
  review: [],
  completed: [],
});

describe('BOARD_SIZES export', () => {
  it('exposes the 4 size buckets in canonical order', () => {
    assert.deepEqual([...BOARD_SIZES], ['quick', 'small', 'medium', 'large']);
  });
});

describe('composeFilter — no filters active', () => {
  it('null/undefined for every dimension → all cards pass (matches view=all)', () => {
    assert.equal(composeFilter(humanRich('h'), {}), true);
    assert.equal(composeFilter(work('w'), {}), true);
    assert.equal(composeFilter(proposal('p'), {}), true);
    assert.equal(composeFilter(attention('a'), {}), true);
  });

  it('view=all + everything undefined === legacy matchesFilter(all)', () => {
    const c = humanRich('h');
    assert.equal(composeFilter(c, { view: 'all', me: ME }), true);
  });
});

describe('composeFilter — view + project AND together', () => {
  it('view=humans + matching project_id → pass', () => {
    const c = humanRich('h', { project_id: 'p-alpha' });
    assert.equal(composeFilter(c, { view: 'humans', project: 'p-alpha', me: ME }), true);
  });

  it('view=humans + non-matching project_id → drop', () => {
    const c = humanRich('h', { project_id: 'p-beta' });
    assert.equal(composeFilter(c, { view: 'humans', project: 'p-alpha', me: ME }), false);
  });

  it('view=mine + matching project_id (mine card) → pass', () => {
    const c = humanRich('h', { project_id: 'p-alpha', assignee_contact_id: ME });
    assert.equal(composeFilter(c, { view: 'mine', project: 'p-alpha', me: ME }), true);
  });

  it('view=mine + matching project but card is Eric\'s → drop (view wins)', () => {
    const c = humanRich('h', { project_id: 'p-alpha', assignee_contact_id: 'ct-eric' });
    assert.equal(composeFilter(c, { view: 'mine', project: 'p-alpha', me: ME }), false);
  });
});

describe('composeFilter — project="__none__"', () => {
  it('matches cards with null project_id', () => {
    const c = humanRich('h', { project_id: null });
    assert.equal(composeFilter(c, { project: '__none__', me: ME }), true);
  });

  it('does not match cards that have a project_id set', () => {
    const c = humanRich('h', { project_id: 'p-alpha' });
    assert.equal(composeFilter(c, { project: '__none__', me: ME }), false);
  });
});

describe('composeFilter — size filter', () => {
  for (const s of ['quick', 'small', 'medium', 'large']) {
    it(`size=${s} → only cards with that size pass`, () => {
      const match = humanRich('h-m', { size: s });
      const other = humanRich('h-o', { size: s === 'quick' ? 'large' : 'quick' });
      assert.equal(composeFilter(match, { size: s, me: ME }), true);
      assert.equal(composeFilter(other, { size: s, me: ME }), false);
    });
  }

  it('size="__none__" matches cards with null/missing size', () => {
    assert.equal(composeFilter(humanRich('h', { size: null }), { size: '__none__', me: ME }), true);
    const noSize = humanRich('h2');
    delete noSize.size;
    assert.equal(composeFilter(noSize, { size: '__none__', me: ME }), true);
    assert.equal(composeFilter(humanRich('h3', { size: 'small' }), { size: '__none__', me: ME }), false);
  });
});

describe('composeFilter — signal_meeting_id', () => {
  it('matches via card.signal_meeting_id', () => {
    const c = humanRich('h', { signal_meeting_id: 'sm-XYZ', message_id: 'other' });
    assert.equal(composeFilter(c, { signal_meeting_id: 'sm-XYZ', me: ME }), true);
  });

  it('matches via card.message_id when signal_meeting_id is absent', () => {
    const c = humanRich('h', { signal_meeting_id: null, message_id: 'msg-XYZ' });
    assert.equal(composeFilter(c, { signal_meeting_id: 'msg-XYZ', me: ME }), true);
  });

  it('non-matching id → drop', () => {
    const c = humanRich('h', { signal_meeting_id: 'sm-A', message_id: 'msg-A' });
    assert.equal(composeFilter(c, { signal_meeting_id: 'sm-B', me: ME }), false);
  });
});

describe('composeFilter — all three new filters compose with view', () => {
  it('view + project + size + signal_meeting_id all match → pass', () => {
    const c = humanRich('h', {
      project_id: 'p-alpha',
      size: 'quick',
      signal_meeting_id: 'sm-A',
      assignee_contact_id: ME,
    });
    assert.equal(
      composeFilter(c, {
        view: 'mine',
        project: 'p-alpha',
        size: 'quick',
        signal_meeting_id: 'sm-A',
        me: ME,
      }),
      true,
    );
  });

  it('any one dimension mismatch → drop (AND semantics)', () => {
    const c = humanRich('h', {
      project_id: 'p-alpha',
      size: 'quick',
      signal_meeting_id: 'sm-A',
      assignee_contact_id: ME,
    });
    // size off:
    assert.equal(
      composeFilter(c, {
        view: 'mine',
        project: 'p-alpha',
        size: 'large',
        signal_meeting_id: 'sm-A',
        me: ME,
      }),
      false,
    );
    // project off:
    assert.equal(
      composeFilter(c, {
        view: 'mine',
        project: 'p-other',
        size: 'quick',
        signal_meeting_id: 'sm-A',
        me: ME,
      }),
      false,
    );
    // signal off:
    assert.equal(
      composeFilter(c, {
        view: 'mine',
        project: 'p-alpha',
        size: 'quick',
        signal_meeting_id: 'sm-Z',
        me: ME,
      }),
      false,
    );
  });
});

describe('composeFilter — human-task-only filters exclude other kinds', () => {
  it('project filter active → work_item / proposal / attention all drop', () => {
    assert.equal(composeFilter(work('w'), { project: 'p-alpha', me: ME }), false);
    assert.equal(composeFilter(proposal('p'), { project: 'p-alpha', me: ME }), false);
    assert.equal(composeFilter(attention('a'), { project: 'p-alpha', me: ME }), false);
  });

  it('size filter active → non-human_task cards drop', () => {
    assert.equal(composeFilter(work('w'), { size: 'quick', me: ME }), false);
    assert.equal(composeFilter(proposal('p'), { size: 'quick', me: ME }), false);
  });

  it('signal_meeting_id filter active → non-human_task cards drop', () => {
    assert.equal(composeFilter(work('w'), { signal_meeting_id: 'sm-A', me: ME }), false);
    assert.equal(composeFilter(attention('a'), { signal_meeting_id: 'sm-A', me: ME }), false);
  });

  it('view alone (no human-task filter) → other kinds pass per view rules', () => {
    assert.equal(composeFilter(work('w'), { view: 'agents', me: ME }), true);
    assert.equal(composeFilter(proposal('p'), { view: 'humans', me: ME }), true);
  });
});

describe('composeFilterLanes — preserves the 6 lane ids regardless of filters', () => {
  it('no filters → same 6 lane ids', () => {
    const out = composeFilterLanes(lanesV02(), {}, ME);
    assert.deepEqual(
      Object.keys(out).sort(),
      ['assigned', 'completed', 'created', 'in_progress', 'needs_you', 'review'],
    );
  });

  it('aggressive filter combo → still all 6 lane ids (lanes may be empty)', () => {
    const out = composeFilterLanes(
      lanesV02(),
      { view: 'mine', project: 'p-alpha', size: 'quick', signal_meeting_id: 'sm-A' },
      ME,
    );
    assert.deepEqual(
      Object.keys(out).sort(),
      ['assigned', 'completed', 'created', 'in_progress', 'needs_you', 'review'],
    );
  });

  it('filter active → only matching human_task cards remain', () => {
    const out = composeFilterLanes(lanesV02(), { project: 'p-alpha' }, ME);
    const all = Object.values(out).flat();
    for (const c of all) {
      assert.equal(c.kind, 'human_task');
      assert.equal(c.project_id, 'p-alpha');
    }
    assert.ok(all.length > 0, 'expected at least one match');
  });

  it('does not mutate the input lanes', () => {
    const input = lanesV02();
    const beforeCounts = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v.length]),
    );
    composeFilterLanes(input, { project: 'p-alpha', size: 'quick' }, ME);
    for (const [k, v] of Object.entries(input)) {
      assert.equal(v.length, beforeCounts[k], `lane ${k} mutated`);
    }
  });
});

describe('parseFiltersFromUrl', () => {
  const mk = (pairs) => new URLSearchParams(pairs);

  it('empty params → view=all, others undefined', () => {
    const f = parseFiltersFromUrl({ searchParams: mk('') });
    assert.equal(f.view, 'all');
    assert.equal(f.project, undefined);
    assert.equal(f.size, undefined);
    assert.equal(f.signal_meeting_id, undefined);
  });

  it('valid view + project + size + signal_meeting_id → echoed back', () => {
    const f = parseFiltersFromUrl({
      searchParams: mk('view=mine&project=p-alpha&size=quick&signal_meeting_id=sm-A'),
    });
    assert.equal(f.view, 'mine');
    assert.equal(f.project, 'p-alpha');
    assert.equal(f.size, 'quick');
    assert.equal(f.signal_meeting_id, 'sm-A');
  });

  it('size=__none__ is accepted as a sentinel', () => {
    const f = parseFiltersFromUrl({ searchParams: mk('size=__none__') });
    assert.equal(f.size, '__none__');
  });

  it('invalid size value → undefined (no filter)', () => {
    const f = parseFiltersFromUrl({ searchParams: mk('size=ginormous') });
    assert.equal(f.size, undefined);
  });

  it('invalid view → falls back to all', () => {
    const f = parseFiltersFromUrl({ searchParams: mk('view=galaxy-brain') });
    assert.equal(f.view, 'all');
  });

  it('missing searchParams → safe defaults', () => {
    const f = parseFiltersFromUrl({});
    assert.equal(f.view, 'all');
    assert.equal(f.project, undefined);
  });
});
