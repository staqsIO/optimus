import { query } from '../../db.js';

/**
 * Exploration Monitor -- Social physics circuit breaker (spec S14).
 *
 * Monitors whether the Strategist is exploring cross-domain workstreams
 * or getting stuck in exploitation-only mode.
 *
 * Circuit breaker rule:
 *   If exploration ratio drops below 5% for 30 consecutive days,
 *   Strategist MUST assign 20% of new directives to cross-domain workstreams.
 *
 * A directive is "cross-domain" if its workstream spans multiple topic areas
 * (determined by the signal.topics domain classification).
 *
 * P4: Boring infrastructure. Deterministic measurement.
 */

const DEFAULT_THRESHOLD = 0.05;
const DEFAULT_CIRCUIT_BREAKER_DAYS = 30;
const DEFAULT_FORCED_RATIO = 0.20;

/**
 * Measure the exploration ratio for a given date.
 * Counts directives with cross-domain workstreams vs total directives.
 *
 * A directive is "cross-domain" if it has metadata.domains with 2+ entries,
 * or if it is tagged as cross_domain in metadata.
 *
 * @param {Date} [date] - Date to measure (defaults to today).
 * @returns {Promise<{date: string, totalDirectives: number, crossDomainDirectives: number, explorationRatio: number}>}
 */
