/**
 * Strategy Planner (ADR-021)
 *
 * LLM-driven strategy selection for campaign iterations.
 * Reads campaign_iterations history (what's been tried, what worked/failed)
 * and determines the next strategy to try.
 *
 * Self-correction is structural:
 * 1. campaign_iterations query gives full history of attempts + quality scores
 * 2. failure_analysis from discarded iterations tells what NOT to repeat
 * 3. strategy_adjustment proposes what to try differently
 */

import { query } from '../../lib/db.js';
import { queryEffectiveStrategies, classifyGoalType } from '../../lib/graph/claw-learning.js';
import { runCypher, isGraphAvailable } from '../../lib/graph/client.js';
import { queryRAG } from '../../lib/rag/client.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'campaigner' });

/**
 * Get iteration history for strategy context.
 * Returns the last N iterations with their outcomes.
 */
export async function getIterationHistory(campaignId, limit = 20, resumedAt = null) {
  const result = await query(
    `SELECT iteration_number, strategy_used, action_taken,
            quality_score, decision, failure_analysis, strategy_adjustment,
            quality_details, cost_usd, duration_ms
     FROM agent_graph.campaign_iterations
     WHERE campaign_id = $1
       AND ($3::timestamptz IS NULL OR created_at > $3)
     ORDER BY iteration_number DESC
     LIMIT $2`,
    [campaignId, limit, resumedAt]
  );
  // Enrich rows with top-level failure_reasons extracted from quality_details JSONB
  return result.rows.reverse().map(row => {
    const details = typeof row.quality_details === 'string'
      ? JSON.parse(row.quality_details) : row.quality_details || {};
    return { ...row, failure_reasons: details.failure_reasons || [] };
  });
}

/**
 * Get campaign context for strategy planning.
 */
export async function getCampaignContext(campaignId) {
  const result = await query(
    `SELECT c.goal_description, c.success_criteria, c.constraints,
            c.budget_envelope_usd, c.spent_usd, c.completed_iterations,
            c.max_iterations, c.campaign_mode,
            c.budget_envelope_usd - c.spent_usd - c.reserved_usd AS remaining_usd
     FROM agent_graph.campaigns c
     WHERE c.id = $1`,
    [campaignId]
  );
  return result.rows[0] || null;
}

/**
 * Build the strategy planning prompt for the LLM.
 * Includes goal, history, failures, and remaining budget.
 */
export async function buildStrategyPrompt(campaignContext, iterationHistory, options = {}) {
  const { goal_description, success_criteria, remaining_usd, completed_iterations, max_iterations } = campaignContext;

  const historyBlock = iterationHistory.length > 0
    ? iterationHistory.map(it => {
        const decision = it.decision === 'keep' ? '✓ KEPT' : it.decision === 'discard' ? '✗ DISCARDED' : it.decision;
        return `  #${it.iteration_number}: ${decision} | score=${it.quality_score ?? 'N/A'} | strategy=${JSON.stringify(it.strategy_used)}${it.failure_analysis ? `\n    Failure: ${it.failure_analysis}` : ''}${it.strategy_adjustment ? `\n    Adjustment: ${it.strategy_adjustment}` : ''}`;
      }).join('\n')
    : '  (no iterations yet — this is the first attempt)';

  // Extract what has been tried and failed
  const failedStrategies = iterationHistory
    .filter(it => it.decision === 'discard')
    .map(it => it.strategy_used);

  const bestScore = iterationHistory
    .filter(it => it.quality_score != null)
    .reduce((best, it) => Math.max(best, parseFloat(it.quality_score)), 0);

  // Load RAG knowledge base context relevant to the campaign goal
  const ragContext = await getCampaignRAGContext(campaignContext);

  // Query winning strategies from similar past campaigns (cross-campaign learning)
  const winningStrategies = await queryWinningStrategies(goal_description);
  const goalType = classifyGoalType(goal_description);
  let winningBlock = '';
  if (winningStrategies.length > 0) {
    const strategiesText = winningStrategies.map((s, i) =>
      `${i + 1}. Approach: ${s.approach} (scored ${s.score}, ${s.iterations} iterations, goal: "${s.goal}")`
    ).join('\n');
    winningBlock = `\nPROVEN STRATEGIES for similar ${goalType} campaigns:\n${strategiesText}\nConsider adapting these approaches.\n`;
  }

  // Build failure-aware guidance from most recent failed iteration
  let failureGuidanceBlock = '';
  const lastFailed = iterationHistory.filter(h => h.decision === 'discard' || h.decision === 'stop_error').slice(-1)[0];
  if (lastFailed?.failure_reasons?.length > 0) {
    const failureGuidance = lastFailed.failure_reasons.map(reason => {
      switch (reason) {
        case 'no_code_blocks': return '- You MUST output code in fenced code blocks (```language\\ncode\\n```)';
        case 'code_too_short': return '- Code blocks must contain substantial, complete implementations (100+ characters)';
        case 'placeholder_stubs': return '- Do NOT use placeholder stubs like // TODO or ... — write complete code';
        case 'self_assessment': return '- Do NOT include quality scores, confidence ratings, or self-assessments';
        case 'envelope_wrapped': return '- Minimize narrative wrapping — code should be the primary content, not explanation';
        case 'missing_sections': return '- Include all required sections specified in the success criteria';
        case 'word_count_low': return '- Output must be substantial (50+ words minimum)';
        default: return null;
      }
    }).filter(Boolean).join('\n');

    if (failureGuidance) {
      failureGuidanceBlock = `\n\nCRITICAL — Previous iteration failed these quality checks:\n${failureGuidance}\n`;
    }
  }

  // Pivot-on-plateau: when circuit breaker signals pivot, add directive
  const pivotBlock = options.pivotRequired
    ? `\n\nPIVOT REQUIRED: Previous approach has plateaued. You MUST try a fundamentally different strategy.\nDo NOT refine the previous approach — propose something entirely new.\n`
    : '';

  return `You are planning the next iteration strategy for a campaign.

GOAL:
${goal_description}

SUCCESS CRITERIA:
${JSON.stringify(success_criteria, null, 2)}

${ragContext ? `${ragContext}\n` : ''}ITERATION HISTORY (${completed_iterations}/${max_iterations} completed, $${parseFloat(remaining_usd).toFixed(2)} remaining):
${historyBlock}${failureGuidanceBlock}${pivotBlock}

BEST SCORE SO FAR: ${bestScore}

${failedStrategies.length > 0 ? `STRATEGIES THAT FAILED (do NOT repeat these):
${failedStrategies.map(s => `  - ${JSON.stringify(s)}`).join('\n')}` : ''}

${await getGraphHints()}
${winningBlock}
Respond with a JSON object describing your next strategy:
{
  "strategy": { "approach": "...", "parameters": {...} },
  "rationale": "Why this strategy, given history",
  "expected_improvement": "What specific improvement you expect"
}

Be specific. Vary your approach based on what has and hasn't worked.`;
}

