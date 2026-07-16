/**
 * RED step (TDD) — GET /api/board handler does not yet exist.
 *
 * Asserts the contract defined in board/docs/adr/003-route-and-api-contract.md:
 *   { lanes: { needs_you, created, assigned, in_progress, review, completed } }
 *
 * `routes` is not exported from src/api.js, so this file imports a not-yet-
 * exported `getBoard` helper from `../src/api.js`. That import is what makes
 * the test fail in the RED phase: the symbol does not exist. The GREEN step
 * will add `export async function getBoard(req)` to src/api.js (and the
 * existing `routes.set('GET /api/board', ...)` registration will call it).
 *
 * Mirrors the seed-and-clean pattern of governance.test.js: unique
 * `board-test-*` sentinel IDs, parameterized queries, no close().
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { getBoard } from '../src/api.js';

describe('GET /api/board', () => {
  let query;

  // Test sentinels — every row this suite inserts uses one of these prefixes
  // so cleanup is surgical (PGlite singleton is shared with other test files).
  const WI_PREFIX = 'board-test-wi-';
  const AP_PREFIX = 'board-test-ap-';
  const NA_SIG_PREFIX = 'board-test-sig-';

  function mockReq() {
    return { url: '/api/board', headers: {} };
  }

  before(async () => {
    ({ query } = await getDb());

    // Clean prior test rows so seeds are deterministic.
    await query(`DELETE FROM agent_graph.action_proposals WHERE id LIKE $1`, [`${AP_PREFIX}%`]);
    await query(`DELETE FROM agent_graph.needs_attention_log WHERE signature LIKE $1`, [`${NA_SIG_PREFIX}%`]);
    await query(`DELETE FROM agent_graph.work_items WHERE id LIKE $1`, [`${WI_PREFIX}%`]);

    // ---- Case 1: type filter (directive in_progress, workstream review, task in_progress) ----
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
       VALUES ($1, 'directive', 'board-test directive A', 'in_progress', 'board', 'orchestrator')`,
      [`${WI_PREFIX}case1-directive`],
    );
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
       VALUES ($1, 'workstream', 'board-test workstream A', 'review', 'board', 'orchestrator')`,
      [`${WI_PREFIX}case1-workstream`],
    );
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
       VALUES ($1, 'task', 'board-test task A (should be filtered)', 'in_progress', 'board', 'executor-intake')`,
      [`${WI_PREFIX}case1-task`],
    );

    // ---- Case 2: one directive per status, for lane bucketing ----
    const statuses = ['created', 'assigned', 'in_progress', 'review', 'completed'];
    for (const s of statuses) {
      await query(
        `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to)
         VALUES ($1, 'directive', $2, $3, 'board', 'orchestrator')`,
        [`${WI_PREFIX}case2-${s}`, `board-test bucket ${s}`, s],
      );
    }

    // ---- Case 3a: pending proposal with subject ----
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, $2, $3, NULL,
               'msg-board-test-1', ARRAY['someone@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}pending-with-subject`, 'reply body content', 'Reply to acme'],
    );

    // ---- Case 3b: pending proposal WITHOUT subject (title falls back to first line of body) ----
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, $2, NULL, NULL,
               'msg-board-test-2', ARRAY['other@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}pending-no-subject`, 'First line of body\nsecond line should be ignored'],
    );

    // ---- Case 4: open needs_attention row (acknowledged_at IS NULL) ----
    await query(
      `INSERT INTO agent_graph.needs_attention_log
         (signature, work_item_id, agent_id, payload, created_at, acknowledged_at)
       VALUES ($1, NULL, 'executor-intake', '{"reason":"gate_block"}'::jsonb, now(), NULL)`,
      [`${NA_SIG_PREFIX}open-1`],
    );

    // ---- Case 5: acknowledged needs_attention row (should NOT appear) ----
    await query(
      `INSERT INTO agent_graph.needs_attention_log
         (signature, work_item_id, agent_id, payload, created_at, acknowledged_at)
       VALUES ($1, NULL, 'executor-intake', '{"reason":"acked"}'::jsonb, now(), now())`,
      [`${NA_SIG_PREFIX}acked-1`],
    );

    // ---- Case 6: acted-on proposal (board_action = 'approved') — should NOT appear ----
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action, acted_at,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'approved body', 'approved subject',
               'approved', now(),
               'msg-board-test-3', ARRAY['acted@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}acted-approved`],
    );

    // ---- Case 7: completed-lane window (recent vs old) ----
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to, updated_at)
       VALUES ($1, 'directive', 'board-test recent completed', 'completed', 'board', 'orchestrator',
               now() - interval '5 days')`,
      [`${WI_PREFIX}case7-recent`],
    );
    await query(
      `INSERT INTO agent_graph.work_items (id, type, title, status, created_by, assigned_to, updated_at)
       VALUES ($1, 'directive', 'board-test old completed', 'completed', 'board', 'orchestrator',
               now() - interval '60 days')`,
      [`${WI_PREFIX}case7-old`],
    );
  });

  // ----------------------------------------------------------------------------
  // Acceptance contract assertions — ADR-003 response shape.
  // ----------------------------------------------------------------------------

  it('Case 1: filters dev tasks out — directive/workstream kept, task excluded', async () => {
    const result = await getBoard(mockReq());

    const allCards = [
      ...result.lanes.created,
      ...result.lanes.assigned,
      ...result.lanes.in_progress,
      ...result.lanes.review,
      ...result.lanes.completed,
    ];

    const directiveId = `${WI_PREFIX}case1-directive`;
    const workstreamId = `${WI_PREFIX}case1-workstream`;
    const taskId = `${WI_PREFIX}case1-task`;

    assert.ok(
      result.lanes.in_progress.some((c) => c.id === directiveId),
      'directive must appear in in_progress lane',
    );
    assert.ok(
      result.lanes.review.some((c) => c.id === workstreamId),
      'workstream must appear in review lane',
    );
    assert.ok(
      !allCards.some((c) => c.id === taskId),
      'task type must be filtered out of all lanes (ADR-001 dev-task exclusion)',
    );
  });

  it('Case 2: status-lane bucketing with WorkItemCard shape', async () => {
    const result = await getBoard(mockReq());

    for (const s of ['created', 'assigned', 'in_progress', 'review', 'completed']) {
      const expectedId = `${WI_PREFIX}case2-${s}`;
      const card = result.lanes[s].find((c) => c.id === expectedId);
      assert.ok(card, `${s} lane must contain ${expectedId}`);

      assert.equal(card.kind, 'work_item', 'kind must be "work_item"');
      assert.equal(card.id, expectedId);
      assert.equal(card.type, 'directive');
      assert.equal(card.status, s);
      assert.ok(typeof card.title === 'string' && card.title.length > 0, 'title required');
      // assigned_to/created_by/created_at/updated_at must all be present
      assert.ok('assigned_to' in card, 'assigned_to key required');
      assert.equal(card.created_by, 'board');
      assert.ok(card.created_at, 'created_at required');
      assert.ok(card.updated_at, 'updated_at required');
    }
  });

  it('Case 3: needs_you includes pending proposals; title from subject or first body line', async () => {
    const result = await getBoard(mockReq());

    const withSubject = result.lanes.needs_you.find(
      (c) => c.kind === 'proposal' && c.id === `${AP_PREFIX}pending-with-subject`,
    );
    assert.ok(withSubject, 'pending proposal with subject must appear in needs_you');
    assert.equal(withSubject.title, 'Reply to acme', 'title must come from subject when present');

    const noSubject = result.lanes.needs_you.find(
      (c) => c.kind === 'proposal' && c.id === `${AP_PREFIX}pending-no-subject`,
    );
    assert.ok(noSubject, 'pending proposal without subject must still appear');
    assert.equal(
      noSubject.title,
      'First line of body',
      'title must fall back to first line of body when subject is null',
    );
  });

  it('Case 4: needs_you includes open needs_attention_log rows', async () => {
    const result = await getBoard(mockReq());

    const attentionCard = result.lanes.needs_you.find(
      (c) => c.kind === 'attention' && c.signature === `${NA_SIG_PREFIX}open-1`,
    );
    assert.ok(attentionCard, 'open attention row must appear in needs_you');
    assert.equal(attentionCard.kind, 'attention');
    assert.ok(attentionCard.id, 'attention card must carry an id');
  });

  it('Case 5: needs_you excludes acknowledged needs_attention_log rows', async () => {
    const result = await getBoard(mockReq());

    const acked = result.lanes.needs_you.find(
      (c) => c.kind === 'attention' && c.signature === `${NA_SIG_PREFIX}acked-1`,
    );
    assert.equal(acked, undefined, 'acknowledged attention row must NOT appear in needs_you');
  });

  it('Case 6: needs_you excludes acted-on proposals (board_action IS NOT NULL)', async () => {
    const result = await getBoard(mockReq());

    const acted = result.lanes.needs_you.find(
      (c) => c.kind === 'proposal' && c.id === `${AP_PREFIX}acted-approved`,
    );
    assert.equal(acted, undefined, 'proposal with board_action set must NOT appear in needs_you');
  });

  it('Case 7: completed lane only includes items updated within the 14-day window', async () => {
    const result = await getBoard(mockReq());

    const recent = result.lanes.completed.find((c) => c.id === `${WI_PREFIX}case7-recent`);
    const old = result.lanes.completed.find((c) => c.id === `${WI_PREFIX}case7-old`);

    assert.ok(recent, '5-day-old completed directive must appear in completed lane');
    assert.equal(old, undefined, '60-day-old completed directive must NOT appear (outside 14-day window)');
  });
});
