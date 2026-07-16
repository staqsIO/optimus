import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './helpers/setup-db.js';

/**
 * #498 — AI-disclosure compliance TRIPWIRE.
 *
 * Board policy (2026-07-05): AI-disclosure text must be appended ONLY to
 * *autonomously-released* outbound messages — i.e. messages sent WITHOUT board
 * review. Board-reviewed / board-edited sends are treated as human-authored and
 * carry no disclosure.
 *
 * The signal for "never human-reviewed" is `board_action IS NULL` on
 * agent_graph.action_proposals (set only by the human-driven approve/edit/skip
 * routes in api.js; NULL means no board member ever touched the row).
 *
 * WHY THIS TEST EXISTS (and why #498 needs no live code change today):
 *   There is currently NO wired autonomous send path — every production send
 *   goes through board review (`sendApprovedDraft`), and `email_send` is
 *   auto_deny / review_required at every autonomy level. More importantly, the
 *   baseline table constraint
 *
 *       CHECK (send_state != 'delivered' OR board_action IS NOT NULL)
 *
 *   (autobot-inbox/sql/001-baseline.sql) STRUCTURALLY forbids delivering any
 *   `board_action IS NULL` (autonomous) message. So under the board policy above,
 *   the only messages that would ever need a disclosure stamp CANNOT currently be
 *   delivered at all — there is nothing to stamp, and no live exposure.
 *
 *   This test pins that guarantee. The day someone builds an autonomous send
 *   path (e.g. wiring the currently-dead `gmail/sender.js:sendDraft`), they must
 *   relax this constraint to let a `board_action IS NULL` row reach 'delivered'.
 *   THE MOMENT THEY DO, test A below fails — forcing them to consciously add the
 *   AI-disclosure enforcement that the board policy requires, instead of silently
 *   shipping un-disclosed autonomous messages. It is a sensor, not instrumentation.
 *
 *   See GitHub issue #498 (design writeup) and the comment on
 *   gmail/sender.js:sendDraft for the enforcement design the future path must use.
 *
 * Runs on PGlite (all migrations applied by getDb) — no DATABASE_URL needed.
 */

const ROW_ID = 'ap-498-tripwire';

describe('#498 disclosure tripwire: autonomous (board_action IS NULL) sends cannot be delivered', () => {
  let query;

  before(async () => {
    ({ query } = await getDb());
    // A staged email_draft with NO board action — i.e. never human-reviewed.
    // email_draft requires message_id + to_addresses + channel (baseline check).
    await query(
      `INSERT INTO agent_graph.action_proposals
         (id, action_type, body, send_state, board_action, message_id, to_addresses, channel)
       VALUES ($1, 'email_draft', 'hello', 'staged', NULL, 'msg-498', ARRAY['a@example.com'], 'email')
       ON CONFLICT (id) DO UPDATE
         SET send_state = 'staged', board_action = NULL`,
      [ROW_ID]
    );
  });

  after(async () => {
    await query(`DELETE FROM agent_graph.action_proposals WHERE id = $1`, [ROW_ID]);
  });

  it('A (load-bearing): delivering a board_action IS NULL proposal is REJECTED by the DB', async () => {
    // This is the compliance guarantee. If this UPDATE ever succeeds, an
    // autonomous send path exists that can deliver an un-reviewed, un-disclosed
    // message — the exact #498 exposure. Adding the disclosure stamp is then
    // mandatory before this constraint may be relaxed.
    await assert.rejects(
      () => query(
        `UPDATE agent_graph.action_proposals SET send_state = 'delivered' WHERE id = $1`,
        [ROW_ID]
      ),
      /check|constraint|violat/i,
      'An autonomous (board_action IS NULL) proposal MUST NOT be deliverable. ' +
      'If you relaxed this constraint to enable autonomous sends, you MUST also ' +
      'append AI-disclosure text per board policy (2026-07-05) — see #498 / ' +
      'gmail/sender.js:sendDraft / GitHub issue #498.'
    );

    // Confirm the row did NOT transition (the reject left it staged).
    const r = await query(
      `SELECT send_state FROM agent_graph.action_proposals WHERE id = $1`,
      [ROW_ID]
    );
    assert.equal(r.rows[0].send_state, 'staged', 'row must remain staged after the rejected UPDATE');
  });

  it('B (positive control): once board-reviewed (board_action set), delivery is allowed', async () => {
    // Proves the constraint blocks ONLY the un-reviewed case — it does not
    // block legitimate board-approved delivery (guards against a false-positive
    // reading of test A where delivery is simply always broken).
    await query(
      `UPDATE agent_graph.action_proposals SET board_action = 'approved' WHERE id = $1`,
      [ROW_ID]
    );
    await query(
      `UPDATE agent_graph.action_proposals SET send_state = 'delivered' WHERE id = $1`,
      [ROW_ID]
    );
    const r = await query(
      `SELECT send_state, board_action FROM agent_graph.action_proposals WHERE id = $1`,
      [ROW_ID]
    );
    assert.equal(r.rows[0].send_state, 'delivered');
    assert.equal(r.rows[0].board_action, 'approved');
  });
});