/**
 * Parse the LLM's strategy response.
 * Returns structured strategy or a fallback.
 */
export function parseStrategyResponse(llmResponse) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        strategy: parsed.strategy || { approach: 'default' },
        rationale: parsed.rationale || '',
        expectedImprovement: parsed.expected_improvement || '',
      };
    }
  } catch {
    // JSON parse failed
  }

  // Fallback: use the raw response as the strategy description
  return {
    strategy: { approach: 'llm_directed', description: llmResponse.slice(0, 500) },
    rationale: 'Parsed from unstructured LLM response',
    expectedImprovement: 'unknown',
  };
}

/**
 * Query RAG knowledge base for context relevant to the campaign goal.
 * Extracts key topics from the goal and retrieves knowledge base docs.
 * Returns a formatted context block or empty string if unavailable.
 */
async function getCampaignRAGContext(campaignContext) {
  try {
    const goal = campaignContext.goal_description || '';
    if (!goal) return '';

    // Query the knowledge base with the campaign goal as context
    const result = await queryRAG(
      `Provide all relevant context about: ${goal.slice(0, 500)}`,
      { scope: 'campaign', kbOnly: true }
    );

    if (!result?.answer) return '';

    log.info(` RAG context loaded (${result.citations?.length || 0} citations)`);

    const block = [`KNOWLEDGE BASE CONTEXT (from documents, transcripts, and internal knowledge):\n${result.answer}`];
    if (result.citations?.length > 0) {
      block.push(`\nSources: ${result.citations.map(c => c.title || c.source || 'doc').join(', ')}`);
    }
    block.push('\nUse this context to inform your strategy. Do NOT invent details beyond what is provided.');
    return block.join('\n');
  } catch (err) {
    log.info(` RAG context unavailable: ${err.message}`);
    return '';
  }
}

/**
 * Query Neo4j for winning strategies on similar goal types.
 * Returns top strategies that succeeded for the same classified goal type,
 * enabling cross-campaign learning.
 *
 * @param {string} goalDescription
 * @param {number} [limit=3]
 * @returns {Promise<Array<{approach: string, iterations: number, score: number, goal: string}>>}
 */
async function queryWinningStrategies(goalDescription, limit = 3) {
  if (!isGraphAvailable()) return [];

  const goalType = classifyGoalType(goalDescription);
  try {
    const records = await runCypher(`
      MATCH (s:Strategy)-[:STRATEGY_FOR]->(gt:GoalType {name: $goalType})
      WHERE s.best_score > 0.7
      RETURN s.approach AS approach, s.iterations_to_success AS iterations, s.best_score AS score, s.goal_summary AS goal
      ORDER BY s.best_score DESC
      LIMIT $limit
    `, { goalType, limit }, { readOnly: true });

    return (records || []).map(r => ({
      approach: r.get('approach'),
      iterations: r.get('iterations'),
      score: r.get('score'),
      goal: r.get('goal'),
    }));
  } catch {
    return []; // Neo4j unavailable — degrade gracefully
  }
}

/**
 * Get strategy hints from Neo4j knowledge graph.
 * Returns a prompt block with effective strategies from past campaigns,
 * or empty string if Neo4j is unavailable.
 */
async function getGraphHints() {
  try {
    const effective = await queryEffectiveStrategies('', 5);
    if (effective.length === 0) return '';

    const lines = effective.map(s =>
      `  - "${s.strategy}" (avg score: ${s.avg_score?.toFixed(3) || 'N/A'}, success rate: ${(s.success_rate * 100).toFixed(0)}%, used ${s.uses}x)`
    ).join('\n');

    return `STRATEGIES THAT WORKED IN PAST CAMPAIGNS (consider these):
${lines}`;
  } catch {
    return '';
  }
}
