import { query } from '../db.js';
import { isPhase3Active } from '../runtime/phase-manager.js';

/**
 * Financial Script -- One of 5 Immutable Components (spec S13)
 * Phase-aware: shadow mode (Phase 2) or real mode (Phase 3+).
 * NO AI. Deterministic only. Separate credentials (Phase 3).
 *
 * Phase 2: computes allocations but does not execute transfers.
 * Phase 3: real financial transactions (small scale).
 *   - monthly_allocations.is_shadow_mode = false
 *   - Ledger entries are committed (not just logged)
 *   - Budget enforcement is strict (no fail-open)
 *
 * Tracks: revenue, expenses, monthly allocations (40/20/40 split).
 * Enforces: pre-distribution activation gate, budget limits.
 */

// Record LLM expenses from llm_invocations into autobot_finance
export async function syncLlmExpenses(periodMonth) {
  const monthStr = formatMonth(periodMonth);
  try {
    const result = await query(
      `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
              COUNT(*) as invocation_count
       FROM agent_graph.llm_invocations
       WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 month')`,
      [monthStr]
    );

    const { total_cost, invocation_count } = result.rows[0];
    if (parseFloat(total_cost) === 0) return { synced: false, reason: 'No LLM costs' };

    await query(
      `INSERT INTO autobot_finance.expenses
       (category, amount, description, vendor, period_month)
       VALUES ('llm_api', $1, $2, 'anthropic', $3::date)`,
      [total_cost, `${invocation_count} LLM invocations`, monthStr]
    );

    return { synced: true, amount: parseFloat(total_cost), invocations: parseInt(invocation_count) };
  } catch (err) {
    if (err.message?.includes('does not exist')) return { synced: false, reason: 'Schema not ready' };
    throw err;
  }
}

// Compute monthly allocation (calls SQL function)
// Phase 3: sets is_shadow_mode = false for real transactions.
export async function computeMonthlyAllocation(periodMonth) {
  const monthStr = formatMonth(periodMonth);
  try {
    await query(`SELECT autobot_finance.compute_monthly_allocation($1::date)`, [monthStr]);

    // Phase 3: update shadow mode flag
    const phase3 = await isPhase3Active();
    if (phase3) {
      await query(
        `UPDATE autobot_finance.monthly_allocations
         SET is_shadow_mode = false
         WHERE period_month = $1::date`,
        [monthStr]
      );
    }

    const result = await query(
      `SELECT * FROM autobot_finance.monthly_allocations WHERE period_month = $1::date`,
      [monthStr]
    );

    return result.rows[0] || null;
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

// Get financial summary (for dashboard/briefing)
export async function getFinancialSummary() {
  try {
    const currentMonth = formatMonth(new Date());

    const [revenue, expenses, allocation, accounts] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount), 0) as total FROM autobot_finance.revenue WHERE period_month = $1::date`, [currentMonth]),
      query(`SELECT COALESCE(SUM(amount), 0) as total, category FROM autobot_finance.expenses WHERE period_month = $1::date GROUP BY category`, [currentMonth]),
      query(`SELECT * FROM autobot_finance.monthly_allocations WHERE period_month = $1::date`, [currentMonth]),
      query(`SELECT account_type, balance FROM autobot_finance.accounts`),
    ]);

    return {
      currentMonth,
      revenue: parseFloat(revenue.rows[0]?.total || 0),
      expenses: expenses.rows.map(r => ({ category: r.category, amount: parseFloat(r.total) })),
      totalExpenses: expenses.rows.reduce((sum, r) => sum + parseFloat(r.total), 0),
      allocation: allocation.rows[0] || null,
      accounts: accounts.rows.reduce((acc, r) => { acc[r.account_type] = parseFloat(r.balance); return acc; }, {}),
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

// Daily cost digest (pushed to board via preferred channel)
export async function generateCostDigest() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const result = await query(
      `SELECT
         agent_id,
         model,
         COUNT(*) as calls,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COALESCE(SUM(cost_usd), 0) as total_cost
       FROM agent_graph.llm_invocations
       WHERE created_at::date = $1::date
       GROUP BY agent_id, model
       ORDER BY total_cost DESC`,
      [today]
    );

    const totalSpend = result.rows.reduce((sum, r) => sum + parseFloat(r.total_cost), 0);

    const byModel = {};
    const byAgent = {};
    for (const row of result.rows) {
      const model = row.model || 'unknown';
      const agent = row.agent_id || 'unknown';
      byModel[model] = (byModel[model] || 0) + parseFloat(row.total_cost);
      byAgent[agent] = (byAgent[agent] || 0) + parseFloat(row.total_cost);
    }

    return {
      date: today,
      totalSpend: Math.round(totalSpend * 100) / 100,
      byModel,
      byAgent,
      invocations: result.rows,
    };
  } catch {
    return { date: new Date().toISOString().split('T')[0], totalSpend: 0, byModel: {}, byAgent: {}, invocations: [] };
  }
}

// Check pre-distribution activation gate
export async function checkDistributionGate() {
  try {
    const result = await query(
      `SELECT
         AVG(gross_revenue) as avg_revenue,
         AVG(total_expenses) as avg_expenses
       FROM autobot_finance.monthly_allocations
       WHERE period_month >= (date_trunc('month', now()) - interval '3 months')::date
         AND period_month < date_trunc('month', now())::date`
    );

    if (!result.rows[0]) return { eligible: false, reason: 'Insufficient history' };

    const avgRevenue = parseFloat(result.rows[0].avg_revenue || 0);
    const avgExpenses = parseFloat(result.rows[0].avg_expenses || 0);
    const threshold = avgExpenses * 1.5;

    return {
      eligible: avgRevenue > 0 && avgRevenue > threshold,
      avgRevenue,
      avgExpenses,
      threshold,
      ratio: avgExpenses > 0 ? (avgRevenue / avgExpenses) : 0,
    };
  } catch {
    return { eligible: false, reason: 'Finance schema not ready' };
  }
}

/**
 * Get the current financial mode.
 * Phase 2: 'shadow' (compute only). Phase 3+: 'real' (execute transactions).
 *
 * @returns {Promise<'shadow'|'real'>}
 */
export async function getFinancialMode() {
  const phase3 = await isPhase3Active();
  return phase3 ? 'real' : 'shadow';
}

function formatMonth(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
