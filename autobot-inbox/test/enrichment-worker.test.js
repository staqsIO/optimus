/**
 * RED step (TDD) — lib/runtime/human-task-enrichment-worker.js does not exist yet.
 *
 * Tests the post-promotion enrichment worker. Contract (PRD §6, AD-1, FR-1..FR-4):
 *
 *   - Subscribes to pg_notify channel `human_task_enrichment_pending`.
 *     (Underscored — PRD's dotted form fails LISTEN parsing without
 *     double-quoting; PGlite's listen() doesn't quote.)
 *   - Periodically polls inbox.human_tasks WHERE enrichment_status='pending'
 *     AND deleted_at IS NULL as a backstop.
 *   - Dequeues one task at a time using SELECT … FOR UPDATE SKIP LOCKED.
 *   - Sets enrichment_status='running' on claim, calls enrichTask(...), then
 *     sets enrichment_status='completed' + enrichment_at=now() with the
 *     patch applied — minus any fields in getStickyFields(feedback_history).
 *   - On error: enrichment_status='failed', logs, doesn't throw uphill.
 *   - Appends a `verb='llm_decision', kind='enrichment'` entry to
 *     feedback_history (with guardrail_id=null — guardrails are not in
 *     v0.2 scope for enrichment).
 *   - On shutdown / startup, in-flight rows in 'running' are reset to
 *     'pending' so a crash doesn't strand work.
 *
 * Tests use the real PGlite DB + an injectable `enrichTask` so we exercise
 * the worker plumbing without going near a real LLM.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { startEnrichmentWorker } from '../../lib/runtime/human-task-enrichment-worker.js';

const ACC = 'acc-enrichment-worker-test';
const MSG = 'msg-enrichment-worker';

// Helper — yield to the event loop a few times so notify handlers + the
// claim transaction have a chance to run. Tests assert against terminal
// state of the row, so we poll until done with a hard ceiling.
async function waitUntil(predicate, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

async function seedTask(query, overrides = {}) {
  const id = overrides.id || `htm-enr-${Math.random().toString(36).slice(2, 10)}`;
  const cols = {
    id,
    title: 'Eric to ship the migration',
    source_quote: 'Eric to ship the migration before EOW',
    assignee_label: 'Eric',
    status: 'inbox',
    enrichment_status: 'pending',
    message_id: MSG,
    feedback_history: '[]',
    priority: null,
    size: null,
    project_id: null,
    relevance_score: null,
    push_status: null,
    ...overrides,
  };
  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, source_quote, assignee_label, status,
        enrichment_status, message_id, feedback_history,
        priority, size, project_id, relevance_score, push_status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,
             COALESCE($9, 'normal'), $10, $11, $12, $13, 'meeting_pipeline')`,
    [
      cols.id, cols.title, cols.source_quote, cols.assignee_label,
      cols.status, cols.enrichment_status, cols.message_id, cols.feedback_history,
      cols.priority, cols.size, cols.project_id, cols.relevance_score, cols.push_status,
    ],
  );
  return id;
}

async function getRow(query, id) {
  const r = await query(`SELECT * FROM inbox.human_tasks WHERE id = $1`, [id]);
  return r.rows[0];
}

describe('enrichment-worker — integration', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // Seed parent message so message_id refs are consistent. Use webhook
    // channel for parity with promoter output.
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'isaias', 'tldv-webhook', 'tldv@webhook', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'wh-enr-w', 't-enr-w',
               'mid-enr-w', 'tldv@webhook', now(), ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG, ACC],
    );

    // Seed a contact + project so the worker has allow-lists to pass into
    // enrichTask. The fake enrichTask doesn't care what they contain.
    await query(
      `INSERT INTO signal.contacts (id, email_address, name)
       VALUES ('ct-enr-eric', 'eric@staqs.io', 'Eric Gang')
       ON CONFLICT (email_address) DO NOTHING`,
    );
    await query(
      `INSERT INTO agent_graph.projects (id, slug, name)
       VALUES ('proj-enr-staqs', 'staqspro-enr', 'StaqsPro')
       ON CONFLICT (slug) DO NOTHING`,
    );
  });

  beforeEach(async () => {
    // Clear human_tasks rows scoped to this suite. Other suites use
    // 'htm-promoter-%' etc.
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-enr-%'`);
  });

  it('drains existing pending rows on startup', async () => {
    const id1 = await seedTask(query);
    const id2 = await seedTask(query);

    const enrichTask = async () => ({ priority: 'high', size: 'small' });

    const worker = await startEnrichmentWorker({
      query,
      enrichTask,
      llm: async () => '{}',
      pollIntervalMs: 50,
    });

    try {
      await waitUntil(async () => {
        const r1 = await getRow(query, id1);
        const r2 = await getRow(query, id2);
        return r1.enrichment_status === 'completed'
            && r2.enrichment_status === 'completed';
      });
    } finally {
      await worker.stop();
    }

    const r1 = await getRow(query, id1);
    assert.equal(r1.enrichment_status, 'completed');
    assert.equal(r1.priority, 'high');
    assert.equal(r1.size, 'small');
  });

  it('sets status=running before enrichTask is called, completed after', async () => {
    const id = await seedTask(query);

    let observedStatusDuring = null;
    const enrichTask = async ({ task }) => {
      // Mid-call: re-read the row from the DB; it should be 'running'.
      const r = await query(
        `SELECT enrichment_status FROM inbox.human_tasks WHERE id = $1`,
        [task.id],
      );
      observedStatusDuring = r.rows[0]?.enrichment_status;
      return { priority: 'normal' };
    };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    assert.equal(observedStatusDuring, 'running', 'row was running during enrichTask');
    assert.equal((await getRow(query, id)).enrichment_status, 'completed');
  });

  it('stamps enrichment_at to a recent timestamp on success', async () => {
    const id = await seedTask(query);
    const t0 = Date.now();
    const enrichTask = async () => ({});

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.ok(row.enrichment_at, 'enrichment_at set');
    const stamped = new Date(row.enrichment_at).getTime();
    assert.ok(stamped >= t0 - 1000, 'enrichment_at is not in the distant past');
    assert.ok(stamped <= Date.now() + 1000, 'enrichment_at is not in the future');
  });

  it('applies patch fields (description, project_id, size, priority, tags)', async () => {
    const id = await seedTask(query);
    const enrichTask = async () => ({
      description: 'Eric agreed to ship migration 120 by Friday.',
      project_id: 'proj-enr-staqs',
      size: 'medium',
      priority: 'high',
      tags: ['migration', 'linear'],
      next_action_hint: 'Open the PR',
    });

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.description, 'Eric agreed to ship migration 120 by Friday.');
    assert.equal(row.project_id, 'proj-enr-staqs');
    assert.equal(row.size, 'medium');
    assert.equal(row.priority, 'high');
    assert.deepEqual(row.tags, ['migration', 'linear']);
    assert.equal(row.next_action_hint, 'Open the PR');
  });

  it('honours sticky fields — operator-edited project_id is NOT overwritten', async () => {
    // feedback_history records the operator setting project_id manually.
    // The sticky helper returns {'project_id'}; the worker must drop the
    // patch's project_id but keep other fields.
    const originalHistory = [
      { verb: 'edited', field: 'project_id', value: 'operator-pinned-proj',
        by: 'ct-isaias', at: '2026-05-14T10:00:00Z' },
    ];
    const id = await seedTask(query, {
      project_id: 'operator-pinned-proj',
      feedback_history: JSON.stringify(originalHistory),
    });

    const enrichTask = async () => ({
      project_id: 'proj-enr-staqs', // would clobber if not sticky-filtered
      size: 'small',
      priority: 'high',
    });

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.project_id, 'operator-pinned-proj',
      'sticky project_id preserved');
    assert.equal(row.size, 'small', 'non-sticky size applied');
    assert.equal(row.priority, 'high', 'non-sticky priority applied');

    // feedback_history is append-only: prior entries remain untouched and
    // in order; the new llm_decision entry is appended at the tail.
    const history = typeof row.feedback_history === 'string'
      ? JSON.parse(row.feedback_history)
      : row.feedback_history;
    assert.equal(history.length, originalHistory.length + 1,
      'one new entry appended');
    assert.deepEqual(history.slice(0, originalHistory.length), originalHistory,
      'prior entries preserved in order');
    assert.equal(history[history.length - 1].verb, 'llm_decision',
      'llm_decision entry is the appended one');
  });

  it('marks row failed when enrichTask throws, logs error, keeps running', async () => {
    const idBad = await seedTask(query, { title: 'will fail' });
    const idGood = await seedTask(query, { title: 'will succeed' });

    let calls = 0;
    const enrichTask = async ({ task }) => {
      calls++;
      if (task.id === idBad) throw new Error('llm exploded');
      return { priority: 'normal' };
    };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () => {
        const a = await getRow(query, idBad);
        const b = await getRow(query, idGood);
        return a.enrichment_status === 'failed'
            && b.enrichment_status === 'completed';
      });
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, idBad)).enrichment_status, 'failed');
    assert.equal((await getRow(query, idGood)).enrichment_status, 'completed');
    assert.ok(calls >= 2, 'both rows were attempted');
  });

  it('persists an empty patch as completed with no field updates', async () => {
    const id = await seedTask(query, { priority: 'low', size: 'quick' });
    const enrichTask = async () => ({}); // simulates invalid LLM JSON

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => 'not json', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.enrichment_status, 'completed');
    assert.equal(row.priority, 'low', 'priority untouched');
    assert.equal(row.size, 'quick', 'size untouched');
    assert.ok(row.enrichment_at, 'enrichment_at still stamped');
  });

  it('two workers racing on the same row — only one wins (SKIP LOCKED)', async () => {
    const id = await seedTask(query);

    let workerACalls = 0;
    let workerBCalls = 0;

    // Both workers share the same row. The first to claim sets it
    // 'running'; the second must SKIP LOCKED and find nothing.
    const enrichTaskA = async () => { workerACalls++; return { priority: 'high' }; };
    const enrichTaskB = async () => { workerBCalls++; return { priority: 'low' }; };

    const wA = await startEnrichmentWorker({
      query, enrichTask: enrichTaskA, llm: async () => '{}', pollIntervalMs: 50,
    });
    const wB = await startEnrichmentWorker({
      query, enrichTask: enrichTaskB, llm: async () => '{}', pollIntervalMs: 50,
    });

    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
      // Give the loser worker a tick to also try its claim and back off.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await wA.stop();
      await wB.stop();
    }

    // Exactly one worker should have called enrichTask on this row.
    assert.equal(workerACalls + workerBCalls, 1,
      `only one worker enriches the row; got A=${workerACalls} B=${workerBCalls}`);
  });

  it('appends a feedback_history entry with verb=llm_decision, kind=enrichment, guardrail_id=null', async () => {
    const id = await seedTask(query);
    const enrichTask = async () => ({ priority: 'high', size: 'small' });

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    const history = typeof row.feedback_history === 'string'
      ? JSON.parse(row.feedback_history)
      : row.feedback_history;
    assert.ok(Array.isArray(history), 'feedback_history is an array');
    const llmDecisions = history.filter((e) => e.verb === 'llm_decision');
    assert.equal(llmDecisions.length, 1, 'exactly one llm_decision entry');
    const entry = llmDecisions[0];
    assert.equal(entry.kind, 'enrichment');
    assert.equal(entry.guardrail_id, null);
    // The patch should be captured.
    assert.ok(entry.patch && typeof entry.patch === 'object');
    assert.equal(entry.patch.priority, 'high');
    assert.equal(entry.patch.size, 'small');
  });

  it('does NOT process rows where deleted_at IS NOT NULL', async () => {
    const id = await seedTask(query);
    await query(
      `UPDATE inbox.human_tasks SET deleted_at = now() WHERE id = $1`,
      [id],
    );

    let calls = 0;
    const enrichTask = async () => { calls++; return {}; };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    // Let the polling tick run a few times.
    await new Promise((r) => setTimeout(r, 250));
    await worker.stop();

    assert.equal(calls, 0, 'soft-deleted row was not picked up');
    const row = await getRow(query, id);
    assert.equal(row.enrichment_status, 'pending', 'status unchanged on deleted row');
  });

  it('skips rows already in enrichment_status=running (fresh)', async () => {
    // Freshness contract (paired with the "orphan running row reset on
    // startup" test below):
    //   - Orphan cleanup resets ONLY rows where enrichment_at IS NULL OR
    //     enrichment_at < now() - interval '5 minutes' (stale).
    //   - A FRESH 'running' row (enrichment_at set recently) is owned by
    //     another worker that's actively processing it — leave it alone.
    //
    // Simulates another worker (or instance) that holds the row in flight.
    // The dequeue MUST only select status='pending'; orphan cleanup MUST
    // not touch this fresh row.
    const id = await seedTask(query, { enrichment_status: 'running' });
    await query(
      `UPDATE inbox.human_tasks SET enrichment_at = now() WHERE id = $1`,
      [id],
    );

    let calls = 0;
    const enrichTask = async () => { calls++; return {}; };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    assert.equal(calls, 0, 'fresh row in running state was not re-claimed');
    // The worker should not have touched the row's status.
    const row = await getRow(query, id);
    assert.equal(row.enrichment_status, 'running');
  });

  it('does NOT modify rows where enrichment_status=completed (idempotent)', async () => {
    const id = await seedTask(query, {
      enrichment_status: 'completed',
      priority: 'normal',
    });
    // Also stamp enrichment_at so we can detect any overwrite.
    await query(
      `UPDATE inbox.human_tasks SET enrichment_at = '2026-01-01T00:00:00Z'
        WHERE id = $1`,
      [id],
    );

    let calls = 0;
    const enrichTask = async () => { calls++; return { priority: 'high' }; };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    await worker.stop();

    assert.equal(calls, 0, 'completed row was not re-enriched');
    const row = await getRow(query, id);
    assert.equal(row.priority, 'normal');
    // enrichment_at stamp unchanged.
    assert.equal(
      new Date(row.enrichment_at).toISOString(),
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('does NOT throw uphill — errors from enrichTask are swallowed', async () => {
    const id = await seedTask(query);
    const enrichTask = async () => { throw new Error('LLM down'); };

    // If the worker propagated the error, the unhandled rejection would
    // crash node:test. The fact that this test reaches its assertion is
    // the proof.
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'failed',
      );
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, id)).enrichment_status, 'failed');
  });

  it('does NOT overwrite any field listed in sticky-fields (size + priority both sticky)', async () => {
    const originalHistory = [
      { verb: 'edited', field: 'size', value: 'quick', by: 'op', at: '2026-05-14T10:00:00Z' },
      { verb: 'edited', field: 'priority', value: 'low', by: 'op', at: '2026-05-14T11:00:00Z' },
    ];
    const id = await seedTask(query, {
      size: 'quick',
      priority: 'low',
      feedback_history: JSON.stringify(originalHistory),
    });

    const enrichTask = async () => ({
      size: 'large', priority: 'urgent', tags: ['enriched'],
    });

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.size, 'quick', 'sticky size preserved');
    assert.equal(row.priority, 'low', 'sticky priority preserved');
    assert.deepEqual(row.tags, ['enriched'], 'non-sticky tags applied');

    // feedback_history is append-only: both prior entries remain in order;
    // the new llm_decision entry is appended at the tail.
    const history = typeof row.feedback_history === 'string'
      ? JSON.parse(row.feedback_history)
      : row.feedback_history;
    assert.equal(history.length, originalHistory.length + 1,
      'one new entry appended');
    assert.deepEqual(history.slice(0, originalHistory.length), originalHistory,
      'prior entries preserved in order');
    assert.equal(history[history.length - 1].verb, 'llm_decision',
      'llm_decision entry is the appended one');
  });

  it('startup cleanup — orphaned (stale) running rows are reset to pending', async () => {
    // Freshness contract (paired with the "skips rows already in
    // enrichment_status=running (fresh)" test above):
    //   - Orphan cleanup resets ONLY rows where enrichment_at IS NULL OR
    //     enrichment_at < now() - interval '5 minutes' (stale).
    //   - A STALE 'running' row is presumed crashed mid-flight; reset it
    //     so it can be re-enriched (AD-1 simpler retry semantics).
    //
    // Simulate a crashed-mid-flight worker by inserting a row that's
    // 'running' with an enrichment_at 10 minutes in the past. On the next
    // startup, the worker MUST reset it.
    const id = await seedTask(query, { enrichment_status: 'running' });
    await query(
      `UPDATE inbox.human_tasks
          SET enrichment_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [id],
    );

    const enrichTask = async () => ({ priority: 'high' });
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
        { timeoutMs: 2000 },
      );
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, id)).enrichment_status, 'completed');
    assert.equal((await getRow(query, id)).priority, 'high');
  });

  it('shutdown — in-flight row is reset to pending (no orphan in running)', async () => {
    const id = await seedTask(query);

    let releaseEnrich;
    const enrichInFlight = new Promise((r) => (releaseEnrich = r));
    let started = false;

    const enrichTask = async () => {
      started = true;
      await enrichInFlight; // park forever; worker.stop() should unblock us
      return {};
    };

    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });

    // Wait until enrichTask has started.
    await waitUntil(() => started, { timeoutMs: 2000 });

    // Stop while in flight. Worker MUST reset the row back to 'pending'.
    const stopPromise = worker.stop();
    releaseEnrich();
    await stopPromise;

    const row = await getRow(query, id);
    assert.notEqual(row.enrichment_status, 'running',
      'in-flight row should not be left in running on shutdown');
    // 'pending' (per AD-1: simpler retry semantics) or 'completed' if the
    // enrichTask resolution beat the cancellation. Either is acceptable;
    // 'running' is the forbidden terminal state.
    assert.ok(['pending', 'completed'].includes(row.enrichment_status));
  });

  it('reacts to pg_notify (no poll wait) when a row becomes pending', async () => {
    // Insert AFTER the worker is running, then NOTIFY. The worker should
    // pick it up without waiting a full poll interval. We pick a long
    // poll interval so this only passes via the notify path.
    const enrichTask = async () => ({ priority: 'urgent' });
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 10_000,
    });

    try {
      const id = await seedTask(query);
      // Fire the notification the promoter would have emitted.
      await query(`SELECT pg_notify('human_task_enrichment_pending', $1)`, [id]);

      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
        { timeoutMs: 2000 },
      );
    } finally {
      await worker.stop();
    }
  });
});

/**
 * Two-tier push trigger (FR-6, PRD §4 "Push outcomes", §10 open question 1).
 *
 * After enrichment completes, the worker examines relevance_score and
 * decides whether to auto-enqueue a Linear push:
 *
 *   - score >= 0.8  → push_status='pending' + pg_notify('human_task_push_pending', id)
 *   - 0.6 ≤ s < 0.8 → push_status remains NULL (operator must click "Push to Linear")
 *   - score < 0.6   → push_status remains NULL
 *   - score IS NULL → push_status remains NULL
 *   - row in terminal status (done/skipped/not_for_us) → push_status remains NULL even if score ≥ 0.8
 *   - row already has push_status (pending/running/succeeded/skipped/failed)
 *     → leave it alone (operator owns force-push transitions from Task 9)
 *
 * On enrichment failure the row goes to 'failed' and the push enqueue
 * step MUST NOT run.
 */
