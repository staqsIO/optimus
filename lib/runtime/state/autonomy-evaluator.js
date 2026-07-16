import { query } from '../../db.js';
import { getConfig } from '../../config/loader.js';

const gates = getConfig('gates');

/**
 * Autonomy level evaluator (spec §14: G4 exit criteria).
 * Evaluates whether L0 → L1 or L1 → L2 exit criteria are met.
 * Does NOT auto-advance — logs evaluation for board review.
 * P5: Measure before you trust.
 */

/**
 * Evaluate current autonomy level exit criteria.
 * @returns {Promise<Object>} Evaluation result with recommendations
 */
export async function evaluateAutonomy() {
  const currentLevel = parseInt(process.env.AUTONOMY_LEVEL || '0', 10);
  const result = { currentLevel, evaluatedAt: new Date().toISOString() };

  if (currentLevel === 0) {
    result.exitCriteria = await evaluateL0Exit();
  } else if (currentLevel === 1) {
    result.exitCriteria = await evaluateL1Exit();
  } else {
    result.exitCriteria = { met: true, note: 'L2 is the maximum autonomy level' };
  }

  // Log evaluation (append-only for transparency)
  await query(
    `INSERT INTO agent_graph.task_events
     (event_type, work_item_id, target_agent_id, priority, event_data)
     VALUES ('state_changed', 'system', 'board', 0, $1)`,
    [JSON.stringify({
      type: 'autonomy_evaluation',
      ...result,
    })]
  );

  return result;
}

