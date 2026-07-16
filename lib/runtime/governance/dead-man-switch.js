import { query } from '../../db.js';

/**
 * Dead-Man's Switch -- 30-day board renewal (spec §8, Article 3.6).
 *
 * One of the Creator's non-delegable obligations.
 * Board must renew the switch every 30 days to confirm ongoing oversight.
 *
 * Escalation:
 *   - Missed > 3 consecutive checks (checked hourly = 72h): HALT + standby
 *   - Missed > 30 days since last renewal: graceful shutdown
 *
 * Uses the halt_signals table to trigger HALT (same mechanism as kill switch).
 * P2: Infrastructure enforces; prompts advise.
 * P4: Boring infrastructure.
 */

const STANDBY_THRESHOLD_MISSED = 3;
const SHUTDOWN_DAYS = 30;
const CHECK_INTERVAL_HOURS = 24;

/**
 * Check if the dead-man's switch renewal is overdue.
 * Called periodically (daily by the agent loop or cron).
 *
 * If missed > 3 consecutive checks: triggers HALT + moves to standby.
 * If missed > 30 days since last renewal: triggers graceful shutdown.
 *
 * @returns {Promise<{status: string, action: string|null, daysSinceRenewal: number, consecutiveMissed: number}>}
 */
export async function checkDeadManSwitch() {
  try {
    const result = await query(
      `SELECT id, last_renewal, renewal_interval_days, status, last_checked_at, consecutive_missed
       FROM agent_graph.dead_man_switch
       WHERE id = 'primary'`
    );

    if (result.rows.length === 0) {
      return { status: 'not_configured', action: null, daysSinceRenewal: 0, consecutiveMissed: 0 };
    }

    const row = result.rows[0];

    // If already shut down, do not re-process
    if (row.status === 'shutdown') {
      return { status: 'shutdown', action: null, daysSinceRenewal: 0, consecutiveMissed: parseInt(row.consecutive_missed) };
    }

    const now = new Date();
    const lastRenewal = new Date(row.last_renewal);
    const daysSinceRenewal = (now - lastRenewal) / (1000 * 60 * 60 * 24);
    const renewalIntervalDays = parseInt(row.renewal_interval_days) || SHUTDOWN_DAYS;

    // If in standby, still check for 30-day shutdown escalation
    if (row.status === 'standby') {
      if (daysSinceRenewal > SHUTDOWN_DAYS) {
        await triggerShutdown(daysSinceRenewal);
        return { status: 'standby', action: 'shutdown', daysSinceRenewal: Math.round(daysSinceRenewal * 100) / 100, consecutiveMissed: parseInt(row.consecutive_missed) || 0 };
      }
      return { status: 'standby', action: null, daysSinceRenewal: Math.round(daysSinceRenewal * 100) / 100, consecutiveMissed: parseInt(row.consecutive_missed) || 0 };
    }

    // Determine if this check counts as a "missed" renewal
    const isOverdue = daysSinceRenewal > renewalIntervalDays;
    let consecutiveMissed = parseInt(row.consecutive_missed) || 0;

    if (isOverdue) {
      consecutiveMissed += 1;
    } else {
      consecutiveMissed = 0;
    }

    // Update the check record
    await query(
      `UPDATE agent_graph.dead_man_switch
       SET last_checked_at = now(), consecutive_missed = $1
       WHERE id = 'primary'`,
      [consecutiveMissed]
    );

    let action = null;

    // Shutdown: missed > 30 days since last renewal
    if (daysSinceRenewal > SHUTDOWN_DAYS) {
      action = 'shutdown';
      await triggerShutdown(daysSinceRenewal);
    }
    // Standby: missed > 3 consecutive checks
    else if (consecutiveMissed > STANDBY_THRESHOLD_MISSED) {
      action = 'halt_standby';
      await triggerHaltAndStandby(consecutiveMissed, daysSinceRenewal);
    }

    return {
      status: isOverdue ? 'overdue' : 'active',
      action,
      daysSinceRenewal: Math.round(daysSinceRenewal * 100) / 100,
      consecutiveMissed,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { status: 'not_configured', action: null, daysSinceRenewal: 0, consecutiveMissed: 0 };
    }
    throw err;
  }
}

/**
 * Renew the dead-man's switch. Called by a board member.
 * Resets the renewal timer and clears any overdue state.
 *
 * @param {string} renewedBy - Board member identifier.
 * @returns {Promise<{renewed: boolean, previousStatus: string, daysSinceLastRenewal: number}>}
 */
