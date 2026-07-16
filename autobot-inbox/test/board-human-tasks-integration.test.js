/**
 * Tests the human_tasks → /api/board mapping at the lib level
 * (PRD: meeting-actions-to-kanban §11.2). Imports the small board-side
 * lib module directly — avoids src/api.js's heavy transitive imports.
 *
 * Mapping under test:
 *   inbox + assignee + high-confidence   → 'created'
 *   inbox + unassigned                   → 'needs_you'
 *   inbox + low-confidence (<0.5)        → 'needs_you'
 *   proposed                             → 'needs_you'
 *   todo, later                          → 'assigned'
 *   in_progress, blocked                 → 'in_progress'
 *   review                               → 'review'
 *   done                                 → 'completed'
 *   skipped, not_for_us                  → filtered (null)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  bucketHumanTask,
  toHumanTaskCard,
  appendHumanTasksToLanes,
} from '../../lib/runtime/board-human-tasks.js';

const HT = (k) => `htm-board-${k}`;

function emptyLanes() {
  return {
    needs_you: [], created: [], assigned: [],
    in_progress: [], review: [], completed: [],
  };
}

describe('bucketHumanTask — pure mapping (PRD §11.2)', () => {
  it('inbox + assignee + confident → created', () => {
    assert.equal(
      bucketHumanTask({
        status: 'inbox', assignee_contact_id: 'ct-eric', extraction_confidence: 0.9,
      }),
      'created',
    );
  });

  it('inbox + no assignee → needs_you', () => {
    assert.equal(
      bucketHumanTask({ status: 'inbox', assignee_contact_id: null, extraction_confidence: 0.9 }),
      'needs_you',
    );
  });

  it('inbox + low confidence → needs_you', () => {
    assert.equal(
      bucketHumanTask({ status: 'inbox', assignee_contact_id: 'ct-eric', extraction_confidence: 0.3 }),
      'needs_you',
    );
  });

  it('proposed → needs_you', () => {
    assert.equal(bucketHumanTask({ status: 'proposed' }), 'needs_you');
  });

  it('todo → assigned', () => {
    assert.equal(bucketHumanTask({ status: 'todo' }), 'assigned');
  });

  it('later → assigned', () => {
    assert.equal(bucketHumanTask({ status: 'later' }), 'assigned');
  });

  it('in_progress → in_progress', () => {
    assert.equal(bucketHumanTask({ status: 'in_progress' }), 'in_progress');
  });

  it('blocked → in_progress', () => {
    assert.equal(bucketHumanTask({ status: 'blocked' }), 'in_progress');
  });

  it('review → review', () => {
    assert.equal(bucketHumanTask({ status: 'review' }), 'review');
  });

  it('done → completed', () => {
    assert.equal(bucketHumanTask({ status: 'done' }), 'completed');
  });

  it('skipped → null (filtered)', () => {
    assert.equal(bucketHumanTask({ status: 'skipped' }), null);
  });

  it('not_for_us → null (filtered)', () => {
    assert.equal(bucketHumanTask({ status: 'not_for_us' }), null);
  });

  it('unknown status → null', () => {
    assert.equal(bucketHumanTask({ status: 'wat' }), null);
  });

  it('null row → null', () => {
    assert.equal(bucketHumanTask(null), null);
  });
});

describe('toHumanTaskCard — shape contract', () => {
  it('emits kind=human_task with all PRD §7 visual + payload fields', () => {
    const card = toHumanTaskCard({
      id: 'htm-card-1', title: 'Eric to ship',
      status: 'inbox', priority: 'normal',
      assignee_contact_id: 'ct-eric', assignee_label: 'Eric Gang',
      assignee_confidence: 0.9, extraction_confidence: 0.85,
      tags: ['migration'],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.equal(card.kind, 'human_task');
    assert.equal(card.id, 'htm-card-1');
    assert.equal(card.assignee_label, 'Eric Gang');
    assert.equal(card.priority, 'normal');
    assert.deepEqual(card.tags, ['migration']);
    assert.ok('needs_human' in card, 'needs_human field present');
  });

  it('coerces NUMERIC columns from string back to number', () => {
    // pg returns NUMERIC as a string by default; the card layer normalises.
    const card = toHumanTaskCard({
      id: 'x', title: 'x', status: 'inbox',
      assignee_confidence: '0.42',
      relevance_score: '0.7',
      extraction_confidence: '0.85',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.equal(card.assignee_confidence, 0.42);
    assert.equal(card.relevance_score, 0.7);
    assert.equal(card.extraction_confidence, 0.85);
  });

  it('renders tags as [] when row has null tags', () => {
    const card = toHumanTaskCard({
      id: 'x', title: 'x', status: 'inbox',
      tags: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.deepEqual(card.tags, []);
  });
});

describe('appendHumanTasksToLanes — integration against PGlite', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-board-%'`);

    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority, extraction_confidence, assignee_contact_id)
       VALUES
         ($1,  'Inbox glance',   'inbox',       'normal', 0.9, 'ct-eric'),
         ($2,  'Inbox no-own',   'inbox',       'normal', 0.9, NULL),
         ($3,  'Proposed lo',    'proposed',    'normal', 0.4, 'ct-eric'),
         ($4,  'Todo',           'todo',        'normal', 0.9, 'ct-eric'),
         ($5,  'Later',          'later',       'normal', 0.9, 'ct-eric'),
         ($6,  'In progress',    'in_progress', 'normal', 0.9, 'ct-eric'),
         ($7,  'Blocked',        'blocked',     'normal', 0.9, 'ct-eric'),
         ($8,  'Review',         'review',      'normal', 0.9, 'ct-eric'),
         ($9,  'Done',           'done',        'normal', 0.9, 'ct-eric'),
         ($10, 'Skipped',        'skipped',     'normal', 0.9, 'ct-eric'),
         ($11, 'NotForUs',       'not_for_us',  'normal', 0.9, 'ct-eric')`,
      [
        HT('inbox-g'), HT('inbox-u'), HT('proposed'),
        HT('todo'), HT('later'),
        HT('ip'), HT('blocked'), HT('review'),
        HT('done'), HT('skipped'), HT('nfu'),
      ],
    );
  });

  it('routes every status to the expected lane (full PRD §11.2 sweep)', async () => {
    const rows = (await query(
      `SELECT id, title, status, priority, assignee_contact_id, extraction_confidence,
              tags, created_at, updated_at
         FROM inbox.human_tasks
        WHERE id LIKE 'htm-board-%'`,
    )).rows;

    const lanes = emptyLanes();
    appendHumanTasksToLanes(lanes, rows);

    const idsIn = (lane) => new Set(lane.map((c) => c.id));

    assert.ok(idsIn(lanes.created).has(HT('inbox-g')), 'inbox-glance on created');
    assert.ok(idsIn(lanes.needs_you).has(HT('inbox-u')), 'inbox-unassigned on needs_you');
    assert.ok(idsIn(lanes.needs_you).has(HT('proposed')), 'proposed on needs_you');
    assert.ok(idsIn(lanes.assigned).has(HT('todo')), 'todo on assigned');
    assert.ok(idsIn(lanes.assigned).has(HT('later')), 'later on assigned');
    assert.ok(idsIn(lanes.in_progress).has(HT('ip')), 'in_progress on in_progress');
    assert.ok(idsIn(lanes.in_progress).has(HT('blocked')), 'blocked on in_progress');
    assert.ok(idsIn(lanes.review).has(HT('review')), 'review on review');
    assert.ok(idsIn(lanes.completed).has(HT('done')), 'done on completed');

    // Terminal: filtered out everywhere.
    const everywhere = new Set([
      ...idsIn(lanes.needs_you), ...idsIn(lanes.created), ...idsIn(lanes.assigned),
      ...idsIn(lanes.in_progress), ...idsIn(lanes.review), ...idsIn(lanes.completed),
    ]);
    assert.equal(everywhere.has(HT('skipped')), false, 'skipped filtered');
    assert.equal(everywhere.has(HT('nfu')), false, 'not_for_us filtered');
  });

  it('every emitted card carries kind=human_task and a needs_human field', async () => {
    const rows = (await query(
      `SELECT id, title, status, priority, assignee_contact_id, extraction_confidence,
              tags, created_at, updated_at
         FROM inbox.human_tasks
        WHERE id LIKE 'htm-board-%'
          AND status NOT IN ('skipped','not_for_us')`,
    )).rows;

    const lanes = emptyLanes();
    appendHumanTasksToLanes(lanes, rows);

    const allCards = Object.values(lanes).flat();
    for (const c of allCards) {
      assert.equal(c.kind, 'human_task', `card ${c.id} kind`);
      assert.ok('needs_human' in c, `card ${c.id} needs_human`);
    }
  });
});
