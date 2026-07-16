import { query, withTransaction } from '../../db.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
const log = createLogger('runtime/intent-manager');

/**
 * Intent Manager: create and manage agent intents.
 * Agents call createIntent() to propose work. Board approves via CLI/dashboard.
 *
 * P1: Deny by default — all intents start as 'pending'.
 * P2: Infrastructure enforces — status transitions validated by DB constraints + guards.
 * P3: Transparency by structure — all transitions logged via trigger.
 */

/**
 * Default TTL for intents by decision tier (ms).
 */
const DEFAULT_TTL = {
  tactical: 48 * 60 * 60_000,    // 48 hours
  strategic: 7 * 24 * 60 * 60_000, // 7 days
  existential: 14 * 24 * 60 * 60_000, // 14 days
};

/**
 * Agent tier mapping — derived from agents.json (ADR-009: config-driven).
 * Loaded once at module init to avoid hardcoded drift.
 */
const AGENT_TIERS = (() => {
  try {
    const config = getConfig('agents');
    const tiers = {};
    for (const [id, cfg] of Object.entries(config.agents || {})) {
      tiers[id] = cfg.type || 'executor';
    }
    return tiers;
  } catch {
    // Fallback for test environments where config may not be available
    return {};
  }
})();

/**
 * Valid status transitions (Fix 5: transition guards).
 */
const VALID_TRANSITIONS = {
  approved: ['pending'],
  rejected: ['pending'],
  executed: ['approved'],
  expired: ['pending'],
};

/**
 * Create a new agent intent with dedup via ON CONFLICT (Fix 6).
 *
 * @param {Object} opts
 * @param {string} opts.agentId - ID of the proposing agent
 * @param {string} opts.intentType - 'task' | 'directive' | 'observation' | 'schedule' | 'governance'
 * @param {string} opts.decisionTier - 'tactical' | 'strategic' | 'existential'
 * @param {string} opts.title - Short description
 * @param {string} opts.reasoning - Why this intent was proposed
 * @param {Object} opts.proposedAction - What to do if approved
 * @param {Object} [opts.triggerContext] - What prompted this (signal IDs, metrics, patterns)
 * @param {number} [opts.ttlMs] - Custom TTL in ms (overrides default for decision tier)
 * @param {string} [opts.triggerType] - 'once' | 'interval' | 'cron' | 'condition'
 * @param {Object} [opts.triggerConfig] - interval_ms, cron_expression, or condition pattern
 * @param {number} [opts.budgetPerFire] - estimated cost per execution
 * @returns {Object|null} The created intent row, or null if duplicate
 */
export async function createIntent({
  agentId,
  intentType,
  decisionTier = 'tactical',
  title,
  reasoning,
  proposedAction,
  triggerContext = null,
  ttlMs = null,
  triggerType = 'once',
  triggerConfig = null,
  budgetPerFire = null,
}) {
  const agentTier = AGENT_TIERS[agentId] || 'executor';
  const ttl = ttlMs || DEFAULT_TTL[decisionTier] || DEFAULT_TTL.tactical;
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  // Fix 6: Use ON CONFLICT DO NOTHING for dedup instead of check-then-insert
  const result = await query(
    `INSERT INTO agent_graph.agent_intents
     (agent_id, agent_tier, intent_type, decision_tier, title, reasoning,
      proposed_action, trigger_context, trigger_type, trigger_config,
      budget_per_fire, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (agent_id, (trigger_context->>'pattern'), (COALESCE(trigger_context->>'contact_id', '')), (COALESCE(trigger_context->>'message_id', '')))
     WHERE status IN ('pending', 'approved', 'executed')
     DO NOTHING
     RETURNING *`,
    [
      agentId,
      agentTier,
      intentType,
      decisionTier,
      title,
      reasoning,
      JSON.stringify(proposedAction),
      triggerContext ? JSON.stringify(triggerContext) : null,
      triggerType,
      triggerConfig ? JSON.stringify(triggerConfig) : null,
      budgetPerFire,
      expiresAt,
    ]
  );

  if (result.rows.length === 0) {
    log.info(`Dedup: skipped duplicate intent [${decisionTier}/${intentType}] "${title}" by ${agentId}`);
    return null;
  }

  const intent = result.rows[0];
  log.info(`Created: ${intent.id.slice(0, 8)}... [${decisionTier}/${intentType}] "${title}" by ${agentId}`);
  return intent;
}