export async function renewDeadManSwitch(renewedBy) {
  if (!renewedBy) {
    return { renewed: false, previousStatus: 'unknown', daysSinceLastRenewal: 0, reason: 'renewedBy is required' };
  }

  try {
    const current = await query(
      `SELECT status, last_renewal FROM agent_graph.dead_man_switch WHERE id = 'primary'`
    );

    if (current.rows.length === 0) {
      return { renewed: false, previousStatus: 'not_configured', daysSinceLastRenewal: 0 };
    }

    const previousStatus = current.rows[0].status;
    const lastRenewal = new Date(current.rows[0].last_renewal);
    const daysSinceLastRenewal = (new Date() - lastRenewal) / (1000 * 60 * 60 * 24);

    // Renew: reset timer, clear missed counter, set status to active
    await query(
      `UPDATE agent_graph.dead_man_switch
       SET last_renewal = now(), consecutive_missed = 0, status = 'active', last_checked_at = now()
       WHERE id = 'primary'`
    );

    // If we were in halt/standby due to dead-man switch, resolve the halt signal
    if (previousStatus === 'standby' || previousStatus === 'shutdown') {
      await query(
        `UPDATE agent_graph.halt_signals
         SET is_active = false, resolved_at = now(), resolved_by = $1
         WHERE signal_type = 'system'
           AND reason ILIKE '%dead-man switch%'
           AND is_active = true`,
        [renewedBy]
      );
    }

    return {
      renewed: true,
      previousStatus,
      daysSinceLastRenewal: Math.round(daysSinceLastRenewal * 100) / 100,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { renewed: false, previousStatus: 'not_configured', daysSinceLastRenewal: 0 };
    }
    throw err;
  }
}

/**
 * Get the current dead-man's switch status.
 *
 * @returns {Promise<{status: string, lastRenewal: string|null, renewalIntervalDays: number, consecutiveMissed: number, daysSinceRenewal: number}>}
 */
export async function getDeadManSwitchStatus() {
  try {
    const result = await query(
      `SELECT id, last_renewal, renewal_interval_days, status, last_checked_at, consecutive_missed
       FROM agent_graph.dead_man_switch
       WHERE id = 'primary'`
    );

    if (result.rows.length === 0) {
      return { status: 'not_configured', lastRenewal: null, renewalIntervalDays: SHUTDOWN_DAYS, consecutiveMissed: 0, daysSinceRenewal: 0 };
    }

    const row = result.rows[0];
    const lastRenewal = new Date(row.last_renewal);
    const daysSinceRenewal = (new Date() - lastRenewal) / (1000 * 60 * 60 * 24);

    return {
      status: row.status,
      lastRenewal: row.last_renewal,
      renewalIntervalDays: parseInt(row.renewal_interval_days) || SHUTDOWN_DAYS,
      consecutiveMissed: parseInt(row.consecutive_missed) || 0,
      daysSinceRenewal: Math.round(daysSinceRenewal * 100) / 100,
      lastCheckedAt: row.last_checked_at,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { status: 'not_configured', lastRenewal: null, renewalIntervalDays: SHUTDOWN_DAYS, consecutiveMissed: 0, daysSinceRenewal: 0 };
    }
    throw err;
  }
}

/**
 * Trigger HALT + move switch to standby.
 * Inserts a halt signal so the agent loop stops processing.
 */
async function triggerHaltAndStandby(consecutiveMissed, daysSinceRenewal) {
  try {
    // Insert halt signal
    await query(
      `INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
       VALUES ('system', $1, 'dead_man_switch')`,
      [`Dead-man switch: ${consecutiveMissed} consecutive missed checks, ${Math.round(daysSinceRenewal)} days since renewal`]
    );

    // Move switch to standby
    await query(
      `UPDATE agent_graph.dead_man_switch SET status = 'standby' WHERE id = 'primary'`
    );
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }
}

/**
 * Trigger graceful shutdown after 30+ days without renewal.
 * Inserts a halt signal and moves switch to shutdown state.
 */
async function triggerShutdown(daysSinceRenewal) {
  try {
    // Insert halt signal
    await query(
      `INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
       VALUES ('system', $1, 'dead_man_switch')`,
      [`Dead-man switch SHUTDOWN: ${Math.round(daysSinceRenewal)} days since last renewal. Graceful shutdown initiated.`]
    );

    // Move switch to shutdown
    await query(
      `UPDATE agent_graph.dead_man_switch SET status = 'shutdown' WHERE id = 'primary'`
    );
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }
}
