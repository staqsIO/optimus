/**
 * Retrospector — Native Feedback Loop (Hermes-inspired, P2 compliant).
 *
 * Runs fire-and-forget after every task completion. Classifies outcomes
 * via decision table (O(1), 90% of cases) or Haiku LLM (10%), then
 * routes learnings through existing infrastructure:
 *   - Tactical: saveMemory() directly (pattern/failure memories)
 *   - Strategic: createIntent() for board review
 *
 * All behavioral modification flows through DB-enforced gates (P2),
 * not prompts. Retrospective log is append-only (P3).
 *
 * Cost target: ~$0.001/task for the 10% needing LLM; $0 for the rest.
 */

import { createHash } from 'node:crypto';
import { query } from '../../db.js';
import { saveMemory } from '../agent-memory.js';
import { createIntent } from '../intent-manager.js';
import { createLLMClient, callProvider } from '../../llm/provider.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/retrospector');

const TERMINAL_RETRY_COUNT = 3;  // SPEC §11

/**
 * Normalize a failure reason to a stable cluster signature.
 *
 * Strips UUIDs, ISO timestamps, and long numeric runs so the same underlying
 * bug across many work items collapses to one row in failure_signatures.
 * Mirrors the SQL normalization in sql/087-needs-attention-trigger.sql but
 * is a touch more aggressive (also strips quoted email-looking strings).
 */
