/**
 * Unified permission enforcement module (ADR-017).
 *
 * Wraps the DB check_permission() function with fail-closed semantics.
 * Agents call checkPermission/requirePermission at their actual call sites
 * (adapter fetch, API client calls, subprocess spawns) — not through a
 * single executeTool() bottleneck that everything bypasses.
 *
 * P1: Deny by default — no grant row = denied.
 * P2: Infrastructure enforces — the DB function is the source of truth.
 * P3: Transparency — logCapabilityInvocation writes to tool_invocations.
 */

import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/permissions');

/**
 * Check if an agent has permission to use a resource.
 * Returns true/false, never throws. Fail-closed: errors → false.
 *
 * @param {string} agentId - Agent requesting access
 * @param {string} resourceType - 'tool' | 'adapter' | 'api_client' | 'subprocess'
 * @param {string} resourceName - Specific resource name (e.g., 'linear', 'gmail')
 * @returns {Promise<boolean>}
 */
export async function checkPermission(agentId, resourceType, resourceName) {
  try {
    const result = await query(
      `SELECT agent_graph.check_permission($1, $2, $3) AS allowed`,
      [agentId, resourceType, resourceName]
    );
    return result.rows[0]?.allowed === true;
  } catch (err) {
    // P1: fail-closed — if we can't check, deny
    log.error(`check_permission failed (denying): ${err.message}`);
    return false;
  }
}

/**
 * Require permission — throws if denied. Use at agent-level call sites
 * where denial should abort the operation (task retries 3x then escalates).
 *
 * @param {string} agentId
 * @param {string} resourceType
 * @param {string} resourceName
 * @throws {Error} if permission denied
 */
export async function requirePermission(agentId, resourceType, resourceName) {
  const allowed = await checkPermission(agentId, resourceType, resourceName);
  if (!allowed) {
    throw new Error(
      `Permission denied: agent '${agentId}' lacks grant for ${resourceType}:${resourceName}`
    );
  }
}

/**
 * Log a capability invocation to tool_invocations (fire-and-forget).
 * Extends the existing audit table with resource_type and work_item_id.
 *
 * @param {Object} params
 * @param {string} params.agentId
 * @param {string} params.resourceType - 'tool' | 'adapter' | 'api_client' | 'subprocess'
 * @param {string} params.resourceName
 * @param {boolean} params.success
 * @param {number} [params.durationMs]
 * @param {string} [params.errorMessage]
 * @param {string} [params.workItemId]
 * @param {string} [params.resultSummary]
 */
export function logCapabilityInvocation({
  agentId,
  resourceType,
  resourceName,
  success,
  durationMs = null,
  errorMessage = null,
  workItemId = null,
  resultSummary = null,
}) {
  // Fire-and-forget — audit failures must not affect agent execution
  query(
    `INSERT INTO agent_graph.tool_invocations
     (agent_id, resource_type, tool_name, success, duration_ms, error_message, work_item_id, result_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [agentId, resourceType, resourceName, success, durationMs, errorMessage, workItemId, resultSummary]
  ).catch((err) => {
    log.warn(`audit log failed (non-fatal): ${err.message}`);
  });
}
