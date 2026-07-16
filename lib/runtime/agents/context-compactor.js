/**
 * Context Compaction (Claude Code Architecture Audit — Change 3).
 *
 * Dynamic context summarization for long-running agent sessions (campaigns).
 * Keeps the last N iterations verbatim and summarizes older ones using a cheap
 * model (Haiku), reducing token usage without losing critical context.
 *
 * Inspired by Claude Code's `compact` command and `snipReplay` pattern.
 *
 * Post-review fixes applied:
 *   - LLM calls route through budget system (Linus: no untracked spend)
 *   - Hard 5s timeout with fallback to static truncation (Neo: no new failure mode)
 *   - Summaries cached in DB for idempotency (avoids re-summarizing same history)
 */

import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/context-compactor');

// How many recent iterations to keep verbatim (not summarized)
const KEEP_VERBATIM = 2;

// Token threshold: only compact if total exceeds this
const COMPACTION_THRESHOLD_TOKENS = 4000;

// Rough token estimate (~4 chars per token for English text)
export function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Compact campaign iteration history by summarizing older iterations.
 * Keeps the last KEEP_VERBATIM iterations verbatim and summarizes the rest.
 *
 * @param {Array} iterations - Full iteration history
 * @param {Object} agent - AgentLoop instance (for callLLM with budget tracking)
 * @param {Object} opts
 * @param {string} opts.workItemId - Campaign work item ID (for caching)
 * @param {number} [opts.maxTokens=4000] - Target token budget for compacted history
 * @param {number} [opts.timeoutMs=5000] - Hard timeout for LLM compaction call
 * @returns {Promise<Array>} Compacted history (summary + recent verbatim iterations)
 */
export async function compactHistory(iterations, agent, opts = {}) {
  const { workItemId, maxTokens = COMPACTION_THRESHOLD_TOKENS, timeoutMs = 5000 } = opts;

  // Nothing to compact
  if (!iterations || iterations.length <= KEEP_VERBATIM) {
    return iterations;
  }

  const totalTokens = estimateTokens(iterations);
  if (totalTokens <= maxTokens) {
    return iterations; // Under budget — no compaction needed
  }

  const recent = iterations.slice(-KEEP_VERBATIM);
  const older = iterations.slice(0, -KEEP_VERBATIM);

  // Check cache: have we already summarized this exact history?
  const cacheKey = `${workItemId}:${older.length}`;
  try {
    const cached = await query(
      `SELECT summary FROM agent_graph.context_summaries
       WHERE work_item_id = $1 AND iteration_count = $2
       ORDER BY created_at DESC LIMIT 1`,
      [workItemId, older.length]
    );
    if (cached.rows[0]) {
      return [
        { type: 'compacted_summary', content: cached.rows[0].summary, covers: older.length, cached: true },
        ...recent,
      ];
    }
  } catch {
    // Table may not exist yet — proceed without cache
  }

  // Attempt LLM-based compaction with hard timeout
  // Routes through agent.callLLM() for budget tracking (Linus review fix)
  try {
    const summary = await Promise.race([
      agent.callLLM(
        'You are a concise summarizer. Compress the following campaign iteration history into key decisions, outcomes, and learnings. Preserve actionable information. Be brief.',
        `Summarize these ${older.length} campaign iterations:\n${JSON.stringify(older, null, 0)}`,
        {
          taskId: workItemId,
          maxTokens: Math.floor(maxTokens * 0.3),
          temperature: 0.1,
          idempotencyKey: `compact-${cacheKey}`,
        }
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('compaction timeout')), timeoutMs)),
    ]);

    const summaryText = summary.text;

    // Cache the summary for idempotency
    query(
      `INSERT INTO agent_graph.context_summaries (work_item_id, iteration_count, summary, agent_id, cost_usd)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [workItemId, older.length, summaryText, agent.agentId, summary.costUsd || 0]
    ).catch(() => {}); // non-critical

    return [
      { type: 'compacted_summary', content: summaryText, covers: older.length, cached: false },
      ...recent,
    ];
  } catch (err) {
    // Fallback: static truncation (no LLM dependency in the critical path)
    log.warn(`LLM compaction failed (${err.message}), falling back to static truncation`);
    return staticCompact(older, recent, maxTokens);
  }
}

/**
 * Static compaction fallback: extract structured outcomes without LLM.
 * Keeps decision + result + cost from each iteration as a compact record.
 */
function staticCompact(older, recent, maxTokens) {
  const compacted = older.map((iter, i) => ({
    iteration: i + 1,
    decision: iter.decision || iter.plan || iter.action || '(unknown)',
    outcome: iter.outcome || iter.result || iter.status || '(unknown)',
    cost: iter.costUsd || iter.cost || 0,
  }));

  return [
    { type: 'compacted_summary', content: JSON.stringify(compacted), covers: older.length, method: 'static' },
    ...recent,
  ];
}

/**
 * Get compaction stats for a campaign (for diagnostics/board display).
 */
export async function getCompactionStats(workItemId) {
  try {
    const stats = await query(
      `SELECT COUNT(*) as summaries, SUM(cost_usd) as total_cost, MAX(created_at) as last_compacted
       FROM agent_graph.context_summaries
       WHERE work_item_id = $1`,
      [workItemId]
    );
    return stats.rows[0] || null;
  } catch {
    return null;
  }
}
