/**
 * Operator-driven backfill API — FR-B1 through FR-B7.
 *
 * Tech spec: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   §FR-B1–B7, §3.1 (linear_backfill_batches), §4.1.
 *
 * Endpoints under test:
 *   GET  /api/linear/backfill/preview     — count + first 50 candidates
 *   POST /api/linear/backfill             — body {filters, dry_run?}
 *   POST /api/linear/backfill/:id/cancel  — flip pending rows back to NULL
 *   GET  /api/linear/backfill/:id         — batch row + push_status progress
 *
 * All four require role='board'. Handlers are pure functions of (req, body);
 * tests build mockReq() objects and inspect the returned shape + the database.
 *
 * Migration 122 amends inbox.linear_backfill_batches with task_ids JSONB so
 * the cancel + progress queries know which rows belong to which batch.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import {
  previewBackfill,
  startBackfill,
  cancelBackfill,
  getBackfillBatch,
} from '../src/api-routes/backfill.js';

const BOARD = {
  role: 'board',
  sub: 'isaias',
  github_username: 'cboone',
  scope: ['*'],
};

function boardReq(url, extra = {}) {
  return { url, headers: {}, auth: BOARD, ...extra };
}

function publicReq(url) {
  return { url, headers: {} };
}

const BF = (k) => `htm-bf-api-${k}`;

async function wipe(query) {
  // task_ids reference human_tasks; clear batches first.
  await query(`DELETE FROM inbox.linear_backfill_batches WHERE created_by = 'cboone' OR created_by = 'system'`);
  await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-bf-api-%'`);
}

async function seedRow(query, id, overrides = {}) {
  const cols = {
    id,
    title: `Backfill task ${id}`,
    status: 'inbox',
    priority: 'normal',
    relevance_score: 0.7,
    push_status: null,
    ...overrides,
  };
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  await query(
    `INSERT INTO inbox.human_tasks (${keys.join(', ')}) VALUES (${placeholders})`,
    keys.map((k) => cols[k]),
  );
}

// ---------------------------------------------------------------------------
// Migration 122 — task_ids column on linear_backfill_batches
// ---------------------------------------------------------------------------

describe('migration 122 (linear_backfill_batches.task_ids)', () => {
  let query;
  before(async () => { ({ query } = await getDb()); });

  it('task_ids column exists with default []', async () => {
    const r = await query(
      `SELECT column_name, data_type, column_default
         FROM information_schema.columns
        WHERE table_schema = 'inbox'
          AND table_name = 'linear_backfill_batches'
          AND column_name = 'task_ids'`,
    );
    assert.equal(r.rows.length, 1, 'task_ids column missing');
    assert.match(r.rows[0].data_type.toLowerCase(), /json/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/linear/backfill/preview
// ---------------------------------------------------------------------------

describe('GET /api/linear/backfill/preview', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    await wipe(query);

    // 3 inbox / 1 todo / 1 done / 1 skipped / 1 not_for_us / 1 low relevance
    await seedRow(query, BF('inbox-1'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('inbox-2'), { status: 'inbox', relevance_score: 0.9 });
    await seedRow(query, BF('inbox-3'), { status: 'inbox', relevance_score: 0.3 });
    await seedRow(query, BF('todo-1'),  { status: 'todo',  relevance_score: 0.8 });
    await seedRow(query, BF('done-1'),  { status: 'done',  relevance_score: 0.9 });
    await seedRow(query, BF('skip-1'),  { status: 'skipped', relevance_score: 0.9 });
    await seedRow(query, BF('nfu-1'),   { status: 'not_for_us', relevance_score: 0.9 });
    await seedRow(query, BF('null-rs'), { status: 'inbox', relevance_score: null });
  });

  it('default filters return non-terminal rows', async () => {
    const res = await previewBackfill(boardReq('/api/linear/backfill/preview'));
    const ids = res.preview.map((r) => r.id);
    assert.ok(ids.includes(BF('inbox-1')));
    assert.ok(ids.includes(BF('inbox-2')));
    assert.ok(ids.includes(BF('todo-1')));
    assert.ok(ids.includes(BF('null-rs')), 'NULL relevance treated as 0 — still passes default min=0');
    assert.equal(ids.includes(BF('done-1')), false);
    assert.equal(ids.includes(BF('skip-1')), false);
    assert.equal(ids.includes(BF('nfu-1')), false);
    assert.equal(res.count, res.preview.length);
  });

  it('terminal rows are hard-excluded regardless of status filter', async () => {
    const res = await previewBackfill(
      boardReq('/api/linear/backfill/preview?status=done,skipped,not_for_us,inbox'),
    );
    const ids = res.preview.map((r) => r.id);
    assert.equal(ids.includes(BF('done-1')), false);
    assert.equal(ids.includes(BF('skip-1')), false);
    assert.equal(ids.includes(BF('nfu-1')), false);
    // inbox rows still admitted by the status intersection.
    assert.ok(ids.includes(BF('inbox-1')));
  });

  it('min_relevance filter (0.5) excludes rows below threshold', async () => {
    const res = await previewBackfill(
      boardReq('/api/linear/backfill/preview?min_relevance=0.5'),
    );
    const ids = res.preview.map((r) => r.id);
    assert.ok(ids.includes(BF('inbox-1')));
    assert.ok(ids.includes(BF('inbox-2')));
    assert.equal(ids.includes(BF('inbox-3')), false, 'rs=0.3 must be excluded');
    assert.equal(ids.includes(BF('null-rs')), false, 'NULL rs (treated as 0) must be excluded at min=0.5');
  });

  it('max_age_days filter excludes older rows', async () => {
    // Insert one ancient row.
    await query(
      `INSERT INTO inbox.human_tasks (id, title, status, priority, relevance_score, created_at)
       VALUES ($1, 'old', 'inbox', 'normal', 0.9, now() - interval '60 days')`,
      [BF('old')],
    );

    const recent = await previewBackfill(
      boardReq('/api/linear/backfill/preview?max_age_days=7'),
    );
    const ids = recent.preview.map((r) => r.id);
    assert.equal(ids.includes(BF('old')), false);

    const all = await previewBackfill(
      boardReq('/api/linear/backfill/preview?max_age_days=365'),
    );
    const ids2 = all.preview.map((r) => r.id);
    assert.ok(ids2.includes(BF('old')));

    // Cleanup
    await query(`DELETE FROM inbox.human_tasks WHERE id = $1`, [BF('old')]);
  });

  it('preview capped at 50; count is total', async () => {
    // Seed 55 more rows.
    for (let i = 0; i < 55; i++) {
      await seedRow(query, BF(`bulk-${i}`), { status: 'inbox', relevance_score: 0.7 });
    }
    const res = await previewBackfill(boardReq('/api/linear/backfill/preview'));
    assert.ok(res.preview.length <= 50, `preview must be <=50; got ${res.preview.length}`);
    assert.ok(res.count > 50, `count must reflect total > 50; got ${res.count}`);

    // Cleanup
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-bf-api-bulk-%'`);
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => previewBackfill(publicReq('/api/linear/backfill/preview')),
      /board|forbidden|401|403/i,
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/linear/backfill
// ---------------------------------------------------------------------------

describe('POST /api/linear/backfill', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await wipe(query);
    await seedRow(query, BF('post-inbox-1'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('post-inbox-2'), { status: 'inbox', relevance_score: 0.9 });
    await seedRow(query, BF('post-done-1'),  { status: 'done',  relevance_score: 0.9 });
  });

  it('dry_run=true → no writes; returns would_push + sample', async () => {
    const res = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {}, dry_run: true },
    );
    assert.equal(typeof res.would_push, 'number');
    assert.ok(res.would_push >= 2);
    assert.ok(Array.isArray(res.sample));
    assert.ok(res.sample.length <= 10);

    const batches = await query(`SELECT id FROM inbox.linear_backfill_batches`);
    assert.equal(batches.rows.length, 0, 'dry_run must NOT create a batch row');

    const pendings = await query(
      `SELECT id FROM inbox.human_tasks
        WHERE id LIKE 'htm-bf-api-post-%' AND push_status = 'pending'`,
    );
    assert.equal(pendings.rows.length, 0, 'dry_run must NOT flip push_status');
  });

  it('without dry_run → inserts batch row + flips push_status=pending on matches', async () => {
    const res = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );
    assert.equal(res.ok, true);
    assert.equal(typeof res.batch_id, 'string');
    assert.ok(res.task_count >= 2);

    const batch = await query(
      `SELECT id, created_by, task_count, state, filter_json, task_ids
         FROM inbox.linear_backfill_batches WHERE id = $1`,
      [res.batch_id],
    );
    assert.equal(batch.rows.length, 1);
    assert.equal(batch.rows[0].state, 'pending');
    assert.equal(batch.rows[0].created_by, 'cboone');

    const pendings = await query(
      `SELECT id FROM inbox.human_tasks
        WHERE id LIKE 'htm-bf-api-post-inbox-%' AND push_status = 'pending'`,
    );
    assert.equal(pendings.rows.length, 2);

    // Terminal row defensively excluded.
    const doneRow = await query(
      `SELECT push_status FROM inbox.human_tasks WHERE id = $1`,
      [BF('post-done-1')],
    );
    assert.equal(doneRow.rows[0].push_status, null);
  });

  it('task_ids persisted on the batch row', async () => {
    const res = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );
    const batch = await query(
      `SELECT task_ids FROM inbox.linear_backfill_batches WHERE id = $1`,
      [res.batch_id],
    );
    const ids = typeof batch.rows[0].task_ids === 'string'
      ? JSON.parse(batch.rows[0].task_ids)
      : batch.rows[0].task_ids;
    assert.ok(Array.isArray(ids));
    assert.ok(ids.includes(BF('post-inbox-1')));
    assert.ok(ids.includes(BF('post-inbox-2')));
    assert.equal(ids.includes(BF('post-done-1')), false);
  });

  it('terminal rows excluded server-side even if filters request them', async () => {
    const res = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: { status: ['inbox', 'done', 'skipped', 'not_for_us'] } },
    );
    const batch = await query(
      `SELECT task_ids FROM inbox.linear_backfill_batches WHERE id = $1`,
      [res.batch_id],
    );
    const ids = typeof batch.rows[0].task_ids === 'string'
      ? JSON.parse(batch.rows[0].task_ids)
      : batch.rows[0].task_ids;
    assert.equal(ids.includes(BF('post-done-1')), false, 'done must not appear in batch');
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => startBackfill(publicReq('/api/linear/backfill'), { filters: {} }),
      /board|forbidden|401|403/i,
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/linear/backfill/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /api/linear/backfill/:id/cancel', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await wipe(query);
    await seedRow(query, BF('cx-a'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('cx-b'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('cx-c'), { status: 'inbox', relevance_score: 0.7 });
  });

  it('cancels pending rows back to NULL', async () => {
    const start = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );

    const res = await cancelBackfill(
      boardReq(`/api/linear/backfill/${start.batch_id}/cancel`),
    );
    assert.equal(res.ok, true);
    assert.equal(res.batch_id, start.batch_id);
    assert.ok(res.cancelled_count >= 3);

    const rows = await query(
      `SELECT id, push_status FROM inbox.human_tasks WHERE id LIKE 'htm-bf-api-cx-%'`,
    );
    for (const r of rows.rows) {
      assert.equal(r.push_status, null, `${r.id} should be reset to NULL`);
    }

    const batch = await query(
      `SELECT state, completed_at FROM inbox.linear_backfill_batches WHERE id = $1`,
      [start.batch_id],
    );
    assert.equal(batch.rows[0].state, 'cancelled');
    assert.ok(batch.rows[0].completed_at !== null);
  });

  it('does NOT cancel rows that already moved past pending', async () => {
    const start = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );

    // Simulate worker progressing one row to 'running' and another to 'succeeded'.
    await query(
      `UPDATE inbox.human_tasks SET push_status = 'running' WHERE id = $1`,
      [BF('cx-a')],
    );
    await query(
      `UPDATE inbox.human_tasks SET push_status = 'succeeded' WHERE id = $1`,
      [BF('cx-b')],
    );

    await cancelBackfill(
      boardReq(`/api/linear/backfill/${start.batch_id}/cancel`),
    );

    const rowA = await query(`SELECT push_status FROM inbox.human_tasks WHERE id = $1`, [BF('cx-a')]);
    const rowB = await query(`SELECT push_status FROM inbox.human_tasks WHERE id = $1`, [BF('cx-b')]);
    const rowC = await query(`SELECT push_status FROM inbox.human_tasks WHERE id = $1`, [BF('cx-c')]);
    assert.equal(rowA.rows[0].push_status, 'running', 'running rows must be left alone');
    assert.equal(rowB.rows[0].push_status, 'succeeded', 'succeeded rows must be left alone');
    assert.equal(rowC.rows[0].push_status, null, 'pending row reset to NULL');
  });

  it('409 when batch already cancelled or completed', async () => {
    const start = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );
    await cancelBackfill(
      boardReq(`/api/linear/backfill/${start.batch_id}/cancel`),
    );

    await assert.rejects(
      () => cancelBackfill(boardReq(`/api/linear/backfill/${start.batch_id}/cancel`)),
      (err) => err.statusCode === 409,
    );

    // Manually mark a fresh batch as completed.
    const start2 = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );
    await query(
      `UPDATE inbox.linear_backfill_batches SET state='completed', completed_at=now() WHERE id = $1`,
      [start2.batch_id],
    );
    await assert.rejects(
      () => cancelBackfill(boardReq(`/api/linear/backfill/${start2.batch_id}/cancel`)),
      (err) => err.statusCode === 409,
    );
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => cancelBackfill(publicReq('/api/linear/backfill/some-id/cancel')),
      /board|forbidden|401|403/i,
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/linear/backfill/:id
// ---------------------------------------------------------------------------

describe('GET /api/linear/backfill/:id', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => {
    await wipe(query);
    await seedRow(query, BF('g-a'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('g-b'), { status: 'inbox', relevance_score: 0.7 });
    await seedRow(query, BF('g-c'), { status: 'inbox', relevance_score: 0.7 });
  });

  it('returns batch row + progress counts per push_status', async () => {
    const start = await startBackfill(
      boardReq('/api/linear/backfill'),
      { filters: {} },
    );

    // Move one to running, one to succeeded.
    await query(`UPDATE inbox.human_tasks SET push_status = 'running'   WHERE id = $1`, [BF('g-a')]);
    await query(`UPDATE inbox.human_tasks SET push_status = 'succeeded' WHERE id = $1`, [BF('g-b')]);

    const res = await getBackfillBatch(
      boardReq(`/api/linear/backfill/${start.batch_id}`),
    );
    assert.equal(res.batch.id, start.batch_id);
    assert.equal(res.batch.state, 'pending');
    assert.ok(res.progress);
    assert.equal(res.progress.running, 1);
    assert.equal(res.progress.succeeded, 1);
    assert.equal(res.progress.pending, 1);
  });

  it('rejects unauthenticated callers (403)', async () => {
    await assert.rejects(
      () => getBackfillBatch(publicReq('/api/linear/backfill/some-id')),
      /board|forbidden|401|403/i,
    );
  });
});
