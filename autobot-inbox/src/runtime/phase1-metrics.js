import { query } from '../../../lib/db.js';
import { getGitHubToken } from '../github/app-auth.js';
import { fetchWithTimeout } from '../../../lib/runtime/fetch-utils.js';
import { createLogger } from '../../../lib/logger.js';
const log = createLogger('runtime/phase1-metrics');

/**
 * Phase 1 Success Metrics Collector (SPEC §14).
 * Instruments all 13 Phase 1 success metrics.
 * Runs hourly via scheduleService in index.js.
 */

const STARTUP_TIME = Date.now();

async function safeQuery(label, queryFn) {
  try {
    return await queryFn();
  } catch (err) {
    log.warn(`${label} query failed: ${err.message}`);
    return null;
  }
}

/**
 * Collect all Phase 1 metrics and return as a structured object.
 */
export async function collectPhase1Metrics() {
  const metrics = {};

  // 1. E2E latency: directive creation → last child task completion (target: < 120s p95)
  const e2eResult = await safeQuery('e2e_latency', () => query(
    `SELECT
       AVG(e2e_seconds) AS avg_seconds,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e2e_seconds) AS p95_seconds,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e2e_seconds) AS p99_seconds
     FROM (
       SELECT EXTRACT(EPOCH FROM (MAX(st.created_at) - w.created_at)) AS e2e_seconds
       FROM agent_graph.work_items w
       JOIN agent_graph.edges e ON e.from_id = w.id AND e.edge_type = 'decomposes_into'
       JOIN agent_graph.work_items c ON c.id = e.to_id AND c.status = 'completed'
       JOIN agent_graph.state_transitions st ON st.work_item_id = c.id AND st.to_state = 'completed'
       WHERE w.type = 'directive' AND w.created_at >= now() - interval '24 hours'
       GROUP BY w.id, w.created_at
     ) sub`
  ));
  metrics.e2e_latency_seconds = parseFloat(e2eResult?.rows[0]?.avg_seconds) || null;
  metrics.e2e_latency_p95_seconds = parseFloat(e2eResult?.rows[0]?.p95_seconds) || null;
  metrics.e2e_latency_p99_seconds = parseFloat(e2eResult?.rows[0]?.p99_seconds) || null;

  // 2. Cost per directive: aggregate LLM costs for directive subtrees
  const costResult = await safeQuery('cost_per_directive', () => query(
    `SELECT AVG(directive_cost) AS avg_cost
     FROM (
       SELECT w.id, COALESCE(SUM(li.cost_usd), 0) AS directive_cost
       FROM agent_graph.work_items w
       JOIN agent_graph.edges e ON e.from_id = w.id
       JOIN agent_graph.llm_invocations li ON li.task_id = e.to_id
       WHERE w.type = 'directive' AND w.created_at >= now() - interval '24 hours'
       GROUP BY w.id
     ) sub`
  ));
  metrics.cost_per_directive_usd = parseFloat(costResult?.rows[0]?.avg_cost) || null;

  // 3. Dispatch latency: time from task creation to in_progress (avg + p99)
  const dispatchResult = await safeQuery('dispatch_latency', () => query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (st.created_at - w.created_at))) AS avg_seconds,
       PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (st.created_at - w.created_at))) AS p99_seconds
     FROM agent_graph.work_items w
     JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'
     WHERE w.created_at >= now() - interval '24 hours'
       AND st.from_state IN ('created', 'assigned')`
  ));
  metrics.dispatch_latency_seconds = parseFloat(dispatchResult?.rows[0]?.avg_seconds) || null;
  metrics.dispatch_latency_p99_seconds = parseFloat(dispatchResult?.rows[0]?.p99_seconds) || null;

  // 4. Context tokens per task (target: < 8,000 max)
  const tokensResult = await safeQuery('context_tokens', () => query(
    `SELECT AVG(input_tokens) AS avg_input, MAX(input_tokens) AS max_input,
            AVG(output_tokens) AS avg_output, MAX(output_tokens) AS max_output
     FROM agent_graph.llm_invocations
     WHERE created_at >= now() - interval '24 hours'`
  ));
  metrics.avg_input_tokens = parseFloat(tokensResult?.rows[0]?.avg_input) || null;
  metrics.max_input_tokens = parseInt(tokensResult?.rows[0]?.max_input) || null;
  metrics.avg_output_tokens = parseFloat(tokensResult?.rows[0]?.avg_output) || null;
  metrics.max_output_tokens = parseInt(tokensResult?.rows[0]?.max_output) || null;

  // 5. Agent idle time (target: < 30%)
  // Idle % = total gap time between tasks / total wall-clock time per agent
  const idleResult = await safeQuery('agent_idle', () => query(
    `SELECT agent_id,
            SUM(idle_seconds) AS total_idle_seconds,
            EXTRACT(EPOCH FROM (MAX(next_start) - MIN(prev_end))) AS wall_clock_seconds
     FROM (
       SELECT agent_id,
              created_at AS prev_end,
              LEAD(created_at) OVER (PARTITION BY agent_id ORDER BY created_at) AS next_start,
              COALESCE(EXTRACT(EPOCH FROM (
                LEAD(created_at) OVER (PARTITION BY agent_id ORDER BY created_at) - created_at
              )), 0) AS idle_seconds
       FROM agent_graph.state_transitions
       WHERE to_state = 'in_progress' AND created_at >= now() - interval '24 hours'
     ) sub
     WHERE next_start IS NOT NULL
     GROUP BY agent_id`
  ));
  metrics.agent_idle_pct = {};
  if (idleResult) {
    for (const row of idleResult.rows) {
      const wall = parseFloat(row.wall_clock_seconds) || 0;
      const idle = parseFloat(row.total_idle_seconds) || 0;
      metrics.agent_idle_pct[row.agent_id] = wall > 0 ? (idle / wall) : 0;
    }
  }

  // 6. Task success rate
  const successResult = await safeQuery('task_success', () => query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed') AS completed,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COUNT(*) AS total
     FROM agent_graph.work_items
     WHERE status IN ('completed', 'failed')
       AND updated_at >= now() - interval '24 hours'`
  ));
  const sr = successResult?.rows[0];
  const total = parseInt(sr?.total || 0);
  metrics.task_success_rate = total > 0
    ? parseInt(sr.completed) / total
    : null;
  metrics.tasks_completed_24h = parseInt(sr?.completed || 0);
  metrics.tasks_failed_24h = parseInt(sr?.failed || 0);

  // 7. Crash recovery time (target: < 60s to re-queue)
  // Measures how long it takes the reaper to detect a stuck task and transition it.
  // Stuck duration = reaper's timed_out transition timestamp - task's last updated_at before stuck.
  const recoveryResult = await safeQuery('crash_recovery', () => query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (st.created_at - w.updated_at))) AS avg_seconds,
       MAX(EXTRACT(EPOCH FROM (st.created_at - w.updated_at))) AS max_seconds,
       COUNT(*) AS recoveries
     FROM agent_graph.state_transitions st
     JOIN agent_graph.work_items w ON w.id = st.work_item_id
     WHERE st.to_state = 'timed_out' AND st.agent_id = 'reaper'
       AND st.created_at >= now() - interval '24 hours'`
  ));
  metrics.crash_recovery_avg_seconds = parseFloat(recoveryResult?.rows[0]?.avg_seconds) || null;
  metrics.crash_recovery_max_seconds = parseFloat(recoveryResult?.rows[0]?.max_seconds) || null;
  metrics.crash_recoveries_24h = parseInt(recoveryResult?.rows[0]?.recoveries || 0);
  metrics.process_uptime_seconds = Math.round((Date.now() - STARTUP_TIME) / 1000);

  // 8. Sanitization false positive rate
  const sanitizerResult = await safeQuery('sanitizer', () => query(
    `SELECT
       COUNT(*) FILTER (WHERE guardrail_checks_json->>'sanitizer_blocked' = 'true') AS blocked,
       COUNT(*) AS total
     FROM agent_graph.state_transitions
     WHERE created_at >= now() - interval '24 hours'
       AND guardrail_checks_json IS NOT NULL
       AND guardrail_checks_json ? 'sanitizer_blocked'`
  ));
  metrics.sanitizer_block_count = parseInt(sanitizerResult?.rows[0]?.blocked || 0);
  metrics.sanitizer_check_count = parseInt(sanitizerResult?.rows[0]?.total || 0);

  // 9. Tool integrity pass rate
  const toolResult = await safeQuery('tool_integrity', () => query(
    `SELECT
       COUNT(*) FILTER (WHERE guardrail_checks_json->>'tool_integrity' = 'pass') AS passed,
       COUNT(*) AS total
     FROM agent_graph.state_transitions
     WHERE created_at >= now() - interval '24 hours'
       AND guardrail_checks_json IS NOT NULL
       AND guardrail_checks_json ? 'tool_integrity'`
  ));
  const toolTotal = parseInt(toolResult?.rows[0]?.total || 0);
  metrics.tool_integrity_pass_rate = toolTotal > 0
    ? parseInt(toolResult.rows[0].passed) / toolTotal
    : null;

  // 10. Daily LLM spend
  const spendResult = await safeQuery('daily_spend', () => query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
     FROM agent_graph.llm_invocations
     WHERE created_at >= CURRENT_DATE`
  ));
  metrics.daily_llm_spend_usd = parseFloat(spendResult?.rows[0]?.total_cost) || 0;

  // 11. PR-to-merge cycle time (target: < 30 min p95 for agent-managed paths)
  // Fetch actual merge timestamps from GitHub API for accurate measurement.
  const prListResult = await safeQuery('pr_list', () => query(
    `SELECT id, github_pr_url, github_pr_number, target_repo, created_at
     FROM agent_graph.action_proposals
     WHERE action_type = 'code_fix_pr'
       AND github_pr_url IS NOT NULL
       AND github_pr_number IS NOT NULL
       AND created_at >= now() - interval '30 days'`
  ));
  const prCycleTimes = [];
  if (prListResult?.rows?.length > 0) {
    try {
      const token = await getGitHubToken();
      for (const pr of prListResult.rows) {
        try {
          const [owner, repo] = (pr.target_repo || 'staqsIO/optimus-private').split('/');
          const res = await fetchWithTimeout(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.github_pr_number}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
          );
          if (res.ok) {
            const data = await res.json();
            if (data.merged_at) {
              const createdAt = new Date(pr.created_at).getTime();
              const mergedAt = new Date(data.merged_at).getTime();
              prCycleTimes.push((mergedAt - createdAt) / 1000);
            }
          }
        } catch {} // skip individual PR failures
      }
    } catch {} // skip if GitHub auth fails
  }
  if (prCycleTimes.length > 0) {
    const sorted = [...prCycleTimes].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    metrics.pr_cycle_time_p95_seconds = sorted[p95Index];
  } else {
    metrics.pr_cycle_time_p95_seconds = null;
  }
  metrics.pr_count_30d = prListResult?.rows?.length || 0;
  metrics.pr_merged_30d = prCycleTimes.length;

  // 12. Promotion-to-production lag (target: < 24 hours p95)
  // Measured as time from PR creation (action_proposals.created_at) to next pipeline_start deploy event
  const promoResult = await safeQuery('promotion_lag', () => query(
    `SELECT
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY lag_seconds) AS p95_seconds,
       AVG(lag_seconds) AS avg_seconds
     FROM (
       SELECT EXTRACT(EPOCH FROM (de.created_at - ap.created_at)) AS lag_seconds
       FROM agent_graph.action_proposals ap
       JOIN LATERAL (
         SELECT created_at FROM agent_graph.deploy_events
         WHERE event_type = 'pipeline_start' AND created_at > ap.created_at
         ORDER BY created_at ASC LIMIT 1
       ) de ON true
       WHERE ap.action_type = 'code_fix_pr'
         AND ap.github_pr_url IS NOT NULL
         AND ap.created_at >= now() - interval '30 days'
     ) sub`
  ));
  metrics.promotion_lag_p95_seconds = parseFloat(promoResult?.rows[0]?.p95_seconds) || null;

  // 13. Missed escalation rate (target: 0%)
  // A missed escalation = failed task with retry_count >= 3 that has no
  // corresponding escalation state_transition (to_state = 'failed' with
  // guardrail escalation recorded).
  const escalationResult = await safeQuery('missed_escalation', () => query(
    `SELECT
       COUNT(*) FILTER (WHERE w.retry_count >= 3 AND esc.work_item_id IS NULL) AS missed,
       COUNT(*) FILTER (WHERE w.retry_count >= 3) AS should_escalate
     FROM agent_graph.work_items w
     LEFT JOIN agent_graph.state_transitions esc
       ON esc.work_item_id = w.id AND esc.to_state = 'failed'
     WHERE w.status = 'failed'
       AND w.updated_at >= now() - interval '30 days'`
  ));
  const shouldEscalate = parseInt(escalationResult?.rows[0]?.should_escalate || 0);
  metrics.missed_escalation_rate = shouldEscalate > 0
    ? parseInt(escalationResult?.rows[0]?.missed || 0) / shouldEscalate
    : 0; // 0 failures that needed escalation = 0% missed

  metrics.collected_at = new Date().toISOString();

  return metrics;
}