/**
 * Transition an intent's status with audit trail and transition guards.
 *
 * Fix 2: Only set reviewed_by when toStatus === 'approved'.
 * Fix 5: Validates from_status → to_status transition.
 *
 * @param {string} intentId
 * @param {string} toStatus - 'approved' | 'rejected' | 'expired' | 'executed'
 * @param {string} actor - who performed the transition ('board', agent ID, 'system')
 * @param {string} [feedback] - optional board feedback
 * @returns {{ success: boolean, intent?: Object, error?: string }}
 */
export async function transitionIntent(intentId, toStatus, actor, feedback = null) {
  const validFromStates = VALID_TRANSITIONS[toStatus];
  if (!validFromStates) {
    return { success: false, error: `Invalid target status: ${toStatus}` };
  }

  const timestampCol = toStatus === 'approved' || toStatus === 'rejected'
    ? 'reviewed_at'
    : toStatus === 'executed'
      ? 'executed_at'
      : null;

  // Build SET clause
  let setClauses = ['status = $1'];
  const params = [toStatus];

  // Fix 2: Only set reviewed_by for 'approved' and 'rejected' (reviewer identity)
  if (toStatus === 'approved' || toStatus === 'rejected') {
    params.push(actor);
    setClauses.push(`reviewed_by = $${params.length}`);
  }

  if (feedback) {
    params.push(feedback);
    setClauses.push(`board_feedback = $${params.length}`);
  }

  if (timestampCol) {
    setClauses.push(`${timestampCol} = now()`);
  }

  // Fix 5: WHERE clause includes valid from-states guard
  params.push(intentId);
  const idParam = params.length;
  const fromStatesStr = validFromStates.map((s, i) => `$${params.length + 1 + i}`).join(', ');
  params.push(...validFromStates);

  const sql = `UPDATE agent_graph.agent_intents
     SET ${setClauses.join(', ')}
     WHERE id = $${idParam} AND status IN (${fromStatesStr})
     RETURNING *`;

  const result = await query(sql, params);

  if (result.rows.length === 0) {
    // Check if intent exists to give a better error message
    const check = await query(`SELECT status FROM agent_graph.agent_intents WHERE id = $1`, [intentId]);
    if (check.rows.length === 0) {
      return { success: false, error: `Intent ${intentId} not found` };
    }
    const currentStatus = check.rows[0].status;
    return {
      success: false,
      error: `Cannot transition from '${currentStatus}' to '${toStatus}'. Valid source states: ${validFromStates.join(', ')}`,
    };
  }

  return { success: true, intent: result.rows[0] };
}

/**
 * Get pending intents, optionally filtered.
 */
export async function getPendingIntents({ agentId = null, decisionTier = null, limit = 50 } = {}) {
  let sql = `SELECT * FROM agent_graph.agent_intents WHERE status = 'pending'`;
  const params = [];

  if (agentId) {
    params.push(agentId);
    sql += ` AND agent_id = $${params.length}`;
  }
  if (decisionTier) {
    params.push(decisionTier);
    sql += ` AND decision_tier = $${params.length}`;
  }

  sql += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Expire stale intents. Called by reaper or periodic service.
 * @returns {number} Number of intents expired
 */
export async function expireStaleIntents() {
  const result = await query(`SELECT agent_graph.expire_stale_intents() AS count`);
  const count = result.rows[0]?.count || 0;
  if (count > 0) {
    log.info(`Expired ${count} stale intent(s)`);
  }
  return count;
}
