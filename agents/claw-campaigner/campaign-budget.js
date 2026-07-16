/**
 * Campaign Budget Manager (ADR-021)
 *
 * Handles budget envelope operations for campaigns:
 * - reserve: atomic check-and-reserve within envelope
 * - release: undo reservation on failure
 * - commit: move reserved → spent after iteration completes
 * - check: verify remaining budget
 *
 * All budget enforcement is DB-level (P2: infrastructure enforces).
 * The campaigns.no_overspend CHECK constraint is the final backstop.
 */

import { query } from '../../lib/db.js';

/**
 * Reserve budget for an upcoming iteration.
 * Returns false if: envelope exhausted, campaign not running,
 * or amount exceeds max_cost_per_iteration.
 */
export async function reserveBudget(campaignId, estimatedCost) {
  const result = await query(
    `SELECT agent_graph.reserve_campaign_budget($1, $2) AS reserved`,
    [campaignId, estimatedCost]
  );
  return result.rows[0]?.reserved === true;
}

/**
 * Release a budget reservation (on iteration failure/abort).
 */
export async function releaseBudget(campaignId, estimatedCost) {
  await query(
    `SELECT agent_graph.release_campaign_budget($1, $2)`,
    [campaignId, estimatedCost]
  );
}

/**
 * Commit actual spend after iteration completes.
 * Moves reserved → spent and increments completed_iterations.
 */
export async function commitSpend(campaignId, reservedAmount, actualCost) {
  await query(
    `SELECT agent_graph.commit_campaign_spend($1, $2, $3)`,
    [campaignId, reservedAmount, actualCost]
  );
}

/**
 * Get current budget state for a campaign.
 */
export async function getBudgetState(campaignId) {
  const result = await query(
    `SELECT budget_envelope_usd, spent_usd, reserved_usd,
            max_cost_per_iteration,
            budget_envelope_usd - spent_usd - reserved_usd AS remaining_usd
     FROM agent_graph.campaigns
     WHERE id = $1`,
    [campaignId]
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  return {
    envelope: parseFloat(row.budget_envelope_usd),
    spent: parseFloat(row.spent_usd),
    reserved: parseFloat(row.reserved_usd),
    remaining: parseFloat(row.remaining_usd),
    maxPerIteration: row.max_cost_per_iteration ? parseFloat(row.max_cost_per_iteration) : null,
  };
}

/**
 * Estimate iteration cost based on model and expected tokens.
 * Uses the models config from agents.json pricing.
 */
export function estimateIterationCost(model, inputTokens, outputTokens, modelsConfig) {
  const pricing = modelsConfig?.[model];
  if (!pricing) return 0.10; // conservative default

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return inputCost + outputCost;
}
