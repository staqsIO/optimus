/**
 * RED step (TDD) — lib/runtime/human-task-push-worker.js does not exist yet.
 *
 * Tests the post-enrichment push-to-Linear worker. Contract (PRD §1 FR-5,
 * FR-6, FR-8, FR-10; §6 AD-1, AD-3; §2 NFR-7, NFR-8):
 *
 *   - Subscribes to pg_notify channel `human_task_push_pending`.
 *   - Periodically polls inbox.human_tasks WHERE push_status='pending'
 *     AND deleted_at IS NULL as a backstop.
 *   - Dequeues one task at a time using SELECT … FOR UPDATE SKIP LOCKED.
 *   - Sets push_status='running' on claim, calls the push LLM via the
 *     injected `llm(prompt)`, parses the JSON, runs `buildIssuePayload`,
 *     then either:
 *       - skip: push_status='skipped', push_skip_reason set, no Linear call,
 *         sync_log row with outcome='skipped'.
 *       - push: linearClient.createIssue(payload) → linear_issue_id,
 *         linear_issue_url, linear_synced_at, push_status='succeeded',
 *         sync_log row with outcome='success'.
 *   - On Linear error: in-process retry up to MAX_ATTEMPTS=3 with
 *     exponential backoff (50ms × 2^i, capped 500ms). Row stays
 *     push_status='running' across attempts (never bounced to 'pending');
 *     push_attempts++ and push_last_error set per failed Linear call.
 *     After attempts exhausted → push_status='failed', sync_log
 *     outcome='failed'. The LLM is called exactly once per push (NFR-8)
 *     — the row's decision is f(task, cache, guardrail, llm₁) and is
 *     not re-rolled on Linear blips.
 *   - Wraps LLM + Linear call in Promise.race against `pushTimeoutMs`.
 *   - Worker never throws uphill.
 *   - On startup: rows in 'running' older than 5 min reset to 'pending'.
 *     Fresh 'running' rows owned by another worker are left alone.
 *   - feedback_history appends `verb='linear_push'` entries.
 *
 * Tests use the real PGlite DB + an injected `llm` (returns a JSON string)
 * + an injected `linearClient.createIssue` (returns {id, url} or rejects).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { startPushWorker } from '../../lib/runtime/human-task-push-worker.js';

const ACC = 'acc-push-worker-test';
const MSG = 'msg-push-worker';
const TEAM_ID = 'team-push-worker';

// ── helpers ────────────────────────────────────────────────────────────────

async function waitUntil(predicate, { timeoutMs = 2500, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

async function seedTask(query, overrides = {}) {
  const id = overrides.id || `htm-push-${Math.random().toString(36).slice(2, 10)}`;
  const cols = {
    id,
    title: 'Eric to ship the migration',
    source_quote: 'Eric to ship the migration before EOW',
    assignee_label: 'Eric',
    status: 'inbox',
    push_status: 'pending',
    push_attempts: 0,
    message_id: MSG,
    feedback_history: '[]',
    ...overrides,
  };
  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, source_quote, assignee_label, status,
        push_status, push_attempts, message_id, feedback_history, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'meeting_pipeline')`,
    [
      cols.id, cols.title, cols.source_quote, cols.assignee_label,
      cols.status, cols.push_status, cols.push_attempts, cols.message_id,
      cols.feedback_history,
    ],
  );
  return id;
}

async function getRow(query, id) {
  const r = await query(`SELECT * FROM inbox.human_tasks WHERE id = $1`, [id]);
  return r.rows[0];
}

async function getSyncLog(query, id) {
  const r = await query(
    `SELECT * FROM inbox.human_task_sync_log WHERE task_id = $1 ORDER BY at ASC, id ASC`,
    [id],
  );
  return r.rows;
}

async function seedTeamCache(query) {
  await query(
    `INSERT INTO inbox.linear_team_cache
       (team_id, workflow_states, projects, members, labels, refreshed_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())
     ON CONFLICT (team_id) DO UPDATE
       SET workflow_states = EXCLUDED.workflow_states,
           projects        = EXCLUDED.projects,
           members         = EXCLUDED.members,
           labels          = EXCLUDED.labels,
           refreshed_at    = now()`,
    [
      TEAM_ID,
      JSON.stringify([
        { id: 'state-todo', name: 'Todo', type: 'unstarted' },
        { id: 'state-inprog', name: 'In Progress', type: 'started' },
      ]),
      JSON.stringify([{ id: 'proj-staqs', name: 'StaqsPro', state: 'started' }]),
      JSON.stringify([{ id: 'member-eric', name: 'Eric', email: 'eric@staqs.io' }]),
      JSON.stringify([{ id: 'label-optimus', name: 'optimus' }]),
    ],
  );
}

async function clearTeamCache(query) {
  await query(`DELETE FROM inbox.linear_team_cache WHERE team_id = $1`, [TEAM_ID]);
}

async function seedGuardrail(query, opts = {}) {
  const id = opts.id || `gr-push-${Math.random().toString(36).slice(2, 8)}`;
  // Flip any prior current row off first to respect the unique-current invariant.
  await query(
    `UPDATE inbox.llm_guardrails SET is_current=false WHERE kind='push' AND is_current=true`,
  );
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, is_current, revision, created_by)
     VALUES ($1, 'push', $2, $3::jsonb, true, $4, 'system')`,
    [
      id,
      opts.prompt_text || 'Decide whether to push.',
      JSON.stringify(opts.mapping || { defaultStateId: 'state-todo' }),
      opts.revision || 1,
    ],
  );
  return id;
}

async function clearGuardrails(query) {
  await query(`DELETE FROM inbox.llm_guardrails WHERE kind='push'`);
}

// Standard LLM response shape — picks the cached state/project/assignee.
function llmReturning(payload) {
  return async () => JSON.stringify(payload);
}

const HAPPY_PAYLOAD = {
  title: 'Ship migration 120',
  description: 'Eric ships migration 120 before EOW.',
  projectId: 'proj-staqs',
  assigneeId: 'member-eric',
  stateId: 'state-todo',
  priority: 2,
  labelIds: [],
  dueDate: null,
};

// Real Linear assigns a DISTINCT issue id per createIssue call, and migration
// 153 enforces that with the `human_tasks_linear_issue_unique_live` unique
// index (one live task per Linear issue). Tests that push more than one row in a
// single run must therefore return distinct ids — pass `uniquePerCall: true` so
// each call yields `${id}-${callIndex}`. Single-row tests keep the literal `id`.
function makeLinearClient({ id = 'lin-abc', url = 'https://linear.app/team/issue/LIN-1', throws = null, uniquePerCall = false } = {}) {
  const calls = [];
  return {
    calls,
    async createIssue(payload) {
      calls.push(payload);
      if (typeof throws === 'function') {
        return throws(calls.length, payload);
      }
      if (throws) throw throws;
      if (uniquePerCall) {
        return { id: `${id}-${calls.length}`, url: `${url}-${calls.length}` };
      }
      return { id, url };
    },
  };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('push-worker — integration', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

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
       VALUES ($1, $2, 'webhook', 'gmail', NULL, 'wh-push-w', 't-push-w',
               'mid-push-w', 'tldv@webhook', now(), ARRAY['webhook:tldv'])
       ON CONFLICT DO NOTHING`,
      [MSG, ACC],
    );
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_task_sync_log WHERE task_id LIKE 'htm-push-%'`);
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-push-%'`);
    await clearGuardrails(query);
    await seedGuardrail(query);
    await seedTeamCache(query);
  });

  // ── Startup / lifecycle ─────────────────────────────────────────────────

  it('drains existing pending rows on startup', async () => {
    const id1 = await seedTask(query);
    const id2 = await seedTask(query);

    // Two rows push in one drain → two distinct Linear issues (the
    // human_tasks_linear_issue_unique_live index forbids sharing an issue id).
    const linearClient = makeLinearClient({ uniquePerCall: true });
    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });

    try {
      await waitUntil(async () => {
        const r1 = await getRow(query, id1);
        const r2 = await getRow(query, id2);
        return r1.push_status === 'succeeded' && r2.push_status === 'succeeded';
      });
    } finally {
      await worker.stop();
    }

    assert.equal(linearClient.calls.length, 2, 'linear called twice');
  });

  it('resets stale running rows (>5 min old pushed_at) back to pending on startup', async () => {
    const id = await seedTask(query, { push_status: 'running' });
    // Backdate pushed_at directly. We cannot use updated_at — the
    // touch_human_tasks_updated_at BEFORE UPDATE trigger (migration 119)
    // unconditionally rewrites it to now(). pushed_at is a dedicated column
    // owned by the worker; the trigger never touches it.
    await query(
      `UPDATE inbox.human_tasks
          SET pushed_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [id],
    );

    const linearClient = makeLinearClient();
    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });

    try {
      await waitUntil(async () => (await getRow(query, id)).push_status === 'succeeded',
        { timeoutMs: 3000 });
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, id)).push_status, 'succeeded');
  });

  it('leaves fresh running rows alone (recently touched pushed_at)', async () => {
    const id = await seedTask(query, { push_status: 'running' });
    // Stamp pushed_at = now() to mark this row as freshly claimed by some
    // other worker. Startup cleanup keys off pushed_at, not updated_at
    // (which the touch trigger rewrites on every UPDATE).
    await query(
      `UPDATE inbox.human_tasks SET pushed_at = now() WHERE id = $1`,
      [id],
    );

    const linearClient = makeLinearClient();
    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });

    // Let polling tick a couple times.
    await new Promise((r) => setTimeout(r, 250));
    await worker.stop();

    assert.equal(linearClient.calls.length, 0, 'fresh running row not picked up');
    assert.equal((await getRow(query, id)).push_status, 'running');
  });

  it('reacts to pg_notify on human_task_push_pending without waiting a full poll', async () => {
    const linearClient = makeLinearClient();
    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 10_000, // long poll — only the notify path can pass this test
    });

    try {
      const id = await seedTask(query);
      await query(`SELECT pg_notify('human_task_push_pending', $1)`, [id]);
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
        { timeoutMs: 3000 },
      );
    } finally {
      await worker.stop();
    }
  });

  it('stop() returns within stopTimeoutMs even if work is hung', async () => {
    const id = await seedTask(query);
    let releaseLlm;
    const hangLlm = new Promise((r) => { releaseLlm = r; });
    let started = false;
    const llm = async () => {
      started = true;
      await hangLlm;
      return JSON.stringify(HAPPY_PAYLOAD);
    };

    const linearClient = makeLinearClient();
    const worker = await startPushWorker({
      query,
      llm,
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
      pushTimeoutMs: 60_000,   // long per-row timeout, irrelevant — we bound via stop
      stopTimeoutMs: 200,      // tight stop budget
    });

    await waitUntil(() => started, { timeoutMs: 2000 });
    const t0 = Date.now();
    await worker.stop();
    const dt = Date.now() - t0;
    releaseLlm();
    assert.ok(dt < 2000, `stop() returned in ${dt}ms — must respect stopTimeoutMs`);
    // Row should not be left in 'running' indefinitely. Worker should
    // either reset to pending or finish before stop completes; the forbidden
    // state is 'running' with no in-flight worker.
    const row = await getRow(query, id);
    assert.notEqual(row.push_status, 'running',
      'row not left in running after stop');
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it('happy path — pending → running → succeeded with Linear ids written back', async () => {
    const id = await seedTask(query);
    const linearClient = makeLinearClient({
      id: 'lin-iss-1',
      url: 'https://linear.app/team/issue/LIN-7',
    });

    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, 'succeeded');
    assert.equal(row.linear_issue_id, 'lin-iss-1');
    assert.equal(row.linear_issue_url, 'https://linear.app/team/issue/LIN-7');
    assert.ok(row.linear_synced_at, 'linear_synced_at stamped');
    assert.equal(linearClient.calls.length, 1, 'Linear called exactly once');
  });

  it('appends feedback_history entry verb=linear_push outcome=success with guardrail_id', async () => {
    // Look up the current guardrail id so we can assert against it.
    const grRow = await query(
      `SELECT id FROM inbox.llm_guardrails WHERE kind='push' AND is_current=true LIMIT 1`,
    );
    const guardrailId = grRow.rows[0].id;

    const id = await seedTask(query);
    const linearClient = makeLinearClient({ id: 'lin-iss-2', url: 'https://linear.app/x' });

    const worker = await startPushWorker({
      query, llm: llmReturning(HAPPY_PAYLOAD), linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    const history = typeof row.feedback_history === 'string'
      ? JSON.parse(row.feedback_history)
      : row.feedback_history;
    const linearPushEntries = history.filter((e) => e.verb === 'linear_push');
    assert.equal(linearPushEntries.length, 1, 'exactly one linear_push entry');
    const entry = linearPushEntries[0];
    assert.equal(entry.outcome, 'success');
    assert.equal(entry.guardrail_id, guardrailId);
    assert.equal(entry.issue_id, 'lin-iss-2');
  });

  it('writes a human_task_sync_log row with direction=push outcome=success guardrail_id', async () => {
    const grRow = await query(
      `SELECT id FROM inbox.llm_guardrails WHERE kind='push' AND is_current=true LIMIT 1`,
    );
    const guardrailId = grRow.rows[0].id;

    const id = await seedTask(query);
    const linearClient = makeLinearClient({ id: 'lin-iss-3', url: 'https://linear.app/y' });

    const worker = await startPushWorker({
      query, llm: llmReturning(HAPPY_PAYLOAD), linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
      );
    } finally {
      await worker.stop();
    }

    const logs = await getSyncLog(query, id);
    assert.ok(logs.length >= 1, 'sync_log row inserted');
    const successLog = logs.find((l) => l.outcome === 'success');
    assert.ok(successLog, 'success sync_log row present');
    assert.equal(successLog.direction, 'push');
    assert.equal(successLog.guardrail_id, guardrailId);
  });

  // ── Skip path ───────────────────────────────────────────────────────────

  it('LLM returns skip_reason → push_status=skipped, no Linear call, skip reason persisted', async () => {
    const id = await seedTask(query);
    const linearClient = makeLinearClient();

    const worker = await startPushWorker({
      query,
      llm: llmReturning({ skip_reason: 'not enough context' }),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'skipped',
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, 'skipped');
    assert.equal(row.push_skip_reason, 'not enough context');
    assert.equal(linearClient.calls.length, 0, 'Linear never called on skip');
  });

  it('skip path appends sync_log row with direction=push outcome=skipped', async () => {
    const id = await seedTask(query);
    const linearClient = makeLinearClient();

    const worker = await startPushWorker({
      query,
      llm: llmReturning({ skip_reason: 'duplicate' }),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'skipped',
      );
    } finally {
      await worker.stop();
    }

    const logs = await getSyncLog(query, id);
    const skipped = logs.find((l) => l.outcome === 'skipped');
    assert.ok(skipped, 'sync_log skipped row present');
    assert.equal(skipped.direction, 'push');
  });

  // ── Retry path ──────────────────────────────────────────────────────────

  it('linearClient throws once → push_attempts increments, eventually succeeds', async () => {
    const id = await seedTask(query);
    let attempt = 0;
    const linearClient = {
      calls: [],
      async createIssue(payload) {
        this.calls.push(payload);
        attempt++;
        if (attempt === 1) throw new Error('502 Bad Gateway');
        return { id: 'lin-retry', url: 'https://linear.app/r' };
      },
    };

    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });
    try {
      // After first attempt → pending again with push_attempts=1, push_last_error set.
      await waitUntil(async () => {
        const r = await getRow(query, id);
        return r.push_attempts >= 1 && typeof r.push_last_error === 'string'
          && r.push_last_error.length > 0;
      });

      // Then second attempt succeeds → push_status=succeeded.
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
        { timeoutMs: 3000 },
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, 'succeeded');
    assert.ok(row.push_attempts >= 1, 'push_attempts incremented on failure');
  });

  it('linearClient throws 3 times → push_status=failed, sync_log outcome=failed', async () => {
    const id = await seedTask(query);
    const linearClient = {
      calls: [],
      async createIssue(payload) {
        this.calls.push(payload);
        throw new Error('500 always');
      },
    };

    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'failed',
        { timeoutMs: 4000 },
      );
    } finally {
      await worker.stop();
    }

    const row = await getRow(query, id);
    assert.equal(row.push_status, 'failed');
    assert.ok(row.push_attempts >= 3, `push_attempts >=3, got ${row.push_attempts}`);
    const logs = await getSyncLog(query, id);
    const failedLog = logs.find((l) => l.outcome === 'failed');
    assert.ok(failedLog, 'sync_log failed row present');
    assert.equal(failedLog.direction, 'push');
  });

  it('worker continues to other rows after one fails permanently', async () => {
    // Seed two rows with deterministic created_at ordering: the BAD row is
    // older, so the worker (which polls oldest-first) claims it first. The
    // LLM stub then routes by call ORDER — not by grepping the prompt —
    // so the test stays decoupled from prompt internals.
    const idBad = await seedTask(query, { id: 'htm-push-bad-1' });
    const idGood = await seedTask(query, { id: 'htm-push-good-1' });
    await query(
      `UPDATE inbox.human_tasks
          SET created_at = now() - interval '2 minutes'
        WHERE id = $1`,
      [idBad],
    );
    await query(
      `UPDATE inbox.human_tasks
          SET created_at = now() - interval '1 minute'
        WHERE id = $1`,
      [idGood],
    );

    const linearClient = {
      calls: [],
      async createIssue(payload) {
        this.calls.push(payload);
        if (payload.title && payload.title.includes('BAD')) {
          throw new Error('always fails');
        }
        return { id: 'lin-good', url: 'https://linear.app/good' };
      },
    };

    // Counter-driven router: 1st LLM invocation → BAD-tagged payload (older
    // row), every subsequent → GOOD-tagged. No coupling to prompt text.
    let llmCallIndex = 0;
    const llm = async () => {
      llmCallIndex++;
      const isFirst = llmCallIndex === 1;
      return JSON.stringify({
        ...HAPPY_PAYLOAD,
        title: isFirst ? 'BAD title' : 'GOOD title',
      });
    };

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () => {
        const a = await getRow(query, idBad);
        const b = await getRow(query, idGood);
        return a.push_status === 'failed' && b.push_status === 'succeeded';
      }, { timeoutMs: 5000 });
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, idBad)).push_status, 'failed');
    assert.equal((await getRow(query, idGood)).push_status, 'succeeded');
  });

  // ── Cache / guardrail missing ───────────────────────────────────────────

  it('missing team cache → row marked failed, LLM never called', async () => {
    await clearTeamCache(query);
    const id = await seedTask(query);

    let llmCalled = false;
    const llm = async () => { llmCalled = true; return JSON.stringify(HAPPY_PAYLOAD); };
    const linearClient = makeLinearClient();

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'failed',
        { timeoutMs: 3000 },
      );
    } finally {
      await worker.stop();
    }

    assert.equal(llmCalled, false, 'LLM not called without team cache');
    assert.equal(linearClient.calls.length, 0, 'Linear not called without team cache');
  });

  it('missing current push guardrail → row marked failed, LLM never called', async () => {
    await clearGuardrails(query);
    const id = await seedTask(query);

    let llmCalled = false;
    const llm = async () => { llmCalled = true; return JSON.stringify(HAPPY_PAYLOAD); };
    const linearClient = makeLinearClient();

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'failed',
        { timeoutMs: 3000 },
      );
    } finally {
      await worker.stop();
    }

    assert.equal(llmCalled, false, 'LLM not called without guardrail');
    assert.equal(linearClient.calls.length, 0, 'Linear not called without guardrail');
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  it('LLM hangs longer than pushTimeoutMs → row eventually failed', async () => {
    const id = await seedTask(query);
    const llm = async () => new Promise(() => { /* forever */ });
    const linearClient = makeLinearClient();

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
      pushTimeoutMs: 100,
      stopTimeoutMs: 500,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'failed',
        { timeoutMs: 5000 },
      );
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, id)).push_status, 'failed');
    assert.equal(linearClient.calls.length, 0, 'Linear never called on LLM hang');
  });

  it('linearClient hangs longer than pushTimeoutMs → row eventually failed', async () => {
    const id = await seedTask(query);
    const linearClient = {
      calls: [],
      async createIssue(payload) {
        this.calls.push(payload);
        return new Promise(() => { /* hang */ });
      },
    };

    const worker = await startPushWorker({
      query,
      llm: llmReturning(HAPPY_PAYLOAD),
      linearClient,
      teamId: TEAM_ID,
      pollIntervalMs: 50,
      pushTimeoutMs: 100,
      stopTimeoutMs: 500,
    });
    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'failed',
        { timeoutMs: 5000 },
      );
    } finally {
      await worker.stop();
    }

    assert.equal((await getRow(query, id)).push_status, 'failed');
  });

  // ── Concurrency ─────────────────────────────────────────────────────────

  it('two workers racing on the same row — only one wins (SKIP LOCKED)', async () => {
    const id = await seedTask(query);

    const linearClientA = makeLinearClient({ id: 'lin-A', url: 'https://linear.app/A' });
    const linearClientB = makeLinearClient({ id: 'lin-B', url: 'https://linear.app/B' });

    const wA = await startPushWorker({
      query, llm: llmReturning(HAPPY_PAYLOAD), linearClient: linearClientA,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    const wB = await startPushWorker({
      query, llm: llmReturning(HAPPY_PAYLOAD), linearClient: linearClientB,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });

    try {
      await waitUntil(async () =>
        (await getRow(query, id)).push_status === 'succeeded',
      );
      // Give the loser a tick to attempt + back off.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await wA.stop();
      await wB.stop();
    }

    assert.equal(linearClientA.calls.length + linearClientB.calls.length, 1,
      `only one worker pushes the row; got A=${linearClientA.calls.length} B=${linearClientB.calls.length}`);
  });

  // ── Restricted ──────────────────────────────────────────────────────────

  it('does NOT process rows where deleted_at IS NOT NULL', async () => {
    const id = await seedTask(query);
    await query(`UPDATE inbox.human_tasks SET deleted_at = now() WHERE id = $1`, [id]);

    const linearClient = makeLinearClient();
    let llmCalls = 0;
    const llm = async () => { llmCalls++; return JSON.stringify(HAPPY_PAYLOAD); };

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();

    assert.equal(llmCalls, 0, 'LLM never called for soft-deleted row');
    assert.equal(linearClient.calls.length, 0, 'Linear never called for soft-deleted row');
    const row = await getRow(query, id);
    assert.equal(row.push_status, 'pending', 'push_status untouched on deleted row');
  });

  it('does NOT reprocess rows where push_status=succeeded (idempotent)', async () => {
    const id = await seedTask(query, {
      push_status: 'succeeded',
    });
    await query(
      `UPDATE inbox.human_tasks
          SET linear_issue_id='lin-prev', linear_issue_url='https://linear.app/p',
              linear_synced_at = '2026-01-01T00:00:00Z'
        WHERE id = $1`,
      [id],
    );

    const linearClient = makeLinearClient();
    let llmCalls = 0;
    const llm = async () => { llmCalls++; return JSON.stringify(HAPPY_PAYLOAD); };

    const worker = await startPushWorker({
      query, llm, linearClient,
      teamId: TEAM_ID, pollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();

    assert.equal(llmCalls, 0, 'LLM never called for already-succeeded row');
    assert.equal(linearClient.calls.length, 0, 'Linear never called for already-succeeded row');
    const row = await getRow(query, id);
    assert.equal(row.push_status, 'succeeded', 'push_status unchanged');
    assert.equal(row.linear_issue_id, 'lin-prev', 'linear_issue_id preserved');
  });
});
