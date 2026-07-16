import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * STAQPRO-353: orchestrator's queue is task_events; if a work_item ends up in
 * 'created' state with no unprocessed task_events row, it's invisible to
 * claim_next_task and stalls indefinitely. The reaper's sweepOrphanedCreated()
 * INSERTs a fresh task_assigned event so the queue can see it.
 *
 * These tests pin:
 *   1. Orphan recovery: a 'created' work_item with no task_events row gets one.
 *   2. Idempotency: re-running the sweep doesn't duplicate events.
 *   3. Fresh-create guard: work_items younger than 60s are not touched.
 *   4. After recovery, claim_next_task() returns the work_item.
 */
describe('Reaper sweepOrphanedCreated (STAQPRO-353)', () => {
  let queryFn;
  let Reaper;
  // Unique per-run prefix keeps reruns hermetic against PGlite's persisted
  // data dir (`data/pglite-reaper-orphan`) — without this, rows from prior
  // runs leak into ORDER BY priority DESC, created_at ASC scans.
  const RUN = `353-${Date.now()}`;
  const idFor = (k) => `wi-orphan-${RUN}-${k}`;

  before(async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.SQL_DIR = new URL('../sql', import.meta.url).pathname;
    process.env.PGLITE_DATA_DIR = new URL('../data/pglite-reaper-orphan', import.meta.url).pathname;
    const db = await import('../src/db.js');
    queryFn = db.query;
    await db.initializeDatabase();
    ({ Reaper } = await import('../../lib/runtime/reaper.js'));
  });

  async function insertCreatedWorkItem({ id, agent, ageSeconds }) {
    const createdAt = `now() - interval '${ageSeconds} seconds'`;
    await queryFn(
      `INSERT INTO agent_graph.work_items
         (id, type, title, created_by, assigned_to, status, priority, created_at, updated_at)
       VALUES ($1, 'task', 'orphan test', 'board', $2, 'created', 0,
               ${createdAt}, ${createdAt})
       ON CONFLICT (id) DO UPDATE SET
         status = 'created',
         assigned_to = EXCLUDED.assigned_to,
         updated_at = EXCLUDED.updated_at`,
      [id, agent],
    );
  }

  async function countUnprocessedEvents(workItemId) {
    const r = await queryFn(
      `SELECT count(*)::int AS n
         FROM agent_graph.task_events
        WHERE work_item_id = $1
          AND event_type = 'task_assigned'
          AND processed_at IS NULL`,
      [workItemId],
    );
    return r.rows[0].n;
  }

  it('re-emits task_assigned for an orphaned created work_item older than 60s', async () => {
    const wiId = idFor('old');
    await insertCreatedWorkItem({ id: wiId, agent: 'orchestrator', ageSeconds: 120 });

    // Pre-condition: no task_events row at all.
    assert.equal(await countUnprocessedEvents(wiId), 0);

    const reaper = new Reaper();
    await reaper.sweepOrphanedCreated();

    // Post-condition: exactly one task_assigned event for this work_item.
    assert.equal(await countUnprocessedEvents(wiId), 1, 'orphan should get one recovery event');
  });

  it('is idempotent — re-running does not duplicate events', async () => {
    const wiId = idFor('idem');
    await insertCreatedWorkItem({ id: wiId, agent: 'orchestrator', ageSeconds: 120 });

    const reaper = new Reaper();
    await reaper.sweepOrphanedCreated();
    await reaper.sweepOrphanedCreated();
    await reaper.sweepOrphanedCreated();

    assert.equal(await countUnprocessedEvents(wiId), 1, 'idempotent: only one event after 3 sweeps');
  });

  it('skips fresh creates (<60s) to avoid racing the post-commit notify', async () => {
    const wiId = idFor('fresh');
    await insertCreatedWorkItem({ id: wiId, agent: 'orchestrator', ageSeconds: 5 });

    const reaper = new Reaper();
    await reaper.sweepOrphanedCreated();

    assert.equal(await countUnprocessedEvents(wiId), 0, 'fresh creates should not be touched');
  });

  it('recovered work_items become visible to claim_next_task()', async () => {
    const wiId = idFor('drain');
    await insertCreatedWorkItem({ id: wiId, agent: 'orchestrator', ageSeconds: 120 });

    const reaper = new Reaper();
    await reaper.sweepOrphanedCreated();

    // Drain the orchestrator's queue. PGlite state is shared across tests in
    // this file so the queue may contain orphans recovered by earlier cases;
    // we just need to assert our target eventually appears.
    const claimed = new Set();
    for (let i = 0; i < 20; i += 1) {
      const r = await queryFn(`SELECT * FROM agent_graph.claim_next_task($1)`, ['orchestrator']);
      if (r.rows.length === 0) break;
      claimed.add(r.rows[0].work_item_id);
    }
    assert.ok(
      claimed.has(wiId),
      `claim_next_task should eventually return recovered work_item ${wiId}, got: ${[...claimed].join(', ')}`,
    );
  });
});
