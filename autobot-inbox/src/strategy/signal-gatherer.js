import { query } from '../db.js';

/**
 * Signal gatherer for strategic/existential decision evaluations.
 * Collects financial constraints, build capability metrics, and legal constraints
 * to feed into the three-perspective evaluation protocol (spec S19).
 *
 * Shadow mode: read-only queries, no side effects.
 */

/**
 * Gather all signals relevant to evaluating a work item decision.
 *
 * @param {string} workItemId - The work item under evaluation
 * @returns {Promise<object>} Structured signal object for consumption by evaluation protocol
 */
export async function gatherSignals(workItemId) {
  const [financial, capability, workItem, legal] = await Promise.all([
    gatherFinancialSignals(),
    gatherCapabilitySignals(),
    gatherWorkItemContext(workItemId),
    gatherLegalConstraints(),
  ]);

  return {
    financial,
    capability,
    workItem,
    legal,
    gatheredAt: new Date().toISOString(),
  };
}

/**
 * Query autobot_finance tables for current financial state.
 * Handles missing tables gracefully (autobot_finance may not be set up).
 */
async function gatherFinancialSignals() {
  const signals = {
    dailyBudgetRemaining: null,
    monthlySpend: null,
    operatingBalance: null,
    reserveBalance: null,
  };

  // Daily budget remaining from agent_graph.budgets
  try {
    const budgetResult = await query(
      `SELECT allocated_usd, spent_usd, reserved_usd
       FROM agent_graph.budgets
       WHERE scope = 'daily' AND period_start = CURRENT_DATE
       LIMIT 1`
    );
    if (budgetResult.rows.length > 0) {
      const b = budgetResult.rows[0];
      signals.dailyBudgetRemaining = parseFloat(b.allocated_usd) -
        parseFloat(b.spent_usd) - parseFloat(b.reserved_usd);
    }
  } catch (err) {
    console.warn('[signal-gatherer] Failed to query daily budget:', err.message);
  }

  // Monthly spend from autobot_finance.expenses
  try {
    const expenseResult = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM autobot_finance.expenses
       WHERE period_month = date_trunc('month', CURRENT_DATE)::date`
    );
    signals.monthlySpend = parseFloat(expenseResult.rows[0]?.total ?? 0);
  } catch (err) {
    // autobot_finance schema may not exist — that is acceptable
    console.warn('[signal-gatherer] Failed to query monthly expenses:', err.message);
  }

  // Account balances from autobot_finance.accounts
  try {
    const accountResult = await query(
      `SELECT account_type, balance FROM autobot_finance.accounts`
    );
    for (const row of accountResult.rows) {
      if (row.account_type === 'operating') {
        signals.operatingBalance = parseFloat(row.balance);
      } else if (row.account_type === 'reserve') {
        signals.reserveBalance = parseFloat(row.balance);
      }
    }
  } catch (err) {
    console.warn('[signal-gatherer] Failed to query account balances:', err.message);
  }

  return signals;
}

/**
 * Query work_items for historical velocity and error rates.
 * These feed into the capability perspective evaluation.
 */
async function gatherCapabilitySignals() {
  const signals = {
    completedLast30Days: 0,
    failedLast30Days: 0,
    avgCompletionTimeMs: null,
    errorRate: null,
  };

  try {
    const completedResult = await query(
      `SELECT COUNT(*) AS cnt
       FROM agent_graph.work_items
       WHERE status = 'completed'
         AND updated_at >= now() - interval '30 days'`
    );
    signals.completedLast30Days = parseInt(completedResult.rows[0]?.cnt ?? 0, 10);

    const failedResult = await query(
      `SELECT COUNT(*) AS cnt
       FROM agent_graph.work_items
       WHERE status = 'failed'
         AND updated_at >= now() - interval '30 days'`
    );
    signals.failedLast30Days = parseInt(failedResult.rows[0]?.cnt ?? 0, 10);

    const total = signals.completedLast30Days + signals.failedLast30Days;
    if (total > 0) {
      signals.errorRate = signals.failedLast30Days / total;
    }
  } catch (err) {
    console.warn('[signal-gatherer] Failed to query capability signals:', err.message);
  }

  // Average completion time from state transitions (created -> completed)
  try {
    const avgResult = await query(
      `SELECT AVG(EXTRACT(EPOCH FROM (st_end.created_at - st_start.created_at)) * 1000) AS avg_ms
       FROM agent_graph.state_transitions st_start
       JOIN agent_graph.state_transitions st_end
         ON st_start.work_item_id = st_end.work_item_id
       WHERE st_start.to_state = 'in_progress'
         AND st_end.to_state = 'completed'
         AND st_end.created_at >= now() - interval '30 days'`
    );
    if (avgResult.rows[0]?.avg_ms != null) {
      signals.avgCompletionTimeMs = parseFloat(avgResult.rows[0].avg_ms);
    }
  } catch (err) {
    console.warn('[signal-gatherer] Failed to query avg completion time:', err.message);
  }

  return signals;
}

/**
 * Load the work item and its metadata for evaluation context.
 */
async function gatherWorkItemContext(workItemId) {
  try {
    const result = await query(
      `SELECT id, type, title, description, status, priority, budget_usd, metadata, created_at
       FROM agent_graph.work_items
       WHERE id = $1`,
      [workItemId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn('[signal-gatherer] Failed to query work item:', err.message);
    return null;
  }
}

/**
 * Static legal constraints from project configuration.
 * These are known invariants that apply to all decisions.
 */
async function gatherLegalConstraints() {
  return {
    dailyBudgetCeilingUsd: parseFloat(process.env.DAILY_BUDGET_USD || '20'),
    autonomyLevel: parseInt(process.env.AUTONOMY_LEVEL || '0', 10),
    constraints: [
      'G2: No commitment/contract language without board approval',
      'G5: Prefer drafts over sends (reversibility)',
      'G7: Flag pricing/timeline/policy commitments',
    ],
  };
}
