import { query, withBoardScope } from '../db.js';
import { transitionState } from '../runtime/state-machine.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { emit } from '../runtime/event-bus.js';
import { getConfig } from '../../../lib/config/loader.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

/**
 * Pipeline Health API routes.
 *
 * GET  /api/pipeline/health        — queue depth per agent, stuck items, board commands
 * GET  /api/pipeline/throughput     — completed items bucketed by hour (last 24h)
 * GET  /api/pipeline/timeline       — message → work item state transitions + drafts (replay UI)
 * POST /api/pipeline/stuck/cancel   — cancel a stuck work item (board action)
 * POST /api/pipeline/stuck/retry    — retry a stuck work item (board action)
 */
export function registerPipelineRoutes(routes, cachedQuery, { withViewer } = {}) {

  // OPT-166 P3: inbox.messages RLS is PERMISSIVE (read_messages USING(true), mig 138) —
  // the flip does NOT filter message rows, so app-layer visibleClause is the ONLY tenant
  // boundary on message-backed reads. Resolve the request principal (fail-closed to a
  // deny-by-default null principal on absence/throw) so the timeline message read can
  // scope by owner_org_id. Mirrors api-routes/meetings.js resolveViewer.
  async function resolveViewer(req) {
    if (typeof withViewer !== 'function') return { principal: null };
    try {
      const v = await withViewer(req);
      return { principal: v?.principal ?? null };
    } catch {
      return { principal: null };
    }
  }

  routes.set('GET /api/pipeline/timeline', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const messageId = url.searchParams.get('message_id');
    if (!messageId) {
      return { error: 'message_id query parameter required' };
    }
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    // Tenant boundary on the permissive inbox.messages read (see registrar note).
    // Non-visible message ⇒ zero rows ⇒ "Message not found"; downstream work_item /
    // transition / draft reads are keyed to this messageId, so they are transitively
    // gated (we never reach them for a message the principal cannot see).
    const { principal } = await resolveViewer(req);
    const msgScope = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
    try {
      const msgR = await scopedQuery(
        `SELECT id, received_at, triage_category, processed_at, work_item_id, priority_score
         FROM inbox.messages WHERE id = $1 AND ${msgScope.sql}`,
        [messageId, ...msgScope.params]
      );
      if (msgR.rows.length === 0) {
        return { error: 'Message not found' };
      }
      const message = msgR.rows[0];
      let workItem = null;
      let transitions = [];
      if (message.work_item_id) {
        const wiR = await scopedQuery(
          `SELECT id, status, type, assigned_to, title, created_at, updated_at
           FROM agent_graph.work_items WHERE id = $1`,
          [message.work_item_id]
        );
        workItem = wiR.rows[0] || null;
        const trR = await scopedQuery(
          `SELECT from_state, to_state, agent_id, reason, created_at
           FROM agent_graph.state_transitions
           WHERE work_item_id = $1
           ORDER BY created_at ASC`,
          [message.work_item_id]
        );
        transitions = trR.rows;
      }
      const draftsR = await scopedQuery(
        `SELECT id, created_at, reviewer_verdict, board_action, send_state, tone_score, email_summary
         FROM agent_graph.action_proposals
         WHERE message_id = $1 AND action_type = 'email_draft'
         ORDER BY created_at ASC`,
        [messageId]
      );
      return {
        message,
        work_item: workItem,
        transitions,
        drafts: draftsR.rows,
      };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  routes.set('GET /api/pipeline/health', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await cachedQuery('pipeline-health', async () => {
        // Queue depth per agent
        const queuesR = await scopedQuery(`
          SELECT
            assigned_to AS agent_id,
            COUNT(*) FILTER (WHERE status = 'created')     AS created,
            COUNT(*) FILTER (WHERE status = 'assigned')    AS assigned,
            COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
            COUNT(*) FILTER (WHERE status = 'review')      AS in_review,
            COUNT(*) FILTER (WHERE status = 'blocked')     AS blocked,
            COUNT(*)                                        AS total_active
          FROM agent_graph.work_items
          WHERE status NOT IN ('completed', 'cancelled', 'failed', 'timed_out')
            AND assigned_to IS NOT NULL
          GROUP BY assigned_to
          ORDER BY COUNT(*) DESC
        `);

        // Stuck items: in_progress/blocked > 30 min or retry_count >= 2
        const stuckR = await scopedQuery(`
          SELECT
            wi.id, wi.title, wi.type, wi.status, wi.assigned_to, wi.retry_count,
            wi.created_at, wi.updated_at,
            EXTRACT(EPOCH FROM (NOW() - wi.updated_at)) / 60 AS minutes_since_update,
            c.id AS campaign_id, c.campaign_status, c.completed_iterations, c.max_iterations
          FROM agent_graph.work_items wi
          LEFT JOIN agent_graph.campaigns c ON c.work_item_id = wi.id
          WHERE (
            (wi.status IN ('in_progress', 'blocked') AND wi.updated_at < NOW() - interval '30 minutes')
            OR wi.retry_count >= 2
          )
          AND wi.status NOT IN ('completed', 'cancelled', 'failed', 'timed_out')
          ORDER BY wi.retry_count DESC, wi.updated_at ASC
          LIMIT 20
        `);

        // Board commands — recent 20
        const boardR = await scopedQuery(`
          SELECT
            id, title, type, status, assigned_to, created_at, updated_at,
            metadata->>'source' AS source
          FROM agent_graph.work_items
          WHERE created_by = 'board'
          ORDER BY created_at DESC
          LIMIT 20
        `);

        return {
          queues: queuesR.rows.map(r => ({
            agent_id: r.agent_id,
            created: parseInt(r.created),
            assigned: parseInt(r.assigned),
            in_progress: parseInt(r.in_progress),
            in_review: parseInt(r.in_review),
            blocked: parseInt(r.blocked),
            total_active: parseInt(r.total_active),
          })),
          stuck: stuckR.rows.map(r => ({
            ...r,
            retry_count: parseInt(r.retry_count || '0'),
            minutes_since_update: parseFloat(r.minutes_since_update || '0'),
            campaign_id: r.campaign_id || null,
            campaign_status: r.campaign_status || null,
            campaign_iterations: r.completed_iterations != null ? `${r.completed_iterations}/${r.max_iterations}` : null,
          })),
          boardCommands: boardR.rows,
        };
      }, 15_000);
      return result || { queues: [], stuck: [], boardCommands: [] };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  routes.set('GET /api/pipeline/throughput', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await cachedQuery('pipeline-throughput', async () => {
        const r = await scopedQuery(`
          SELECT
            date_trunc('hour', st.created_at) AS bucket,
            COUNT(*) AS completed
          FROM agent_graph.state_transitions st
          WHERE st.to_state = 'completed'
            AND st.created_at >= NOW() - interval '24 hours'
          GROUP BY bucket
          ORDER BY bucket ASC
        `);

        const total = r.rows.reduce((sum, row) => sum + parseInt(row.completed), 0);

        return {
          buckets: r.rows.map(row => ({
            bucket: row.bucket,
            completed: parseInt(row.completed),
          })),
          total_24h: total,
        };
      }, 60_000);
      return result || { buckets: [], total_24h: 0 };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // ── Stuck task actions (board commands via dashboard) ──

  routes.set('POST /api/pipeline/stuck/cancel', async (req, body) => {
    const { id } = body || {};
    if (!id) return { success: false, error: 'Missing work item id' };

    // OPT-166 P3-B6: this is a board command (transitionState below runs as
    // agentId 'board') — gate it board-only rather than falling back to the
    // legacy pool for non-board callers.
    if (req.auth?.role !== 'board') {
      return { success: false, error: 'board role required', status: 403 };
    }
    const boardScope = await withBoardScope(req.auth);
    const scopedQuery = boardScope;
    try {
      // Fetch current state
      const r = await scopedQuery(
        `SELECT id, status, title, assigned_to FROM agent_graph.work_items WHERE id = $1`,
        [id]
      );
      if (r.rows.length === 0) return { success: false, error: 'Work item not found' };

      const item = r.rows[0];
      const cancellableStates = ['in_progress', 'assigned', 'timed_out', 'blocked', 'review'];
      if (!cancellableStates.includes(item.status)) {
        return { success: false, error: `Cannot cancel from state: ${item.status}` };
      }

      const result = await transitionState({
        workItemId: id,
        toState: 'cancelled',
        agentId: 'board',
        configHash: 'dashboard',
        reason: 'Cancelled by board via dashboard',
      });
      if (!result) return { success: false, error: 'Transition failed (check valid_transitions)' };

      await publishEvent('board_command', `Board cancelled task "${item.title}" (${item.status} → cancelled)`, 'board', id);

      // Invalidate cached health data
      cachedQuery.invalidate?.('pipeline-health');

      return { success: true, id, fromState: item.status, toState: 'cancelled' };
    } finally {
      await boardScope.release();
    }
  });

  routes.set('POST /api/pipeline/stuck/retry', async (req, body) => {
    const { id } = body || {};
    if (!id) return { success: false, error: 'Missing work item id' };

    // OPT-166 P3-B6: this is a board command (transitionState below runs as
    // agentId 'board') — gate it board-only rather than falling back to the
    // legacy pool for non-board callers.
    if (req.auth?.role !== 'board') {
      return { success: false, error: 'board role required', status: 403 };
    }
    const boardScope = await withBoardScope(req.auth);
    const scopedQuery = boardScope;
    try {
      const r = await scopedQuery(
        `SELECT id, status, title, assigned_to, retry_count FROM agent_graph.work_items WHERE id = $1`,
        [id]
      );
      if (r.rows.length === 0) return { success: false, error: 'Work item not found' };

      const item = r.rows[0];
      const retryableStates = ['in_progress', 'timed_out', 'failed', 'blocked'];
      if (!retryableStates.includes(item.status)) {
        return { success: false, error: `Cannot retry from state: ${item.status}` };
      }

      // Two-step for in_progress: in_progress → timed_out → assigned
      if (item.status === 'in_progress') {
        const timedOut = await transitionState({
          workItemId: id,
          toState: 'timed_out',
          agentId: 'board',
          configHash: 'dashboard',
          reason: 'Board-initiated retry (step 1: timeout)',
        });
        if (!timedOut) return { success: false, error: 'Transition to timed_out failed' };
      }

      // blocked → in_progress first (valid_transitions requires this intermediate step)
      if (item.status === 'blocked') {
        const unblocked = await transitionState({
          workItemId: id,
          toState: 'in_progress',
          agentId: 'board',
          configHash: 'dashboard',
          reason: 'Board-initiated retry (step 1: unblock)',
        });
        if (!unblocked) return { success: false, error: 'Transition from blocked to in_progress failed' };
        // Then in_progress → timed_out for the standard path
        const timedOut = await transitionState({
          workItemId: id,
          toState: 'timed_out',
          agentId: 'board',
          configHash: 'dashboard',
          reason: 'Board-initiated retry (step 2: timeout)',
        });
        if (!timedOut) return { success: false, error: 'Transition to timed_out failed' };
      }

      // timed_out/failed → assigned
      const reassigned = await transitionState({
        workItemId: id,
        toState: 'assigned',
        agentId: 'board',
        configHash: 'dashboard',
        reason: 'Board-initiated retry via dashboard',
      });
      if (!reassigned) return { success: false, error: 'Transition to assigned failed' };

      // Reset retry_count — board retry = fresh start
      await scopedQuery(
        `UPDATE agent_graph.work_items SET retry_count = 0 WHERE id = $1`,
        [id]
      );

      // Emit event so the assigned agent picks it up
      const targetAgent = item.assigned_to || 'orchestrator';
      await emit({
        eventType: 'task_assigned',
        workItemId: id,
        targetAgentId: targetAgent,
        priority: 0,
        eventData: { retry: true, reason: 'board_retry' },
      });

      await publishEvent('board_command', `Board retried task "${item.title}" (${item.status} → assigned)`, 'board', id);

      // Invalidate cached health data
      cachedQuery.invalidate?.('pipeline-health');

      return { success: true, id, fromState: item.status, toState: 'assigned' };
    } finally {
      await boardScope.release();
    }
  });

  // ── Agent work completions (visual agents: Pixel + Forge) ──

  routes.set('GET /api/pipeline/completions', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await cachedQuery('pipeline-completions', async () => {
        // Completed visual agent work
        const completedR = await scopedQuery(`
          SELECT
            wi.id, wi.title, wi.type, wi.assigned_to, wi.status,
            wi.created_at, wi.updated_at,
            wi.metadata->>'url' AS source_url,
            wi.metadata->>'project_name' AS project_name,
            wi.metadata->>'cost_usd' AS cost_usd,
            (wi.metadata ? 'html_output') AS has_preview,
            st.created_at AS completed_at,
            st.reason AS completion_reason,
            c.id AS campaign_id,
            c.campaign_status,
            c.goal_description AS campaign_goal,
            c.completed_iterations AS campaign_iterations,
            c.spent_usd AS campaign_spent_usd,
            (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci
             WHERE ci.campaign_id = c.id AND ci.decision IN ('keep', 'stop_success')) AS campaign_best_score
          FROM agent_graph.work_items wi
          LEFT JOIN LATERAL (
            SELECT created_at, reason
            FROM agent_graph.state_transitions
            WHERE work_item_id = wi.id AND to_state = 'completed'
            ORDER BY created_at DESC LIMIT 1
          ) st ON true
          LEFT JOIN agent_graph.campaigns c ON c.work_item_id = wi.id
          WHERE wi.assigned_to IN ('executor-redesign', 'executor-blueprint', 'claw-campaigner', 'claw-workshop')
            AND wi.status = 'completed'
          ORDER BY wi.updated_at DESC
          LIMIT 20
        `);

        // In-progress visual agent work
        const inProgressR = await scopedQuery(`
          SELECT
            wi.id, wi.title, wi.type, wi.assigned_to, wi.status,
            wi.created_at, wi.updated_at,
            wi.metadata->>'url' AS source_url,
            wi.metadata->>'project_name' AS project_name,
            c.id AS campaign_id,
            c.campaign_status,
            c.goal_description AS campaign_goal,
            c.completed_iterations AS campaign_iterations,
            c.max_iterations AS campaign_max_iterations,
            c.spent_usd AS campaign_spent_usd,
            c.budget_envelope_usd AS campaign_budget_usd
          FROM agent_graph.work_items wi
          LEFT JOIN agent_graph.campaigns c ON c.work_item_id = wi.id
          WHERE wi.assigned_to IN ('executor-redesign', 'executor-blueprint', 'claw-campaigner', 'claw-workshop')
            AND wi.status IN ('in_progress', 'assigned')
          ORDER BY wi.updated_at DESC
          LIMIT 10
        `);

        return {
          completions: completedR.rows.map(r => ({
            id: r.id,
            title: r.title,
            type: r.type,
            agent: r.assigned_to,
            status: r.status,
            sourceUrl: r.source_url,
            projectName: r.project_name,
            costUsd: r.cost_usd ? parseFloat(r.cost_usd) : null,
            hasPreview: r.has_preview === true || r.has_preview === 't',
            completedAt: r.completed_at || r.updated_at,
            completionReason: r.completion_reason,
            createdAt: r.created_at,
            // Campaign-specific fields (null for non-campaign work)
            campaignId: r.campaign_id || null,
            campaignStatus: r.campaign_status || null,
            campaignGoal: r.campaign_goal || null,
            campaignIterations: r.campaign_iterations != null ? parseInt(r.campaign_iterations) : null,
            campaignSpentUsd: r.campaign_spent_usd ? parseFloat(r.campaign_spent_usd) : null,
            campaignBestScore: r.campaign_best_score ? parseFloat(r.campaign_best_score) : null,
          })),
          inProgress: inProgressR.rows.map(r => ({
            id: r.id,
            title: r.title,
            type: r.type,
            agent: r.assigned_to,
            status: r.status,
            sourceUrl: r.source_url,
            projectName: r.project_name,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            // Campaign-specific fields
            campaignId: r.campaign_id || null,
            campaignGoal: r.campaign_goal || null,
            campaignIterations: r.campaign_iterations != null ? parseInt(r.campaign_iterations) : null,
            campaignMaxIterations: r.campaign_max_iterations != null ? parseInt(r.campaign_max_iterations) : null,
            campaignSpentUsd: r.campaign_spent_usd ? parseFloat(r.campaign_spent_usd) : null,
            campaignBudgetUsd: r.campaign_budget_usd ? parseFloat(r.campaign_budget_usd) : null,
          })),
        };
      }, 30_000);
      return result || { completions: [], inProgress: [] };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // ── Bypass activity (work items routed via config gates, not triage) ──

  routes.set('GET /api/pipeline/bypass-activity', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await cachedQuery('bypass-activity', async () => {
        const r = await scopedQuery(`
          SELECT wi.id, wi.title, wi.assigned_to, wi.status, wi.created_at,
                 wi.metadata->>'source' AS source,
                 wi.metadata->>'linear_issue_id' AS linear_issue_id,
                 wi.metadata->>'github_issue_url' AS github_issue_url
          FROM agent_graph.work_items wi
          WHERE wi.metadata->>'source' IN ('linear', 'github')
            AND wi.created_at >= NOW() - interval '7 days'
          ORDER BY wi.created_at DESC
          LIMIT 20
        `);
        return { items: r.rows };
      }, 30_000);
      return result || { items: [] };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // ── Bot scope config (consumed by Board Workstation graph) ──

  // Note: /api/config/bot-scope touches no enforced table (getConfig() only,
  // no DB query) — left unwrapped intentionally (the batch's "1 unscoped").
  routes.set('GET /api/config/bot-scope', async () => {
    const result = await cachedQuery('bot-scope-config', () => {
      let linear = null;
      let github = null;
      try { linear = getConfig('linear-bot'); } catch {}
      try { github = getConfig('github-bot'); } catch {}

      return {
        linear: linear ? {
          triggers: [
            ...(linear.triggerAssigneeNames || []).map(n => ({ type: 'assignee', value: n })),
            linear.triggerLabel ? { type: 'label', value: linear.triggerLabel } : null,
            linear.workshopLabel ? { type: 'label', value: linear.workshopLabel } : null,
          ].filter(Boolean),
          watchedTeams: linear.watchedTeams || [],
          watchedProjects: linear.watchedProjects || [],
          intentLabels: linear.intentLabels || {},
          repoMapping: linear.repoMapping || {},
        } : null,
        github: github ? {
          repos: github.repos || [],
          autoFixLabels: github.autoFixLabels || [],
          intentLabels: github.intentLabels || {},
          watchedEvents: Object.keys(github.watchedEvents || {}),
          defaultAgent: github.defaultAgent || null,
        } : null,
      };
    }, 60_000);
    return result || { linear: null, github: null };
  });

  // GET /api/pipeline/intake-drift — heuristic vs LLM classification drift metrics
  routes.set('GET /api/pipeline/intake-drift', async (req) => {
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const result = await cachedQuery('intake-drift', async () => {
        // Count classification methods used in last 7 days
        const methodsR = await scopedQuery(`
          SELECT
            COALESCE(metadata->'intake_classification'->>'method', 'unknown') AS method,
            COUNT(*) AS cnt
          FROM agent_graph.work_items
          WHERE created_at > NOW() - INTERVAL '7 days'
            AND metadata ? 'intake_classification'
          GROUP BY method
          ORDER BY cnt DESC
        `);

        // Count heuristic categories
        const heuristicR = await scopedQuery(`
          SELECT
            COALESCE(metadata->'intake_classification'->>'heuristic_category',
                     metadata->'triage_result'->>'category', 'unknown') AS category,
            COUNT(*) AS cnt
          FROM agent_graph.work_items
          WHERE created_at > NOW() - INTERVAL '7 days'
            AND metadata->'intake_classification'->>'method' = 'heuristic'
          GROUP BY category
          ORDER BY cnt DESC
        `);

        // Count deterministic vs heuristic vs llm
        const deterministicR = await scopedQuery(`
          SELECT
            COUNT(*) FILTER (WHERE (metadata->'intake_classification'->>'deterministic')::boolean = true) AS deterministic,
            COUNT(*) FILTER (WHERE metadata->'intake_classification'->>'method' = 'heuristic') AS heuristic,
            COUNT(*) FILTER (WHERE metadata->>'intake_classification' = 'llm_pending') AS llm_pending,
            COUNT(*) AS total
          FROM agent_graph.work_items
          WHERE created_at > NOW() - INTERVAL '7 days'
            AND metadata ? 'intake_classification'
        `);

        const breakdown = deterministicR.rows[0] || {};
        return {
          methods: methodsR.rows.map(r => ({ method: r.method, count: parseInt(r.cnt) })),
          heuristic_categories: heuristicR.rows.map(r => ({ category: r.category, count: parseInt(r.cnt) })),
          breakdown: {
            deterministic: parseInt(breakdown.deterministic || '0'),
            heuristic: parseInt(breakdown.heuristic || '0'),
            llm_pending: parseInt(breakdown.llm_pending || '0'),
            total: parseInt(breakdown.total || '0'),
          },
        };
      }, 60_000);
      return result || { methods: [], heuristic_categories: [], breakdown: {} };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });

  // GET /api/pipeline/agent-stats?agent_id=X — per-agent performance from state_transitions
  routes.set('GET /api/pipeline/agent-stats', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('agent_id');
    if (!agentId) return { error: 'agent_id required' };

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      const cacheKey = `agent-stats-${agentId}`;
      const result = await cachedQuery(cacheKey, async () => {
        // Count state transitions initiated by this agent (7d)
        const transitionsR = await scopedQuery(`
          SELECT
            to_state,
            COUNT(*) AS cnt
          FROM agent_graph.state_transitions
          WHERE agent_id = $1
            AND created_at > NOW() - INTERVAL '7 days'
          GROUP BY to_state
          ORDER BY cnt DESC
        `, [agentId]);

        // Work items assigned to this agent (all time stats)
        const workR = await scopedQuery(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE status IN ('assigned', 'in_progress', 'review')) AS active,
            COUNT(*) AS total
          FROM agent_graph.work_items
          WHERE assigned_to = $1
        `, [agentId]);

        // Recent activity steps (count last 7d)
        const stepsR = await scopedQuery(`
          SELECT COUNT(*) AS cnt
          FROM agent_graph.agent_activity_steps
          WHERE agent_id = $1
            AND created_at > NOW() - INTERVAL '7 days'
        `, [agentId]);

        // Average task duration (completed in last 7d)
        const durationR = await scopedQuery(`
          SELECT
            AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) AS avg_seconds,
            MIN(EXTRACT(EPOCH FROM (completed_at - created_at))) AS min_seconds,
            MAX(EXTRACT(EPOCH FROM (completed_at - created_at))) AS max_seconds
          FROM agent_graph.agent_activity_steps
          WHERE agent_id = $1
            AND status = 'completed'
            AND completed_at IS NOT NULL
            AND created_at > NOW() - INTERVAL '7 days'
        `, [agentId]);

        const transitions = {};
        for (const r of transitionsR.rows) {
          transitions[r.to_state] = parseInt(r.cnt);
        }

        const work = workR.rows[0] || {};
        const duration = durationR.rows[0] || {};

        return {
          agent_id: agentId,
          transitions_7d: transitions,
          total_transitions_7d: Object.values(transitions).reduce((a, b) => a + b, 0),
          work_items: {
            completed: parseInt(work.completed || '0'),
            failed: parseInt(work.failed || '0'),
            active: parseInt(work.active || '0'),
            total: parseInt(work.total || '0'),
          },
          activity_steps_7d: parseInt(stepsR.rows[0]?.cnt || '0'),
          avg_task_duration_s: duration.avg_seconds ? parseFloat(duration.avg_seconds) : null,
        };
      }, 30_000);
      return result || { agent_id: agentId, transitions_7d: {}, work_items: {}, activity_steps_7d: 0 };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });
}