async function evaluateL0Exit() {
  const params = gates.gates.G4.params.L0.exitCriteria;

  // M1: Minimum drafts reviewed
  const draftsResult = await query(
    `SELECT COUNT(*) as cnt FROM agent_graph.action_proposals
     WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days'`
  );
  const draftsReviewed = parseInt(draftsResult.rows[0]?.cnt || '0', 10);

  // M2: Edit rate
  const editResult = await query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE board_action = 'edited') as edited
     FROM agent_graph.action_proposals
     WHERE board_action IS NOT NULL AND acted_at >= now() - interval '14 days'`
  );
  const total = parseInt(editResult.rows[0]?.total || '0', 10);
  const edited = parseInt(editResult.rows[0]?.edited || '0', 10);
  const editRate = total > 0 ? (edited / total) * 100 : 100;

  // M3: Minimum operating days
  const daysResult = await query(
    `SELECT COUNT(DISTINCT DATE(created_at)) as days
     FROM agent_graph.llm_invocations
     WHERE created_at >= now() - interval '30 days'`
  );
  const operatingDays = parseInt(daysResult.rows[0]?.days || '0', 10);

  // P1: Agent success rate >= 90% over 30 days (from learned_patterns)
  let successRate = null;
  try {
    const successResult = await query(
      `SELECT metric_value, sample_size
       FROM agent_graph.learned_patterns
       WHERE pattern_type = 'success_rate'
         AND period_end >= now() - interval '30 days'
         AND sample_size >= 10
       ORDER BY period_end DESC LIMIT 1`
    );
    if (successResult.rows.length > 0) {
      successRate = parseFloat(successResult.rows[0].metric_value);
    }
  } catch { /* learned_patterns may not exist yet */ }

  // P2: No guard_failure patterns in last 14 days
  let guardFailures = 0;
  try {
    const guardResult = await query(
      `SELECT COALESCE(SUM(CAST(metric_value AS INTEGER)), 0) AS cnt
       FROM agent_graph.learned_patterns
       WHERE pattern_type = 'failure_mode'
         AND metadata->>'error_category' = 'guard_failure'
         AND period_end >= now() - interval '14 days'
         AND sample_size > 0`
    );
    guardFailures = parseInt(guardResult.rows[0]?.cnt || '0', 10);
  } catch { /* learned_patterns may not exist yet */ }

  // P3: Cost efficiency within 1.5x of fleet average
  let costRatio = null;
  try {
    const costResult = await query(
      `WITH fleet AS (
         SELECT AVG(metric_value) AS avg_cost
         FROM agent_graph.learned_patterns
         WHERE pattern_type = 'cost_efficiency'
           AND period_end >= now() - interval '30 days'
           AND sample_size >= 5
       )
       SELECT lp.metric_value AS agent_cost, f.avg_cost,
              CASE WHEN f.avg_cost > 0 THEN lp.metric_value / f.avg_cost ELSE NULL END AS ratio
       FROM agent_graph.learned_patterns lp, fleet f
       WHERE lp.pattern_type = 'cost_efficiency'
         AND lp.period_end >= now() - interval '30 days'
         AND lp.sample_size >= 5
       ORDER BY lp.period_end DESC LIMIT 1`
    );
    if (costResult.rows.length > 0 && costResult.rows[0].ratio != null) {
      costRatio = parseFloat(costResult.rows[0].ratio);
    }
  } catch { /* learned_patterns may not exist yet */ }

  const criteria = {
    minDrafts: { required: params.minDrafts, actual: draftsReviewed, met: draftsReviewed >= params.minDrafts },
    maxEditRate: { required: params.maxEditRatePct, actual: Math.round(editRate * 100) / 100, met: editRate <= params.maxEditRatePct },
    minDays: { required: params.minDays, actual: operatingDays, met: operatingDays >= params.minDays },
    // Pattern-informed criteria (graceful: null means "not enough data yet")
    successRate: {
      required: 0.90,
      actual: successRate,
      met: successRate === null ? true : successRate >= 0.90, // pass if no data yet
      note: successRate === null ? 'Insufficient data (need 10+ tasks)' : null,
    },
    noGuardFailures: {
      required: 0,
      actual: guardFailures,
      met: guardFailures === 0,
    },
    costEfficiency: {
      required: 1.5,
      actual: costRatio !== null ? Math.round(costRatio * 100) / 100 : null,
      met: costRatio === null ? true : costRatio <= 1.5, // pass if no data yet
      note: costRatio === null ? 'Insufficient data' : null,
    },
  };

  const allMet = Object.values(criteria).every(c => c.met);

  return {
    met: allMet,
    criteria,
    recommendation: allMet
      ? 'L0 exit criteria met. Board may consider advancing to L1.'
      : `L0 exit criteria not yet met: ${Object.entries(criteria).filter(([, c]) => !c.met).map(([k]) => k).join(', ')}`,
  };
}

async function evaluateL1Exit() {
  const params = gates.gates.G4.params.L1.exitCriteria;

  // M1: Minimum operating days
  const daysResult = await query(
    `SELECT COUNT(DISTINCT DATE(created_at)) as days
     FROM agent_graph.llm_invocations
     WHERE created_at >= now() - interval '120 days'`
  );
  const operatingDays = parseInt(daysResult.rows[0]?.days || '0', 10);

  // M2: Error rate (rejected + failed drafts / total)
  const errorResult = await query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE board_action = 'rejected' OR reviewer_verdict = 'rejected') as errors
     FROM agent_graph.action_proposals
     WHERE created_at >= now() - interval '90 days'`
  );
  const total = parseInt(errorResult.rows[0]?.total || '0', 10);
  const errors = parseInt(errorResult.rows[0]?.errors || '0', 10);
  const errorRate = total > 0 ? (errors / total) * 100 : 100;

  // P1: Success rate >= 95% over 60 days
  let successRate = null;
  try {
    const successResult = await query(
      `SELECT metric_value, sample_size
       FROM agent_graph.learned_patterns
       WHERE pattern_type = 'success_rate'
         AND period_end >= now() - interval '60 days'
         AND sample_size >= 20
       ORDER BY period_end DESC LIMIT 1`
    );
    if (successResult.rows.length > 0) {
      successRate = parseFloat(successResult.rows[0].metric_value);
    }
  } catch {}

  // P2: No failure_mode patterns with sample_size > 5 in last 30 days
  let activeFailures = 0;
  try {
    const failResult = await query(
      `SELECT COUNT(*) AS cnt
       FROM agent_graph.learned_patterns
       WHERE pattern_type = 'failure_mode'
         AND period_end >= now() - interval '30 days'
         AND sample_size > 5`
    );
    activeFailures = parseInt(failResult.rows[0]?.cnt || '0', 10);
  } catch {}

  // P3: All delegation paths >= 85% success
  let worstDelegation = null;
  try {
    const delResult = await query(
      `SELECT MIN(metric_value) AS worst
       FROM agent_graph.learned_patterns
       WHERE pattern_type = 'delegation_path'
         AND period_end >= now() - interval '30 days'
         AND sample_size >= 5`
    );
    if (delResult.rows.length > 0 && delResult.rows[0].worst != null) {
      worstDelegation = parseFloat(delResult.rows[0].worst);
    }
  } catch {}

  const criteria = {
    minDays: { required: params.minDays, actual: operatingDays, met: operatingDays >= params.minDays },
    maxErrorRate: { required: params.maxErrorRatePct, actual: Math.round(errorRate * 100) / 100, met: errorRate <= params.maxErrorRatePct },
    // Pattern-informed criteria (graceful: null means "not enough data yet")
    successRate95: {
      required: 0.95,
      actual: successRate,
      met: successRate === null ? true : successRate >= 0.95,
      note: successRate === null ? 'Insufficient data (need 20+ tasks)' : null,
    },
    noActiveFailures: {
      required: 0,
      actual: activeFailures,
      met: activeFailures === 0,
    },
    delegationHealth: {
      required: 0.85,
      actual: worstDelegation !== null ? Math.round(worstDelegation * 100) / 100 : null,
      met: worstDelegation === null ? true : worstDelegation >= 0.85,
      note: worstDelegation === null ? 'Insufficient data' : null,
    },
  };

  const allMet = Object.values(criteria).every(c => c.met);

  return {
    met: allMet,
    criteria,
    recommendation: allMet
      ? 'L1 exit criteria met. Board may consider advancing to L2.'
      : `L1 exit criteria not yet met: ${Object.entries(criteria).filter(([, c]) => !c.met).map(([k]) => k).join(', ')}`,
  };
}
