/**
 * RED step (TDD) — POST /api/board/proposals/:id/skip and
 *                  POST /api/board/attention/:id/skip handlers do not yet exist.
 *
 * Asserts the contract defined in board/docs/adr/005-skip-needs-you-items.md
 * over the schema established by sql/111-skip-needs-you-items.sql:
 *   - action_proposals.board_action CHECK now allows 'skipped'
 *   - needs_attention_log gains acknowledgment_reason TEXT
 *
 * The import `{ skipProposal, skipAttention } from '../src/api.js'` is what
 * makes this file fail at load time in the RED phase: those symbols are not
 * exported. The GREEN step will add them in src/api.js (and register the
 * corresponding `POST /api/board/...` routes).
 *
 * Mirrors the seed-and-clean pattern of board-endpoint.test.js: unique
 * `board-skip-test-*` sentinel IDs, parameterized queries, no close().
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';
import { skipProposal, skipAttention } from '../src/api.js';

// Test sentinel — every row this suite inserts uses this prefix so cleanup is
// surgical (PGlite singleton is shared with other test files).
const AP_PREFIX = 'board-skip-test-ap-';
const NA_SIG_PREFIX = 'board-skip-test-sig-';

const BOARD_IDENTITY = 'isaias';

function mockReq(pathTail) {
  return {
    url: pathTail,
    headers: {},
    auth: { role: 'board', sub: BOARD_IDENTITY, github_username: BOARD_IDENTITY, scope: ['*'] },
  };
}

// --------------------------------------------------------------------------
// Proposal skip — POST /api/board/proposals/:id/skip
// --------------------------------------------------------------------------

describe('POST /api/board/proposals/:id/skip', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());

    // Setup assertion: migration 111 must have run so the CHECK constraint
    // accepts 'skipped'. If this throws, the migration discovery is broken
    // and there's no point running the rest of the suite.
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'probe body', 'probe', 'skipped',
               'msg-board-skip-probe', ARRAY['probe@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}migration-probe`],
    );
    await query(`DELETE FROM agent_graph.action_proposals WHERE id = $1`, [
      `${AP_PREFIX}migration-probe`,
    ]);

    // Clean prior test rows so seeds are deterministic.
    await query(`DELETE FROM agent_graph.action_proposals WHERE id LIKE $1`, [`${AP_PREFIX}%`]);

    // Case 1: pending proposal
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'body for case 1', 'Case 1 subject', NULL,
               'msg-board-skip-1', ARRAY['c1@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}case1-pending`],
    );

    // Case 2: pending proposal (no-reason path)
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'body for case 2', 'Case 2 subject', NULL,
               'msg-board-skip-2', ARRAY['c2@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}case2-pending-noreason`],
    );

    // Case 4: already approved (409)
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action, acted_at, acted_by,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'approved body', 'Approved subject',
               'approved', now() - interval '1 hour', 'someone-else',
               'msg-board-skip-4', ARRAY['c4@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}case4-approved`],
    );

    // Case 5: already skipped (re-skip is idempotent)
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, work_item_id, body, subject, board_action,
          board_notes, acted_at, acted_by,
          message_id, to_addresses, channel, provider)
       VALUES ($1, 'email_draft', NULL, 'reskip body', 'Reskip subject',
               'skipped', 'old reason', now() - interval '2 days', 'someone-else',
               'msg-board-skip-5', ARRAY['c5@example.com'], 'email', 'gmail')`,
      [`${AP_PREFIX}case5-already-skipped`],
    );
  });

  it('Case 1: happy path — pending proposal becomes skipped with reason', async () => {
    const id = `${AP_PREFIX}case1-pending`;
    const result = await skipProposal(
      mockReq(`/api/board/proposals/${id}/skip`),
      { reason: 'superseded by phone call' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.id, id);
    assert.equal(result.board_action, 'skipped');

    const row = await query(
      `SELECT board_action, board_notes, acted_at, acted_by
       FROM agent_graph.action_proposals WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].board_action, 'skipped');
    assert.equal(row.rows[0].board_notes, 'superseded by phone call');
    assert.ok(row.rows[0].acted_at, 'acted_at must be set');
    const ageMs = Date.now() - new Date(row.rows[0].acted_at).getTime();
    assert.ok(ageMs >= 0 && ageMs < 30_000, 'acted_at must be recent');
    assert.equal(row.rows[0].acted_by, BOARD_IDENTITY);
  });

  it('Case 2: reason is optional — empty body sets board_notes NULL', async () => {
    const id = `${AP_PREFIX}case2-pending-noreason`;
    const result = await skipProposal(mockReq(`/api/board/proposals/${id}/skip`), {});

    assert.equal(result.ok, true);
    assert.equal(result.board_action, 'skipped');

    const row = await query(
      `SELECT board_action, board_notes FROM agent_graph.action_proposals WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].board_action, 'skipped');
    assert.equal(row.rows[0].board_notes, null, 'board_notes must remain NULL when no reason given');
  });

  it('Case 3: 404 on missing proposal', async () => {
    const id = `${AP_PREFIX}does-not-exist`;
    await assert.rejects(
      () => skipProposal(mockReq(`/api/board/proposals/${id}/skip`), { reason: 'whatever' }),
      (err) => err instanceof Error && err.statusCode === 404,
      'must throw with statusCode 404 for missing id',
    );
  });

  it('Case 4: 409 when already acted on with a non-skip verdict', async () => {
    const id = `${AP_PREFIX}case4-approved`;

    await assert.rejects(
      () => skipProposal(mockReq(`/api/board/proposals/${id}/skip`), { reason: 'try to skip' }),
      (err) => err instanceof Error && err.statusCode === 409,
      'must throw with statusCode 409 when board_action is approved',
    );

    // Verify row unchanged
    const row = await query(
      `SELECT board_action, board_notes, acted_by FROM agent_graph.action_proposals WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].board_action, 'approved', 'board_action must remain approved');
    assert.equal(row.rows[0].board_notes, null, 'board_notes must remain unchanged');
    assert.equal(row.rows[0].acted_by, 'someone-else', 'acted_by must remain unchanged');
  });

  it('Case 5: re-skip is idempotent — updates reason and timestamp', async () => {
    const id = `${AP_PREFIX}case5-already-skipped`;

    const beforeRow = await query(
      `SELECT acted_at FROM agent_graph.action_proposals WHERE id = $1`,
      [id],
    );
    const beforeTs = new Date(beforeRow.rows[0].acted_at).getTime();

    const result = await skipProposal(
      mockReq(`/api/board/proposals/${id}/skip`),
      { reason: 'new better reason' },
    );
    assert.equal(result.ok, true);
    assert.equal(result.board_action, 'skipped');

    const row = await query(
      `SELECT board_action, board_notes, acted_at, acted_by
       FROM agent_graph.action_proposals WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].board_action, 'skipped');
    assert.equal(row.rows[0].board_notes, 'new better reason', 'reason must be updated');
    const afterTs = new Date(row.rows[0].acted_at).getTime();
    assert.ok(afterTs > beforeTs, 'acted_at must be bumped');
    assert.equal(row.rows[0].acted_by, BOARD_IDENTITY, 'acted_by must be updated to current actor');
  });
});

// --------------------------------------------------------------------------
// Attention skip — POST /api/board/attention/:id/skip
// --------------------------------------------------------------------------

describe('POST /api/board/attention/:id/skip', () => {
  let query;
  const seededIds = {};

  before(async () => {
    ({ query } = await getDb());

    // Setup assertion: migration 111 added acknowledgment_reason column.
    const colCheck = await query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agent_graph'
          AND table_name = 'needs_attention_log'
          AND column_name = 'acknowledgment_reason'`,
    );
    assert.equal(
      colCheck.rows.length,
      1,
      'migration 111 must have added needs_attention_log.acknowledgment_reason',
    );

    // Clean prior test rows.
    await query(`DELETE FROM agent_graph.needs_attention_log WHERE signature LIKE $1`, [
      `${NA_SIG_PREFIX}%`,
    ]);

    // Case 6: open attention row
    const r6 = await query(
      `INSERT INTO agent_graph.needs_attention_log
         (signature, work_item_id, agent_id, payload, created_at, acknowledged_at)
       VALUES ($1, NULL, 'executor-intake', '{"reason":"gate_block"}'::jsonb, now(), NULL)
       RETURNING id`,
      [`${NA_SIG_PREFIX}case6-open`],
    );
    seededIds.case6 = r6.rows[0].id;

    // Case 7: open attention row (no-reason path)
    const r7 = await query(
      `INSERT INTO agent_graph.needs_attention_log
         (signature, work_item_id, agent_id, payload, created_at, acknowledged_at)
       VALUES ($1, NULL, 'executor-intake', '{"reason":"gate_block"}'::jsonb, now(), NULL)
       RETURNING id`,
      [`${NA_SIG_PREFIX}case7-open-noreason`],
    );
    seededIds.case7 = r7.rows[0].id;

    // Case 9: already acknowledged with an old reason — re-ack updates it
    const r9 = await query(
      `INSERT INTO agent_graph.needs_attention_log
         (signature, work_item_id, agent_id, payload, created_at,
          acknowledged_at, acknowledged_by, acknowledgment_reason)
       VALUES ($1, NULL, 'executor-intake', '{"reason":"gate_block"}'::jsonb, now(),
               now() - interval '2 days', 'someone-else', 'old reason')
       RETURNING id`,
      [`${NA_SIG_PREFIX}case9-already-acked`],
    );
    seededIds.case9 = r9.rows[0].id;
  });

  it('Case 6: happy path — open attention row becomes acknowledged with reason', async () => {
    const id = seededIds.case6;
    const result = await skipAttention(
      mockReq(`/api/board/attention/${id}/skip`),
      { reason: 'flaky agent, restart fixed it' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.id, id);
    assert.ok(result.acknowledged_at, 'acknowledged_at must be present in response');
    // Should be a parseable ISO timestamp
    assert.ok(!Number.isNaN(new Date(result.acknowledged_at).getTime()));

    const row = await query(
      `SELECT acknowledged_at, acknowledged_by, acknowledgment_reason
       FROM agent_graph.needs_attention_log WHERE id = $1`,
      [id],
    );
    assert.ok(row.rows[0].acknowledged_at, 'acknowledged_at must be set');
    const ageMs = Date.now() - new Date(row.rows[0].acknowledged_at).getTime();
    assert.ok(ageMs >= 0 && ageMs < 30_000, 'acknowledged_at must be recent');
    assert.equal(row.rows[0].acknowledged_by, BOARD_IDENTITY);
    assert.equal(row.rows[0].acknowledgment_reason, 'flaky agent, restart fixed it');
  });

  it('Case 7: reason is optional — empty body sets acknowledgment_reason NULL', async () => {
    const id = seededIds.case7;
    const result = await skipAttention(mockReq(`/api/board/attention/${id}/skip`), {});

    assert.equal(result.ok, true);
    assert.ok(result.acknowledged_at);

    const row = await query(
      `SELECT acknowledged_at, acknowledgment_reason
       FROM agent_graph.needs_attention_log WHERE id = $1`,
      [id],
    );
    assert.ok(row.rows[0].acknowledged_at, 'acknowledged_at must be set');
    assert.equal(
      row.rows[0].acknowledgment_reason,
      null,
      'acknowledgment_reason must remain NULL when no reason given',
    );
  });

  it('Case 8: 404 on missing attention row', async () => {
    const id = 99999999; // very unlikely to collide with seeded rows
    await assert.rejects(
      () => skipAttention(mockReq(`/api/board/attention/${id}/skip`), { reason: 'whatever' }),
      (err) => err instanceof Error && err.statusCode === 404,
      'must throw with statusCode 404 for missing id',
    );
  });

  it('Case 9: re-ack updates reason, timestamp, and acknowledged_by', async () => {
    const id = seededIds.case9;

    const beforeRow = await query(
      `SELECT acknowledged_at FROM agent_graph.needs_attention_log WHERE id = $1`,
      [id],
    );
    const beforeTs = new Date(beforeRow.rows[0].acknowledged_at).getTime();

    const result = await skipAttention(
      mockReq(`/api/board/attention/${id}/skip`),
      { reason: 'new better reason' },
    );
    assert.equal(result.ok, true);

    const row = await query(
      `SELECT acknowledged_at, acknowledged_by, acknowledgment_reason
       FROM agent_graph.needs_attention_log WHERE id = $1`,
      [id],
    );
    const afterTs = new Date(row.rows[0].acknowledged_at).getTime();
    assert.ok(afterTs > beforeTs, 'acknowledged_at must be bumped on re-ack');
    assert.equal(row.rows[0].acknowledged_by, BOARD_IDENTITY, 'acknowledged_by must be updated');
    assert.equal(
      row.rows[0].acknowledgment_reason,
      'new better reason',
      'acknowledgment_reason must be updated',
    );
  });
});
