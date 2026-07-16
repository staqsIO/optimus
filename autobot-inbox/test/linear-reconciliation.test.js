/**
 * RED step (TDD) — lib/runtime/linear-reconciliation.js does not exist yet.
 *
 * Tests the 10-min reconciliation cron (PRD FR-16, AD-11). The cron compares
 * inbox.human_tasks WHERE linear_issue_id IS NOT NULL against Linear's
 * authoritative state via GraphQL, fills divergent rows via the same
 * pull-mapping path as webhook ingest, and fires
 * pg_notify('human_task_divergence', task_id) on any observed drift.
 *
 * Contract:
 *
 *   startReconciliation({ query, linearClient, teamId, intervalMs })
 *     → { stop() }
 *
 *   1. Fires an initial pass on startup (does not wait for intervalMs).
 *   2. Each pass:
 *      - SELECT all rows WHERE linear_issue_id IS NOT NULL
 *        AND deleted_at IS NULL (cap LIMIT 500).
 *      - If 0 rows → skip pass (no Linear call).
 *      - Otherwise → linearClient.fetchIssues({ ids: [...] }) ONCE per pass
 *        returning [{ id, stateId, stateName, assigneeId, projectId,
 *        title, description, priority, updatedAt }, …].
 *      - For each row, compare local mirror vs Linear:
 *          state_id   differs → UPDATE linear_state_id + status (via
 *                                guardrail mapping) + linear_last_event_at.
 *          assignee   differs → UPDATE linear_assignee_id.
 *          project    differs → UPDATE linear_project_id.
 *          title      differs → UPDATE title.
 *          description differs → UPDATE description.
 *        Any divergence → pg_notify('human_task_divergence', task_id) once
 *        per row.
 *        No divergence → no UPDATE, no notify.
 *   3. Linear API error → log + continue; next interval still fires.
 *   4. Missing issue (Linear returns no row for an id) → skip that row,
 *      other rows still reconciled.
 *   5. Reconcile NEVER touches rows without linear_issue_id.
 *   6. Reconcile respects sticky fields (feedback_history 'edited' entries
 *      block overwrite of those columns; AD-5).
 *   7. stop() halts further passes; in-flight pass settles.
 *
 * Style: real DB (PGlite by default). Injectable linearClient. Action
 * sentences for test names.
 *
 * Run:
 *   cd autobot-inbox && node --test test/linear-reconciliation.test.js
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from './helpers/setup-db.js';
import { _getPgLiteForTest } from '../../lib/db.js';

import { startReconciliation } from '../../lib/runtime/linear-reconciliation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-recon-1';
const DIVERGENCE_CHANNEL = 'human_task_divergence';

const MAPPING = {
  'st-backlog':   'inbox',
  'st-todo':      'todo',
  'st-progress':  'in_progress',
  'st-review':    'review',
  'st-done':      'done',
  'st-cancelled': 'not_for_us',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function seedTask(query, overrides = {}) {
  const id = overrides.id || rid('htm-recon');
  const cols = {
    id,
    title: overrides.title ?? 'Eric to review proposal',
    description: overrides.description ?? 'Body.',
    source_quote: 'Eric to review proposal',
    status: overrides.status ?? 'todo',
    priority: 'normal',
    linear_issue_id: overrides.linear_issue_id === null
      ? null
      : (overrides.linear_issue_id ?? rid('lin-issue')),
    linear_state_id: overrides.linear_state_id ?? null,
    linear_state_name: overrides.linear_state_name ?? null,
    linear_assignee_id: overrides.linear_assignee_id ?? null,
    linear_project_id: overrides.linear_project_id ?? null,
    feedback_history: overrides.feedback_history ?? '[]',
    deleted_at: overrides.deleted_at ?? null,
  };

  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, description, source_quote, status, priority,
        linear_issue_id, linear_state_id, linear_state_name,
        linear_assignee_id, linear_project_id,
        feedback_history, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb, 'meeting_pipeline', $13)`,
    [
      cols.id, cols.title, cols.description, cols.source_quote, cols.status,
      cols.priority, cols.linear_issue_id, cols.linear_state_id,
      cols.linear_state_name, cols.linear_assignee_id, cols.linear_project_id,
      cols.feedback_history, cols.deleted_at,
    ],
  );
  return id;
}

async function getRow(query, id) {
  const r = await query(`SELECT * FROM inbox.human_tasks WHERE id = $1`, [id]);
  return r.rows[0];
}

async function ensurePushGuardrail(query, { id = 'gr-recon-push-1', mapping = MAPPING } = {}) {
  await query(`UPDATE inbox.llm_guardrails SET is_current = false WHERE kind = 'push' AND is_current = true`);
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, revision, created_by, is_current)
     VALUES ($1, 'push', 'recon test prompt', $2::jsonb, 1, 'system', true)
     ON CONFLICT (id) DO UPDATE
        SET mapping    = EXCLUDED.mapping,
            is_current = true`,
    [id, JSON.stringify(mapping)],
  );
  return id;
}

/**
 * Build an injectable linearClient. `linearClient.fetchIssues({ ids })`
 * returns issues from the `byId` map; missing ids are silently dropped.
 * Records every call.
 */
