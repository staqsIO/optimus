/**
 * RED step (TDD) — handleHumanTaskWebhook is a STUB in src/linear/ingest.js
 * (see Task 11 hand-off note in the file). These tests pin the contract for
 * Task 12: mirror Linear Issue/Comment events into inbox.human_tasks.
 *
 * Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-13, FR-17,
 * FR-18, FR-19, NFR-4; AD-5 sticky overrides):
 *
 *   handleHumanTaskWebhook(payload, { query, taskId }) → Promise<void>
 *
 *   1. Fetch the current push guardrail
 *      (SELECT id, mapping FROM inbox.llm_guardrails
 *         WHERE kind='push' AND is_current=true LIMIT 1).
 *      Missing → log warn + return early, no row writes.
 *   2. mapLinearEventToPatch({ payload, mappingFromGuardrail: gr.mapping }).
 *   3. If patch is non-empty, apply via parameterised UPDATE (single round
 *      trip), respecting AD-5 sticky overrides:
 *        - Fields whose name is in getStickyFields(feedback_history)
 *          MUST NOT be overwritten (silently dropped from the UPDATE).
 *   4. Append a feedback_history entry
 *        { verb: 'linear_pull', event_type, fields_changed, guardrail_id, at }
 *      on every issue event (regardless of patch contents). Comment events
 *      with no patch DO NOT append (only state-affecting events trigger
 *      pull entries).
 *   5. terminal=true → emit pg_notify('human_task_completed', taskId).
 *   6. DB errors during UPDATE → caught + logged, no throw.
 *
 * Style: real DB (PGlite by default per setup-db.js). Injected query.
 * Action-sentence test names.
 *
 * Run:
 *   cd autobot-inbox && node --test test/linear-human-task-handler.test.js
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from './helpers/setup-db.js';
import { _getPgLiteForTest } from '../../lib/db.js';

import { handleHumanTaskWebhook } from '../src/linear/ingest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAPPING = {
  'st-backlog':   'inbox',
  'st-todo':      'todo',
  'st-progress':  'in_progress',
  'st-review':    'review',
  'st-done':      'done',
  'st-cancelled': 'not_for_us',
};

const COMPLETED_CHANNEL = 'human_task_completed';

async function seedTask(query, overrides = {}) {
  const id = overrides.id || `htm-pullh-${Math.random().toString(36).slice(2, 10)}`;
  const cols = {
    id,
    title: 'Eric to review the proposal',
    description: 'Body.',
    source_quote: 'Eric to review the proposal',
    status: 'inbox',
    priority: 'normal',
    linear_issue_id: 'lin-issue-pullh',
    feedback_history: '[]',
    ...overrides,
  };
  await query(
    `INSERT INTO inbox.human_tasks
       (id, title, description, source_quote, status, priority,
        linear_issue_id, feedback_history, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'meeting_pipeline')`,
    [
      cols.id, cols.title, cols.description, cols.source_quote, cols.status,
      cols.priority, cols.linear_issue_id, cols.feedback_history,
    ],
  );
  return id;
}

async function getRow(query, id) {
  const r = await query(`SELECT * FROM inbox.human_tasks WHERE id = $1`, [id]);
  return r.rows[0];
}

function parseHistory(row) {
  if (!row) return [];
  const h = row.feedback_history;
  if (Array.isArray(h)) return h;
  if (h == null) return [];
  if (typeof h === 'string') {
    try { return JSON.parse(h); } catch { return []; }
  }
  return [];
}

async function ensurePushGuardrail(query, { id = 'gr-pullh-push-1', mapping = MAPPING } = {}) {
  // Idempotent — flip any prior current push row off, then upsert this one.
  await query(`UPDATE inbox.llm_guardrails SET is_current = false WHERE kind = 'push' AND is_current = true`);
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, revision, created_by, is_current)
     VALUES ($1, 'push', 'test prompt', $2::jsonb, 1, 'system', true)
     ON CONFLICT (id) DO UPDATE
        SET mapping    = EXCLUDED.mapping,
            is_current = true`,
    [id, JSON.stringify(mapping)],
  );
  return id;
}

async function clearPushGuardrails(query) {
  await query(`DELETE FROM inbox.llm_guardrails WHERE kind = 'push'`);
}

// Subscribe to a pg_notify channel via the PGlite handle (mirrors the
// pattern in signal-task-promoter-notify.test.js). Returns { received,
// unsubscribe }. Throws if PGlite is unavailable — these tests require it.
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

// Payload builders.
function makeIssueUpdatePayload(overrides = {}) {
  return {
    action: 'update',
    type: 'Issue',
    data: {
      id: 'lin-issue-pullh',
      title: 'Renamed in Linear',
      description: 'Updated body.',
      assigneeId: 'u-isaias-linear',
      projectId: 'p-staqspro',
      priority: 2,
      state: { id: 'st-progress', name: 'In Progress', type: 'started' },
      stateId: 'st-progress',
      ...overrides.data,
    },
    updatedFrom: overrides.updatedFrom ?? {
      stateId: 'st-todo',
      title: 'Eric to review the proposal',
      description: 'Body.',
      assigneeId: 'u-eric',
      projectId: 'p-formul8',
      priority: 3,
    },
  };
}

function makeCommentPayload(overrides = {}) {
  return {
    action: 'create',
    type: 'Comment',
    data: {
      id: 'cmt-pullh-1',
      body: 'just a note',
      issueId: 'lin-issue-pullh',
      issue: { id: 'lin-issue-pullh' },
      user: { id: 'u-eric', name: 'Eric Gang' },
      ...overrides.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleHumanTaskWebhook — Linear pull → human_tasks integration', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-pullh-%'`);
    await clearPushGuardrails(query);
  });

  it('applies the mapped patch fields to the matched human_tasks row', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const row = await getRow(query, id);
    assert.equal(row.status, 'in_progress', 'status mapped from state id');
    assert.equal(row.title, 'Renamed in Linear');
    assert.equal(row.description, 'Updated body.');
    assert.equal(row.linear_state_id, 'st-progress');
    assert.equal(row.linear_state_name, 'In Progress');
    assert.equal(row.linear_assignee_id, 'u-isaias-linear');
    assert.equal(row.linear_project_id, 'p-staqspro');
    assert.equal(row.priority, 'high', 'Linear priority 2 → high');
    assert.ok(row.linear_last_event_at, 'linear_last_event_at must be stamped');
  });

  it('appends a feedback_history entry with verb=linear_pull, event_type, fields_changed, guardrail_id', async () => {
    const grId = await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const history = parseHistory(await getRow(query, id));
    const pull = history.find((e) => e && e.verb === 'linear_pull');
    assert.ok(pull, 'feedback_history must contain a linear_pull entry');
    assert.equal(pull.event_type, 'Issue.update');
    assert.ok(Array.isArray(pull.fields_changed), 'fields_changed must be an array');
    // Several fields changed in this payload; assert a representative sample.
    assert.ok(pull.fields_changed.includes('status'));
    assert.ok(pull.fields_changed.includes('title'));
    assert.equal(pull.guardrail_id, grId);
    assert.ok(pull.at, 'at must be set');
  });

  it('fires pg_notify on human_task_completed when the pulled state is terminal', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query, { status: 'in_progress' });

    const sub = await subscribe(COMPLETED_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload({
          data: { state: { id: 'st-done', name: 'Done', type: 'completed' } },
          updatedFrom: { stateId: 'st-progress' },
        }),
        { query, taskId: id },
      );

      await tick();
      assert.equal(sub.received.length, 1, 'one terminal notify must fire');
      assert.equal(sub.received[0], id, 'notify payload must be the task id');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('does NOT fire pg_notify when the pulled state is non-terminal', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query, { status: 'todo' });

    const sub = await subscribe(COMPLETED_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload({
          data: { state: { id: 'st-progress', name: 'In Progress', type: 'started' } },
          updatedFrom: { stateId: 'st-todo' },
        }),
        { query, taskId: id },
      );

      await tick(60);
      assert.equal(sub.received.length, 0, 'non-terminal state must NOT notify completed');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('returns early and applies no patch when the push guardrail is missing', async () => {
    // No guardrail row at all.
    const id = await seedTask(query, { status: 'todo' });
    const rowBefore = await getRow(query, id);

    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => { warned.push(args); };
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload(),
        { query, taskId: id },
      );
    } finally {
      console.warn = originalWarn;
    }

    const rowAfter = await getRow(query, id);
    // No field of interest changed.
    assert.equal(rowAfter.status, rowBefore.status, 'status must not change without guardrail');
    assert.equal(rowAfter.title, rowBefore.title, 'title must not change without guardrail');
    assert.equal(rowAfter.linear_state_id, rowBefore.linear_state_id, 'state id must not change');
    const history = parseHistory(rowAfter);
    assert.equal(
      history.filter((e) => e && e.verb === 'linear_pull').length,
      0,
      'no linear_pull feedback entry must be appended when guardrail is missing',
    );
    assert.ok(warned.length >= 1, 'a warn must surface when the push guardrail is missing');
  });

  it('applies non-status fields when state id is not in the guardrail mapping (status stays unchanged)', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query, { status: 'todo' });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload({
          data: {
            state: { id: 'st-UNKNOWN', name: 'Custom', type: 'started' },
            title: 'New title via custom state',
            assigneeId: 'u-new',
          },
          updatedFrom: { stateId: 'st-todo' },
        }),
        { query, taskId: id },
      );
    } finally {
      console.warn = originalWarn;
    }

    const row = await getRow(query, id);
    assert.equal(row.status, 'todo', 'status stays unchanged when state id is unmapped');
    assert.equal(row.title, 'New title via custom state', 'other fields still apply');
    assert.equal(row.linear_assignee_id, 'u-new');
  });

  it('does NOT update the row or append a linear_pull entry for a comment event with no patch', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);
    const before = await getRow(query, id);
    const beforeUpdatedAt = before.updated_at;

    await handleHumanTaskWebhook(
      makeCommentPayload(),
      { query, taskId: id },
    );

    const after = await getRow(query, id);
    // No mirrored fields touched.
    assert.equal(after.status, before.status);
    assert.equal(after.title, before.title);
    assert.equal(after.description, before.description);
    // updated_at MUST NOT advance (the row was not UPDATEd at all).
    assert.equal(
      new Date(after.updated_at).getTime(),
      new Date(beforeUpdatedAt).getTime(),
      'comment-only events must NOT trigger an UPDATE',
    );
    const history = parseHistory(after);
    assert.equal(
      history.filter((e) => e && e.verb === 'linear_pull').length,
      0,
      'comment-only events must NOT append a linear_pull feedback entry',
    );
  });

  it('does NOT overwrite sticky fields (operator-edited via verb=edited)', async () => {
    await ensurePushGuardrail(query);
    // Seed with feedback_history showing the operator edited title + priority.
    const stickyHistory = JSON.stringify([
      { verb: 'edited', field: 'title', value: 'Operator-set title (sticky)', by: 'isaias', at: new Date().toISOString() },
      { verb: 'edited', field: 'priority', value: 'urgent', by: 'isaias', at: new Date().toISOString() },
    ]);
    const id = await seedTask(query, {
      title: 'Operator-set title (sticky)',
      priority: 'urgent',
      feedback_history: stickyHistory,
    });

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload({
        data: {
          title: 'Linear-overwrite title (should be dropped)',
          priority: 2, // 'high' — should be dropped
          description: 'Updated body (NOT sticky).',
          assigneeId: 'u-linear', // NOT sticky
          state: { id: 'st-progress', name: 'In Progress', type: 'started' },
        },
        updatedFrom: { stateId: 'st-todo' },
      }),
      { query, taskId: id },
    );

    const row = await getRow(query, id);
    assert.equal(row.title, 'Operator-set title (sticky)', 'sticky title must NOT be overwritten');
    assert.equal(row.priority, 'urgent', 'sticky priority must NOT be overwritten');
    // Non-sticky fields DO apply.
    assert.equal(row.description, 'Updated body (NOT sticky).');
    assert.equal(row.linear_assignee_id, 'u-linear');
    assert.equal(row.status, 'in_progress', 'status is not a sticky field by default — pull applies');
  });

  it('catches DB errors during UPDATE and does not throw', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    // Inject a query that succeeds for SELECT but throws for UPDATE.
    let updateAttempts = 0;
    const flakyQuery = async (text, params) => {
      if (typeof text === 'string' && /^\s*UPDATE/i.test(text)) {
        updateAttempts += 1;
        throw new Error('simulated DB write failure');
      }
      return query(text, params);
    };

    const originalError = console.error;
    console.error = () => {};
    let threw = null;
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload(),
        { query: flakyQuery, taskId: id },
      );
    } catch (err) {
      threw = err;
    } finally {
      console.error = originalError;
    }

    assert.equal(threw, null, 'handler must NOT throw on UPDATE failure');
    assert.ok(updateAttempts >= 1, 'an UPDATE must have been attempted');
  });
});

// ---------------------------------------------------------------------------
// ready-for-Optimus signal — FR-15
// ---------------------------------------------------------------------------
//
// Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md FR-15;
// PRD v0.2 §5.2 "Ready for Optimus" signal):
//
//   After the pull-side patch is applied, the handler calls
//   detectReadyForOptimus({ payload, mapping, optimusHandle }). When
//   ready=true it fires
//     pg_notify('human_task_ready_for_optimus',
//               JSON.stringify({ task_id, comment_text, actor, source }))
//   and appends a feedback_history entry
//     { verb: 'ready_for_optimus', source, actor, at }.
//
//   The state-mapping side reads `awaitingOptimusStateId` from the current
//   push guardrail's `mapping` JSONB. The comment side matches `@optimus`
//   (word-boundary, case-insensitive).
//
//   Missing guardrail → handler returns early; no ready notify fires even
//   when a comment otherwise matches.
//
// ---------------------------------------------------------------------------

const READY_CHANNEL = 'human_task_ready_for_optimus';
const AWAITING_OPTIMUS_STATE_ID = 'st-awaiting-optimus';

async function ensurePushGuardrailWithAwaiting(query, {
  id = 'gr-pullh-push-rfo',
  mapping = {
    ...MAPPING,
    [AWAITING_OPTIMUS_STATE_ID]: 'inbox',
    awaitingOptimusStateId: AWAITING_OPTIMUS_STATE_ID,
  },
} = {}) {
  await query(`UPDATE inbox.llm_guardrails SET is_current = false WHERE kind = 'push' AND is_current = true`);
  await query(
    `INSERT INTO inbox.llm_guardrails
       (id, kind, prompt_text, mapping, revision, created_by, is_current)
     VALUES ($1, 'push', 'test prompt', $2::jsonb, 1, 'system', true)
     ON CONFLICT (id) DO UPDATE
        SET mapping    = EXCLUDED.mapping,
            is_current = true`,
    [id, JSON.stringify(mapping)],
  );
  return id;
}

function makeAwaitingStateIssuePayload() {
  return {
    action: 'update',
    type: 'Issue',
    actor: { id: 'u-eric', name: 'Eric Gang' },
    data: {
      id: 'lin-issue-pullh',
      stateId: AWAITING_OPTIMUS_STATE_ID,
      state: { id: AWAITING_OPTIMUS_STATE_ID, name: 'Ready for Optimus', type: 'started' },
    },
    updatedFrom: { stateId: 'st-progress' },
  };
}

function makeOptimusCommentPayload(body = '@optimus please draft a reply') {
  return {
    action: 'create',
    type: 'Comment',
    actor: { id: 'u-eric', name: 'Eric Gang' },
    data: {
      id: 'cmt-pullh-rfo',
      body,
      issueId: 'lin-issue-pullh',
      issue: { id: 'lin-issue-pullh' },
      user: { id: 'u-eric', name: 'Eric Gang' },
    },
  };
}

describe('handleHumanTaskWebhook — ready-for-Optimus signal (FR-15)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-pullh-%'`);
    await clearPushGuardrails(query);
  });

  it('fires human_task_ready_for_optimus with source=state when issue moves to the awaiting-Optimus state', async () => {
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query, { status: 'in_progress' });

    const sub = await subscribe(READY_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeAwaitingStateIssuePayload(),
        { query, taskId: id },
      );

      await tick();
      assert.equal(sub.received.length, 1, 'exactly one ready notify must fire');
      const payload = JSON.parse(sub.received[0]);
      assert.equal(payload.task_id, id, 'task_id must be the row id');
      assert.equal(payload.source, 'state', 'source must be state');
      assert.ok(payload.actor, 'actor must be present in the notify');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('fires human_task_ready_for_optimus with source=comment + comment_text when a comment contains @optimus', async () => {
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query);

    const sub = await subscribe(READY_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeOptimusCommentPayload('@optimus please draft a reply'),
        { query, taskId: id },
      );

      await tick();
      assert.equal(sub.received.length, 1, 'exactly one ready notify must fire');
      const payload = JSON.parse(sub.received[0]);
      assert.equal(payload.task_id, id, 'task_id must be the row id');
      assert.equal(payload.source, 'comment', 'source must be comment');
      assert.equal(payload.comment_text, '@optimus please draft a reply');
      assert.ok(payload.actor, 'actor must be present in the notify');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('does NOT fire the ready notify when the state moves to a non-awaiting-Optimus state', async () => {
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query, { status: 'todo' });

    const sub = await subscribe(READY_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload({
          data: { state: { id: 'st-progress', name: 'In Progress', type: 'started' } },
          updatedFrom: { stateId: 'st-todo' },
        }),
        { query, taskId: id },
      );

      await tick(60);
      assert.equal(sub.received.length, 0, 'no ready notify must fire for a non-awaiting state');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('mirrors the state via the pull patch AND fires the ready notify when moving to awaiting-Optimus', async () => {
    // Map the awaiting-Optimus state to `inbox` so the pull side has something
    // to apply alongside the ready notify (both paths must run).
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query, { status: 'in_progress' });

    const sub = await subscribe(READY_CHANNEL);
    try {
      await handleHumanTaskWebhook(
        makeAwaitingStateIssuePayload(),
        { query, taskId: id },
      );

      await tick();
      // Pull side applied the state mirror.
      const row = await getRow(query, id);
      assert.equal(row.linear_state_id, AWAITING_OPTIMUS_STATE_ID, 'linear_state_id must mirror');
      assert.equal(row.status, 'inbox', 'status must mirror the awaiting-state mapping');
      // Ready notify also fired.
      assert.equal(sub.received.length, 1, 'ready notify must fire alongside the pull patch');
      const payload = JSON.parse(sub.received[0]);
      assert.equal(payload.source, 'state');
    } finally {
      await sub.unsubscribe();
    }
  });

  it('appends a verb=ready_for_optimus feedback_history entry alongside any linear_pull entry', async () => {
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query, { status: 'in_progress' });

    await handleHumanTaskWebhook(
      makeAwaitingStateIssuePayload(),
      { query, taskId: id },
    );

    const history = parseHistory(await getRow(query, id));
    const ready = history.find((e) => e && e.verb === 'ready_for_optimus');
    assert.ok(ready, 'feedback_history must contain a ready_for_optimus entry');
    assert.equal(ready.source, 'state');
    assert.ok(ready.actor, 'ready_for_optimus entry must carry actor');
    assert.ok(ready.at, 'ready_for_optimus entry must carry at');

    // The state change is also a pull event — both entries must coexist.
    const pull = history.find((e) => e && e.verb === 'linear_pull');
    assert.ok(pull, 'a linear_pull entry must also be appended');
  });

  it('appends a verb=ready_for_optimus entry on a comment match even when no linear_pull entry is appended', async () => {
    await ensurePushGuardrailWithAwaiting(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeOptimusCommentPayload('@optimus take it from here'),
      { query, taskId: id },
    );

    const history = parseHistory(await getRow(query, id));
    const ready = history.find((e) => e && e.verb === 'ready_for_optimus');
    assert.ok(ready, 'feedback_history must contain a ready_for_optimus entry for comment matches');
    assert.equal(ready.source, 'comment');
    // Comment-only events do NOT append linear_pull (per existing contract).
    const pull = history.find((e) => e && e.verb === 'linear_pull');
    assert.equal(pull, undefined, 'no linear_pull entry should appear for a pure comment event');
  });

  it('does NOT fire the ready notify when the push guardrail is missing, even if the comment matches', async () => {
    // No guardrail at all — defensive: handler returns early.
    const id = await seedTask(query);

    const sub = await subscribe(READY_CHANNEL);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await handleHumanTaskWebhook(
        makeOptimusCommentPayload('@optimus please act'),
        { query, taskId: id },
      );

      await tick(60);
      assert.equal(
        sub.received.length, 0,
        'missing guardrail must suppress the ready notify even for an @optimus comment',
      );
    } finally {
      console.warn = originalWarn;
      await sub.unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------
// sync_log (NFR-13) — every successful or failed pull must append one
// inbox.human_task_sync_log row with direction='pull'.
// ---------------------------------------------------------------------------
//
// Contract (PRD meeting-actions-to-kanban-v0.2-tech-spec.md NFR-13, §3.1):
//
//   Every sync event (push, pull, reconcile) appends ONE row to
//   inbox.human_task_sync_log. The pull handler MUST:
//     - On successful UPDATE → INSERT direction='pull', outcome='success',
//       guardrail_id=current.id, after_snapshot=jsonb of the applied patch,
//       duration_ms=non-negative integer (wall-clock).
//     - On DB error during UPDATE → INSERT direction='pull',
//       outcome='failed', error_text=<msg>.
//     - On comment events that yield an empty patch → NO sync_log row
//       (no-op; only state-affecting events produce audit rows).
//     - Order: feedback_history append + UPDATE first; sync_log INSERT
//       happens AFTER UPDATE (atomicity-ish: if UPDATE fails, sync_log
//       records the failure, not a phantom success).
//
// ---------------------------------------------------------------------------

async function getSyncLogRows(query, taskId) {
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

describe('handleHumanTaskWebhook — sync_log (NFR-13)', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
  });

  beforeEach(async () => {
    // Clean child rows first (FK ON DELETE CASCADE also covers, but explicit
    // is cheap and avoids depending on cascade behaviour).
    await query(`DELETE FROM inbox.human_task_sync_log WHERE task_id LIKE 'htm-pullh-%'`);
    await query(`DELETE FROM inbox.human_tasks WHERE id LIKE 'htm-pullh-%'`);
    await clearPushGuardrails(query);
  });

  it('appends one sync_log row with direction=pull, outcome=success after a successful pull-apply', async () => {
    const grId = await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const rows = await getSyncLogRows(query, id);
    assert.equal(rows.length, 1, 'exactly one sync_log row after one successful pull');
    const r = rows[0];
    assert.equal(r.direction, 'pull', 'direction must be pull');
    assert.equal(r.outcome, 'success', 'outcome must be success');
    assert.equal(r.guardrail_id, grId, 'guardrail_id must match current push guardrail');
    assert.equal(r.error_text, null, 'no error_text on success');
  });

  it('records the applied patch in after_snapshot on a successful pull', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const rows = await getSyncLogRows(query, id);
    assert.equal(rows.length, 1);
    const snap = parseJsonb(rows[0].after_snapshot);
    assert.ok(snap && typeof snap === 'object', 'after_snapshot must be a JSON object');
    // Patch contained at least title + status-mapped fields — assert a
    // representative key is present.
    const keys = Object.keys(snap);
    assert.ok(
      keys.includes('title') || keys.includes('status') || keys.includes('linear_state_id'),
      `after_snapshot must reflect the applied patch (got keys: ${keys.join(',')})`,
    );
  });

  it('records duration_ms as a non-negative integer on a successful pull', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const rows = await getSyncLogRows(query, id);
    assert.equal(rows.length, 1);
    const d = rows[0].duration_ms;
    assert.ok(Number.isInteger(d), `duration_ms must be an integer (got ${typeof d}: ${d})`);
    assert.ok(d >= 0, `duration_ms must be non-negative (got ${d})`);
  });

  it('does NOT append a sync_log row for a comment-only event with an empty patch', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeCommentPayload(),
      { query, taskId: id },
    );

    const rows = await getSyncLogRows(query, id);
    assert.equal(
      rows.length, 0,
      'comment-only events must NOT write a sync_log row (no-op audit suppression)',
    );
  });

  it('appends one sync_log row with direction=pull, outcome=failed when the UPDATE throws', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    // Flaky query: SELECT succeeds, the human_tasks UPDATE throws, but
    // sync_log INSERT (separate statement) must still succeed.
    const flakyQuery = async (text, params) => {
      if (typeof text === 'string' && /^\s*UPDATE\s+inbox\.human_tasks/i.test(text)) {
        throw new Error('simulated DB write failure');
      }
      return query(text, params);
    };

    const originalError = console.error;
    console.error = () => {};
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload(),
        { query: flakyQuery, taskId: id },
      );
    } finally {
      console.error = originalError;
    }

    const rows = await getSyncLogRows(query, id);
    assert.equal(rows.length, 1, 'one failure sync_log row must be written');
    const r = rows[0];
    assert.equal(r.direction, 'pull', 'direction must still be pull on failure');
    assert.equal(r.outcome, 'failed', 'outcome must be failed when UPDATE throws');
    assert.ok(
      typeof r.error_text === 'string' && r.error_text.length > 0,
      `error_text must be populated on failure (got ${r.error_text})`,
    );
    assert.ok(
      /simulated DB write failure/i.test(r.error_text),
      `error_text must surface the underlying error (got: ${r.error_text})`,
    );
  });

  it('records duration_ms as a non-negative integer on a failed pull', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    const flakyQuery = async (text, params) => {
      if (typeof text === 'string' && /^\s*UPDATE\s+inbox\.human_tasks/i.test(text)) {
        throw new Error('simulated DB write failure');
      }
      return query(text, params);
    };

    const originalError = console.error;
    console.error = () => {};
    try {
      await handleHumanTaskWebhook(
        makeIssueUpdatePayload(),
        { query: flakyQuery, taskId: id },
      );
    } finally {
      console.error = originalError;
    }

    const rows = await getSyncLogRows(query, id);
    assert.equal(rows.length, 1);
    const d = rows[0].duration_ms;
    assert.ok(Number.isInteger(d), `duration_ms must be an integer on failure (got ${typeof d}: ${d})`);
    assert.ok(d >= 0, `duration_ms must be non-negative on failure (got ${d})`);
  });

  it('writes the sync_log row AFTER the human_tasks UPDATE (order — atomicity-ish)', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    // Record the order of writes by wrapping query.
    const order = [];
    const trackingQuery = async (text, params) => {
      if (typeof text === 'string') {
        if (/^\s*UPDATE\s+inbox\.human_tasks/i.test(text)) {
          order.push('update_human_tasks');
        } else if (/INSERT\s+INTO\s+inbox\.human_task_sync_log/i.test(text)) {
          order.push('insert_sync_log');
        }
      }
      return query(text, params);
    };

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query: trackingQuery, taskId: id },
    );

    const iUpdate = order.indexOf('update_human_tasks');
    const iLog = order.indexOf('insert_sync_log');
    assert.ok(iUpdate >= 0, 'UPDATE inbox.human_tasks must have been issued');
    assert.ok(iLog >= 0, 'INSERT INTO inbox.human_task_sync_log must have been issued');
    assert.ok(
      iUpdate < iLog,
      `sync_log INSERT must come AFTER human_tasks UPDATE (got update=${iUpdate}, log=${iLog})`,
    );

    // Feedback history append happens via the UPDATE statement itself (single
    // round-trip), so the relative order of "feedback_history append + UPDATE
    // first; sync_log INSERT after" is satisfied iff the UPDATE precedes the
    // INSERT — already asserted above.
    const row = await getRow(query, id);
    const history = parseHistory(row);
    const pull = history.find((e) => e && e.verb === 'linear_pull');
    assert.ok(pull, 'feedback_history must contain the linear_pull entry from the UPDATE');
  });

  it('does NOT use direction=push or direction=reconcile for pull events', async () => {
    await ensurePushGuardrail(query);
    const id = await seedTask(query);

    await handleHumanTaskWebhook(
      makeIssueUpdatePayload(),
      { query, taskId: id },
    );

    const rows = await getSyncLogRows(query, id);
    for (const r of rows) {
      assert.equal(r.direction, 'pull',
        `pull handler must only write direction=pull (got ${r.direction})`);
    }
  });
});
