/**
 * Auto-Classifier / YOLO Classifier — G9 (Claude Code Architecture Audit — Change 4).
 *
 * AI-based permission evaluation using a cheap model (Haiku) against
 * configurable rules per autonomy level. Inspired by Claude Code's
 * yoloClassifier with allow/soft_deny/deny three-tier system.
 *
 * CRITICAL: This runs POST-CLAIM, PRE-EXECUTION — NOT inside guardCheck().
 * guardCheck() runs in a Postgres transaction. LLM calls inside transactions
 * hold connections open for seconds, causing pool exhaustion.
 * (Neo/Linus review: all three reviewers flagged this independently.)
 *
 * Integration point: agent-loop.js, after claimAndStart() returns.
 *
 * Rules use REPLACE semantics per section (Claude Code pattern):
 * A non-empty user section replaces that section's defaults entirely.
 */

import { createLLMClient, callProvider } from '../../llm/provider.js';
import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config/loader.js';
const log = createLogger('runtime/auto-classifier');

// Load autonomy rules from config
let autonomyRules = null;

function loadRules() {
  if (autonomyRules) return autonomyRules;
  try {
    autonomyRules = getConfig('autonomy-rules');
    return autonomyRules;
  } catch { /* fall through to embedded defaults */ }
  // Default rules if no config found
  autonomyRules = {
    L0: { auto_allow: [], auto_deny: ['*'], review_required: ['*'] },
    L1: {
      auto_allow: ['email_triage', 'signal_extraction', 'status_query', 'classification'],
      auto_deny: ['email_send', 'budget_modify', 'external_api_write'],
      review_required: ['*'],
    },
    L2: {
      auto_allow: ['email_triage', 'signal_extraction', 'status_query', 'classification', 'email_draft', 'task_assignment'],
      auto_deny: ['budget_modify', 'external_api_write'],
      review_required: ['email_send', 'code_deploy'],
    },
  };
  return autonomyRules;
}

/**
 * Quick lookup classification — O(1) decision table check.
 * Handles the 90% case without an LLM call (Liotta's feedback).
 * Falls through to LLM classification for ambiguous cases.
 *
 * @param {string} actionType - The action being classified
 * @param {string} autonomyLevel - 'L0', 'L1', 'L2'
 * @returns {'allow' | 'deny' | 'review' | null} null = ambiguous, needs LLM
 */
function quickClassify(actionType, autonomyLevel) {
  const rules = loadRules();
  const levelRules = rules[autonomyLevel];
  if (!levelRules) return 'deny'; // Unknown level = deny (P1)

  // Exact match checks (O(1) with Set for larger rule sets)
  if (levelRules.auto_allow.includes(actionType)) return 'allow';
  if (levelRules.auto_deny.includes(actionType)) return 'deny';
  if (levelRules.review_required.includes(actionType)) return 'review';

  // Wildcard checks
  if (levelRules.auto_deny.includes('*')) return 'deny';
  if (levelRules.review_required.includes('*')) return 'review';
  if (levelRules.auto_allow.includes('*')) return 'allow';

  return null; // Ambiguous — fall through to LLM
}

// Lazy-init classifier LLM client (cheapest model)
let classifierLLM = null;
function getClassifierLLM() {
  if (!classifierLLM) {
    classifierLLM = createLLMClient('anthropic/claude-haiku', {
      'anthropic/claude-haiku': {
        provider: 'anthropic',
        inputCostPer1M: 0.25,
        outputCostPer1M: 1.25,
      },
    });
  }
  return classifierLLM;
}

/**
 * Classify an agent's proposed action against autonomy rules.
 * Uses decision table first (O(1)), falls through to LLM for ambiguous cases.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - Agent proposing the action
 * @param {Object} opts.task - The work item being executed
 * @param {string} opts.autonomyLevel - 'L0', 'L1', 'L2'
 * @param {Object} [opts.context] - Additional context for LLM classification
 * @returns {Promise<{decision: 'allow'|'deny'|'review', reason: string, method: 'table'|'llm', costUsd: number}>}
 */
export async function classifyAction({ agentId, task, autonomyLevel = 'L0', context = {} }) {
  const actionType = task.event_type || task.event_data?.action_type || 'unknown';

  // Step 1: O(1) decision table (handles 90% of cases)
  const quickResult = quickClassify(actionType, autonomyLevel);
  if (quickResult) {
    // Audit trail (fire-and-forget)
    logClassification(agentId, task.work_item_id, actionType, autonomyLevel, quickResult, 'table', 0);
    return { decision: quickResult, reason: `${autonomyLevel} rule: ${actionType} → ${quickResult}`, method: 'table', costUsd: 0 };
  }

  // Step 2: LLM classification for ambiguous cases
  try {
    const rules = loadRules();
    const llm = getClassifierLLM();

    const response = await Promise.race([
      callProvider(llm, {
        system: `You are a permission classifier for an AI agent system. Given an action and autonomy rules, respond with exactly one word: ALLOW, DENY, or REVIEW.\n\nRules for ${autonomyLevel}:\n${JSON.stringify(rules[autonomyLevel])}`,
        messages: [{ role: 'user', content: `Agent: ${agentId}\nAction: ${actionType}\nTask: ${task.work_item_id}\nContext: ${JSON.stringify(context).slice(0, 500)}` }],
        maxTokens: 10,
        temperature: 0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('classifier timeout')), 3000)),
    ]);

    const costUsd = (response.inputTokens * 0.25 / 1_000_000) + (response.outputTokens * 1.25 / 1_000_000);
    const text = response.text.trim().toUpperCase();
    const decision = text.startsWith('ALLOW') ? 'allow' : text.startsWith('DENY') ? 'deny' : 'review';

    logClassification(agentId, task.work_item_id, actionType, autonomyLevel, decision, 'llm', costUsd);
    return { decision, reason: `LLM classified ${actionType} as ${decision} at ${autonomyLevel}`, method: 'llm', costUsd };
  } catch (err) {
    // Fail-closed: classifier error = review (P1 — deny by default)
    log.warn(`LLM classification failed (${err.message}), defaulting to review`);
    logClassification(agentId, task.work_item_id, actionType, autonomyLevel, 'review', 'error', 0);
    return { decision: 'review', reason: `Classifier error (fail-closed): ${err.message}`, method: 'error', costUsd: 0 };
  }
}

/**
 * Log classification decision to audit trail (fire-and-forget).
 */
function logClassification(agentId, workItemId, actionType, autonomyLevel, decision, method, costUsd) {
  query(
    `INSERT INTO agent_graph.auto_classifications
     (agent_id, work_item_id, action_type, autonomy_level, decision, method, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [agentId, workItemId, actionType, autonomyLevel, decision, method, costUsd]
  ).catch(err => {
    // Non-fatal: audit table may not exist yet
    log.warn(`Audit log failed (non-fatal): ${err.message}`);
  });
}

/**
 * Get the current autonomy level from the DB (or default to L0).
 */
export async function getAutonomyLevel() {
  try {
    const result = await query(
      `SELECT current_level FROM agent_graph.autonomy_state ORDER BY updated_at DESC LIMIT 1`
    );
    return result.rows[0]?.current_level || 'L0';
  } catch {
    return 'L0'; // Default to most restrictive
  }
}

/**
 * Reload rules from disk (for hot-reload on config change).
 */
export function reloadRules() {
  autonomyRules = null;
  loadRules();
}
