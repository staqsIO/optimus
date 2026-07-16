import { query, withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

/**
 * Agent Activity Log API routes.
 *
 * GET /api/activity                  — recent steps across all agents (last 200)
 * GET /api/activity?work_item_id=X   — all steps for a specific work item
 * GET /api/activity?agent_id=X       — recent steps for a specific agent
 * GET /api/activity?campaign_id=X    — all steps for a specific campaign
 * GET /api/activity?since=ISO        — steps created after ISO timestamp (incremental poll)
 *
 * `since` may be combined with `agent_id` for incremental per-agent polling.
 * Steps are returned ascending when `since`, `work_item_id`, or `campaign_id`
 * is present so the client can append in order. The default feed returns
 * descending (newest-first); the client reverses for display.
 */
export function registerActivityRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608 r2a: agent_graph.agent_activity_steps now carries owner_org_id
  // (migration 149, backfilled via work_item_id -> agent_graph.work_items;
  // work-item-less steps -> Staqs). The default feed has NO work_item anchor to
  // gate on, so we scope DIRECTLY on the new column — which is exactly why 149
  // added it. withViewer is injected by api.js; absent/throwing → null principal
  // → visibleClause emits FALSE → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('GET /api/activity', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const workItemId  = url.searchParams.get('work_item_id');
    const agentId     = url.searchParams.get('agent_id');
    const campaignId  = url.searchParams.get('campaign_id');
    const since       = url.searchParams.get('since');
    const limit       = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

    const conditions = [];
    const params = [];

    // Tenancy scope (fail-closed): owner_org_id ∈ visible orgs, applied directly
    // on agent_activity_steps (no work_item anchor on the default feed).
    const principal = await resolvePrincipalFor(req);
    const sv = visibleClause(principal, { ownerOrgCol: 's.owner_org_id', startIndex: params.length + 1 });
    conditions.push(sv.sql);
    params.push(...sv.params);

    if (workItemId) {
      params.push(workItemId);
      conditions.push(`s.work_item_id = $${params.length}`);
    } else if (campaignId) {
      params.push(campaignId);
      conditions.push(`s.campaign_id = $${params.length}`);
    } else if (agentId) {
      params.push(agentId);
      conditions.push(`s.agent_id = $${params.length}`);
    }

    if (since) {
      params.push(since);
      conditions.push(`s.created_at > $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Ascending when scoped to a specific context or incremental (`since`),
    // descending for the general recent feed.
    const orderClause = (workItemId || campaignId || since)
      ? 'ORDER BY s.created_at ASC'
      : 'ORDER BY s.created_at DESC';

    params.push(limit);
    const limitClause = `LIMIT $${params.length}`;

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT
           s.id,
           s.work_item_id,
           s.campaign_id,
           s.iteration_number,
           s.parent_step_id,
           s.depth,
           s.agent_id,
           s.step_type,
           s.description,
           s.status,
           s.metadata,
           s.created_at,
           s.completed_at,
           CASE WHEN s.completed_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) * 1000
                ELSE EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000
           END AS duration_ms,
           wi.title AS work_item_title
         FROM agent_graph.agent_activity_steps s
         LEFT JOIN agent_graph.work_items wi ON wi.id = s.work_item_id::text
         ${whereClause}
         ${orderClause}
         ${limitClause}`,
        params
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { steps: result.rows };
  });

  // GET /api/activity/gate-failures
  // Recent action_proposals with at least one failed gate. Surfaces which-gate
  // and why for held drafts — closes the P3 transparency gap where users see
  // "draft held for review" without seeing the cause.
  routes.set('GET /api/activity/gate-failures', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    // Tenancy scope (fail-closed): action_proposals carries owner_org_id
    // (migration 134). $1 is the limit; the visible clause params follow.
    const principal = await resolvePrincipalFor(req);
    const av = visibleClause(principal, { ownerOrgCol: 'ap.owner_org_id', startIndex: 2 });
    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT
           ap.id,
           ap.created_at,
           ap.action_type,
           ap.subject,
           ap.body,
           ap.to_addresses,
           ap.channel,
           ap.work_item_id,
           ap.tone_score,
           ap.gate_results,
           ap.reviewer_verdict,
           ap.reviewer_notes,
           wi.title AS work_item_title
         FROM agent_graph.action_proposals ap
         LEFT JOIN agent_graph.work_items wi ON wi.id = ap.work_item_id
         WHERE ap.gate_results IS NOT NULL
           AND ap.gate_results != '{}'::jsonb
           AND ${av.sql}
           AND EXISTS (
             SELECT 1
             FROM jsonb_each(ap.gate_results) AS g(key, val)
             WHERE jsonb_typeof(val) = 'object'
               AND (val ->> 'passed') = 'false'
           )
         ORDER BY ap.created_at DESC
         LIMIT $1`,
        [limit, ...av.params]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    return { proposals: result.rows };
  });
}
