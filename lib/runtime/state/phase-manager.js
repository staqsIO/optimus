import { query, withTransaction } from '../../db.js';
import { activateFullAutonomy, checkDataCooperativeFormation } from '../autonomy-controller.js';
import { publishAllProofs } from '../merkle-publisher.js';

/**
 * Phase Manager -- Phase transition management (spec S14).
 *
 * Manages activation/deactivation of operational phases.
 * Phase 3 activation triggers:
 *   - Constitutional engine switches from shadow to active mode
 *   - Gateway enables full tier processing (Tier 2 quorum)
 *   - Financial script exits shadow mode
 *   - Auditor gains HALT authority
 *   - Dead-man's switch activates
 *
 * Phase 4 activation triggers:
 *   - Full autonomy activated (budget cap removed, multi-product, distribution, data fees)
 *   - Creator role transitions to custodian
 *   - Initial Merkle proofs published for all 4 ledger types
 *   - Data cooperative formation check enabled
 *
 * P2: Infrastructure enforces; prompts advise.
 * P4: Boring infrastructure.
 */

/**
 * Get the current active phase number.
 * Defaults to phase 2 if no phase config exists.
 *
 * @returns {Promise<number>} Current active phase (1-4).
 */
export async function getCurrentPhase() {
  try {
    const result = await query(
      `SELECT phase FROM agent_graph.phase_config
       WHERE is_active = true
       ORDER BY phase DESC
       LIMIT 1`
    );
    return result.rows[0]?.phase ?? 2;
  } catch (err) {
    if (err.message?.includes('does not exist')) return 2;
    throw err;
  }
}

/**
 * Activate a phase, deactivating the previous active phase.
 * Records who activated it and when.
 *
 * @param {number} phaseNumber - Phase to activate (1-4).
 * @param {string} activatedBy - Board member or system identifier.
 * @returns {Promise<{activated: boolean, phase: number, previousPhase: number|null, triggers: string[]}>}
 */
export async function activatePhase(phaseNumber, activatedBy) {
  if (phaseNumber < 1 || phaseNumber > 4) {
    return { activated: false, phase: phaseNumber, previousPhase: null, triggers: [], reason: 'Invalid phase number (must be 1-4)' };
  }

  if (!activatedBy) {
    return { activated: false, phase: phaseNumber, previousPhase: null, triggers: [], reason: 'activatedBy is required' };
  }

  const previousPhase = await getCurrentPhase();

  // Safety: cannot skip phases (must go sequentially)
  if (phaseNumber > previousPhase + 1) {
    return {
      activated: false,
      phase: phaseNumber,
      previousPhase,
      triggers: [],
      reason: `Cannot skip phases. Current: ${previousPhase}, requested: ${phaseNumber}`,
    };
  }

  // Safety: cannot downgrade below current phase without explicit override
  if (phaseNumber < previousPhase) {
    return {
      activated: false,
      phase: phaseNumber,
      previousPhase,
      triggers: [],
      reason: `Cannot downgrade from phase ${previousPhase} to ${phaseNumber}`,
    };
  }

  if (phaseNumber === previousPhase) {
    return { activated: false, phase: phaseNumber, previousPhase, triggers: [], reason: 'Phase already active' };
  }

  try {
    // Wrap deactivate + activate in a single transaction to prevent orphaned state on crash
    await withTransaction(async (client) => {
      // Deactivate all phases
      await client.query(
        `UPDATE agent_graph.phase_config
         SET is_active = false, deactivated_at = now()
         WHERE is_active = true`
      );

      // Activate the requested phase
      const result = await client.query(
        `UPDATE agent_graph.phase_config
         SET is_active = true, activated_at = now(), activated_by = $1
         WHERE phase = $2
         RETURNING id, phase, config`,
        [activatedBy, phaseNumber]
      );

      if (result.rows.length === 0) {
        // Phase config row does not exist yet -- insert it
        await client.query(
          `INSERT INTO agent_graph.phase_config (id, phase, is_active, activated_at, activated_by, config)
           VALUES ($1, $2, true, now(), $3, $4)`,
          [`phase-${phaseNumber}`, phaseNumber, activatedBy, JSON.stringify({})]
        );
      }
    });

    // Execute phase-specific activation triggers (outside transaction — they have their own error handling)
    const triggers = await executePhaseActivationTriggers(phaseNumber);

    return {
      activated: true,
      phase: phaseNumber,
      previousPhase,
      triggers,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { activated: false, phase: phaseNumber, previousPhase, triggers: [], reason: 'Phase config table not ready' };
    }
    throw err;
  }
}

