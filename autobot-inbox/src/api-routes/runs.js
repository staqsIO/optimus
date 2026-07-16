import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

/**
 * Runs API routes — E2E trigger-to-agent-chain visualization.
 *
 * GET /api/runs                      — list root work items (runs) with aggregated stats
 * GET /api/runs/tree?id=X            — full work item DAG for a single run
 * GET /api/runs/activity?id=X        — activity steps for all items in a run
 * GET /api/runs/transitions?id=X     — state transitions for all items in a run
 *
 * STAQPRO-597: agent_graph.work_items carries owner_org_id (migration 134), so
 * these routes serve PER-ORG rows. The classifier (route-tiers.js) now tags the
 * family org-shared, and the LIST endpoint applies visibleClause(owner_org_id)
 * fail-closed (unresolved principal → zero rows). withViewer is injected by
 * api.js (the board_members ↔ viewer ↔ principal bridge); when it is absent
 * (older callers / tests) the principal is null → visibleClause emits FALSE.
 */
export function registerRunRoutes(routes, cachedQuery, { withViewer } = {}) {
  // Resolve the tenancy principal for the run routes. Mirrors the 588/596
  // pattern in flows.js / meetings.js. null principal → visibleClause 'FALSE'
  // → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // STAQPRO-608 anchor gate for the BY-ID endpoints (/tree, /activity,
  // /transitions). These read append-only children — agent_graph.work_items
  // (the tree), agent_graph.edges, agent_graph.llm_invocations,
  // agent_graph.agent_activity_steps, agent_graph.state_transitions. Only
  // work_items carries owner_org_id (migration 134); the child tables do NOT.
  // So we gate on the ANCHOR run's owner_org_id: the root work_item addressed
  // by `id` must be visible to the principal. If it is not, we return the same
  // "Run not found" envelope a missing id produces — a hidden run is
  // indistinguishable from a non-existent one (no cross-tenant enumeration
  // oracle). Unresolved principal → visibleClause 'FALSE' → not visible → 404.
  // Verified-agent (adminBypass) → 'TRUE' → visible, matching the LIST path.
  const anchorVisible = async (principal, id) => {
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
    const r = await query(
      `SELECT 1 FROM agent_graph.work_items WHERE id = $1 AND ${v.sql} LIMIT 1`,
      [id, ...v.params],
    );
    return r.rows.length > 0;
  };

  // TODO(opt-166-p3): mixed principal — all 4 routes below are reachable by
  // verified-agent JWT principals (req.auth.source === 'agent_jwt'), which
  // resolveViewerEmails()/withViewer() map to principal.adminBypass === true
  // (autobot-inbox/src/api.js:489, :575-591) so visibleClause() returns 'TRUE'
  // for them — a currently-working, non-board caller. withBoardScope() THROWS
  // for any req.auth.role !== 'board', so wrapping these handlers would break
  // that caller pre-flip (INERT-rule violation). Left unscoped intentionally;
  // work_items/state_transitions/llm_invocations RLS-flip coverage for the
  // agent-JWT path must come from a different mechanism (e.g. setAgentContext
  // on the pool client) — flagged for the route-matrix owner, not fixed here.

  // ── List runs ─────────────────────────────────────────
  routes.set('GET /api/runs', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status        = url.searchParams.get('status');
    const triggerSource = url.searchParams.get('trigger_source');
    const since         = url.searchParams.get('since');
    const limit         = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset        = parseInt(url.searchParams.get('offset') || '0', 10);

    const principal = await resolvePrincipalFor(req);
    // Org scope key component so the response cache never serves one org's runs
    // to another (the cache is keyed per distinct visible-org set).
    const scopeKey = principal?.adminBypass
      ? 'admin'
      : (principal?.readOrgIds || []).slice().sort().join(',') || 'none';

    return cachedQuery(`runs:list:${scopeKey}:${status}:${triggerSource}:${since}:${limit}:${offset}`, async () => {
      const conditions = ['wi.parent_id IS NULL'];
      const params = [];

      // Tenancy scope (fail-closed): owner_org_id ∈ visible orgs. Placeholder
      // indices are managed off the running params length.
      const v = visibleClause(principal, { ownerOrgCol: 'wi.owner_org_id', startIndex: params.length + 1 });
      conditions.push(v.sql);
      params.push(...v.params);

      if (status) {
        params.push(status);
        conditions.push(`wi.status = $${params.length}`);
      }

      if (triggerSource) {
        params.push(triggerSource);
        conditions.push(`COALESCE(wi.metadata->>'webhook_source', wi.metadata->>'source', wi.created_by) = $${params.length}`);
      }

      if (since) {
        params.push(since);
        conditions.push(`wi.created_at > $${params.length}`);
      }

      params.push(limit);
      const limitIdx = params.length;
      params.push(offset);
      const offsetIdx = params.length;

      const whereClause = conditions.join(' AND ');

      const result = await query(
        `WITH roots AS (
          SELECT wi.id, wi.type, wi.title, wi.status,
                 wi.assigned_to, wi.created_by,
                 wi.created_at, wi.updated_at,
                 wi.metadata, wi.budget_usd,
                 COALESCE(wi.metadata->>'webhook_source', wi.metadata->>'source', wi.created_by) AS trigger_source
          FROM agent_graph.work_items wi
          WHERE ${whereClause}
          ORDER BY wi.created_at DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        )
        SELECT r.*,
          (WITH RECURSIVE tree AS (
            SELECT id FROM agent_graph.work_items WHERE parent_id = r.id
            UNION ALL
            SELECT c.id FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
          ) SELECT COUNT(*) + 1 FROM tree) AS item_count,
          (WITH RECURSIVE tree AS (
            SELECT id, assigned_to FROM agent_graph.work_items WHERE id = r.id
            UNION ALL
            SELECT c.id, c.assigned_to FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
          ) SELECT COUNT(DISTINCT assigned_to) FILTER (WHERE assigned_to IS NOT NULL) FROM tree) AS agent_count,
          (WITH RECURSIVE tree AS (
            SELECT id FROM agent_graph.work_items WHERE id = r.id
            UNION ALL
            SELECT c.id FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
          ) SELECT COALESCE(SUM(li.cost_usd), 0)
            FROM agent_graph.llm_invocations li
            WHERE li.task_id IN (SELECT id FROM tree)
          ) AS total_cost_usd,
          (WITH RECURSIVE tree AS (
            SELECT id, updated_at FROM agent_graph.work_items WHERE id = r.id
            UNION ALL
            SELECT c.id, c.updated_at FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
          ) SELECT EXTRACT(EPOCH FROM (MAX(updated_at) - r.created_at)) * 1000 FROM tree) AS duration_ms
        FROM roots r
        ORDER BY r.created_at DESC`,
        params
      );

      return { runs: result.rows };
    }, 30_000);
  });

  // ── Run tree ──────────────────────────────────────────
  routes.set('GET /api/runs/tree', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) return { error: 'id is required' };

    // STAQPRO-608: gate on the anchor run's owner_org_id (fail-closed).
    const principal = await resolvePrincipalFor(req);
    if (!(await anchorVisible(principal, id))) return { error: 'Run not found' };

    // 1. Recursive work item tree
    const treeResult = await query(
      `WITH RECURSIVE tree AS (
        SELECT * FROM agent_graph.work_items WHERE id = $1
        UNION ALL
        SELECT c.* FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
      )
      SELECT
        t.id, t.type, t.title, t.status, t.assigned_to, t.created_by,
        t.parent_id, t.delegation_depth, t.metadata, t.budget_usd,
        t.created_at, t.updated_at,
        CASE WHEN t.status IN ('completed', 'cancelled', 'failed', 'timed_out')
          THEN EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000
          ELSE EXTRACT(EPOCH FROM (NOW() - t.created_at)) * 1000
        END AS duration_ms
      FROM tree t
      ORDER BY t.delegation_depth ASC, t.created_at ASC
      LIMIT 500`,
      [id]
    );

    if (treeResult.rows.length === 0) {
      return { error: 'Run not found' };
    }

    const itemIds = treeResult.rows.map(r => r.id);

    // 2. Explicit edges
    const edgesResult = await query(
      `SELECT e.id, e.from_id, e.to_id, e.edge_type
       FROM agent_graph.edges e
       WHERE e.from_id = ANY($1) OR e.to_id = ANY($1)`,
      [itemIds]
    );

    // 3. LLM cost per item
    const costsResult = await query(
      `SELECT li.task_id,
              SUM(li.cost_usd)::numeric(15,6) AS cost_usd,
              SUM(li.input_tokens + li.output_tokens) AS total_tokens,
              COUNT(*) AS invocation_count
       FROM agent_graph.llm_invocations li
       WHERE li.task_id = ANY($1)
       GROUP BY li.task_id`,
      [itemIds]
    );

    const root = treeResult.rows[0];
    return {
      root,
      items: treeResult.rows,
      edges: edgesResult.rows,
      costs: costsResult.rows,
    };
  });

  // ── Run activity steps ────────────────────────────────
  routes.set('GET /api/runs/activity', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const workItemId = url.searchParams.get('work_item_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    if (!id) return { error: 'id is required' };

    // STAQPRO-608: gate on the anchor run's owner_org_id (fail-closed).
    const principal = await resolvePrincipalFor(req);
    if (!(await anchorVisible(principal, id))) return { error: 'Run not found' };

    // Get all item IDs in the tree, then query activity steps
    const result = await query(
      `WITH RECURSIVE tree AS (
        SELECT id FROM agent_graph.work_items WHERE id = $1
        UNION ALL
        SELECT c.id FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
      )
      SELECT
        s.id, s.work_item_id, s.parent_step_id, s.depth,
        s.agent_id, s.step_type, s.description, s.status,
        s.metadata, s.created_at, s.completed_at,
        CASE WHEN s.completed_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (s.completed_at - s.created_at)) * 1000
             ELSE EXTRACT(EPOCH FROM (NOW() - s.created_at)) * 1000
        END AS duration_ms,
        wi.title AS work_item_title
      FROM agent_graph.agent_activity_steps s
      JOIN tree t ON t.id = s.work_item_id::text
      LEFT JOIN agent_graph.work_items wi ON wi.id = s.work_item_id::text
      ${workItemId ? 'WHERE s.work_item_id::text = $3' : ''}
      ORDER BY s.created_at ASC
      LIMIT $2`,
      workItemId ? [id, limit, workItemId] : [id, limit]
    );

    return { steps: result.rows };
  });

  // ── Run state transitions ─────────────────────────────
  routes.set('GET /api/runs/transitions', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const workItemId = url.searchParams.get('work_item_id');
    if (!id) return { error: 'id is required' };

    // STAQPRO-608: gate on the anchor run's owner_org_id (fail-closed).
    const principal = await resolvePrincipalFor(req);
    if (!(await anchorVisible(principal, id))) return { error: 'Run not found' };

    const result = await query(
      `WITH RECURSIVE tree AS (
        SELECT id FROM agent_graph.work_items WHERE id = $1
        UNION ALL
        SELECT c.id FROM agent_graph.work_items c JOIN tree t ON c.parent_id = t.id
      )
      SELECT st.id, st.work_item_id, st.from_state, st.to_state,
             st.agent_id, st.cost_usd, st.reason,
             st.guardrail_checks_json, st.created_at,
             wi.title AS work_item_title
      FROM agent_graph.state_transitions st
      JOIN tree t ON st.work_item_id = t.id
      LEFT JOIN agent_graph.work_items wi ON wi.id = st.work_item_id
      ${workItemId ? 'WHERE st.work_item_id = $2' : ''}
      ORDER BY st.created_at ASC`,
      workItemId ? [id, workItemId] : [id]
    );

    return { transitions: result.rows };
  });
}