describe('enrichment-worker — two-tier push trigger', () => {
  let query;
  const PUSH_CHANNEL = 'human_task_push_pending';

  before(async () => {
    ({ query } = await getDb());

    // Reuse the suite-level fixtures from the integration suite — they're
    // idempotent and survive across describe blocks within the same file.
    await query(
      `INSERT INTO inbox.accounts (id, owner, label, identifier, channel, provider)
       VALUES ($1, 'isaias', 'tldv-webhook', 'tldv@webhook', 'email', 'gmail')
       ON CONFLICT DO NOTHING`,
      [ACC],
    );
    await query(
      `INSERT INTO inbox.messages
         (id, account_id, channel, provider, provider_msg_id, channel_id, thread_id,
          message_id, from_address, received_at, labels)
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'wh-enr-w', 't-enr-w',
               'mid-enr-w', 'tldv@webhook', now(), ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG, ACC],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-enr-%'`);
  });

  // Subscribes to the push-pending pg_notify channel and records each
  // payload. Works for both PGlite (db.listen) and real Postgres (LISTEN
  // on a dedicated client). Returns { payloads, stop }.
  async function subscribePushNotifications() {
    const payloads = [];
    const { getMode, _getPgLiteForTest } = await import('../../lib/db.js');
    if (getMode() === 'postgres') {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query(`LISTEN ${PUSH_CHANNEL}`);
      client.on('notification', (msg) => {
        if (msg.channel === PUSH_CHANNEL) payloads.push(msg.payload);
      });
      return {
        payloads,
        stop: async () => { try { await client.end(); } catch { /* swallowed */ } },
      };
    }
    const handle = await _getPgLiteForTest();
    if (!handle || typeof handle.listen !== 'function') {
      return { payloads, stop: async () => {} };
    }
    const unsubscribe = await handle.listen(PUSH_CHANNEL, (payload) => {
      payloads.push(payload);
    });
    return {
      payloads,
      stop: async () => { try { await unsubscribe(); } catch { /* swallowed */ } },
    };
  }

  // ── Auto-tier (≥ 0.8) ──────────────────────────────────────────────────

  it('enqueues push when relevance_score=0.9 (auto-tier)', async () => {
    const id = await seedTask(query, { relevance_score: 0.9 });

    const enrichTask = async () => ({ priority: 'high' });
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'pending',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.enrichment_status, 'completed');
    assert.equal(row.push_status, 'pending',
      'auto-tier row enqueued for push');
  });

  it('enqueues push when relevance_score=0.8 (boundary inclusive)', async () => {
    const id = await seedTask(query, { relevance_score: 0.8 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'pending',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, 'pending',
      '0.8 is inclusive — boundary row enqueued');
  });

  it('emits pg_notify(human_task_push_pending) with task id on auto-enqueue', async () => {
    const sub = await subscribePushNotifications();
    const id = await seedTask(query, { relevance_score: 0.95 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'pending',
      );
      // Give the notify a beat to dispatch to the listener.
      await waitUntil(() => sub.payloads.includes(id), { timeoutMs: 1500 });
    } finally {
      await worker.stop();
      await sub.stop();
    }

    assert.ok(sub.payloads.includes(id),
      `expected pg_notify payload to include task id ${id}, got ${JSON.stringify(sub.payloads)}`);
  });

  // ── Confirm-tier (0.6 ≤ s < 0.8) ──────────────────────────────────────

  it('does NOT enqueue push when relevance_score=0.7 (confirm-tier)', async () => {
    const id = await seedTask(query, { relevance_score: 0.7 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'confirm-tier row left for operator to push manually');
  });

  it('does NOT enqueue push when relevance_score=0.6 (boundary inclusive)', async () => {
    const id = await seedTask(query, { relevance_score: 0.6 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      '0.6 is the confirm-tier floor — boundary row does NOT auto-push');
  });

  it('does NOT emit pg_notify for confirm-tier rows', async () => {
    const sub = await subscribePushNotifications();
    const id = await seedTask(query, { relevance_score: 0.7 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
      // Give the worker a tick to (incorrectly) emit a notification.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await worker.stop();
      await sub.stop();
    }

    assert.ok(!sub.payloads.includes(id),
      `confirm-tier row MUST NOT emit push notify; payloads=${JSON.stringify(sub.payloads)}`);
  });

  // ── Below threshold ───────────────────────────────────────────────────

  it('does NOT enqueue push when relevance_score=0.5 (below threshold)', async () => {
    const id = await seedTask(query, { relevance_score: 0.5 });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'below-0.6 score never auto-pushes');
  });

  it('does NOT enqueue push when relevance_score IS NULL', async () => {
    const id = await seedTask(query, { relevance_score: null });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'NULL relevance_score never auto-pushes');
  });

  // ── Defensive (terminal status) ───────────────────────────────────────

  it('does NOT enqueue push when status=done even if relevance_score ≥ 0.8', async () => {
    // Defensive: if some other path promoted the row to terminal status
    // mid-enrichment, the auto-push trigger MUST honour that and stay out.
    const id = await seedTask(query, {
      relevance_score: 0.95,
      status: 'done',
    });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'terminal done row MUST NOT be auto-enqueued for push');
  });

  it('does NOT enqueue push when status=not_for_us even if relevance_score ≥ 0.8', async () => {
    const id = await seedTask(query, {
      relevance_score: 0.9,
      status: 'not_for_us',
    });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'terminal not_for_us row MUST NOT be auto-enqueued for push');
  });

  it('does NOT enqueue push when status=skipped even if relevance_score ≥ 0.8', async () => {
    const id = await seedTask(query, {
      relevance_score: 0.85,
      status: 'skipped',
    });

    const enrichTask = async () => ({});
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'completed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'terminal skipped row MUST NOT be auto-enqueued for push');
  });

  it('does NOT enqueue push when enrichment fails', async () => {
    const id = await seedTask(query, { relevance_score: 0.95 });

    const enrichTask = async () => { throw new Error('LLM exploded'); };
    const worker = await startEnrichmentWorker({
      query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).enrichment_status === 'failed',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, null,
      'failure path MUST NOT auto-enqueue for push');
  });

  // ── Restricted (push_status already set) ──────────────────────────────

  for (const existing of ['pending', 'running', 'succeeded', 'skipped', 'failed']) {
    it(`does NOT auto-enqueue when push_status='${existing}' already (operator-owned transition)`, async () => {
      // If the row already carries a push_status, the operator (or push
      // worker) owns its lifecycle from Task 9 onwards. The enrichment
      // worker's auto-trigger MUST NOT clobber it — that would re-enqueue
      // a row that's already running, succeeded, or terminally failed.
      const id = await seedTask(query, {
        relevance_score: 0.95,
        push_status: existing,
      });

      const sub = await subscribePushNotifications();
      const enrichTask = async () => ({});
      const worker = await startEnrichmentWorker({
        query, enrichTask, llm: async () => '{}', pollIntervalMs: 50,
      });
      try {
        await waitUntil(async () =>
          (await getRow(query, id)).enrichment_status === 'completed',
        );
        // Allow any (unwanted) notify to dispatch.
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        await worker.stop();
        await sub.stop();
      }

      const row = await getRow(query, id);
      assert.equal(row.push_status, existing,
        `push_status='${existing}' MUST be preserved — worker does not overwrite`);
      assert.ok(!sub.payloads.includes(id),
        `MUST NOT re-fire push notify for row already at push_status='${existing}'`);
    });
  }
});