/**
 * Collect and log metrics. Called by scheduleService.
 */
export async function runPhase1MetricsCollection() {
  const metrics = await collectPhase1Metrics();

  log.info('Collection complete:', JSON.stringify({
    e2e_latency: metrics.e2e_latency_seconds ? `${metrics.e2e_latency_seconds.toFixed(1)}s` : 'N/A',
    e2e_p95: metrics.e2e_latency_p95_seconds ? `${metrics.e2e_latency_p95_seconds.toFixed(1)}s` : 'N/A',
    dispatch_latency: metrics.dispatch_latency_seconds ? `${metrics.dispatch_latency_seconds.toFixed(1)}s` : 'N/A',
    dispatch_p99: metrics.dispatch_latency_p99_seconds ? `${metrics.dispatch_latency_p99_seconds.toFixed(1)}s` : 'N/A',
    success_rate: metrics.task_success_rate !== null ? `${(metrics.task_success_rate * 100).toFixed(1)}%` : 'N/A',
    daily_spend: `$${metrics.daily_llm_spend_usd.toFixed(2)}`,
    uptime: `${Math.round(metrics.process_uptime_seconds / 60)}min`,
    completed: metrics.tasks_completed_24h,
    failed: metrics.tasks_failed_24h,
    pr_cycle_p95: metrics.pr_cycle_time_p95_seconds ? `${(metrics.pr_cycle_time_p95_seconds / 60).toFixed(1)}min` : 'N/A',
    prs_30d: metrics.pr_count_30d,
    promo_lag_p95: metrics.promotion_lag_p95_seconds ? `${(metrics.promotion_lag_p95_seconds / 3600).toFixed(1)}h` : 'N/A',
    missed_escalation: metrics.missed_escalation_rate !== null ? `${(metrics.missed_escalation_rate * 100).toFixed(1)}%` : 'N/A',
  }));

  return metrics;
}
