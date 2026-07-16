/**
 * RED step (TDD) — GET /api/guardrails/decisions does not yet exist.
 *
 * FR-22 / FR-23 (Settings → LLM Guardrails — "Last 10 LLM decisions" panel).
 *
 * Endpoint under test:
 *   GET /api/guardrails/decisions?guardrail_id=<id>&limit=10
 *
 * Source-of-truth for decisions: inbox.human_task_sync_log rows with
 * direction='push' joined back to inbox.human_tasks for the title and
 * Linear chip metadata. guardrail_id is indexed-friendly (single-column).
 *
 * Returns an array of objects shaped:
 *   { task_id, title, linear_issue_id, linear_issue_url, outcome,
 *     decision: <after_snapshot>, at }
 *
 * Auth: requireBoard (same as the other guardrail endpoints).
 *
 * All handler tests inject mockReq() objects exactly like the existing
 * guardrails-api tests.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { getGuardrailDecisions } from '../src/api-routes/guardrails.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

async function clearAll(query) {
  await query(`DELETE FROM inbox.human_task_sync_log`);
  await query(`DELETE FROM inbox.human_tasks`);
  await query(`DELETE FROM inbox.llm_guardrail_corrections`);
  await query(`DELETE FROM inbox.llm_guardrails`);
}

// Note: is_current defaults to false here because each test typically seeds
// multiple revisions of the same kind. The partial-unique-index from migration
// 120 (`llm_guardrails_current_per_kind`) only allows one is_current=true per
// kind, so making rows non-current keeps seeding noise-free. The decisions
// endpoint does NOT filter on is_current — guardrail_id is a denormalised
// pointer recorded at push time, exactly what FR-23 / AD-6 require.
async function seedGuardrail(query, { id, kind = 'push', revision = 1, is_current = false }) {
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, revision, created_by, is_current)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'system', $5)`,
    [id, kind, 'p', revision, is_current],
  );
}

async function seedTask(query, {
  id,
  title = 'Test task',
  status = 'inbox',
  linear_issue_id = null,
  linear_issue_url = null,
}) {
  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, source_quote, status, linear_issue_id, linear_issue_url,
        feedback_history, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'test')`,
    [id, title, 'src', status, linear_issue_id, linear_issue_url],
  );
}

async function seedSyncLog(query, {
  task_id,
  direction = 'push',
  outcome = 'success',
  guardrail_id,
  after_snapshot = null,
  at = null,
}) {
  await query(
    `INSERT INTO inbox.human_task_sync_log
       (task_id, direction, outcome, guardrail_id, after_snapshot, at)
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))`,
    [
      task_id,
      direction,
      outcome,
      guardrail_id,
      after_snapshot ? JSON.stringify(after_snapshot) : null,
      at,
    ],
  );
}

// ===========================================================================
// GET /api/guardrails/decisions
// ===========================================================================

describe('GET /api/guardrails/decisions', () => {
  let query;

  before(async () => { ({ query } = await getDb()); });

  beforeEach(async () => { await clearAll(query); });

  it('rejects unauthenticated callers (401/403)', async () => {
    await assert.rejects(
      () => getGuardrailDecisions(
        publicReq('/api/guardrails/decisions?guardrail_id=gr-1'),
      ),
      (err) => err.statusCode === 401 || err.statusCode === 403,
    );
  });

  it('returns 400 when guardrail_id is missing', async () => {
    await assert.rejects(
      () => getGuardrailDecisions(boardReq('/api/guardrails/decisions')),
      (err) => err.statusCode === 400,
    );
  });

  it('returns 400 when guardrail_id is empty string', async () => {
    await assert.rejects(
      () => getGuardrailDecisions(
        boardReq('/api/guardrails/decisions?guardrail_id='),
      ),
      (err) => err.statusCode === 400,
    );
  });

  it('returns empty array when no push decisions exist for that guardrail', async () => {
    await seedGuardrail(query, { id: 'gr-empty' });
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-empty'),
    );
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 0);
  });

  it('filters by guardrail_id — does not return decisions from other guardrails', async () => {
    await seedGuardrail(query, { id: 'gr-a' });
    await seedGuardrail(query, { id: 'gr-b', revision: 2 });
    await seedTask(query, { id: 't-1', title: 'task one', linear_issue_id: 'LIN-1' });
    await seedTask(query, { id: 't-2', title: 'task two', linear_issue_id: 'LIN-2' });

    await seedSyncLog(query, { task_id: 't-1', guardrail_id: 'gr-a' });
    await seedSyncLog(query, { task_id: 't-2', guardrail_id: 'gr-b' });

    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-a'),
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].task_id, 't-1');
  });

  it("returns only direction='push' entries (pull/reconcile excluded)", async () => {
    await seedGuardrail(query, { id: 'gr-dir' });
    await seedTask(query, { id: 't-push', title: 'pushed' });
    await seedTask(query, { id: 't-pull', title: 'pulled' });
    await seedTask(query, { id: 't-recon', title: 'reconciled' });

    await seedSyncLog(query, { task_id: 't-push', direction: 'push', guardrail_id: 'gr-dir' });
    await seedSyncLog(query, { task_id: 't-pull', direction: 'pull', guardrail_id: 'gr-dir' });
    await seedSyncLog(query, { task_id: 't-recon', direction: 'reconcile', guardrail_id: 'gr-dir' });

    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-dir'),
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].task_id, 't-push');
  });

  it('returns rows ordered by at DESC (newest first)', async () => {
    await seedGuardrail(query, { id: 'gr-order' });
    await seedTask(query, { id: 't-old', title: 'old' });
    await seedTask(query, { id: 't-mid', title: 'mid' });
    await seedTask(query, { id: 't-new', title: 'new' });

    await seedSyncLog(query, {
      task_id: 't-old', guardrail_id: 'gr-order',
      at: '2026-01-01T00:00:00Z',
    });
    await seedSyncLog(query, {
      task_id: 't-new', guardrail_id: 'gr-order',
      at: '2026-05-01T00:00:00Z',
    });
    await seedSyncLog(query, {
      task_id: 't-mid', guardrail_id: 'gr-order',
      at: '2026-03-01T00:00:00Z',
    });

    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-order'),
    );
    assert.strictEqual(res.length, 3);
    assert.deepStrictEqual(
      res.map((r) => r.task_id),
      ['t-new', 't-mid', 't-old'],
    );
  });

  it('default limit=10 caps response when many push decisions exist', async () => {
    await seedGuardrail(query, { id: 'gr-default-limit' });
    for (let i = 0; i < 15; i++) {
      await seedTask(query, { id: `t-dl-${i}`, title: `task ${i}` });
      await seedSyncLog(query, { task_id: `t-dl-${i}`, guardrail_id: 'gr-default-limit' });
    }
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-default-limit'),
    );
    assert.strictEqual(res.length, 10, 'default limit must be 10');
  });

  it('explicit limit is honoured', async () => {
    await seedGuardrail(query, { id: 'gr-lim' });
    for (let i = 0; i < 8; i++) {
      await seedTask(query, { id: `t-lim-${i}`, title: `t ${i}` });
      await seedSyncLog(query, { task_id: `t-lim-${i}`, guardrail_id: 'gr-lim' });
    }
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-lim&limit=3'),
    );
    assert.strictEqual(res.length, 3);
  });

  it('limit > 50 is clamped to 50 (max)', async () => {
    await seedGuardrail(query, { id: 'gr-max' });
    for (let i = 0; i < 60; i++) {
      await seedTask(query, { id: `t-max-${i}`, title: `t ${i}` });
      await seedSyncLog(query, { task_id: `t-max-${i}`, guardrail_id: 'gr-max' });
    }
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-max&limit=200'),
    );
    assert.strictEqual(res.length, 50, 'limit must clamp at 50');
  });

  it('returns 400 for non-numeric limit', async () => {
    await seedGuardrail(query, { id: 'gr-bad-lim' });
    await assert.rejects(
      () => getGuardrailDecisions(
        boardReq('/api/guardrails/decisions?guardrail_id=gr-bad-lim&limit=banana'),
      ),
      (err) => err.statusCode === 400,
    );
  });

  it('returns 400 for limit <= 0', async () => {
    await seedGuardrail(query, { id: 'gr-zero-lim' });
    await assert.rejects(
      () => getGuardrailDecisions(
        boardReq('/api/guardrails/decisions?guardrail_id=gr-zero-lim&limit=0'),
      ),
      (err) => err.statusCode === 400,
    );
  });

  it('each row exposes the expected shape', async () => {
    await seedGuardrail(query, { id: 'gr-shape' });
    await seedTask(query, {
      id: 't-shape',
      title: 'Shape test',
      linear_issue_id: 'LIN-77',
      linear_issue_url: 'https://linear.app/staqs/issue/LIN-77',
    });
    await seedSyncLog(query, {
      task_id: 't-shape',
      guardrail_id: 'gr-shape',
      outcome: 'success',
      after_snapshot: { stateId: 'st-1', projectId: 'pr-1' },
    });
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-shape'),
    );
    assert.strictEqual(res.length, 1);
    const row = res[0];
    for (const key of [
      'task_id', 'title', 'linear_issue_id', 'linear_issue_url',
      'outcome', 'decision', 'at',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, key),
        `row must expose ${key}`,
      );
    }
    assert.strictEqual(row.task_id, 't-shape');
    assert.strictEqual(row.title, 'Shape test');
    assert.strictEqual(row.linear_issue_id, 'LIN-77');
    assert.strictEqual(row.linear_issue_url, 'https://linear.app/staqs/issue/LIN-77');
    assert.strictEqual(row.outcome, 'success');
    const decision = typeof row.decision === 'string'
      ? JSON.parse(row.decision)
      : row.decision;
    assert.deepStrictEqual(decision, { stateId: 'st-1', projectId: 'pr-1' });
    assert.ok(row.at, 'at timestamp must be present');
  });

  it('includes skipped-outcome decisions in the result set', async () => {
    await seedGuardrail(query, { id: 'gr-skip' });
    await seedTask(query, { id: 't-skip', title: 'Skipped one' });
    await seedSyncLog(query, {
      task_id: 't-skip',
      guardrail_id: 'gr-skip',
      outcome: 'skipped',
    });
    const res = await getGuardrailDecisions(
      boardReq('/api/guardrails/decisions?guardrail_id=gr-skip'),
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].outcome, 'skipped');
  });
});

// ===========================================================================
// Route registration sanity — the new handler is exported and wired.
// ===========================================================================

describe('Route registration: GET /api/guardrails/decisions', () => {
  it('registerGuardrailRoutes wires GET /api/guardrails/decisions', async () => {
    const mod = await import('../src/api-routes/guardrails.js');
    const routes = new Map();
    mod.registerGuardrailRoutes(routes);
    assert.ok(
      routes.has('GET /api/guardrails/decisions'),
      'GET /api/guardrails/decisions must be registered',
    );
    assert.strictEqual(
      routes.get('GET /api/guardrails/decisions'),
      mod.getGuardrailDecisions,
    );
  });
});
