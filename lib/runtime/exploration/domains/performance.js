/**
 * Exploration Domain: Performance (ADR-021)
 *
 * Analyzes system performance:
 * - Slow query patterns (pg_stat_statements if available)
 * - Work item processing latency trends
 * - Budget burn rate anomalies
 * - Queue depth and throughput
 *
 * Pure DB analysis — zero LLM cost.
 */

import { query } from '../../../db.js';

export const domain = 'performance';

/**
 * Run performance analysis.
 * @returns {Promise<Array<{title: string, severity: string, evidence: Object}>>}
 */
export async function analyze() {
  const findings = [];

  // 1. Work item processing latency (last 7 days)
  try {
    const latency = await query(
      `SELECT
         assigned_to,
         COUNT(*) AS total,
         ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::numeric, 1) AS avg_seconds,
         ROUND(MAX(EXTRACT(EPOCH FROM (updated_at - created_at)))::numeric, 1) AS max_seconds
       FROM agent_graph.work_items
       WHERE status = 'completed'
         AND created_at > now() - interval '7 days'
       GROUP BY assigned_to
       HAVING AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) > 300
       ORDER BY avg_seconds DESC`
    );

    if (latency.rows.length > 0) {
      findings.push({
        title: `${latency.rows.length} agent(s) with avg processing time > 5 minutes`,
        severity: latency.rows.some(r => parseFloat(r.avg_seconds) > 600) ? 'medium' : 'low',
        evidence: {
          agents: latency.rows.map(r => ({
            agent: r.assigned_to,
            total_items: parseInt(r.total),
            avg_seconds: parseFloat(r.avg_seconds),
            max_seconds: parseFloat(r.max_seconds),
          })),
        },
      });
    }
  } catch { /* skip if table doesn't exist */ }

  // 2. Queue depth — work items waiting assignment
  try {
    const queue = await query(
      `SELECT
         type,
         COUNT(*) AS count,
         MIN(created_at) AS oldest
       FROM agent_graph.work_items
       WHERE status = 'created'
         AND created_at < now() - interval '1 hour'
       GROUP BY type
       ORDER BY count DESC`
    );

    if (queue.rows.length > 0) {
      const totalQueued = queue.rows.reduce((s, r) => s + parseInt(r.count), 0);
      findings.push({
        title: `${totalQueued} work item(s) unassigned for > 1 hour`,
        severity: totalQueued > 10 ? 'high' : 'medium',
        pattern: 'stuck_task',
        evidence: {
          total: totalQueued,
          by_type: queue.rows.map(r => ({
            type: r.type,
            count: parseInt(r.count),
            oldest: r.oldest,
          })),
        },
      });
    }
  } catch { /* skip */ }

  // 3. Budget burn rate — check if daily spend is accelerating
  try {
    const burnRate = await query(
      `SELECT
         DATE(created_at) AS day,
         SUM(cost_usd) AS daily_spend
       FROM agent_graph.state_transitions
       WHERE cost_usd > 0
         AND created_at > now() - interval '14 days'
       GROUP BY DATE(created_at)
       ORDER BY day`
    );

    if (burnRate.rows.length >= 7) {
      const spends = burnRate.rows.map(r => parseFloat(r.daily_spend));
      const recentAvg = spends.slice(-3).reduce((s, v) => s + v, 0) / 3;
      const olderAvg = spends.slice(0, -3).reduce((s, v) => s + v, 0) / Math.max(spends.length - 3, 1);

      if (olderAvg > 0 && recentAvg > olderAvg * 1.5) {
        findings.push({
          title: `Budget burn rate increased ${((recentAvg / olderAvg - 1) * 100).toFixed(0)}% over last 3 days`,
          severity: recentAvg > olderAvg * 2 ? 'high' : 'medium',
          evidence: {
            recent_avg: parseFloat(recentAvg.toFixed(2)),
            older_avg: parseFloat(olderAvg.toFixed(2)),
            daily_spends: burnRate.rows.slice(-7).map(r => ({
              day: r.day,
              spend: parseFloat(parseFloat(r.daily_spend).toFixed(2)),
            })),
          },
        });
      }
    }
  } catch { /* skip */ }

  // 4. Throughput — items completed per day trending down
  try {
    const throughput = await query(
      `SELECT
         DATE(updated_at) AS day,
         COUNT(*) AS completed
       FROM agent_graph.work_items
       WHERE status = 'completed'
         AND updated_at > now() - interval '14 days'
       GROUP BY DATE(updated_at)
       ORDER BY day`
    );

    if (throughput.rows.length >= 7) {
      const counts = throughput.rows.map(r => parseInt(r.completed));
      const recentAvg = counts.slice(-3).reduce((s, v) => s + v, 0) / 3;
      const olderAvg = counts.slice(0, -3).reduce((s, v) => s + v, 0) / Math.max(counts.length - 3, 1);

      if (olderAvg > 0 && recentAvg < olderAvg * 0.5) {
        findings.push({
          title: `Throughput dropped ${((1 - recentAvg / olderAvg) * 100).toFixed(0)}% over last 3 days`,
          severity: 'medium',
          evidence: {
            recent_avg: parseFloat(recentAvg.toFixed(1)),
            older_avg: parseFloat(olderAvg.toFixed(1)),
          },
        });
      }
    }
  } catch { /* skip */ }

  return findings;
}
