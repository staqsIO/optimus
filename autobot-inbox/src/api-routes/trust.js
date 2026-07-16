import {
  getTrustScores,
  getAgentTrustScore,
  refreshTrustScores,
} from '../runtime/trust-scores.js';

/**
 * Agent Trust Score API routes (OPT-82, P5 reification).
 *
 * Follows the same pattern as gates.js / pipeline.js: exports a function that
 * registers route handlers on the provided routes Map.
 *
 * GET  /api/trust              — all agents' trust scores (highest first)
 * GET  /api/trust/agent?id=X   — one agent's trust score + component breakdown
 * POST /api/trust/refresh      — recompute the materialized view on demand
 *
 * OBSERVE-ONLY: these endpoints expose the score. Nothing here graduates or
 * demotes an agent's autonomy level — that enforcement is a deliberate follow-up
 * in the orchestration layer, not in this read surface.
 */
export function registerTrustRoutes(routes) {
  // GET /api/trust — leaderboard of per-agent trust scores
  routes.set('GET /api/trust', async () => {
    const scores = await getTrustScores();
    const scored = scores.filter((s) => s.trust_score !== null);
    const avg = scored.length
      ? scored.reduce((a, s) => a + s.trust_score, 0) / scored.length
      : null;
    return {
      agents: scores,
      summary: {
        total: scores.length,
        scored: scored.length,
        unscored: scores.length - scored.length,
        avg_trust_score: avg === null ? null : Math.round(avg * 10000) / 10000,
      },
      observe_only: true,
    };
  });

  // GET /api/trust/agent?id=X — single agent detail
  routes.set('GET /api/trust/agent', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const agentId = url.searchParams.get('id') || url.searchParams.get('agent_id');
    if (!agentId) return { error: 'id (agent id) query parameter required' };
    const score = await getAgentTrustScore(agentId);
    if (!score) return { error: 'unknown agent', agent_id: agentId };
    return { ...score, observe_only: true };
  });

  // POST /api/trust/refresh — recompute the MV now (board/ops action)
  routes.set('POST /api/trust/refresh', async () => {
    const result = await refreshTrustScores();
    return { ok: true, ...result };
  });
}
