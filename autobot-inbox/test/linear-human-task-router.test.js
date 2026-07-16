/**
 * RED step (TDD) — `routeHumanTaskWebhook` does not exist yet in
 * `src/linear/ingest.js`. These tests pin the contract for Task 11:
 *
 *   Extend `src/linear/ingest.js` so that Linear webhook events whose
 *   issue id matches an existing `inbox.human_tasks.linear_issue_id`
 *   are dispatched to a new human-task pull handler instead of falling
 *   through to the engineering-ticket flow.
 *
 * Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-12, FR-13,
 * AD-9):
 *
 *   - New export `routeHumanTaskWebhook(payload, deps)`.
 *   - For Issue events (action ∈ create|update|remove):
 *       1. Reads `payload.data.id` (or `payload.data.issueId`).
 *       2. Looks it up in inbox.human_tasks WHERE linear_issue_id = $1
 *          AND deleted_at IS NULL.
 *       3. If matched → returns `{ matched: true, taskId }` AND stamps
 *          `human_tasks.linear_last_event_at = now()` on the row.
 *       4. If not matched → returns `{ matched: false }`. No row writes.
 *   - For Comment events (`payload.type === 'Comment'`):
 *       1. Reads `payload.data.issueId` (and falls back to data.issue.id).
 *       2. Same lookup + same return shape.
 *   - MUST NOT throw on missing/null issue id → `{ matched: false }`.
 *   - MUST NOT throw on DB error → logs, returns `{ matched: false }`.
 *   - When matched, `handleLinearWebhook` MUST NOT fall through to
 *     `createWorkItem` (engineering-ticket path skipped).
 *
 * Style: real PGlite DB + injected `query`. Mocked `createWorkItem`
 * asserts it is NOT called on match. Action-sentence test names.
 *
 * Run:
 *   cd autobot-inbox && node --test test/linear-human-task-router.test.js
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

// Import the module under test. `routeHumanTaskWebhook` is the new export
// this RED step is forcing into existence; the existing `handleLinearWebhook`
// is exercised to assert the engineering-ticket path is skipped on match.
const ingestModule = await import('../src/linear/ingest.js');
const { routeHumanTaskWebhook, handleLinearWebhook, clearDedupCache } = ingestModule;

// ---- Helpers ----

async function seedHumanTask(query, overrides = {}) {
  const id = overrides.id || `htm-router-${Math.random().toString(36).slice(2, 10)}`;
  const cols = {
    id,
    title: 'Eric to review the proposal',
    source_quote: 'Eric to review the proposal by Friday',
    status: 'inbox',
    linear_issue_id: null,
    linear_issue_url: null,
    deleted_at: null,
    ...overrides,
  };
  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, source_quote, status, linear_issue_id, linear_issue_url,
        feedback_history, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'meeting_pipeline', $7)`,
    [
      cols.id, cols.title, cols.source_quote, cols.status,
      cols.linear_issue_id, cols.linear_issue_url, cols.deleted_at,
    ],
  );
  return id;
}

async function getRow(query, id) {
  const r = await query(`SELECT * FROM inbox.human_tasks WHERE id = $1`, [id]);
  return r.rows[0];
}

function makeIssuePayload({ action = 'update', issueId, type = 'Issue' } = {}) {
  return {
    action,
    type,
    data: { id: issueId, assigneeId: 'human-uuid' },
  };
}

function makeCommentPayload({ action = 'create', issueId, commentBody = 'hello' } = {}) {
  return {
    action,
    type: 'Comment',
    data: {
      id: `cmt-${Math.random().toString(36).slice(2, 8)}`,
      body: commentBody,
      issueId,
      issue: { id: issueId },
      user: { id: 'u-eric', name: 'Eric Gang' },
    },
  };
}

// ---- Tests ----

describe('routeHumanTaskWebhook — Optimus-owned issue detection', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    clearDedupCache?.();
    // Wipe any rows from previous tests that we might collide with.
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-router-%'`);
  });

  it('exports routeHumanTaskWebhook', () => {
    assert.equal(
      typeof routeHumanTaskWebhook,
      'function',
      'routeHumanTaskWebhook must be a named export of src/linear/ingest.js',
    );
  });

  // ==========================================================
  // Issue event routing
  // ==========================================================

  describe('Issue event with matching linear_issue_id', () => {
    it('returns { matched: true, taskId } when linear_issue_id matches', async () => {
      const linearId = 'lin-issue-match-1';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: linearId }),
        { query },
      );

      assert.equal(result.matched, true);
      assert.equal(result.taskId, taskId);
    });

    it('stamps linear_last_event_at to ~now on the matched row', async () => {
      const linearId = 'lin-issue-match-2';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const before = Date.now();
      await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: linearId }),
        { query },
      );
      const after = Date.now();

      const row = await getRow(query, taskId);
      assert.ok(row.linear_last_event_at, 'linear_last_event_at must be set');
      const stampedMs = new Date(row.linear_last_event_at).getTime();
      // Allow a small clock-skew margin (1s before, 5s after the call window).
      assert.ok(
        stampedMs >= before - 1000 && stampedMs <= after + 5000,
        `linear_last_event_at (${row.linear_last_event_at}) must be ~now`,
      );
    });

    it('returns { matched: true } for action="create" on a matched issue', async () => {
      const linearId = 'lin-issue-match-create';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ action: 'create', issueId: linearId }),
        { query },
      );

      assert.equal(result.matched, true);
      assert.equal(result.taskId, taskId);
    });

    it('returns { matched: true } for action="remove" on a matched issue', async () => {
      const linearId = 'lin-issue-match-remove';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ action: 'remove', issueId: linearId }),
        { query },
      );

      assert.equal(result.matched, true);
      assert.equal(result.taskId, taskId);
    });
  });

  // ==========================================================
  // Issue event with no matching linear_issue_id (engineering path)
  // ==========================================================

  describe('Issue event with no matching human_task', () => {
    it('returns { matched: false } when linear_issue_id is unknown', async () => {
      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: 'lin-issue-not-in-db' }),
        { query },
      );

      assert.equal(result.matched, false);
      assert.equal(result.taskId, undefined);
    });

    it('does not modify any human_tasks row when there is no match', async () => {
      // Seed an unrelated row to confirm it stays untouched.
      const taskId = await seedHumanTask(query, {
        linear_issue_id: 'lin-issue-other',
      });
      const before = await getRow(query, taskId);

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: 'lin-issue-NOT-other' }),
        { query },
      );

      assert.equal(result.matched, false);
      const after = await getRow(query, taskId);
      assert.equal(
        after.linear_last_event_at,
        before.linear_last_event_at,
        'non-matching webhook must NOT touch any human_tasks row',
      );
    });
  });

  // ==========================================================
  // Soft-deleted rows are treated as not Optimus-owned
  // ==========================================================

  describe('soft-deleted human_tasks row', () => {
    it('returns { matched: false } when the matching row has deleted_at IS NOT NULL', async () => {
      const linearId = 'lin-issue-soft-deleted';
      await seedHumanTask(query, {
        linear_issue_id: linearId,
        deleted_at: new Date().toISOString(),
      });

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: linearId }),
        { query },
      );

      assert.equal(result.matched, false);
    });
  });

  // ==========================================================
  // Comment event routing
  // ==========================================================

  describe('Comment event with matching issue id', () => {
    it('returns { matched: true, taskId } when comment.data.issueId matches', async () => {
      const linearId = 'lin-issue-comment-match';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const result = await routeHumanTaskWebhook(
        makeCommentPayload({ issueId: linearId, commentBody: '@optimus done' }),
        { query },
      );

      assert.equal(result.matched, true);
      assert.equal(result.taskId, taskId);
    });

    it('stamps linear_last_event_at on the matched row from a Comment event', async () => {
      const linearId = 'lin-issue-comment-stamp';
      const taskId = await seedHumanTask(query, { linear_issue_id: linearId });

      const before = Date.now();
      await routeHumanTaskWebhook(
        makeCommentPayload({ issueId: linearId }),
        { query },
      );
      const row = await getRow(query, taskId);
      assert.ok(row.linear_last_event_at, 'linear_last_event_at must be set');
      const stampedMs = new Date(row.linear_last_event_at).getTime();
      assert.ok(
        stampedMs >= before - 1000,
        'linear_last_event_at must be at or after the call start',
      );
    });

    it('returns { matched: false } for a Comment on a non-Optimus issue', async () => {
      const result = await routeHumanTaskWebhook(
        makeCommentPayload({ issueId: 'lin-issue-NOT-OPTIMUS' }),
        { query },
      );
      assert.equal(result.matched, false);
    });
  });

  // ==========================================================
  // Negative / robustness
  // ==========================================================

  describe('graceful failure', () => {
    it('returns { matched: false } when payload.data is missing', async () => {
      const result = await routeHumanTaskWebhook(
        { action: 'update', type: 'Issue' },
        { query },
      );
      assert.equal(result.matched, false);
    });

    it('returns { matched: false } when issue id is null/missing', async () => {
      const result = await routeHumanTaskWebhook(
        { action: 'update', type: 'Issue', data: { id: null } },
        { query },
      );
      assert.equal(result.matched, false);
    });

    it('returns { matched: false } when payload itself is null/undefined', async () => {
      const r1 = await routeHumanTaskWebhook(null, { query });
      assert.equal(r1.matched, false);
      const r2 = await routeHumanTaskWebhook(undefined, { query });
      assert.equal(r2.matched, false);
    });

    it('returns { matched: false } and does not throw when the DB query fails', async () => {
      const brokenQuery = async () => {
        throw new Error('connection refused');
      };

      const result = await routeHumanTaskWebhook(
        makeIssuePayload({ issueId: 'lin-issue-any' }),
        { query: brokenQuery },
      );

      assert.equal(result.matched, false);
    });
  });

  // ==========================================================
  // handleLinearWebhook integration: matched → human-task path,
  // not the engineering-ticket createWorkItem path.
  // ==========================================================

  describe('handleLinearWebhook integration: dispatches around engineering path', () => {
    it('does NOT call createWorkItem when the issue matches a human_task', async () => {
      const linearId = 'lin-issue-handle-match';
      await seedHumanTask(query, { linear_issue_id: linearId });

      const createWorkItem = async () => {
        throw new Error(
          'createWorkItem MUST NOT be called when routing dispatches to the human-task path',
        );
      };

      // Wrap in try/catch — the human-task path is stubbed for now (Task 12+),
      // so the outer handler may return early with a routed result, skip, or
      // a stub response. The CRITICAL assertion is that createWorkItem is not
      // invoked: if it were, the throw above would surface here.
      let threw = false;
      try {
        await handleLinearWebhook(
          { action: 'update', type: 'Issue', data: { id: linearId, assigneeId: 'human' } },
          createWorkItem,
        );
      } catch (err) {
        threw = true;
        assert.fail(
          `handleLinearWebhook called createWorkItem on a matched human_task: ${err.message}`,
        );
      }
      assert.equal(
        threw,
        false,
        'handleLinearWebhook must skip the engineering-ticket branch on match',
      );
    });
  });
});
