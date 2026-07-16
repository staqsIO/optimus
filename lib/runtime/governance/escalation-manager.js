/**
 * Graduated escalation manager (spec §8).
 *
 * Thin utility — NOT a service or loop. Called by existing threat sources
 * (sanitizer, tier1-deterministic, guard-check) to record threat events
 * and query the current escalation level.
 *
 * Hash chain follows the same pattern as state-machine.js transitionState.
 */

import { createHash } from 'crypto';
import { query, withTransaction } from '../../db.js';

/**
 * Record a threat event in threat_memory with hash chain computation.
 *
 * Hash chain integrity requires serialized appends: read-prev-hash + compute +
 * insert must be atomic. When no client is provided, wraps in a transaction
 * with an advisory lock to prevent concurrent callers from forking the chain.
 *
 * @param {Object} opts
 * @param {string} opts.sourceType - One of: sanitization, post_check, tier1_audit, tier2_audit, tool_integrity, gateway_inbound
 * @param {string} opts.scopeType - One of: org, agent, task, workstream, tool, inbound_channel
 * @param {string} opts.scopeId - Identifier for the scope (e.g., agent ID, or '*' for org)
 * @param {string} opts.threatClass - One of the 8 threat classes
 * @param {string} opts.severity - INFORMATIONAL, LOW, MEDIUM, HIGH, CRITICAL
 * @param {Object} [opts.detail] - Additional context (stored as JSONB)
 * @param {Object} [opts.client] - Transaction client (for atomic execution within existing tx)
 * @returns {Promise<{id: string, hashChain: string}>}
 */
export async function recordThreatEvent({
  sourceType,
  scopeType,
  scopeId,
  threatClass,
  severity,
  detail = {},
  client = null,
}) {
  const execute = async (q) => {
    // Advisory lock serializes all threat_memory chain appends.
    // hashtext('threat_memory_chain') produces a stable int4 lock key.
    await q(`SELECT pg_advisory_xact_lock(hashtext('threat_memory_chain'))`, []);

    const idResult = await q(`SELECT gen_random_uuid()::text as id`, []);
    const id = idResult.rows[0].id;

    // Get previous hash for chain (serialized by advisory lock)
    const prevResult = await q(
      `SELECT hash_chain_current FROM agent_graph.threat_memory
       ORDER BY detected_at DESC, id DESC LIMIT 1`,
      []
    );
    const prevHash = prevResult.rows[0]?.hash_chain_current || null;

    // Compute hash chain: sha256(prevHash|id|sourceType|scopeType|scopeId|threatClass|severity)
    const payload = (prevHash || 'genesis') + '|' +
      id + '|' + sourceType + '|' + scopeType + '|' +
      scopeId + '|' + threatClass + '|' + severity;
    const hashChain = createHash('sha256').update(payload).digest('hex');

    await q(
      `INSERT INTO agent_graph.threat_memory
         (id, source_type, scope_type, scope_id, threat_class, severity, detail_json, prev_hash, hash_chain_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, sourceType, scopeType, scopeId, threatClass, severity, JSON.stringify(detail), prevHash, hashChain]
    );

    return { id, hashChain };
  };

  if (client) {
    return execute((text, params) => client.query(text, params));
  }
  return withTransaction(async (txClient) => {
    return execute((text, params) => txClient.query(text, params));
  });
}

/**
 * Get the current escalation level for a scope.
 * Delegates to the SQL function current_escalation_level().
 *
 * @param {string} scopeType
 * @param {string} scopeId
 * @returns {Promise<number>} Level 0-4
 */
export async function getEscalationLevel(scopeType, scopeId) {
  const result = await query(
    `SELECT agent_graph.current_escalation_level($1, $2) as level`,
    [scopeType, scopeId]
  );
  return parseInt(result.rows[0]?.level ?? '0', 10);
}

/**
 * Resolve all unresolved threats for a given scope.
 * Board can resolve all severities; non-board skips HIGH/CRITICAL.
 *
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} resolvedBy - 'board' or 'auto_decay'
 * @returns {Promise<number>} Number of threats resolved
 */
export async function resolveThreats(scopeType, scopeId, resolvedBy) {
  // Board can resolve everything in one UPDATE; non-board must skip HIGH/CRITICAL
  const severityFilter = resolvedBy === 'board'
    ? ''
    : `AND severity NOT IN ('HIGH', 'CRITICAL')`;

  const result = await query(
    `UPDATE agent_graph.threat_memory
     SET resolved = true, resolved_by = $3, resolved_at = now()
     WHERE scope_type = $1 AND scope_id = $2 AND resolved = false
       ${severityFilter}
     RETURNING id`,
    [scopeType, scopeId, resolvedBy]
  );

  return result.rows.length;
}
