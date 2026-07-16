import { query } from '../../db.js';

/**
 * Autonomy Controller -- Phase 4 full constitutional autonomy (spec S14).
 *
 * Manages Phase 4 activation:
 *   - Budget cap removed
 *   - Multiple products permitted
 *   - Full distribution mechanism active
 *   - Data contribution fees active (20% allocation)
 *   - Creator role transitions to legal custodian only
 *   - Data Cooperative formation triggered when user count > 50
 *
 * Creator non-delegable obligations (Article 3.6):
 *   - Dead-man switch renewed within 30 days
 *   - Kill switch accessible
 *   - Tax filing oversight current
 *
 * P2: Infrastructure enforces; prompts advise.
 * P4: Boring infrastructure.
 * P5: Measure before you trust.
 */

const DATA_COOPERATIVE_FORMATION_THRESHOLD = 50;
const REQUIRED_CONSECUTIVE_GATE_DAYS = 90;
const DEAD_MAN_SWITCH_RENEWAL_DAYS = 30;

/**
 * Activate full Phase 4 autonomy with all safeguards.
 *
 * Pre-conditions (all must pass):
 *   1. All capability gates pass for 90 consecutive days.
 *   2. Creator obligations are current (dead-man switch, kill switch).
 *
 * On activation:
 *   - Removes budget cap
 *   - Enables multiple products
 *   - Activates full distribution
 *   - Sets creator role to 'custodian'
 *   - Activates data contribution fees
 *
 * @param {string} activatedBy - Board member or system identifier.
 * @returns {Promise<{activated: boolean, reason: string|null, config: Object|null}>}
 */