export async function measureExplorationRatio(date) {
  const measureDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  try {
    // Count total directives created on this date
    const totalResult = await query(
      `SELECT COUNT(*) as total
       FROM agent_graph.work_items
       WHERE type = 'directive'
         AND created_at::date = $1::date`,
      [measureDate]
    );

    // Count cross-domain directives
    // A directive is cross-domain if:
    //   - metadata->'domains' is a JSON array with 2+ elements, OR
    //   - metadata->>'cross_domain' = 'true'
    const crossDomainResult = await query(
      `SELECT COUNT(*) as cross_domain
       FROM agent_graph.work_items
       WHERE type = 'directive'
         AND created_at::date = $1::date
         AND (
           jsonb_array_length(COALESCE(metadata->'domains', '[]'::jsonb)) >= 2
           OR metadata->>'cross_domain' = 'true'
         )`,
      [measureDate]
    );

    const totalDirectives = parseInt(totalResult.rows[0]?.total || '0');
    const crossDomainDirectives = parseInt(crossDomainResult.rows[0]?.cross_domain || '0');
    const explorationRatio = totalDirectives > 0
      ? crossDomainDirectives / totalDirectives
      : 0;

    // Persist the measurement
    await query(
      `INSERT INTO agent_graph.exploration_metrics
       (measurement_date, total_directives, cross_domain_directives, exploration_ratio)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [measureDate, totalDirectives, crossDomainDirectives, Math.round(explorationRatio * 10000) / 10000]
    );

    return {
      date: measureDate,
      totalDirectives,
      crossDomainDirectives,
      explorationRatio: Math.round(explorationRatio * 10000) / 10000,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { date: measureDate, totalDirectives: 0, crossDomainDirectives: 0, explorationRatio: 0 };
    }
    throw err;
  }
}

/**
 * Check the circuit breaker: if exploration has been below threshold
 * for the configured number of consecutive days, activate it.
 *
 * When active, the Strategist must assign at least 20% of new directives
 * to cross-domain workstreams.
 *
 * @returns {Promise<{active: boolean, belowThresholdDays: number, threshold: number, forcedRatio: number, reason: string|null}>}
 */
export async function checkCircuitBreaker() {
  try {
    // Get phase config for thresholds
    const phaseConfig = await getPhase3Config();
    const threshold = phaseConfig?.exploration_threshold ?? DEFAULT_THRESHOLD;
    const circuitBreakerDays = phaseConfig?.exploration_circuit_breaker_days ?? DEFAULT_CIRCUIT_BREAKER_DAYS;
    const forcedRatio = phaseConfig?.exploration_forced_ratio ?? DEFAULT_FORCED_RATIO;

    // Count consecutive days below threshold (looking back from today)
    const result = await query(
      `SELECT COUNT(*) as below_days
       FROM (
         SELECT measurement_date, exploration_ratio
         FROM agent_graph.exploration_metrics
         WHERE measurement_date >= (CURRENT_DATE - $1::int)
           AND measurement_date <= CURRENT_DATE
         ORDER BY measurement_date DESC
       ) sub
       WHERE exploration_ratio < $2`,
      [circuitBreakerDays, threshold]
    );

    const belowThresholdDays = parseInt(result.rows[0]?.below_days || '0');

    // Check if ALL recent days are below threshold (consecutive)
    const totalDaysResult = await query(
      `SELECT COUNT(*) as total_days
       FROM agent_graph.exploration_metrics
       WHERE measurement_date >= (CURRENT_DATE - $1::int)
         AND measurement_date <= CURRENT_DATE`,
      [circuitBreakerDays]
    );
    const totalDays = parseInt(totalDaysResult.rows[0]?.total_days || '0');

    // Circuit breaker activates when we have enough data AND all days are below threshold
    const active = totalDays >= circuitBreakerDays && belowThresholdDays >= circuitBreakerDays;

    // Update the most recent metric record with circuit breaker status
    if (totalDays > 0) {
      await query(
        `UPDATE agent_graph.exploration_metrics
         SET below_threshold_days = $1, circuit_breaker_active = $2
         WHERE measurement_date = (
           SELECT MAX(measurement_date) FROM agent_graph.exploration_metrics
         )`,
        [belowThresholdDays, active]
      );
    }

    return {
      active,
      belowThresholdDays,
      threshold,
      forcedRatio: active ? forcedRatio : 0,
      reason: active
        ? `Exploration ratio below ${threshold * 100}% for ${belowThresholdDays} consecutive days. Strategist must assign ${forcedRatio * 100}% cross-domain directives.`
        : null,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { active: false, belowThresholdDays: 0, threshold: DEFAULT_THRESHOLD, forcedRatio: 0, reason: null };
    }
    throw err;
  }
}

/**
 * Get a dashboard-ready exploration report.
 *
 * @param {number} [lookbackDays=90] - Number of days to include.
 * @returns {Promise<{circuitBreaker: Object, recentMetrics: Array, trend: Object}>}
 */
export async function getExplorationReport(lookbackDays = 90) {
  const circuitBreaker = await checkCircuitBreaker();

  try {
    // Get recent metrics
    const metricsResult = await query(
      `SELECT measurement_date, total_directives, cross_domain_directives,
              exploration_ratio, below_threshold_days, circuit_breaker_active
       FROM agent_graph.exploration_metrics
       WHERE measurement_date >= (CURRENT_DATE - $1::int)
       ORDER BY measurement_date DESC`,
      [lookbackDays]
    );

    // Compute trend (7-day vs 30-day average)
    const metrics = metricsResult.rows;
    const last7 = metrics.filter(m => {
      const d = new Date(m.measurement_date);
      return (new Date() - d) / (1000 * 60 * 60 * 24) <= 7;
    });
    const last30 = metrics.filter(m => {
      const d = new Date(m.measurement_date);
      return (new Date() - d) / (1000 * 60 * 60 * 24) <= 30;
    });

    const avg7 = last7.length > 0
      ? last7.reduce((sum, m) => sum + parseFloat(m.exploration_ratio || 0), 0) / last7.length
      : 0;
    const avg30 = last30.length > 0
      ? last30.reduce((sum, m) => sum + parseFloat(m.exploration_ratio || 0), 0) / last30.length
      : 0;

    return {
      circuitBreaker,
      recentMetrics: metrics.map(m => ({
        date: m.measurement_date,
        totalDirectives: parseInt(m.total_directives),
        crossDomainDirectives: parseInt(m.cross_domain_directives),
        explorationRatio: parseFloat(m.exploration_ratio),
        circuitBreakerActive: m.circuit_breaker_active,
      })),
      trend: {
        avg7Day: Math.round(avg7 * 10000) / 10000,
        avg30Day: Math.round(avg30 * 10000) / 10000,
        direction: avg7 > avg30 ? 'improving' : avg7 < avg30 ? 'declining' : 'stable',
      },
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { circuitBreaker, recentMetrics: [], trend: { avg7Day: 0, avg30Day: 0, direction: 'stable' } };
    }
    throw err;
  }
}

/**
 * Get Phase 3 config for threshold values.
 */
async function getPhase3Config() {
  try {
    const result = await query(
      `SELECT config FROM agent_graph.phase_config WHERE phase = 3`
    );
    return result.rows[0]?.config || null;
  } catch {
    return null;
  }
}
