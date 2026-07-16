/**
 * Postgres-backed sliding window rate limiter (P4: boring infrastructure).
 *
 * Limits per authenticated identity (board member, agent, or legacy).
 * State persists across restarts via gateway_rate_limits table.
 */

import { query } from '../../db.js';

// Requests per minute by role
const LIMITS = {
  board: 120,
  agent: 60,
  legacy: 30,
};

const WINDOW_MS = 60_000; // 1 minute

/**
 * Check and increment rate limit for an identity.
 *
 * @param {string} memberId - Unique identity (board member UUID, agent ID, or 'legacy')
 * @param {string} [role='board'] - Role for limit lookup
 * @returns {Promise<{ allowed: boolean, retryAfterMs: number, remaining: number }>}
 */
export async function checkRateLimit(memberId, role = 'board') {
  const limit = LIMITS[role] || LIMITS.legacy;
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);

  // Atomic upsert: increment count and return current value
  const result = await query(
    `INSERT INTO agent_graph.gateway_rate_limits (member_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (member_id, window_start) DO UPDATE
       SET request_count = agent_graph.gateway_rate_limits.request_count + 1
     RETURNING request_count`,
    [memberId, windowStart.toISOString()]
  );

  const count = result.rows[0]?.request_count || 0;
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);

  // Time until window resets
  const windowEnd = new Date(windowStart.getTime() + WINDOW_MS);
  const retryAfterMs = allowed ? 0 : windowEnd.getTime() - Date.now();

  return { allowed, retryAfterMs, remaining };
}

/**
 * Check work item creation rate limit for external agents.
 * 10 per hour per identity. Prevents task graph flooding.
 */
const CREATION_LIMIT_PER_HOUR = 10;
const CREATION_WINDOW_MS = 3_600_000; // 1 hour

export async function checkCreationRateLimit(memberId) {
  const windowStart = new Date(Math.floor(Date.now() / CREATION_WINDOW_MS) * CREATION_WINDOW_MS);
  const result = await query(
    `INSERT INTO agent_graph.gateway_rate_limits (member_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (member_id, window_start) DO UPDATE
       SET request_count = agent_graph.gateway_rate_limits.request_count + 1
     RETURNING request_count`,
    [memberId, windowStart.toISOString()]
  );
  const count = result.rows[0]?.request_count || 0;
  return { allowed: count <= CREATION_LIMIT_PER_HOUR, count, limit: CREATION_LIMIT_PER_HOUR };
}

/**
 * Prune old rate limit windows (call periodically).
 */
export async function pruneRateLimits() {
  const cutoff = new Date(Date.now() - WINDOW_MS * 5); // keep 5 minutes of history
  await query(
    'DELETE FROM agent_graph.gateway_rate_limits WHERE window_start < $1',
    [cutoff.toISOString()]
  );
}
