import { query, withBoardScope } from '../db.js';

/**
 * Runners visibility + control API.
 *
 * GET  /api/runners                 — rollup: one row per runner_id with
 *                                      status, agents heartbeating from it,
 *                                      last activity, recent error rate.
 * GET  /api/runners/:id/activity    — last 20 llm_invocations for any agent
 *                                      currently heartbeating from runner_id.
 * POST /api/runners/:id/restart     — issue a restart command to runner_id.
 *                                      Audited via runner_commands.issued_by.
 */
export function registerRunnerRoutes(routes) {
  routes.set('GET /api/runners', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(`
      WITH runner_rollup AS (
        SELECT
          runner_id,
          array_agg(DISTINCT agent_id ORDER BY agent_id) AS agents,
          array_agg(DISTINCT machine_name) FILTER (WHERE machine_name IS NOT NULL) AS machines,
          MAX(heartbeat_at) AS latest_heartbeat,
          BOOL_OR(status = 'processing') AS any_processing,
          COUNT(*) AS agent_count
        FROM agent_graph.agent_heartbeats
        WHERE heartbeat_at > now() - interval '24 hours'
        GROUP BY runner_id
      ),
      activity AS (
        SELECT
          h.runner_id,
          MAX(inv.created_at) AS latest_invocation,
          COUNT(inv.id) FILTER (WHERE inv.created_at > now() - interval '1 hour') AS invocations_1h
        FROM agent_graph.agent_heartbeats h
        LEFT JOIN agent_graph.llm_invocations inv ON inv.agent_id = h.agent_id
          AND inv.created_at > now() - interval '24 hours'
        WHERE h.heartbeat_at > now() - interval '24 hours'
        GROUP BY h.runner_id
      ),
      claims AS (
        SELECT
          h.runner_id,
          COUNT(wi.id) AS in_progress_count
        FROM agent_graph.agent_heartbeats h
        LEFT JOIN agent_graph.work_items wi ON wi.assigned_to = h.agent_id
          AND wi.status = 'in_progress'
        WHERE h.heartbeat_at > now() - interval '24 hours'
        GROUP BY h.runner_id
      )
      SELECT
        r.runner_id,
        r.agents,
        r.machines,
        r.latest_heartbeat,
        r.any_processing,
        r.agent_count,
        EXTRACT(EPOCH FROM (now() - r.latest_heartbeat))::int AS seconds_since_heartbeat,
        a.latest_invocation,
        COALESCE(a.invocations_1h, 0)::int AS invocations_1h,
        COALESCE(c.in_progress_count, 0)::int AS in_progress_count
      FROM runner_rollup r
      LEFT JOIN activity a USING (runner_id)
      LEFT JOIN claims c USING (runner_id)
      ORDER BY r.latest_heartbeat DESC
    `);
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { runners: result.rows };
  });

  routes.set('POST /api/runners/:id/restart', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/runners\/([^/]+)\/restart$/);
    const runnerId = match ? decodeURIComponent(match[1]) : null;
    if (!runnerId) return { error: 'Missing runner id' };

    const issuedBy = (body?.issuedBy || '').toString().trim();
    if (!issuedBy) return { error: 'Missing required field: issuedBy' };

    // Reject if no agent has heartbeated from this runner_id in the last
    // 24 hours — prevents typo'd or stale targets.
    const exists = await query(
      `SELECT 1 FROM agent_graph.agent_heartbeats
        WHERE runner_id = $1 AND heartbeat_at > now() - interval '24 hours'
        LIMIT 1`,
      [runnerId]
    );
    if (exists.rows.length === 0) {
      return { error: `Unknown runner_id: ${runnerId} (no heartbeat in last 24h)` };
    }

    // Coalesce: if there's already a pending restart for this runner, reuse
    // it instead of stacking duplicate commands.
    const pending = await query(
      `SELECT id, issued_by, issued_at FROM agent_graph.runner_commands
        WHERE runner_id = $1 AND command = 'restart' AND consumed_at IS NULL
        ORDER BY issued_at DESC LIMIT 1`,
      [runnerId]
    );
    if (pending.rows.length > 0) {
      return { command: pending.rows[0], status: 'already_pending' };
    }

    const inserted = await query(
      `INSERT INTO agent_graph.runner_commands (runner_id, command, issued_by)
       VALUES ($1, 'restart', $2)
       RETURNING id, runner_id, command, issued_by, issued_at`,
      [runnerId, issuedBy]
    );
    return { command: inserted.rows[0], status: 'queued' };
  });

  routes.set('GET /api/runners/:id/activity', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/runners\/([^/]+)\/activity$/);
    const runnerId = match ? decodeURIComponent(match[1]) : null;
    if (!runnerId) return { error: 'Missing runner id' };

    const agents = await query(
      `SELECT DISTINCT agent_id FROM agent_graph.agent_heartbeats
       WHERE runner_id = $1 AND heartbeat_at > now() - interval '24 hours'`,
      [runnerId]
    );
    if (agents.rows.length === 0) return { runnerId, invocations: [] };

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    const agentIds = agents.rows.map(r => r.agent_id);
    let invs;
    try {
      invs = await scopedQuery(
        `SELECT id, agent_id, model, input_tokens, output_tokens, cost_usd, latency_ms, created_at, provider
         FROM agent_graph.llm_invocations
         WHERE agent_id = ANY($1)
         ORDER BY created_at DESC
         LIMIT 20`,
        [agentIds]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { runnerId, invocations: invs.rows };
  });
}
