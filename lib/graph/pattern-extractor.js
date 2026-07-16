// graph/pattern-extractor.js — Daily pattern extraction pipeline (ADR-019)
// Mines Postgres work_items for operational patterns. Stores in Postgres only (P4).
// No Neo4j projection — visualization uses real-time sync data (Liotta review).
// All descriptions are reconstructed from numeric/enum fields only (Linus: prompt injection safety).
import { query } from '../db.js';
import { subscribe } from '../runtime/pg-listener.js';
import { createLogger } from '../logger.js';
const log = createLogger('graph/pattern-extractor');

// PII scrub: strip email addresses as safety net before any description insert
const SCRUB_EMAIL_RE = /\S+@\S+\.\S+/g;
function scrubPII(text) {
  return (text || '').replace(SCRUB_EMAIL_RE, '[redacted]').slice(0, 500);
}

/**
 * Run all 8 pattern extractors for the given period.
 * Called on a 24h schedule aligned with architect-daily (Liotta recommendation).
 */
export async function extractPatterns() {
  const start = performance.now();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60_000);
  // 90-day lookback for statistical significance (Linus requirement)
  const lookbackStart = new Date(periodEnd.getTime() - 90 * 24 * 60 * 60_000);

  const results = {
    success_rate: 0,
    delegation_path: 0,
    cost_efficiency: 0,
    duration_trend: 0,
    failure_mode: 0,
    time_of_day: 0,
    thread_depth: 0,
    sender_type: 0,
  };

  try {
    results.success_rate = await extractSuccessRates(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractSuccessRates error:', err.message);
  }

  try {
    results.delegation_path = await extractDelegationPaths(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractDelegationPaths error:', err.message);
  }

  try {
    results.cost_efficiency = await extractCostPatterns(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractCostPatterns error:', err.message);
  }

  try {
    results.duration_trend = await extractDurationTrends(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractDurationTrends error:', err.message);
  }

  try {
    results.failure_mode = await extractFailureModes(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractFailureModes error:', err.message);
  }

  try {
    results.time_of_day = await extractTimeOfDay(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractTimeOfDay error:', err.message);
  }

  try {
    results.thread_depth = await extractThreadDepth(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractThreadDepth error:', err.message);
  }

  try {
    results.sender_type = await extractSenderType(periodStart, periodEnd, lookbackStart);
  } catch (err) {
    log.error('extractSenderType error:', err.message);
  }

  // After all extractors, check for board-relevant insights
  try {
    await checkForInsights();
  } catch (err) {
    log.error('checkForInsights error:', err.message);
  }

  const durationMs = Math.round(performance.now() - start);
  const totalRows = Object.values(results).reduce((a, b) => a + b, 0);
  log.info(`Extraction complete in ${durationMs}ms: ${totalRows} rows (${JSON.stringify(results)})`);
}

/**
 * 1. Success rates per agent over the lookback window.
 */
async function extractSuccessRates(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `SELECT
       assigned_to AS agent_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'completed') AS completed,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed
     FROM agent_graph.work_items
     WHERE created_at >= $1 AND created_at < $2
       AND status IN ('completed', 'failed')
     GROUP BY assigned_to
     HAVING COUNT(*) >= 1`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const total = parseInt(row.total, 10);
    const completed = parseInt(row.completed, 10);
    const rate = total > 0 ? completed / total : 0;
    const description = scrubPII(`${row.agent_id}: ${(rate * 100).toFixed(1)}% success rate (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'success_rate', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, rate,
        Math.min(1, total / 50), // confidence scales with sample size, max at 50
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ completed, failed: parseInt(row.failed, 10) }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 2. Delegation path effectiveness — parent->child success rates.
 */
async function extractDelegationPaths(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `SELECT
       parent.assigned_to AS assigner,
       child.assigned_to AS executor,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE child.status = 'completed') AS completed
     FROM agent_graph.work_items child
     JOIN agent_graph.work_items parent ON child.parent_id = parent.id
     WHERE child.created_at >= $1 AND child.created_at < $2
       AND child.status IN ('completed', 'failed')
     GROUP BY parent.assigned_to, child.assigned_to
     HAVING COUNT(*) >= 1`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const total = parseInt(row.total, 10);
    const completed = parseInt(row.completed, 10);
    const rate = total > 0 ? completed / total : 0;
    const agentId = `${row.assigner}\u2192${row.executor}`;
    const description = scrubPII(`${agentId}: ${(rate * 100).toFixed(1)}% delegation success (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'delegation_path', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        agentId, description, rate,
        Math.min(1, total / 20),
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ assigner: row.assigner, executor: row.executor, completed }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 3. Cost efficiency — LLM cost per completed task by agent.
 */
async function extractCostPatterns(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `SELECT
       li.agent_id,
       COUNT(DISTINCT wi.id) AS tasks_completed,
       SUM(li.cost_usd) AS total_cost,
       CASE WHEN COUNT(DISTINCT wi.id) > 0
            THEN SUM(li.cost_usd) / COUNT(DISTINCT wi.id)
            ELSE 0 END AS cost_per_task
     FROM agent_graph.llm_invocations li
     JOIN agent_graph.work_items wi ON li.work_item_id = wi.id AND wi.status = 'completed'
     WHERE li.created_at >= $1 AND li.created_at < $2
     GROUP BY li.agent_id
     HAVING COUNT(DISTINCT wi.id) >= 1`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const costPerTask = parseFloat(row.cost_per_task) || 0;
    const tasksCompleted = parseInt(row.tasks_completed, 10);
    const description = scrubPII(`${row.agent_id}: $${costPerTask.toFixed(4)}/task (n=${tasksCompleted})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'cost_efficiency', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, costPerTask,
        Math.min(1, tasksCompleted / 30),
        tasksCompleted, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ total_cost: parseFloat(row.total_cost) || 0, tasks_completed: tasksCompleted }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 4. Duration trends — median duration by agent, compared to prior window.
 */
async function extractDurationTrends(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `WITH durations AS (
       SELECT
         assigned_to AS agent_id,
         EXTRACT(EPOCH FROM (
           COALESCE(
             (SELECT st.transitioned_at FROM agent_graph.state_transitions st
              WHERE st.work_item_id = wi.id AND st.to_state = 'completed'
              ORDER BY st.transitioned_at DESC LIMIT 1),
             wi.updated_at
           ) - wi.created_at
         )) * 1000 AS duration_ms
       FROM agent_graph.work_items wi
       WHERE wi.created_at >= $1 AND wi.created_at < $2
         AND wi.status = 'completed'
     )
     SELECT
       agent_id,
       COUNT(*) AS total,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_ms,
       AVG(duration_ms) AS avg_ms
     FROM durations
     WHERE duration_ms > 0
     GROUP BY agent_id
     HAVING COUNT(*) >= 1`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const medianMs = parseFloat(row.median_ms) || 0;
    const total = parseInt(row.total, 10);
    const medianSec = (medianMs / 1000).toFixed(1);
    const description = scrubPII(`${row.agent_id}: median ${medianSec}s per task (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'duration_trend', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, medianMs,
        Math.min(1, total / 30),
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ avg_ms: parseFloat(row.avg_ms) || 0 }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 5. Failure modes — classified error types (NOT raw reason text).
 * PII scrub: errors are classified into fixed categories, descriptions are template-based.
 * Raw state_transitions.reason is NEVER stored (Linus blocker).
 */
async function extractFailureModes(periodStart, periodEnd, lookbackStart) {
  // Classify failure reasons into safe enum categories
  const r = await query(
    `SELECT
       wi.assigned_to AS agent_id,
       CASE
         WHEN st.reason ILIKE '%timeout%' THEN 'timeout'
         WHEN st.reason ILIKE '%rate_limit%' OR st.reason ILIKE '%rate limit%' THEN 'llm_error'
         WHEN st.reason ILIKE '%api%error%' OR st.reason ILIKE '%anthropic%' THEN 'llm_error'
         WHEN st.reason ILIKE '%routing%' OR st.reason ILIKE '%no agent%' THEN 'routing_error'
         WHEN st.reason ILIKE '%handler%' OR st.reason ILIKE '%TypeError%' OR st.reason ILIKE '%ReferenceError%' THEN 'handler_error'
         WHEN st.reason ILIKE '%guard%' OR st.reason ILIKE '%gate%' OR st.reason ILIKE '%budget%' THEN 'guard_failure'
         ELSE 'unknown'
       END AS error_category,
       COUNT(*) AS failure_count
     FROM agent_graph.work_items wi
     JOIN agent_graph.state_transitions st ON st.work_item_id = wi.id AND st.to_state = 'failed'
     WHERE wi.created_at >= $1 AND wi.created_at < $2
       AND wi.status = 'failed'
     GROUP BY wi.assigned_to, error_category
     HAVING COUNT(*) >= 1`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const count = parseInt(row.failure_count, 10);
    // Description reconstructed from enum + metrics only (Linus: no free-text)
    const description = scrubPII(`${row.agent_id}: ${count} ${row.error_category} failure(s)`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'failure_mode', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, count,
        Math.min(1, count / 10),
        count, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ error_category: row.error_category }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 6. Time-of-day patterns — success rate by hour bucket.
 */
async function extractTimeOfDay(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `SELECT
       assigned_to AS agent_id,
       EXTRACT(HOUR FROM created_at) AS hour_bucket,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'completed') AS completed
     FROM agent_graph.work_items
     WHERE created_at >= $1 AND created_at < $2
       AND status IN ('completed', 'failed')
     GROUP BY assigned_to, hour_bucket
     HAVING COUNT(*) >= 3`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const total = parseInt(row.total, 10);
    const completed = parseInt(row.completed, 10);
    const rate = total > 0 ? completed / total : 0;
    const hour = parseInt(row.hour_bucket, 10);
    const description = scrubPII(`${row.agent_id}: ${(rate * 100).toFixed(1)}% success at hour ${hour} (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'time_of_day', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, rate,
        Math.min(1, total / 30),
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ hour }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 7. Thread depth patterns — success rate by thread size category.
 */
async function extractThreadDepth(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `WITH thread_sizes AS (
       SELECT m.thread_id, COUNT(*) AS depth
       FROM inbox.messages m
       GROUP BY m.thread_id
     )
     SELECT
       wi.assigned_to AS agent_id,
       CASE
         WHEN ts.depth = 1 THEN 'single'
         WHEN ts.depth BETWEEN 2 AND 4 THEN 'short_thread'
         WHEN ts.depth >= 5 THEN 'long_thread'
         ELSE 'unknown'
       END AS thread_category,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE wi.status = 'completed') AS completed
     FROM agent_graph.work_items wi
     JOIN inbox.messages m ON m.id::text = wi.metadata->>'email_id'
     JOIN thread_sizes ts ON ts.thread_id = m.thread_id
     WHERE wi.created_at >= $1 AND wi.created_at < $2
       AND wi.status IN ('completed', 'failed')
     GROUP BY wi.assigned_to, thread_category
     HAVING COUNT(*) >= 3`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const total = parseInt(row.total, 10);
    const completed = parseInt(row.completed, 10);
    const rate = total > 0 ? completed / total : 0;
    const category = row.thread_category;
    const description = scrubPII(`${row.agent_id}: ${(rate * 100).toFixed(1)}% success on ${category} threads (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'thread_depth', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, rate,
        Math.min(1, total / 20),
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ thread_category: category }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * 8. Sender type patterns — success rate by VIP/contact_type/unknown.
 */
async function extractSenderType(periodStart, periodEnd, lookbackStart) {
  const r = await query(
    `SELECT
       wi.assigned_to AS agent_id,
       CASE
         WHEN c.is_vip = true THEN 'vip'
         WHEN c.contact_type IS NOT NULL THEN c.contact_type
         ELSE 'unknown'
       END AS sender_category,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE wi.status = 'completed') AS completed
     FROM agent_graph.work_items wi
     JOIN inbox.messages m ON m.id::text = wi.metadata->>'email_id'
     LEFT JOIN signal.contacts c ON LOWER(c.email) = LOWER(m.from_address)
     WHERE wi.created_at >= $1 AND wi.created_at < $2
       AND wi.status IN ('completed', 'failed')
     GROUP BY wi.assigned_to, sender_category
     HAVING COUNT(*) >= 3`,
    [lookbackStart.toISOString(), periodEnd.toISOString()]
  );

  let upserted = 0;
  for (const row of r.rows) {
    const total = parseInt(row.total, 10);
    const completed = parseInt(row.completed, 10);
    const rate = total > 0 ? completed / total : 0;
    const category = row.sender_category;
    const description = scrubPII(`${row.agent_id}: ${(rate * 100).toFixed(1)}% success for ${category} senders (n=${total})`);

    await query(
      `INSERT INTO agent_graph.learned_patterns
       (agent_id, pattern_type, description, metric_value, confidence, sample_size, period_start, period_end, metadata)
       VALUES ($1, 'sender_type', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, pattern_type, period_start, period_end)
       DO UPDATE SET description = EXCLUDED.description, metric_value = EXCLUDED.metric_value,
                     confidence = EXCLUDED.confidence, sample_size = EXCLUDED.sample_size,
                     metadata = EXCLUDED.metadata, created_at = now()`,
      [
        row.agent_id, description, rate,
        Math.min(1, total / 20),
        total, periodStart.toISOString(), periodEnd.toISOString(),
        JSON.stringify({ sender_category: category }),
      ]
    );
    upserted++;
  }
  return upserted;
}

/**
 * Check learned_patterns for board-relevant anomalies and insert into learning_insights.
 * Deduplicates: same insight_type + agent_id within 24h is skipped.
 * All descriptions are template-based from numeric/enum fields only (Linus: no free-text).
 */
async function checkForInsights() {
  const start = performance.now();
  let insightsGenerated = 0;

  try {
    // 1. Success rate drops > 10%
    const drops = await query(
      `WITH current_rates AS (
         SELECT agent_id, metric_value, period_start
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'success_rate' AND sample_size >= 5
         ORDER BY period_end DESC
       ),
       prior_rates AS (
         SELECT DISTINCT ON (agent_id) agent_id, metric_value
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'success_rate' AND sample_size >= 5
           AND period_end < (SELECT MIN(period_start) FROM current_rates)
         ORDER BY agent_id, period_end DESC
       )
       SELECT c.agent_id, c.metric_value AS current_rate, p.metric_value AS prior_rate,
              (p.metric_value - c.metric_value) AS delta
       FROM current_rates c
       JOIN prior_rates p ON p.agent_id = c.agent_id
       WHERE (p.metric_value - c.metric_value) > 0.10`
    );

    for (const row of drops.rows) {
      const currentPct = (parseFloat(row.current_rate) * 100).toFixed(0);
      const priorPct = (parseFloat(row.prior_rate) * 100).toFixed(0);
      const deltaPct = (parseFloat(row.delta) * 100).toFixed(0);
      const severity = parseFloat(row.delta) > 0.25 ? 'critical' : 'warning';

      const result = await query(
        `INSERT INTO agent_graph.learning_insights
         (insight_type, agent_id, title, summary, severity, metric_current, metric_prior, metric_delta, sample_size)
         SELECT 'success_rate_drop', $1, $2, $3, $4, $5, $6, $7, 0
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_graph.learning_insights
           WHERE insight_type = 'success_rate_drop' AND agent_id = $1
             AND created_at >= now() - interval '24 hours'
         )`,
        [
          row.agent_id,
          `${row.agent_id}: success rate dropped ${deltaPct}% (${priorPct}% → ${currentPct}%)`,
          `Agent ${row.agent_id} success rate declined from ${priorPct}% to ${currentPct}% — a ${deltaPct} percentage point drop.`,
          severity,
          parseFloat(row.current_rate),
          parseFloat(row.prior_rate),
          parseFloat(row.delta),
        ]
      );
      if (result.rowCount > 0) insightsGenerated++;
    }

    // 2. Cost anomalies (>2x fleet average)
    const costAnomalies = await query(
      `WITH fleet_avg AS (
         SELECT AVG(metric_value) AS avg_cost
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'cost_efficiency' AND sample_size >= 5
       )
       SELECT lp.agent_id, lp.metric_value AS agent_cost, f.avg_cost,
              lp.metric_value / NULLIF(f.avg_cost, 0) AS ratio
       FROM agent_graph.learned_patterns lp, fleet_avg f
       WHERE lp.pattern_type = 'cost_efficiency'
         AND lp.sample_size >= 5
         AND f.avg_cost > 0
         AND lp.metric_value > f.avg_cost * 2
       ORDER BY lp.period_end DESC`
    );

    for (const row of costAnomalies.rows) {
      const ratio = parseFloat(row.ratio).toFixed(1);
      const agentCost = parseFloat(row.agent_cost).toFixed(4);
      const avgCost = parseFloat(row.avg_cost).toFixed(4);

      const result = await query(
        `INSERT INTO agent_graph.learning_insights
         (insight_type, agent_id, title, summary, severity, metric_current, metric_prior, metric_delta, sample_size)
         SELECT 'cost_anomaly', $1, $2, $3, 'warning', $4, $5, $6, 0
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_graph.learning_insights
           WHERE insight_type = 'cost_anomaly' AND agent_id = $1
             AND created_at >= now() - interval '24 hours'
         )`,
        [
          row.agent_id,
          `${row.agent_id}: cost ${ratio}x fleet average ($${agentCost} vs $${avgCost}/task)`,
          `Agent ${row.agent_id} costs $${agentCost}/task — ${ratio}x the fleet average of $${avgCost}/task.`,
          parseFloat(row.agent_cost),
          parseFloat(row.avg_cost),
          parseFloat(row.ratio),
        ]
      );
      if (result.rowCount > 0) insightsGenerated++;
    }

    // 3. Delegation degradation (>15% drop)
    const delegationDrops = await query(
      `WITH ranked AS (
         SELECT agent_id, metric_value, period_end,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY period_end DESC) AS rn
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'delegation_path' AND sample_size >= 5
       )
       SELECT c.agent_id, c.metric_value AS current_rate, p.metric_value AS prior_rate,
              (p.metric_value - c.metric_value) AS delta
       FROM ranked c
       JOIN ranked p ON p.agent_id = c.agent_id AND p.rn = 2
       WHERE c.rn = 1 AND (p.metric_value - c.metric_value) > 0.15`
    );

    for (const row of delegationDrops.rows) {
      const currentPct = (parseFloat(row.current_rate) * 100).toFixed(0);
      const priorPct = (parseFloat(row.prior_rate) * 100).toFixed(0);

      const result = await query(
        `INSERT INTO agent_graph.learning_insights
         (insight_type, agent_id, title, summary, severity, metric_current, metric_prior, metric_delta, sample_size)
         SELECT 'delegation_degradation', $1, $2, $3, 'warning', $4, $5, $6, 0
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_graph.learning_insights
           WHERE insight_type = 'delegation_degradation' AND agent_id = $1
             AND created_at >= now() - interval '24 hours'
         )`,
        [
          row.agent_id,
          `${row.agent_id}: delegation success dropped (${priorPct}% → ${currentPct}%)`,
          `Delegation path ${row.agent_id} success rate declined from ${priorPct}% to ${currentPct}%.`,
          parseFloat(row.current_rate),
          parseFloat(row.prior_rate),
          parseFloat(row.delta),
        ]
      );
      if (result.rowCount > 0) insightsGenerated++;
    }

  } catch (err) {
    log.error('checkForInsights error:', err.message);
  }

  const durationMs = Math.round(performance.now() - start);
  if (insightsGenerated > 0) {
    log.info(`Generated ${insightsGenerated} learning insight(s) in ${durationMs}ms`);
  }
}

// --- Improvement 3: Event-triggered extraction via pg_notify ---

let debounceTimer = null;
let _unsubscribe = null;
const DEBOUNCE_MS = 5 * 60_000; // 5-minute debounce

/**
 * Register a task_completed handler on the shared pg-listener.
 * Debounces extraction: waits 5 minutes after last event before running.
 *
 * Phase 1 consolidation: this no longer opens its own pg.Client LISTEN
 * connection. It registers on the single shared listener
 * (lib/runtime/pg-listener.js), whose start()/reconnect/watchdog are owned by
 * the boot sequence. subscribe() is callable before start(), so registration
 * order at boot does not matter.
 */
export function startPatternListener() {
  // Idempotent: avoid stacking duplicate handlers on repeat calls.
  if (_unsubscribe) return;
  _unsubscribe = subscribe('task_completed', () => {
    // Debounce: wait 5 minutes after last event before extracting.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log.info('Event-triggered extraction (debounced)');
      extractPatterns().catch(err =>
        log.error('Event-triggered extraction error:', err.message)
      );
    }, DEBOUNCE_MS);
  });
  log.info('Event listener registered (5min debounce, shared pg-listener)');
}

/**
 * Unregister the task_completed handler and clear the debounce timer.
 * Does NOT stop the shared listener — that is owned by the boot sequence.
 */
export function stopPatternListener() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
}
