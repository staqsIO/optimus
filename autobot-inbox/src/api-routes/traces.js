import { query, withBoardScope } from '../db.js';

/**
 * Task Trace API routes — detailed execution trace for a single work item.
 *
 * GET /api/tasks/trace?task_id=X   — full execution trace for a work item
 *
 * Returns:
 *   - task: work item metadata (title, description, status, type, created_at)
 *   - events: chronological list of significant events merged from
 *       agent_graph.state_transitions + agent_graph.agent_activity_steps
 *   - metrics: aggregated { total_cost_usd, total_tokens, duration_ms }
 */
export function registerTraceRoutes(routes) {

  routes.set('GET /api/tasks/trace', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const taskId = url.searchParams.get('task_id');
    if (!taskId) return { error: 'Missing ?task_id= parameter' };

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      // ── 1. Work item metadata ─────────────────────────────────────────────
      const taskResult = await scopedQuery(
        `SELECT
           id, type, title, description, status, assigned_to, created_by,
           priority, budget_usd, data_classification, acceptance_criteria,
           created_at, updated_at
         FROM agent_graph.work_items
         WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { error: 'Task not found' };
      }

      const task = taskResult.rows[0];

      // ── 2. State transitions ──────────────────────────────────────────────
      const transitionsResult = await scopedQuery(
        `SELECT
           id,
           from_state,
           to_state,
           agent_id,
           reason,
           guardrail_checks_json,
           cost_usd,
           created_at
         FROM agent_graph.state_transitions
         WHERE work_item_id = $1
         ORDER BY created_at ASC`,
        [taskId]
      );

      // ── 3. Activity steps ──────────────────────────────────────────────────
      const stepsResult = await scopedQuery(
        `SELECT
           id,
           parent_step_id,
           depth,
           agent_id,
           step_type,
           description,
           status,
           metadata,
           created_at,
           completed_at,
           CASE WHEN completed_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
                ELSE EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000
           END AS duration_ms
         FROM agent_graph.agent_activity_steps
         WHERE work_item_id = $1
         ORDER BY created_at ASC
         LIMIT 100`,
        [taskId]
      );

      // Count total steps for overflow indicator
      const stepCountResult = await scopedQuery(
        `SELECT COUNT(*) AS total FROM agent_graph.agent_activity_steps WHERE work_item_id = $1`,
        [taskId]
      );
      const totalStepCount = parseInt(stepCountResult.rows[0]?.total ?? 0, 10);

      // ── 4. Merge into unified chronological event list ────────────────────
      const events = [];

      // State transitions → event type "state_transition"
      for (const t of transitionsResult.rows) {
        events.push({
          id: `st:${t.id}`,
          event_type: 'state_transition',
          agent_id: t.agent_id ?? null,
          label: `${t.from_state} → ${t.to_state}`,
          detail: t.reason ?? null,
          metadata: t.guardrail_checks_json ?? null,
          cost_usd: t.cost_usd ? parseFloat(t.cost_usd) : null,
          tokens: null,
          created_at: t.created_at,
          duration_ms: null,
          status: 'completed',
        });
      }

      // Activity steps → event type from step_type
      for (const s of stepsResult.rows) {
        const meta = s.metadata ?? {};
        events.push({
          id: `as:${s.id}`,
          event_type: s.step_type ?? 'step',
          agent_id: s.agent_id ?? null,
          label: s.description,
          detail: null,
          metadata: meta,
          cost_usd: meta.cost_usd != null ? parseFloat(meta.cost_usd) : null,
          tokens: meta.tokens ?? meta.total_tokens ?? null,
          created_at: s.created_at,
          duration_ms: parseFloat(s.duration_ms),
          status: s.status,
        });
      }

      // Sort by created_at ascending
      events.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // ── 5. Aggregate metrics ────────────────────────────────────────────────
      const totalCostUsd = [
        ...transitionsResult.rows.map(t => parseFloat(t.cost_usd || 0)),
        ...stepsResult.rows.map(s => parseFloat((s.metadata?.cost_usd) || 0)),
      ].reduce((sum, v) => sum + v, 0);

      const totalTokens = stepsResult.rows.reduce((sum, s) => {
        const m = s.metadata ?? {};
        return sum + (m.tokens ?? m.total_tokens ?? 0);
      }, 0);

      const firstEvent = events[0];
      const lastEvent = events[events.length - 1];
      const durationMs = firstEvent && lastEvent
        ? new Date(lastEvent.created_at) - new Date(firstEvent.created_at)
        : null;

      return {
        task,
        events,
        metrics: {
          total_cost_usd: totalCostUsd,
          total_tokens: totalTokens,
          duration_ms: durationMs,
          event_count: events.length,
          step_count: stepsResult.rows.length,
          total_step_count: totalStepCount,
          truncated: totalStepCount > 100,
          transition_count: transitionsResult.rows.length,
        },
      };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });
}