function reasonSignature(reason) {
  const normalized = String(reason || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, '<ts>')
    .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
    .replace(/\d{6,}/g, '<num>');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Cluster terminal failures by reason signature so the dashboard and any
 * future incident-detector agent can group identical bugs across work items.
 *
 * Only runs when the work item has actually exhausted retries — non-terminal
 * failures clutter the table without signal.
 */
async function emitFailureSignature({ agentId, workItemId, reason, retryCount }) {
  if (retryCount < TERMINAL_RETRY_COUNT) return;
  if (!reason) return;
  const signature = reasonSignature(reason);
  try {
    await query(
      `INSERT INTO agent_graph.failure_signatures
         (signature, agent_id, sample_work_item_id, sample_reason, count)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (signature, agent_id)
       DO UPDATE SET count = agent_graph.failure_signatures.count + 1,
                     last_seen = now()`,
      [signature, agentId, workItemId, String(reason).slice(0, 500)]
    );
  } catch (err) {
    log.debug(`failure_signatures insert skipped: ${err.message}`);
  }
}

// Lazy-init Haiku client (same pattern as auto-classifier.js)
let retrospectLLM = null;
function getRetrospectLLM() {
  if (!retrospectLLM) {
    retrospectLLM = createLLMClient('anthropic/claude-haiku', {
      'anthropic/claude-haiku': {
        provider: 'anthropic',
        inputCostPer1M: 0.25,
        outputCostPer1M: 1.25,
      },
    });
  }
  return retrospectLLM;
}

/**
 * Quick-classify whether a task outcome produces a learning.
 * Decision table handles ~90% of cases with zero LLM cost.
 *
 * @param {{ success: boolean, durationMs: number, retryCount?: number, costUsd?: number }} taskResult
 * @param {{ medianDurationMs: number, avgCostUsd: number }} agentStats
 * @returns {'skip'|'failure'|'pattern'|'llm_needed'}
 */
export function quickClassifyOutcome(taskResult, agentStats) {
  const { success, durationMs = 0, retryCount = 0, costUsd = 0 } = taskResult;
  const { medianDurationMs = 10000, avgCostUsd = 0.01, totalRuns = 0 } = agentStats;

  // Failure always produces a learning
  if (!success) return 'failure';

  // Recovery from retries is worth capturing
  if (retryCount > 0) return 'pattern';

  // Cold start: capture first 5 runs per agent to build baseline data.
  // Without this, generous defaults cause everything to be 'skip' and
  // the feedback loop never learns anything.
  if (totalRuns < 5) return 'pattern';

  // Unusually slow success — potential optimization
  if (medianDurationMs > 0 && durationMs > medianDurationMs * 2) return 'pattern';

  // Unusually expensive — needs LLM assessment
  if (avgCostUsd > 0 && costUsd > avgCostUsd * 3) return 'llm_needed';

  // Routine success — just update stats
  return 'skip';
}

/**
 * LLM retrospective for non-obvious cases (~10% of tasks).
 * Haiku with structured output. Cost ~$0.001.
 *
 * @param {{ agentId: string, eventType: string, result: any, durationMs: number, costUsd: number }} opts
 * @returns {Promise<{ learningType: string, content: string, route: string, confidence: number }>}
 */
async function llmRetrospect({ agentId, eventType, result, durationMs, costUsd }) {
  const llm = getRetrospectLLM();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5s hard timeout

  try {
    const response = await callProvider(llm, {
      system: `You are a task retrospective analyzer. Given a task outcome, produce a structured learning.
Output EXACTLY one JSON object with these fields:
- learningType: "pattern" | "failure" | "context"
- content: string (max 200 chars, actionable insight)
- route: "tactical" | "strategic"
- confidence: number 0-1`,
      messages: [{
        role: 'user',
        content: `Agent: ${agentId}\nTask type: ${eventType}\nDuration: ${durationMs}ms\nCost: $${costUsd?.toFixed(4) || '0'}\nOutcome summary: ${JSON.stringify(result?.reason || result?.error || 'completed').slice(0, 500)}`,
      }],
      maxTokens: 150,
      temperature: 0,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const text = response?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    return {
      learningType: ['pattern', 'failure', 'context'].includes(parsed.learningType) ? parsed.learningType : 'pattern',
      content: String(parsed.content || '').slice(0, 200),
      route: parsed.route === 'strategic' ? 'strategic' : 'tactical',
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
    };
  } catch (err) {
    clearTimeout(timeout);
    log.warn(`LLM retrospect failed for ${agentId}: ${err.message}`);
    return null;
  }
}

/**
 * Update skill performance stats (UPSERT, per agent+event_type+tool_name).
 */
async function updateSkillPerformance({ agentId, eventType, toolName = '_task', durationMs = 0, success, costUsd = 0 }) {
  try {
    await query(
      `INSERT INTO agent_graph.skill_performance (agent_id, event_type, tool_name, total_runs, success_count, fail_count, total_duration_ms, total_cost_usd, last_run_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, now())
       ON CONFLICT (agent_id, event_type, tool_name) DO UPDATE SET
         total_runs = agent_graph.skill_performance.total_runs + 1,
         success_count = agent_graph.skill_performance.success_count + $4,
         fail_count = agent_graph.skill_performance.fail_count + $5,
         total_duration_ms = agent_graph.skill_performance.total_duration_ms + $6,
         total_cost_usd = agent_graph.skill_performance.total_cost_usd + $7,
         last_run_at = now()`,
      [agentId, eventType, toolName, success ? 1 : 0, success ? 0 : 1, durationMs, costUsd]
    );
  } catch (err) {
    // Fail-open: table may not exist yet (pre-migration)
    log.debug(`Skill performance update skipped: ${err.message}`);
  }
}

/**
 * Load agent's aggregate stats for decision table thresholds.
 */
async function loadAgentStats(agentId) {
  try {
    const result = await query(
      `SELECT
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_duration_ms / NULLIF(total_runs, 0)), 10000) AS median_duration_ms,
         COALESCE(AVG(total_cost_usd / NULLIF(total_runs, 0)), 0.01) AS avg_cost_usd,
         COALESCE(SUM(total_runs), 0) AS total_runs
       FROM agent_graph.skill_performance
       WHERE agent_id = $1`,
      [agentId]
    );
    const row = result.rows[0];
    return {
      medianDurationMs: Number(row?.median_duration_ms) || 10000,
      avgCostUsd: Number(row?.avg_cost_usd) || 0.01,
      totalRuns: Number(row?.total_runs) || 0,
    };
  } catch {
    return { medianDurationMs: 10000, avgCostUsd: 0.01 };
  }
}

/**
 * Log retrospective to append-only audit trail (P3).
 */
async function logRetrospective({ workItemId, agentId, classification, route, learningType, memoryId, intentId, costUsd, metadata }) {
  try {
    await query(
      `INSERT INTO agent_graph.retrospective_log
         (work_item_id, agent_id, classification, route, learning_type, memory_id, intent_id, cost_usd, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [workItemId, agentId, classification, route || null, learningType || null, memoryId || null, intentId || null, costUsd || 0, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    log.debug(`Retrospective log skipped: ${err.message}`);
  }
}

/**
 * Main entry point. Called fire-and-forget after task completion.
 *
 * @param {{ agentId: string, workItemId: string, success: boolean, durationMs: number, result: any, eventType: string, costUsd?: number, retryCount?: number }} ctx
 */
export async function retrospect(ctx) {
  const { agentId, workItemId, success, durationMs = 0, result, eventType = 'unknown', costUsd = 0, retryCount = 0 } = ctx;
  if (!agentId || !workItemId) return;

  try {
    // 1. Update skill performance (always, even for skips)
    await updateSkillPerformance({ agentId, eventType, success, durationMs, costUsd });

    // 2. Classify outcome via decision table
    const agentStats = await loadAgentStats(agentId);
    const classification = quickClassifyOutcome({ success, durationMs, retryCount, costUsd }, agentStats);

    // 3. Skip path — routine success, stats already updated
    if (classification === 'skip') {
      await logRetrospective({ workItemId, agentId, classification, costUsd: 0 });
      log.info(`[retrospector] ${agentId} event=${eventType} duration=${durationMs}ms cost=$${costUsd.toFixed(4)} class=skip reason=routine_success totalRuns=${agentStats.totalRuns} medianMs=${Math.round(agentStats.medianDurationMs)}`);
      return;
    }

    // 4. Direct memory save for clear-cut cases
    let memoryId = null;
    let intentId = null;
    let route = 'tactical';
    let learningType = classification === 'failure' ? 'failure' : 'pattern';
    let learningContent = null;
    let retrospectCost = 0;

    if (classification === 'failure') {
      const failureText = String(result?.error || result?.reason || 'unknown error');
      learningContent = `Task ${eventType} failed: ${failureText.slice(0, 300)}`;
      // Cluster terminal failures so duplicates across work items collapse
      // to one row in failure_signatures (Phase A primitive).
      await emitFailureSignature({ agentId, workItemId, reason: failureText, retryCount });
    } else if (classification === 'pattern') {
      const reason = retryCount > 0
        ? `Recovered after ${retryCount} retries — approach that worked: ${String(result?.reason || 'unknown').slice(0, 200)}`
        : `Slow execution (${durationMs}ms vs ${agentStats.medianDurationMs}ms median) — potential optimization target`;
      learningContent = `Task ${eventType}: ${reason}`;
    } else if (classification === 'llm_needed') {
      // LLM retrospective for ambiguous cases
      const llmResult = await llmRetrospect({ agentId, eventType, result, durationMs, costUsd });
      retrospectCost = 0.001; // ~150 input + 100 output tokens on Haiku

      if (llmResult) {
        learningType = llmResult.learningType;
        learningContent = llmResult.content;
        route = llmResult.route;
      } else {
        // LLM failed — fall back to pattern memory
        learningContent = `Task ${eventType} had unusual cost ($${costUsd?.toFixed(4)}) vs average ($${agentStats.avgCostUsd.toFixed(4)})`;
      }
    }

    // 5. Route the learning
    if (learningContent) {
      if (route === 'tactical') {
        const saved = await saveMemory({
          agentId,
          type: learningType,
          content: learningContent.slice(0, 500),
          workItemId,
          metadata: { source: 'retrospector', eventType, durationMs, costUsd },
        });
        memoryId = saved?.id || null;
      } else {
        // Strategic — create intent for board review
        const intent = await createIntent({
          agentId,
          intentType: 'observation',
          decisionTier: 'strategic',
          title: `Retrospective finding: ${eventType}`,
          reasoning: learningContent,
          proposedAction: { type: 'skill_improvement', eventType, learningType },
        });
        intentId = intent?.id || null;
      }
    }

    // 6. Audit trail (P3: append-only)
    await logRetrospective({
      workItemId, agentId, classification,
      route, learningType, memoryId, intentId,
      costUsd: retrospectCost,
      metadata: { durationMs, taskCostUsd: costUsd, retryCount },
    });

    // Classification reason for human-readable logs
    let reason = 'unknown';
    if (classification === 'failure') reason = 'task_failed';
    else if (classification === 'pattern' && retryCount > 0) reason = 'recovery_after_retries';
    else if (classification === 'pattern' && agentStats.totalRuns < 5) reason = 'cold_start_baseline';
    else if (classification === 'pattern') reason = `slow_success>2x_median`;
    else if (classification === 'llm_retrospect') reason = `cost>3x_avg`;

    log.info(`[retrospector] ${agentId} event=${eventType} duration=${durationMs}ms cost=$${costUsd.toFixed(4)} class=${classification} reason=${reason} route=${route} memory=${memoryId || 'none'}${intentId ? ` intent=${intentId}` : ''}`);

    // Debug: log the actual memory content so operators can trace what was stored
    if (learningContent) {
      log.debug(`[retrospector] ${agentId} stored ${learningType}: "${learningContent.slice(0, 200)}"`);
    }
  } catch (err) {
    // Non-fatal: retrospection failure must never block the pipeline
    log.warn(`[${agentId}] Retrospective error (non-fatal): ${err.message}`);
  }
}
