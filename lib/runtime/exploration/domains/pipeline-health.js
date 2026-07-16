/**
 * Exploration Domain: Pipeline Health (ADR-021)
 *
 * Analyzes the agent pipeline for:
 * - High failure rates by agent
 * - Stuck tasks (in_progress > 1 hour)
 * - Excessive retries
 * - State transition anomalies
 *
 * Pure SQL analysis — zero LLM cost.
 */

import { query } from '../../../db.js';

export const domain = 'pipeline_health';

/**
 * Run pipeline health analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object}>>}
 */
export async function analyze() {
  const findings = [];

  // 1. Agent failure rates (last 7 days)
  const failures = await query(
    `SELECT
       w.assigned_to AS agent,
       COUNT(*) FILTER (WHERE w.status = 'failed') AS failed,
       COUNT(*) AS total,
       ROUND(COUNT(*) FILTER (WHERE w.status = 'failed')::numeric / NULLIF(COUNT(*), 0), 3) AS failure_rate
     FROM agent_graph.work_items w
     WHERE w.created_at > now() - interval '7 days'
       AND w.assigned_to IS NOT NULL
     GROUP BY w.assigned_to
     HAVING COUNT(*) >= 5 AND COUNT(*) FILTER (WHERE w.status = 'failed') > 0
     ORDER BY failure_rate DESC`
  );

  for (const row of failures.rows) {
    const rate = parseFloat(row.failure_rate);
    if (rate > 0.2) {
      findings.push({
        title: `High failure rate: ${row.agent} (${(rate * 100).toFixed(1)}%)`,
        severity: rate > 0.5 ? 'high' : 'medium',
        evidence: { agent: row.agent, failed: parseInt(row.failed), total: parseInt(row.total), failure_rate: rate },
      });
    }
  }

  // 2. Stuck tasks (in_progress > 1 hour)
  const stuck = await query(
    `SELECT id, title, assigned_to, updated_at,
            EXTRACT(EPOCH FROM now() - updated_at) / 3600 AS hours_stuck
     FROM agent_graph.work_items
     WHERE status = 'in_progress'
       AND updated_at < now() - interval '1 hour'
     ORDER BY updated_at`
  );

  if (stuck.rows.length > 0) {
    findings.push({
      title: `${stuck.rows.length} stuck task(s) in_progress > 1 hour`,
      severity: stuck.rows.length > 3 ? 'high' : 'medium',
      evidence: {
        count: stuck.rows.length,
        tasks: stuck.rows.slice(0, 5).map(r => ({
          id: r.id,
          title: r.title,
          agent: r.assigned_to,
          hours_stuck: parseFloat(parseFloat(r.hours_stuck).toFixed(1)),
        })),
      },
    });
  }

  // 3. Excessive retries (retry_count > 2)
  const retries = await query(
    `SELECT id, title, assigned_to, retry_count
     FROM agent_graph.work_items
     WHERE retry_count > 2
       AND status NOT IN ('completed', 'cancelled')
       AND created_at > now() - interval '7 days'
     ORDER BY retry_count DESC
     LIMIT 10`
  );

  if (retries.rows.length > 0) {
    findings.push({
      title: `${retries.rows.length} task(s) with excessive retries (>2)`,
      severity: 'medium',
      evidence: {
        count: retries.rows.length,
        tasks: retries.rows.map(r => ({
          id: r.id,
          title: r.title,
          agent: r.assigned_to,
          retry_count: r.retry_count,
        })),
      },
    });
  }

  return findings;
}