/**
 * Get configuration for a specific phase.
 *
 * @param {number} phaseNumber - Phase number (1-4).
 * @returns {Promise<Object|null>} Phase configuration or null.
 */
export async function getPhaseConfig(phaseNumber) {
  try {
    const result = await query(
      `SELECT id, phase, is_active, activated_at, activated_by, deactivated_at, config
       FROM agent_graph.phase_config
       WHERE phase = $1`,
      [phaseNumber]
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Convenience check: is Phase 3 currently active?
 *
 * @returns {Promise<boolean>}
 */
export async function isPhase3Active() {
  const phase = await getCurrentPhase();
  return phase >= 3;
}

/**
 * Convenience check: is Phase 4 currently active?
 *
 * @returns {Promise<boolean>}
 */
export async function isPhase4Active() {
  const phase = await getCurrentPhase();
  return phase >= 4;
}

/**
 * Execute activation triggers for a specific phase.
 * Each phase has side effects that must occur on activation.
 *
 * @param {number} phaseNumber
 * @returns {Promise<string[]>} List of trigger descriptions that executed.
 */
async function executePhaseActivationTriggers(phaseNumber) {
  const triggers = [];

  if (phaseNumber === 3) {
    // Activate the dead-man's switch
    try {
      await query(
        `UPDATE agent_graph.dead_man_switch
         SET status = 'active', last_renewal = now(), consecutive_missed = 0, last_checked_at = now()
         WHERE id = 'primary'`
      );
      triggers.push('dead_man_switch_activated');
    } catch (err) {
      if (!err.message?.includes('does not exist')) throw err;
    }

    // Update financial allocations to exit shadow mode
    try {
      await query(
        `UPDATE autobot_finance.monthly_allocations
         SET is_shadow_mode = false
         WHERE period_month >= date_trunc('month', now())::date`
      );
      triggers.push('financial_shadow_mode_disabled');
    } catch (err) {
      if (!err.message?.includes('does not exist')) throw err;
    }

    triggers.push('constitutional_engine_active_mode');
    triggers.push('gateway_full_tier_activation');
    triggers.push('auditor_halt_authority_enabled');
  }

  if (phaseNumber === 4) {
    // Phase 4: Full Constitutional Autonomy

    // Activate full autonomy (budget cap removed, multi-product, distribution, data fees)
    try {
      const autonomyResult = await activateFullAutonomy('phase_manager');
      if (autonomyResult.activated) {
        triggers.push('full_autonomy_activated');
        triggers.push('budget_cap_removed');
        triggers.push('multi_product_enabled');
        triggers.push('full_distribution_active');
        triggers.push('data_fees_active');
        triggers.push('creator_role_custodian');
      } else {
        // Autonomy activation failed pre-conditions; record the reason but do not block
        triggers.push(`full_autonomy_blocked: ${autonomyResult.reason}`);
      }
    } catch (err) {
      if (!err.message?.includes('does not exist')) throw err;
      triggers.push('full_autonomy_skipped: table not ready');
    }

    // Publish initial Merkle proofs for all 4 ledger types
    try {
      const proofsResult = await publishAllProofs();
      const publishedCount = proofsResult.results.filter(r => r.published).length;
      triggers.push(`merkle_proofs_published: ${publishedCount}/4`);
    } catch (err) {
      if (!err.message?.includes('does not exist')) throw err;
      triggers.push('merkle_proofs_skipped: table not ready');
    }

    // Enable data cooperative formation check
    try {
      const coopResult = await checkDataCooperativeFormation();
      if (coopResult.triggered) {
        triggers.push('data_cooperative_formation_triggered');
      } else {
        triggers.push(`data_cooperative_formation_check: status=${coopResult.status}, members=${coopResult.currentMembers}/${coopResult.threshold}`);
      }
    } catch (err) {
      if (!err.message?.includes('does not exist')) throw err;
      triggers.push('data_cooperative_check_skipped: table not ready');
    }
  }

  return triggers;
}
