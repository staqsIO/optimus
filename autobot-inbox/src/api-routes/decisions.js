import { query, withTransaction, withBoardScope } from '../db.js';

/**
 * Strategic Decisions API routes — board review of agent strategic decisions.
 *
 * GET  /api/decisions?status=pending|decided  — list decisions by status
 * POST /api/decisions/:id/verdict             — render verdict (approved/rejected/modified)
 * POST /api/decisions/:id/reverse             — reverse a past decision
 */
export function registerDecisionRoutes(routes) {
  // GET /api/decisions — list decisions, filterable by status
  routes.set('GET /api/decisions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || 'pending';

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      if (status === 'pending') {
        const result = await scopedQuery(
          `SELECT sd.id, sd.decision_type, sd.proposed_action, sd.rationale,
                  sd.recommendation, sd.confidence, sd.created_at,
                  sd.board_verdict, sd.board_notes, sd.decided_at,
                  w.title AS work_item_title
           FROM agent_graph.strategic_decisions sd
           LEFT JOIN agent_graph.work_items w ON w.id = sd.work_item_id
           WHERE sd.board_verdict IS NULL
           ORDER BY sd.created_at ASC`
        );
        return { decisions: result.rows };
      }

      if (status === 'decided') {
        const result = await scopedQuery(
          `SELECT sd.id, sd.decision_type, sd.proposed_action, sd.rationale,
                  sd.recommendation, sd.confidence, sd.created_at,
                  sd.board_verdict, sd.board_notes, sd.decided_at, sd.outcome,
                  w.title AS work_item_title
           FROM agent_graph.strategic_decisions sd
           LEFT JOIN agent_graph.work_items w ON w.id = sd.work_item_id
           WHERE sd.board_verdict IS NOT NULL
           ORDER BY sd.decided_at DESC
           LIMIT 50`
        );
        return { decisions: result.rows };
      }

      throw Object.assign(new Error('status must be one of: pending, decided'), { statusCode: 400 });
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // POST /api/decisions/:id/verdict — render board verdict
  routes.set('POST /api/decisions/:id/verdict', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/decisions/')[1]?.split('/verdict')[0];

    if (!id) {
      throw Object.assign(new Error('Missing decision ID'), { statusCode: 400 });
    }

    const { verdict, notes } = body || {};
    const allowed = ['approved', 'rejected', 'modified'];
    if (!allowed.includes(verdict)) {
      throw Object.assign(new Error(`verdict must be one of: ${allowed.join(', ')}`), { statusCode: 400 });
    }

    // Fetch decision to compute match
    const decisionResult = await query(
      `SELECT id, recommendation, board_verdict
       FROM agent_graph.strategic_decisions
       WHERE id = $1`,
      [id]
    );

    if (decisionResult.rows.length === 0) {
      throw Object.assign(new Error('Decision not found'), { statusCode: 404 });
    }

    const decision = decisionResult.rows[0];

    if (decision.board_verdict) {
      throw Object.assign(new Error('Decision already has a verdict'), { statusCode: 409 });
    }

    // Log to suggest_mode_log for G4 measurement — match logic from CLI
    const verdictMatchMap = {
      approved: ['proceed'],
      rejected: ['reject', 'defer'],
      modified: [],
    };
    const matched = (verdictMatchMap[verdict] || []).includes(decision.recommendation);
    const mismatchReason = matched ? null
      : `Agent recommended "${decision.recommendation}", board decided "${verdict}"${notes ? `: ${notes}` : ''}`;

    // Atomic transaction: update verdict + log to suggest_mode_log
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE agent_graph.strategic_decisions
         SET board_verdict = $1, board_notes = $2, decided_by = 'board', decided_at = now()
         WHERE id = $3`,
        [verdict, notes || null, id]
      );

      await client.query(
        `INSERT INTO agent_graph.suggest_mode_log
         (decision_id, agent_recommendation, board_decision, matched, mismatch_reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, decision.recommendation, verdict, matched, mismatchReason]
      );
    });

    return { ok: true, matched };
  });

  // POST /api/decisions/:id/reverse — reverse a past decision
  routes.set('POST /api/decisions/:id/reverse', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/api/decisions/')[1]?.split('/reverse')[0];

    if (!id) {
      throw Object.assign(new Error('Missing decision ID'), { statusCode: 400 });
    }

    const { reason } = body || {};
    if (!reason || typeof reason !== 'string') {
      throw Object.assign(new Error('reason is required'), { statusCode: 400 });
    }

    const decisionResult = await query(
      `SELECT id, outcome, board_verdict FROM agent_graph.strategic_decisions WHERE id = $1`,
      [id]
    );

    if (decisionResult.rows.length === 0) {
      throw Object.assign(new Error('Decision not found'), { statusCode: 404 });
    }

    if (!decisionResult.rows[0].board_verdict) {
      throw Object.assign(new Error('Cannot reverse a decision that has no verdict yet'), { statusCode: 409 });
    }

    if (decisionResult.rows[0].outcome === 'reversed') {
      throw Object.assign(new Error('Decision is already reversed'), { statusCode: 409 });
    }

    await query(
      `UPDATE agent_graph.strategic_decisions
       SET outcome = 'reversed', board_notes = COALESCE(board_notes || E'\\n', '') || $1
       WHERE id = $2`,
      [`Reversed: ${reason}`, id]
    );

    return { ok: true };
  });
}