function makeLinearClient(byId = {}) {
  const calls = [];
  const client = {
    byId: { ...byId },
    calls,
    async fetchIssues({ ids }) {
      calls.push({ ids: [...(ids || [])] });
      const found = [];
      for (const id of ids || []) {
        if (Object.prototype.hasOwnProperty.call(client.byId, id)) {
          found.push(client.byId[id]);
        }
      }
      return found;
    },
  };
  return client;
}

// Subscribe to a pg_notify channel via PGlite (same pattern as
// linear-human-task-handler.test.js).
async function subscribe(channel) {
  const handle = await _getPgLiteForTest();
  if (!handle || typeof handle.listen !== 'function') {
    throw new Error(
      `pg_notify capture for ${channel} requires PGlite handle with listen(); ` +
      'run with FORCE_PGLITE=true (default in setup-db.js).',
    );
  }
  const received = [];
  const unsubscribe = await handle.listen(channel, (payload) => {
    received.push(payload);
  });
  return {
    received,
    unsubscribe: async () => {
      if (typeof unsubscribe === 'function') await unsubscribe();
    },
  };
}

async function tick(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

/** Issue snapshot constructor — mirrors linearClient.fetchIssues row shape. */
function issue(overrides = {}) {
  return {
    id: 'lin-issue-x',
    stateId: 'st-progress',
    stateName: 'In Progress',
    assigneeId: 'u-eric',
    projectId: 'p-staqspro',
    title: 'Eric to review proposal',
    description: 'Body.',
    priority: 3,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('linear-reconciliation — 10-min cron (PRD FR-16, AD-11)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-recon-%'`);
    await query(`DELETE FROM inbox.llm_guardrails WHERE id = 'gr-recon-push-1'`);
    await ensurePushGuardrail(query);
  });

  // =========================================================================
  // Reconcile pass — selection
  // =========================================================================

  describe('reconcile pass — row selection', () => {
    it('fetches all rows with linear_issue_id in one batch call to Linear', async () => {
      const idA = await seedTask(query, { linear_issue_id: 'lin-recon-A', linear_state_id: 'st-todo' });
      const idB = await seedTask(query, { linear_issue_id: 'lin-recon-B', linear_state_id: 'st-todo' });
      const idC = await seedTask(query, { linear_issue_id: 'lin-recon-C', linear_state_id: 'st-todo' });

      const client = makeLinearClient({
        'lin-recon-A': issue({ id: 'lin-recon-A', stateId: 'st-todo' }),
        'lin-recon-B': issue({ id: 'lin-recon-B', stateId: 'st-todo' }),
        'lin-recon-C': issue({ id: 'lin-recon-C', stateId: 'st-todo' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
      } finally {
        await handle.stop();
      }

      assert.equal(client.calls.length, 1, 'one batch fetch on initial pass');
      const fetchedIds = new Set(client.calls[0].ids);
      assert.ok(fetchedIds.has('lin-recon-A'), 'batch includes A');
      assert.ok(fetchedIds.has('lin-recon-B'), 'batch includes B');
      assert.ok(fetchedIds.has('lin-recon-C'), 'batch includes C');
      assert.equal(fetchedIds.size, 3, 'exactly 3 ids fetched');
      // Sanity: idA/B/C are real
      assert.ok(idA && idB && idC);
    });

    it('skips the Linear call entirely when no rows have a linear_issue_id', async () => {
      await seedTask(query, { linear_issue_id: null });

      const client = makeLinearClient();
      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      // Give the initial pass time to run.
      await tick(120);
      await handle.stop();

      assert.equal(client.calls.length, 0, 'no Linear call when no candidates');
    });

    it('excludes soft-deleted rows from the reconcile pass', async () => {
      await seedTask(query, {
        linear_issue_id: 'lin-recon-deleted',
        deleted_at: new Date().toISOString(),
      });

      const client = makeLinearClient({
        'lin-recon-deleted': issue({ id: 'lin-recon-deleted', stateId: 'st-done' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      await tick(120);
      await handle.stop();

      if (client.calls.length > 0) {
        const ids = new Set(client.calls[0].ids);
        assert.equal(ids.has('lin-recon-deleted'), false,
          'soft-deleted row not fetched');
      }
    });

    it('excludes rows with no linear_issue_id from the reconcile pass', async () => {
      await seedTask(query, { linear_issue_id: null });
      await seedTask(query, { linear_issue_id: 'lin-recon-real', linear_state_id: 'st-todo' });

      const client = makeLinearClient({
        'lin-recon-real': issue({ id: 'lin-recon-real', stateId: 'st-todo' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
      } finally {
        await handle.stop();
      }

      const ids = new Set(client.calls[0].ids);
      assert.ok(ids.has('lin-recon-real'), 'row with linear_issue_id fetched');
      assert.equal(ids.size, 1, 'only the linked row fetched');
    });
  });

  // =========================================================================
  // Divergence detection — no-op
  // =========================================================================

  describe('divergence detection — no drift', () => {
    it('does NOT update or notify when local mirror matches Linear', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-match',
        linear_state_id: 'st-progress',
        linear_assignee_id: 'u-eric',
        linear_project_id: 'p-staqspro',
        title: 'Eric to review proposal',
        description: 'Body.',
        status: 'in_progress',
      });

      const sub = await subscribe(DIVERGENCE_CHANNEL);
      const before = await getRow(query, id);

      const client = makeLinearClient({
        'lin-recon-match': issue({
          id: 'lin-recon-match',
          stateId: 'st-progress',
          stateName: 'In Progress',
          assigneeId: 'u-eric',
          projectId: 'p-staqspro',
          title: 'Eric to review proposal',
          description: 'Body.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
        await tick(60); // let any async writes settle.
      } finally {
        await handle.stop();
        await sub.unsubscribe();
      }

      const after = await getRow(query, id);
      assert.equal(after.linear_state_id, before.linear_state_id, 'state untouched');
      assert.equal(after.linear_assignee_id, before.linear_assignee_id, 'assignee untouched');
      assert.equal(after.linear_project_id, before.linear_project_id, 'project untouched');
      // updated_at trigger fires on every UPDATE, so equality of updated_at
      // is the cleanest signal that no UPDATE happened.
      assert.equal(
        new Date(after.updated_at).getTime(),
        new Date(before.updated_at).getTime(),
        'updated_at unchanged → no UPDATE was issued',
      );
      assert.equal(sub.received.length, 0, 'no divergence notify fired');
    });
  });

  // =========================================================================
  // Divergence detection — state drift
  // =========================================================================

  describe('divergence detection — state', () => {
    it('updates linear_state_id, status (via mapping) and linear_last_event_at when Linear state differs', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-state',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      const sub = await subscribe(DIVERGENCE_CHANNEL);

      const client = makeLinearClient({
        'lin-recon-state': issue({
          id: 'lin-recon-state',
          stateId: 'st-progress',
          stateName: 'In Progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
        await tick(40);
      } finally {
        await handle.stop();
        await sub.unsubscribe();
      }

      const after = await getRow(query, id);
      assert.equal(after.linear_state_id, 'st-progress', 'state id mirrored');
      assert.equal(after.status, 'in_progress', 'status mapped via guardrail');
      assert.ok(after.linear_last_event_at, 'linear_last_event_at stamped');
      assert.ok(
        sub.received.some((p) => String(p).includes(id)),
        'pg_notify human_task_divergence fired with task id',
      );
    });
  });

  // =========================================================================
  // Divergence detection — assignee, project, title, description
  // =========================================================================

  describe('divergence detection — assignee', () => {
    it('updates linear_assignee_id when Linear assignee differs', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-assignee',
        linear_assignee_id: 'u-eric',
        linear_state_id: 'st-progress',
        status: 'in_progress',
      });

      const sub = await subscribe(DIVERGENCE_CHANNEL);

      const client = makeLinearClient({
        'lin-recon-assignee': issue({
          id: 'lin-recon-assignee',
          stateId: 'st-progress',
          assigneeId: 'u-isaias',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_assignee_id === 'u-isaias';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
        await sub.unsubscribe();
      }

      const after = await getRow(query, id);
      assert.equal(after.linear_assignee_id, 'u-isaias');
      assert.ok(
        sub.received.some((p) => String(p).includes(id)),
        'divergence notify fired',
      );
    });
  });

  describe('divergence detection — project', () => {
    it('updates linear_project_id when Linear project differs', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-project',
        linear_project_id: 'p-formul8',
        linear_state_id: 'st-progress',
        status: 'in_progress',
      });

      const sub = await subscribe(DIVERGENCE_CHANNEL);

      const client = makeLinearClient({
        'lin-recon-project': issue({
          id: 'lin-recon-project',
          stateId: 'st-progress',
          projectId: 'p-staqspro',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_project_id === 'p-staqspro';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
        await sub.unsubscribe();
      }

      const after = await getRow(query, id);
      assert.equal(after.linear_project_id, 'p-staqspro');
      assert.ok(
        sub.received.some((p) => String(p).includes(id)),
        'divergence notify fired',
      );
    });
  });

  describe('divergence detection — title/description', () => {
    it('updates title when Linear title differs', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-title',
        linear_state_id: 'st-progress',
        status: 'in_progress',
        title: 'Old title',
        description: 'Body.',
      });

      const client = makeLinearClient({
        'lin-recon-title': issue({
          id: 'lin-recon-title',
          stateId: 'st-progress',
          title: 'New title from Linear',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.title === 'New title from Linear';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const after = await getRow(query, id);
      assert.equal(after.title, 'New title from Linear');
    });

    it('updates description when Linear description differs', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-desc',
        linear_state_id: 'st-progress',
        status: 'in_progress',
        description: 'Old body.',
      });

      const client = makeLinearClient({
        'lin-recon-desc': issue({
          id: 'lin-recon-desc',
          stateId: 'st-progress',
          description: 'Fresh body from Linear.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.description === 'Fresh body from Linear.';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const after = await getRow(query, id);
      assert.equal(after.description, 'Fresh body from Linear.');
    });
  });

  // =========================================================================
  // Divergence — single notify per row
  // =========================================================================

  describe('divergence — notify cardinality', () => {
    it('fires pg_notify human_task_divergence exactly once per divergent row even when multiple fields drift', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-multi',
        linear_state_id: 'st-todo',
        linear_assignee_id: 'u-eric',
        linear_project_id: 'p-formul8',
        status: 'todo',
        title: 'Old',
        description: 'Old body.',
      });

      const sub = await subscribe(DIVERGENCE_CHANNEL);

      const client = makeLinearClient({
        'lin-recon-multi': issue({
          id: 'lin-recon-multi',
          stateId: 'st-progress',
          assigneeId: 'u-isaias',
          projectId: 'p-staqspro',
          title: 'New',
          description: 'New body.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
        await tick(60);
      } finally {
        await handle.stop();
        await sub.unsubscribe();
      }

      const forThisTask = sub.received.filter((p) => String(p).includes(id));
      assert.equal(forThisTask.length, 1,
        `exactly one divergence notify per row (got ${forThisTask.length})`);
    });
  });

  // =========================================================================
  // Cron lifecycle
  // =========================================================================

  describe('cron lifecycle', () => {
    it('triggers an initial pass on startup (no need to wait for intervalMs)', async () => {
      await seedTask(query, { linear_issue_id: 'lin-recon-init', linear_state_id: 'st-todo' });

      const client = makeLinearClient({
        'lin-recon-init': issue({ id: 'lin-recon-init', stateId: 'st-todo' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000_000,
      });

      try {
        await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
      } finally {
        await handle.stop();
      }

      assert.ok(client.calls.length >= 1, 'initial pass fired without waiting for interval');
    });

    it('runs another pass after intervalMs elapses', async () => {
      await seedTask(query, { linear_issue_id: 'lin-recon-tick', linear_state_id: 'st-todo' });

      const client = makeLinearClient({
        'lin-recon-tick': issue({ id: 'lin-recon-tick', stateId: 'st-todo' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 50,
      });

      try {
        await waitUntil(() => client.calls.length >= 3, { timeoutMs: 2500 });
      } finally {
        await handle.stop();
      }

      assert.ok(client.calls.length >= 3,
        `recurring passes fire on interval (got ${client.calls.length})`);
    });

    it('stop() halts further passes; in-flight pass settles', async () => {
      await seedTask(query, { linear_issue_id: 'lin-recon-stop', linear_state_id: 'st-todo' });

      const client = makeLinearClient({
        'lin-recon-stop': issue({ id: 'lin-recon-stop', stateId: 'st-todo' }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 50,
      });

      await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
      await handle.stop();

      const countAtStop = client.calls.length;
      // Allow at most one already-in-flight pass to settle; no NEW passes.
      await tick(300);
      const countAfter = client.calls.length;

      assert.ok(
        countAfter - countAtStop <= 1,
        `stop() halts further passes (before=${countAtStop}, after=${countAfter})`,
      );
    });
  });

  // =========================================================================
  // Resilience
  // =========================================================================

  describe('resilience', () => {
    it('logs and continues when Linear fetch throws; next interval still fires', async () => {
      await seedTask(query, { linear_issue_id: 'lin-recon-flaky', linear_state_id: 'st-todo' });

      let i = 0;
      const flaky = {
        calls: [],
        async fetchIssues({ ids }) {
          i++;
          this.calls.push({ ids: [...(ids || [])] });
          if (i === 1) {
            const err = new Error('transient Linear 503');
            err.code = 'LINEAR_FETCH_FAILED';
            throw err;
          }
          return ids.map((id) => issue({ id, stateId: 'st-todo' }));
        },
      };

      const origErr = console.error;
      const origWarn = console.warn;
      const captured = [];
      console.error = (...args) => captured.push(['error', args.join(' ')]);
      console.warn  = (...args) => captured.push(['warn',  args.join(' ')]);

      const handle = startReconciliation({
        query, linearClient: flaky, teamId: TEAM_ID, intervalMs: 40,
      });

      try {
        await waitUntil(() => flaky.calls.length >= 2, { timeoutMs: 2500 });
      } finally {
        await handle.stop();
        console.error = origErr;
        console.warn = origWarn;
      }

      assert.ok(flaky.calls.length >= 2, 'recon kept running after first throw');
      const sawLog = captured.some(([, msg]) => /linear|recon|503|fetch/i.test(msg));
      assert.ok(sawLog, 'error was logged to console');
    });

    it('reconciles other rows when Linear returns no record for one id', async () => {
      const idA = await seedTask(query, {
        linear_issue_id: 'lin-recon-missing',
        linear_state_id: 'st-todo',
        status: 'todo',
      });
      const idB = await seedTask(query, {
        linear_issue_id: 'lin-recon-present',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      // Only B is returned by Linear; A is "missing" (deleted upstream).
      const client = makeLinearClient({
        'lin-recon-present': issue({
          id: 'lin-recon-present',
          stateId: 'st-progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, idB);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const a = await getRow(query, idA);
      const b = await getRow(query, idB);
      assert.equal(a.linear_state_id, 'st-todo',
        'missing-from-Linear row unchanged');
      assert.equal(a.status, 'todo', 'missing-from-Linear status unchanged');
      assert.equal(b.linear_state_id, 'st-progress',
        'present row reconciled despite sibling failure');
      assert.equal(b.status, 'in_progress', 'present row status mapped');
    });
  });

  // =========================================================================
  // Restricted scope
  // =========================================================================

  describe('restricted scope', () => {
    it('does NOT touch rows without a linear_issue_id', async () => {
      const id = await seedTask(query, {
        linear_issue_id: null,
        status: 'todo',
        title: 'Local-only task',
      });

      // Even if Linear had a same-titled issue, we must never fetch/touch it.
      const client = makeLinearClient({
        'lin-anything': issue({ id: 'lin-anything', title: 'whatever' }),
      });

      const before = await getRow(query, id);

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await tick(150);
      } finally {
        await handle.stop();
      }

      const after = await getRow(query, id);
      assert.equal(
        new Date(after.updated_at).getTime(),
        new Date(before.updated_at).getTime(),
        'row without linear_issue_id was not updated',
      );
      assert.equal(after.title, 'Local-only task', 'title untouched');
      assert.equal(after.status, 'todo', 'status untouched');
    });

    it('respects sticky fields — operator-edited columns are not overwritten by reconcile', async () => {
      // feedback_history with an 'edited' entry on title → title is sticky.
      const stickyHistory = JSON.stringify([
        {
          verb: 'edited',
          field: 'title',
          at: new Date().toISOString(),
          actor: 'eric',
        },
      ]);

      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-sticky',
        linear_state_id: 'st-todo',
        status: 'todo',
        title: 'Operator-edited title',
        feedback_history: stickyHistory,
      });

      const client = makeLinearClient({
        'lin-recon-sticky': issue({
          id: 'lin-recon-sticky',
          stateId: 'st-progress',
          title: 'Linear-side title — must not overwrite',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const after = await getRow(query, id);
      assert.equal(after.title, 'Operator-edited title',
        'sticky title preserved (operator wins)');
      assert.equal(after.linear_state_id, 'st-progress',
        'non-sticky state still reconciled');
    });
  });

  // =========================================================================
  // sync_log (NFR-13) — every drift-correcting pass appends one row.
  // No-drift passes write nothing.
  // =========================================================================
  //
  // Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md NFR-13, §3.1):
  //
  //   The reconcile pass MUST INSERT one inbox.human_task_sync_log row per
  //   drifting row processed:
  //     - direction='reconcile'
  //     - outcome='conflict_resolved'
  //     - guardrail_id=current push guardrail id (may be null when absent)
  //     - before_snapshot = JSON of the local row's pre-reconcile mirrored
  //       fields (state, assignee, project, title, description).
  //     - after_snapshot  = JSON of the applied patch (the filtered drift).
  //     - duration_ms     = non-negative integer (per-row wall-clock).
  //
  //   No drift → no UPDATE, no sync_log row.
  //   direction must NEVER be 'pull' on a reconcile pass (it's its own
  //   audit channel for the divergence dashboard panel).
  //
  // =========================================================================

  describe('sync_log (NFR-13) — reconcile pass writes one row per drifting task', () => {
    async function getSyncLogRows(taskId) {
      const r = await query(
        `SELECT id, task_id, direction, outcome, before_snapshot, after_snapshot,
                guardrail_id, error_text, duration_ms, at
           FROM inbox.human_task_sync_log
          WHERE task_id = $1
          ORDER BY id ASC`,
        [taskId],
      );
      return r.rows;
    }

    function parseJsonb(v) {
      if (v == null) return v;
      if (typeof v === 'object') return v;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    }

    beforeEach(async () => {
      await query(`DELETE FROM inbox.human_task_sync_log WHERE task_id LIKE 'htm-recon-%'`);
    });

    it('appends exactly one sync_log row with direction=reconcile, outcome=conflict_resolved per drifting row', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncone',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      const client = makeLinearClient({
        'lin-recon-syncone': issue({
          id: 'lin-recon-syncone',
          stateId: 'st-progress',
          stateName: 'In Progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
        await tick(60);
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.equal(rows.length, 1, 'exactly one sync_log row per drifting task per pass');
      assert.equal(rows[0].direction, 'reconcile', 'direction must be reconcile');
      assert.equal(rows[0].outcome, 'conflict_resolved', 'outcome must be conflict_resolved');
    });

    it('writes guardrail_id matching the current push guardrail on a reconcile-driven row', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncgr',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      const client = makeLinearClient({
        'lin-recon-syncgr': issue({
          id: 'lin-recon-syncgr',
          stateId: 'st-progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].guardrail_id, 'gr-recon-push-1',
        'guardrail_id must match the current push guardrail id');
    });

    it('captures before_snapshot reflecting the local row pre-reconcile and after_snapshot reflecting the applied patch', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncsnap',
        linear_state_id: 'st-todo',
        linear_assignee_id: 'u-eric',
        linear_project_id: 'p-formul8',
        status: 'todo',
        title: 'Pre-reconcile title',
        description: 'Pre-reconcile body.',
      });

      const client = makeLinearClient({
        'lin-recon-syncsnap': issue({
          id: 'lin-recon-syncsnap',
          stateId: 'st-progress',
          stateName: 'In Progress',
          assigneeId: 'u-isaias',
          projectId: 'p-staqspro',
          title: 'New title from Linear',
          description: 'New body from Linear.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.title === 'New title from Linear';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.equal(rows.length, 1, 'one sync_log row written');

      const before = parseJsonb(rows[0].before_snapshot);
      assert.ok(before && typeof before === 'object', 'before_snapshot must be a JSON object');
      // before_snapshot should reflect at least one pre-reconcile value.
      // Accept any subset (the implementation may choose which mirrored
      // fields to capture); assert the values match the seeded pre-state.
      if (Object.prototype.hasOwnProperty.call(before, 'linear_state_id')) {
        assert.equal(before.linear_state_id, 'st-todo',
          'before_snapshot.linear_state_id must reflect pre-reconcile state');
      }
      if (Object.prototype.hasOwnProperty.call(before, 'title')) {
        assert.equal(before.title, 'Pre-reconcile title',
          'before_snapshot.title must reflect pre-reconcile title');
      }

      const after = parseJsonb(rows[0].after_snapshot);
      assert.ok(after && typeof after === 'object', 'after_snapshot must be a JSON object');
      // after_snapshot reflects the applied patch — at least one drift key
      // must appear with the Linear-side value.
      const driftKeys = ['linear_state_id', 'linear_assignee_id', 'linear_project_id', 'title', 'description'];
      const presentKeys = driftKeys.filter((k) => Object.prototype.hasOwnProperty.call(after, k));
      assert.ok(presentKeys.length > 0,
        `after_snapshot must include at least one drift key (got: ${Object.keys(after).join(',')})`);
      if (Object.prototype.hasOwnProperty.call(after, 'linear_state_id')) {
        assert.equal(after.linear_state_id, 'st-progress',
          'after_snapshot.linear_state_id must reflect the applied patch');
      }
      if (Object.prototype.hasOwnProperty.call(after, 'title')) {
        assert.equal(after.title, 'New title from Linear',
          'after_snapshot.title must reflect the applied patch');
      }
    });

    it('records duration_ms as a non-negative integer on a reconcile-driven row', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncdur',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      const client = makeLinearClient({
        'lin-recon-syncdur': issue({
          id: 'lin-recon-syncdur',
          stateId: 'st-progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.equal(rows.length, 1);
      const d = rows[0].duration_ms;
      assert.ok(Number.isInteger(d), `duration_ms must be an integer (got ${typeof d}: ${d})`);
      assert.ok(d >= 0, `duration_ms must be non-negative (got ${d})`);
    });

    it('does NOT write a sync_log row when no drift is detected', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncnodrift',
        linear_state_id: 'st-progress',
        linear_assignee_id: 'u-eric',
        linear_project_id: 'p-staqspro',
        title: 'Eric to review proposal',
        description: 'Body.',
        status: 'in_progress',
      });

      const client = makeLinearClient({
        'lin-recon-syncnodrift': issue({
          id: 'lin-recon-syncnodrift',
          stateId: 'st-progress',
          stateName: 'In Progress',
          assigneeId: 'u-eric',
          projectId: 'p-staqspro',
          title: 'Eric to review proposal',
          description: 'Body.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(() => client.calls.length >= 1, { timeoutMs: 1500 });
        await tick(80);
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.equal(rows.length, 0,
        'no sync_log row must be written when the local mirror already matches Linear');
    });

    it('uses direction=reconcile NOT direction=pull for reconcile-driven rows', async () => {
      const id = await seedTask(query, {
        linear_issue_id: 'lin-recon-syncdir',
        linear_state_id: 'st-todo',
        status: 'todo',
      });

      const client = makeLinearClient({
        'lin-recon-syncdir': issue({
          id: 'lin-recon-syncdir',
          stateId: 'st-progress',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, id);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
      } finally {
        await handle.stop();
      }

      const rows = await getSyncLogRows(id);
      assert.ok(rows.length >= 1, 'at least one sync_log row written');
      for (const r of rows) {
        assert.equal(r.direction, 'reconcile',
          `reconcile pass must NEVER write direction=${r.direction}; only 'reconcile'`);
        assert.notEqual(r.direction, 'pull',
          'reconcile pass must NOT alias to direction=pull');
      }
    });

    it('writes one sync_log row per drifting task and skips clean siblings in the same pass', async () => {
      const drifting = await seedTask(query, {
        linear_issue_id: 'lin-recon-mixdrift',
        linear_state_id: 'st-todo',
        status: 'todo',
      });
      const clean = await seedTask(query, {
        linear_issue_id: 'lin-recon-mixclean',
        linear_state_id: 'st-progress',
        linear_assignee_id: 'u-eric',
        linear_project_id: 'p-staqspro',
        title: 'Eric to review proposal',
        description: 'Body.',
        status: 'in_progress',
      });

      const client = makeLinearClient({
        'lin-recon-mixdrift': issue({
          id: 'lin-recon-mixdrift',
          stateId: 'st-progress',
        }),
        'lin-recon-mixclean': issue({
          id: 'lin-recon-mixclean',
          stateId: 'st-progress',
          stateName: 'In Progress',
          assigneeId: 'u-eric',
          projectId: 'p-staqspro',
          title: 'Eric to review proposal',
          description: 'Body.',
        }),
      });

      const handle = startReconciliation({
        query, linearClient: client, teamId: TEAM_ID, intervalMs: 10_000,
      });

      try {
        await waitUntil(async () => {
          const r = await getRow(query, drifting);
          return r && r.linear_state_id === 'st-progress';
        }, { timeoutMs: 2000 });
        await tick(60);
      } finally {
        await handle.stop();
      }

      const driftingRows = await getSyncLogRows(drifting);
      const cleanRows = await getSyncLogRows(clean);
      assert.equal(driftingRows.length, 1, 'drifting task gets one sync_log row');
      assert.equal(cleanRows.length, 0, 'clean task gets zero sync_log rows');
      assert.equal(driftingRows[0].direction, 'reconcile');
      assert.equal(driftingRows[0].outcome, 'conflict_resolved');
    });
  });
});