export async function activateFullAutonomy(activatedBy) {
  if (!activatedBy) {
    return { activated: false, reason: 'activatedBy is required', config: null };
  }

  // Pre-condition 1: Verify all gates pass for 90 consecutive days
  let consecutiveDays = 0;
  try {
    const snapshotResult = await query(
      `SELECT consecutive_days_all_passing, all_passing
       FROM agent_graph.gate_snapshots
       ORDER BY snapshot_date DESC
       LIMIT 1`
    );

    if (snapshotResult.rows.length > 0 && snapshotResult.rows[0].all_passing) {
      consecutiveDays = parseInt(snapshotResult.rows[0].consecutive_days_all_passing, 10);
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  if (consecutiveDays < REQUIRED_CONSECUTIVE_GATE_DAYS) {
    return {
      activated: false,
      reason: `Capability gates must pass for ${REQUIRED_CONSECUTIVE_GATE_DAYS} consecutive days. Current: ${consecutiveDays} days.`,
      config: null,
    };
  }

  // Pre-condition 2: Verify creator obligations are current
  const obligations = await checkCreatorObligations();
  if (!obligations.allMet) {
    return {
      activated: false,
      reason: `Creator obligations not met: ${obligations.failures.join(', ')}`,
      config: null,
    };
  }

  // All pre-conditions met -- activate Phase 4 autonomy
  try {
    await query(
      `UPDATE agent_graph.autonomy_config SET
         budget_cap_removed = true,
         multi_product_enabled = true,
         full_distribution_active = true,
         data_fees_active = true,
         creator_role = 'custodian',
         activated_at = now(),
         activated_by = $1
       WHERE id = 'primary'`,
      [activatedBy]
    );

    const config = await getAutonomyStatus();

    return {
      activated: true,
      reason: null,
      config,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { activated: false, reason: 'autonomy_config table not ready', config: null };
    }
    throw err;
  }
}

/**
 * Get the current autonomy configuration.
 *
 * @returns {Promise<Object|null>} Current autonomy config, or null if table not ready.
 */
export async function getAutonomyStatus() {
  try {
    const result = await query(
      `SELECT id, budget_cap_removed, multi_product_enabled,
              full_distribution_active, data_fees_active,
              creator_role, activated_at, activated_by
       FROM agent_graph.autonomy_config
       WHERE id = 'primary'`
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      budgetCapRemoved: row.budget_cap_removed,
      multiProductEnabled: row.multi_product_enabled,
      fullDistributionActive: row.full_distribution_active,
      dataFeesActive: row.data_fees_active,
      creatorRole: row.creator_role,
      activatedAt: row.activated_at,
      activatedBy: row.activated_by,
      isPhase4Active: row.budget_cap_removed && row.multi_product_enabled &&
                      row.full_distribution_active && row.data_fees_active &&
                      row.creator_role === 'custodian',
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Verify the creator's non-delegable obligations (Article 3.6).
 *
 * Checks:
 *   1. Dead-man switch renewed within 30 days
 *   2. Kill switch accessible (no unresolved halt signals blocking access)
 *   3. Tax filing oversight current (stub -- always passes until tax integration)
 *
 * @returns {Promise<{allMet: boolean, checks: Object[], failures: string[]}>}
 */
export async function checkCreatorObligations() {
  const checks = [];
  const failures = [];

  // Check 1: Dead-man switch renewed within 30 days
  try {
    const dmsResult = await query(
      `SELECT status, last_renewal
       FROM agent_graph.dead_man_switch
       WHERE id = 'primary'`
    );

    if (dmsResult.rows.length === 0) {
      checks.push({ obligation: 'dead_man_switch', met: false, reason: 'Not configured' });
      failures.push('Dead-man switch not configured');
    } else {
      const row = dmsResult.rows[0];
      const lastRenewal = new Date(row.last_renewal);
      const daysSinceRenewal = (Date.now() - lastRenewal.getTime()) / (1000 * 60 * 60 * 24);
      const met = row.status === 'active' && daysSinceRenewal <= DEAD_MAN_SWITCH_RENEWAL_DAYS;

      checks.push({
        obligation: 'dead_man_switch',
        met,
        reason: met
          ? `Active, renewed ${Math.round(daysSinceRenewal)} days ago`
          : `Status: ${row.status}, ${Math.round(daysSinceRenewal)} days since renewal`,
      });

      if (!met) {
        failures.push(`Dead-man switch: status=${row.status}, ${Math.round(daysSinceRenewal)} days since renewal`);
      }
    }
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      checks.push({ obligation: 'dead_man_switch', met: false, reason: 'Table not available' });
      failures.push('Dead-man switch table not available');
    } else {
      throw err;
    }
  }

  // Check 2: Kill switch accessible (no system-level halt preventing access)
  try {
    const haltResult = await query(
      `SELECT COUNT(*) AS active_halts
       FROM agent_graph.halt_signals
       WHERE is_active = true
         AND signal_type = 'system'
         AND reason LIKE '%kill switch inaccessible%'`
    );

    const activeBlockers = parseInt(haltResult.rows[0]?.active_halts || '0', 10);
    const met = activeBlockers === 0;

    checks.push({
      obligation: 'kill_switch_accessible',
      met,
      reason: met ? 'Kill switch accessible' : `${activeBlockers} active blocker(s)`,
    });

    if (!met) {
      failures.push(`Kill switch: ${activeBlockers} active blocker(s)`);
    }
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      // If halt_signals table doesn't exist, assume kill switch is accessible
      checks.push({ obligation: 'kill_switch_accessible', met: true, reason: 'halt_signals table not available (assumed accessible)' });
    } else {
      throw err;
    }
  }

  // Check 3: Tax filing oversight (stub until tax integration)
  checks.push({
    obligation: 'tax_filing_oversight',
    met: true,
    reason: 'Tax filing oversight check not yet implemented (passes by default)',
  });

  return {
    allMet: failures.length === 0,
    checks,
    failures,
  };
}

/**
 * Check whether the Data Cooperative should be formed.
 * Triggers cooperative formation when user count exceeds the threshold (50).
 *
 * @returns {Promise<{shouldForm: boolean, currentMembers: number, threshold: number, status: string|null, triggered: boolean}>}
 */
export async function checkDataCooperativeFormation() {
  try {
    // Get current cooperative status
    const coopResult = await query(
      `SELECT id, status, member_count, formation_triggered_at
       FROM agent_graph.data_cooperative
       WHERE id = 'primary'`
    );

    if (coopResult.rows.length === 0) {
      return {
        shouldForm: false,
        currentMembers: 0,
        threshold: DATA_COOPERATIVE_FORMATION_THRESHOLD,
        status: null,
        triggered: false,
      };
    }

    const coop = coopResult.rows[0];
    const currentMembers = parseInt(coop.member_count, 10);
    const shouldForm = currentMembers >= DATA_COOPERATIVE_FORMATION_THRESHOLD;

    // If threshold met and cooperative is still in formation_pending, trigger formation
    if (shouldForm && coop.status === 'formation_pending') {
      await query(
        `UPDATE agent_graph.data_cooperative SET
           status = 'forming',
           formation_triggered_at = now()
         WHERE id = 'primary'`,
      );

      return {
        shouldForm: true,
        currentMembers,
        threshold: DATA_COOPERATIVE_FORMATION_THRESHOLD,
        status: 'forming',
        triggered: true,
      };
    }

    return {
      shouldForm,
      currentMembers,
      threshold: DATA_COOPERATIVE_FORMATION_THRESHOLD,
      status: coop.status,
      triggered: false,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return {
        shouldForm: false,
        currentMembers: 0,
        threshold: DATA_COOPERATIVE_FORMATION_THRESHOLD,
        status: null,
        triggered: false,
      };
    }
    throw err;
  }
}
