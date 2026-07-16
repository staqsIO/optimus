/**
 * Exploration Domain Selector (ADR-021)
 *
 * Manages the priority queue of exploration domains.
 * Round-robin initially, yield-weighted later.
 *
 * Reads from agent_graph.exploration_queue to determine
 * which domains to run and in what order.
 */

import { query } from '../../db.js';

/**
 * Get the next batch of domains to explore, ordered by priority.
 * Only returns enabled domains that haven't been run too recently.
 *
 * @param {number} maxDomains - Maximum domains to return per cycle
 * @param {number} minIntervalMs - Minimum time between domain runs
 * @returns {Promise<Array<{domain: string, priority: number}>>}
 */
export async function getNextDomains(maxDomains = 3, minIntervalMs = 3600000) {
  const result = await query(
    `SELECT domain, priority, last_run_at, last_yield, total_findings, total_runs
     FROM agent_graph.exploration_queue
     WHERE enabled = true
       AND (last_run_at IS NULL OR last_run_at < now() - ($1 || ' milliseconds')::interval)
     ORDER BY priority DESC, last_run_at ASC NULLS FIRST
     LIMIT $2`,
    [minIntervalMs, maxDomains]
  );
  return result.rows;
}

/**
 * Record domain exploration results.
 * Updates the queue with last run time and yield metrics.
 */
export async function recordDomainRun(domain, findingsCount, cycleId) {
  const totalResult = await query(
    `SELECT total_findings, total_runs FROM agent_graph.exploration_queue WHERE domain = $1`,
    [domain]
  );
  const prev = totalResult.rows[0] || { total_findings: 0, total_runs: 0 };
  const newTotalRuns = parseInt(prev.total_runs) + 1;
  const newTotalFindings = parseInt(prev.total_findings) + findingsCount;
  const yield_ = newTotalRuns > 0 ? newTotalFindings / newTotalRuns : 0;

  await query(
    `UPDATE agent_graph.exploration_queue
     SET last_run_at = now(),
         last_yield = $1,
         total_findings = $2,
         total_runs = $3,
         updated_at = now()
     WHERE domain = $4`,
    [yield_, newTotalFindings, newTotalRuns, domain]
  );
}

/**
 * Check circuit breaker: should exploration be throttled?
 *
 * Yield < 0.1/cycle for 14 days → weekly schedule
 * Yield < 0.05 for 30 days → pause + board notification
 *
 * @returns {{active: boolean, level: string, reason: string|null}}
 */
export async function checkExplorationCircuitBreaker() {
  // Check average yield over last 14 days
  const result14d = await query(
    `SELECT COUNT(*) AS cycles,
            COALESCE(SUM(findings_count), 0) AS total_findings
     FROM agent_graph.exploration_log
     WHERE created_at > now() - interval '14 days'`
  );

  const cycles14d = parseInt(result14d.rows[0]?.cycles || '0');
  const findings14d = parseInt(result14d.rows[0]?.total_findings || '0');
  const yield14d = cycles14d > 0 ? findings14d / cycles14d : 1.0; // default to high if no data

  if (cycles14d >= 5 && yield14d < 0.05) {
    // Check 30-day window for pause threshold
    const result30d = await query(
      `SELECT COUNT(*) AS cycles,
              COALESCE(SUM(findings_count), 0) AS total_findings
       FROM agent_graph.exploration_log
       WHERE created_at > now() - interval '30 days'`
    );
    const cycles30d = parseInt(result30d.rows[0]?.cycles || '0');
    const findings30d = parseInt(result30d.rows[0]?.total_findings || '0');
    const yield30d = cycles30d > 0 ? findings30d / cycles30d : 1.0;

    if (cycles30d >= 10 && yield30d < 0.05) {
      return { active: true, level: 'pause', reason: `Yield ${yield30d.toFixed(3)}/cycle for 30d — pausing exploration` };
    }

    return { active: true, level: 'throttle', reason: `Yield ${yield14d.toFixed(3)}/cycle for 14d — switching to weekly` };
  }

  return { active: false, level: 'normal', reason: null };
}
