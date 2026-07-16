import { query } from '../db.js';
import { syntheticPrincipal, visibleClause } from '../../../lib/tenancy/scope.js';

/**
 * Briefing generator: compile and retrieve daily briefings.
 */

// STAQPRO-588 (ADR-012 M-C, BLOCKER 1): the briefing read has NO request viewer
// (CLI / agent-runtime context), so it cannot derive a viewer principal. Instead it
// reads on behalf of a single org via syntheticPrincipal(orgId) so the returned
// briefing is built only from rows of that org — generated narrative cannot leak
// across tenants. orgId is resolved once from the org slug (default 'staqs').
// Fail-closed: if the org can't be resolved, no principal scope applies and the
// visibleClause degrades to 'FALSE' → no row (never an unfiltered org-wide read).
let _orgIdCache = new Map();
async function resolveOrgId(slug) {
  if (_orgIdCache.has(slug)) return _orgIdCache.get(slug);
  const r = await query(`SELECT id FROM tenancy.orgs WHERE slug = $1 LIMIT 1`, [slug]);
  const id = r.rows[0]?.id || null;
  _orgIdCache.set(slug, id);
  return id;
}

/**
 * Get today's briefing (or most recent) for a single org.
 * @param {{orgSlug?: string}} [opts] org to generate-for (default 'staqs').
 */
export async function getLatestBriefing({ orgSlug = 'staqs' } = {}) {
  const orgId = await resolveOrgId(orgSlug);
  // syntheticPrincipal(null) yields an empty scope → visibleClause → 'FALSE' (fail-closed).
  const principal = syntheticPrincipal(orgId);
  const v = visibleClause(principal, { ownerUserCol: 'owner_user_id', ownerOrgCol: 'owner_org_id', startIndex: 1 });
  const result = await query(
    `SELECT * FROM signal.briefings WHERE ${v.sql} ORDER BY briefing_date DESC LIMIT 1`,
    v.params
  );
  return result.rows[0] || null;
}

/**
 * Get daily stats from the view.
 */
export async function getDailyStats() {
  const result = await query(`SELECT * FROM signal.v_daily_briefing`);
  return result.rows[0] || null;
}

/**
 * Get agent activity breakdown.
 */
export async function getAgentActivity() {
  const result = await query(`SELECT * FROM agent_graph.v_agent_activity`);
  return result.rows;
}

/**
 * Get budget status.
 */
export async function getBudgetStatus() {
  const result = await query(`SELECT * FROM agent_graph.v_budget_status`);
  return result.rows;
}
