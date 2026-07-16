/**
 * Agent trust scores — read path + refresh hook for the OPT-82 materialized view
 * `agent_graph.agent_trust_scores` (migration 168).
 *
 * P5 reification ("measure before you trust"): the MV computes a per-agent
 * composite trust score in [0,1] from OBSERVABLE audit signals — gate pass rate,
 * retrospector outcomes, retry health, and executor cost stability. See
 * sql/168-agent-trust-score-mv.sql for the component definitions and weights.
 *
 * OBSERVE-ONLY: this module exposes the score; it does NOT graduate or demote
 * any agent's autonomy level. Autonomy enforcement keyed on trust is a deliberate
 * follow-up that belongs in the orchestration layer (guardCheck), not here.
 */

import { query } from '../../../lib/db.js';

/**
 * Recompute the trust-score materialized view from current audit data.
 *
 * Uses REFRESH ... CONCURRENTLY (the unique index agent_trust_scores_agent_id_uq
 * makes this legal) so reads are never blocked during refresh. Falls back to a
 * plain REFRESH if CONCURRENTLY is unavailable (e.g. the view was never populated
 * or the backend lacks the unique index) — both yield identical, deterministic
 * output because the score is a pure aggregate over the source tables.
 *
 * Registered as the 'trust-score-refresh' scheduled service in index.js.
 *
 * @returns {Promise<{ refreshed: boolean, concurrent: boolean }>}
 */
export async function refreshTrustScores() {
  try {
    // REFRESH requires MV *ownership*, which the post-flip agent pool does not
    // (and must not) have — the SECURITY DEFINER wrapper (migration 202) runs
    // the refresh with owner privileges and handles the CONCURRENTLY fallback
    // internally.
    await query('SELECT agent_graph.refresh_agent_trust_scores()');
    return { refreshed: true, concurrent: true };
  } catch (err) {
    // Pre-202 database (function absent): refresh directly, with the
    // CONCURRENTLY-requires-populated-view fallback.
    if (!/refresh_agent_trust_scores/.test(err.message || '')) throw err;
    try {
      await query('REFRESH MATERIALIZED VIEW CONCURRENTLY agent_graph.agent_trust_scores');
      return { refreshed: true, concurrent: true };
    } catch {
      await query('REFRESH MATERIALIZED VIEW agent_graph.agent_trust_scores');
      return { refreshed: true, concurrent: false };
    }
  }
}

/**
 * Map a raw MV row (NUMERIC columns arrive as strings via node-postgres) into a
 * typed object. NULL components / score are preserved as null (no evidence yet).
 * @private
 */
function shapeRow(r) {
  const num = (v) => (v === null || v === undefined ? null : parseFloat(v));
  const int = (v) => (v === null || v === undefined ? 0 : parseInt(v, 10));
  return {
    agent_id: r.agent_id,
    agent_type: r.agent_type,
    trust_score: num(r.trust_score),
    components: {
      gate_pass_rate: num(r.gate_pass_rate),
      retro_outcome_rate: num(r.retro_outcome_rate),
      retry_health: num(r.retry_health),
      cost_stability: num(r.cost_stability),
    },
    evidence: {
      gate_transitions: int(r.gate_transitions),
      retro_runs: int(r.retro_runs),
      retry_items: int(r.retry_items),
      cost_invocations: int(r.cost_invocations),
      sample_size: int(r.sample_size),
    },
    computed_at: r.computed_at,
  };
}

const SELECT_COLS = `
  agent_id, agent_type, trust_score,
  gate_pass_rate, retro_outcome_rate, retry_health, cost_stability,
  gate_transitions, retro_runs, retry_items, cost_invocations, sample_size,
  computed_at
`;

/**
 * All agents' trust scores, highest first (NULL scores — no evidence — last).
 * @returns {Promise<Array<object>>}
 */
export async function getTrustScores() {
  const r = await query(
    `SELECT ${SELECT_COLS}
       FROM agent_graph.agent_trust_scores
      ORDER BY trust_score DESC NULLS LAST, agent_id ASC`
  );
  return r.rows.map(shapeRow);
}

/**
 * One agent's trust score, or null if the agent is unknown.
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
export async function getAgentTrustScore(agentId) {
  const r = await query(
    `SELECT ${SELECT_COLS}
       FROM agent_graph.agent_trust_scores
      WHERE agent_id = $1`,
    [agentId]
  );
  return r.rows[0] ? shapeRow(r.rows[0]) : null;
}
