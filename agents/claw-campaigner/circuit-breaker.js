/**
 * Campaign Circuit Breaker (ADR-021)
 *
 * Detects plateau conditions and halt signals.
 * Pauses campaigns when progress stalls to prevent budget waste.
 *
 * Two checks:
 * 1. Plateau: last K iterations show quality improvement < threshold
 * 2. Halt: active halt_signals in the system (fail-closed)
 */

import { query } from '../../lib/db.js';

/**
 * Check if a campaign has plateaued.
 *
 * @param {string} campaignId
 * @param {number} window - Number of recent iterations to check (default: campaign.plateau_window)
 * @param {number} threshold - Minimum quality improvement (default: campaign.plateau_threshold)
 * @returns {{plateaued: boolean, reason: string|null, recentScores: number[]}}
 */
export async function checkPlateau(campaignId, window = null, threshold = null) {
  // Get campaign config if window/threshold not provided
  if (window == null || threshold == null) {
    const config = await query(
      `SELECT plateau_window, plateau_threshold FROM agent_graph.campaigns WHERE id = $1`,
      [campaignId]
    );
    if (!config.rows[0]) return { plateaued: false, reason: 'campaign not found', recentScores: [] };
    window = window ?? config.rows[0].plateau_window;
    threshold = threshold ?? parseFloat(config.rows[0].plateau_threshold);
  }

  // Get recent iteration quality scores
  const result = await query(
    `SELECT quality_score, iteration_number
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1
       AND quality_score IS NOT NULL
       AND decision NOT IN ('stop_success', 'stop_budget', 'stop_deadline', 'stop_halt', 'stop_error')
     ORDER BY iteration_number DESC
     LIMIT $2`,
    [campaignId, window]
  );

  const scores = result.rows.map(r => parseFloat(r.quality_score)).reverse();

  // Need at least `window` iterations to detect plateau
  if (scores.length < window) {
    return { plateaued: false, reason: null, recentScores: scores };
  }

  // Check if quality improvement over the window is below threshold
  const oldest = scores[0];
  const newest = scores[scores.length - 1];
  const improvement = newest - oldest;

  if (improvement < threshold) {
    // Count prior pivots: iterations where strategy approach changed from the previous iteration
    const pivotCount = await countPriorPivots(campaignId);

    if (pivotCount < 2) {
      return {
        plateaued: true,
        pivotRequired: true,
        pivotCount: pivotCount + 1,
        reason: `Quality improvement ${improvement.toFixed(4)} < threshold ${threshold} — pivot ${pivotCount + 1}/2`,
        recentScores: scores,
      };
    }

    return {
      plateaued: true,
      reason: `Quality improvement ${improvement.toFixed(4)} < threshold ${threshold} over last ${window} iterations (${pivotCount} pivots exhausted)`,
      recentScores: scores,
    };
  }

  return { plateaued: false, reason: null, recentScores: scores };
}

/**
 * Count how many strategy pivots have occurred for a campaign.
 * A pivot is detected when the strategy approach name differs from the previous iteration,
 * or when a strategy_adjustment is recorded.
 */
async function countPriorPivots(campaignId) {
  const result = await query(
    `SELECT strategy_used, strategy_adjustment
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1
     ORDER BY iteration_number ASC`,
    [campaignId]
  );

  let pivots = 0;
  let prevApproach = null;

  for (const row of result.rows) {
    const strategyObj = typeof row.strategy_used === 'string'
      ? JSON.parse(row.strategy_used) : row.strategy_used;
    const approach = strategyObj?.approach || null;

    if (prevApproach !== null && approach !== prevApproach) {
      pivots++;
    }
    if (row.strategy_adjustment) {
      pivots++;
    }

    prevApproach = approach;
  }

  return pivots;
}

/**
 * Check for active halt signals (fail-closed).
 * @returns {boolean} true if halt is active
 */
export async function checkHalt() {
  const result = await query(
    `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`
  );
  return result.rows.length > 0;
}

/**
 * Check if campaign deadline has passed.
 * @param {string} campaignId
 * @returns {boolean}
 */
export async function checkDeadline(campaignId) {
  const result = await query(
    `SELECT 1 FROM agent_graph.campaigns
     WHERE id = $1 AND deadline IS NOT NULL AND deadline < now()`,
    [campaignId]
  );
  return result.rows.length > 0;
}

/**
 * Check if max iterations reached.
 * @param {string} campaignId
 * @returns {boolean}
 */
export async function checkMaxIterations(campaignId) {
  const result = await query(
    `SELECT 1 FROM agent_graph.campaigns
     WHERE id = $1 AND completed_iterations >= max_iterations`,
    [campaignId]
  );
  return result.rows.length > 0;
}

/**
 * Run all pre-iteration checks. Returns the first failure reason or null.
 * @param {string} campaignId
 * @returns {{canContinue: boolean, stopReason: string|null}}
 */
export async function preIterationChecks(campaignId) {
  // 1. Halt (most critical — fail-closed)
  if (await checkHalt()) {
    return { canContinue: false, stopReason: 'stop_halt' };
  }

  // 2. Deadline
  if (await checkDeadline(campaignId)) {
    return { canContinue: false, stopReason: 'stop_deadline' };
  }

  // 3. Max iterations
  if (await checkMaxIterations(campaignId)) {
    return { canContinue: false, stopReason: 'stop_max_iterations' };
  }

  // 4. Plateau (with pivot support)
  const plateau = await checkPlateau(campaignId);
  if (plateau.plateaued) {
    if (plateau.pivotRequired) {
      // Allow continuation but signal pivot needed
      return { canContinue: true, stopReason: null, pivotRequired: true, pivotCount: plateau.pivotCount };
    }
    return { canContinue: false, stopReason: 'stop_plateau' };
  }

  return { canContinue: true, stopReason: null };
}
