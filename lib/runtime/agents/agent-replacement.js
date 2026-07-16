import { query } from '../../db.js';

/**
 * Agent Replacement Protocol (spec §11)
 *
 * When an agent is replaced (model swap, prompt rewrite, or full replacement):
 * 1. New agent runs in shadow mode until measurement-based exit criteria are met.
 * 2. After shadow mode, graduated trust escalation: Level 1 → 2 → 3.
 * 3. Trust resets on config_hash change, model change, or high rejection rate.
 *
 * P5: Measure before you trust.
 * P2: Infrastructure enforces; prompts advise.
 */

// ============================================================
// Initiate Replacement
// ============================================================

/**
 * Start shadow mode for an agent replacement.
 * Records the old and new config hashes and creates a shadow run entry.
 *
 * @param {string} agentId - The agent being replaced.
 * @param {string} newConfigHash - SHA256 hash of the new agent config.
 * @param {Object} [options]
 * @param {number} [options.minTasks=50] - Minimum tasks before shadow exit.
 * @param {number} [options.maxDurationDays=7] - Upper time bound for shadow mode.
 * @returns {Promise<Object>} The created shadow run record.
 */
export async function initiateReplacement(agentId, newConfigHash, options = {}) {
  const { minTasks = 50, maxDurationDays = 7 } = options;

  // Look up the current config_hash as the old config
  let oldConfigHash = null;
  try {
    const configResult = await query(
      `SELECT config_hash FROM agent_graph.agent_configs WHERE id = $1`,
      [agentId]
    );
    if (configResult.rows.length > 0) {
      oldConfigHash = configResult.rows[0].config_hash;
    }
  } catch (err) {
    // agent_configs table may not exist in test environments
    if (!err.message?.includes('does not exist')) throw err;
  }

  const result = await query(
    `INSERT INTO agent_graph.agent_shadow_mode
     (agent_id, old_config_hash, new_config_hash, status, min_tasks, max_duration_days)
     VALUES ($1, $2, $3, 'shadow', $4, $5)
     RETURNING *`,
    [agentId, oldConfigHash, newConfigHash, minTasks, maxDurationDays]
  );

  return result.rows[0];
}

// ============================================================
// Record Shadow Comparison
// ============================================================

/**
 * Record and compare outputs from the original and shadow agent.
 * Divergence is calculated using Jaccard distance on key output fields.
 *
 * @param {string} shadowRunId - The shadow run to record against.
 * @param {string} workItemId - The work item being compared.
 * @param {Object} originalOutput - Output from the original agent.
 * @param {Object} shadowOutput - Output from the shadow (new) agent.
 * @returns {Promise<Object>} The comparison record with divergence analysis.
 */
export async function recordShadowComparison(shadowRunId, workItemId, originalOutput, shadowOutput) {
  const { isDivergent, reason } = computeDivergence(originalOutput, shadowOutput);

  const result = await query(
    `INSERT INTO agent_graph.shadow_mode_comparisons
     (shadow_run_id, work_item_id, original_output, shadow_output, is_divergent, divergence_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [shadowRunId, workItemId, JSON.stringify(originalOutput), JSON.stringify(shadowOutput), isDivergent, reason]
  );

  // Update shadow run counters atomically
  await query(
    `UPDATE agent_graph.agent_shadow_mode
     SET tasks_processed = tasks_processed + 1,
         total_comparisons = total_comparisons + 1,
         divergence_count = divergence_count + $2,
         task_categories_seen = (
           SELECT array_agg(DISTINCT cat) FROM (
             SELECT unnest(task_categories_seen) AS cat
             FROM agent_graph.agent_shadow_mode WHERE id = $1
             UNION
             SELECT $3
           ) sub WHERE cat IS NOT NULL
         )
     WHERE id = $1`,
    [shadowRunId, isDivergent ? 1 : 0, extractCategory(workItemId, originalOutput)]
  );

  return result.rows[0];
}

/**
 * Compute Jaccard distance on top-level keys of two output objects.
 * Divergence threshold: any key present in both with different values counts.
 *
 * @param {Object} original
 * @param {Object} shadow
 * @returns {{isDivergent: boolean, reason: string|null}}
 */
function computeDivergence(original, shadow) {
  if (!original || !shadow) {
    return { isDivergent: true, reason: 'One or both outputs are null' };
  }

  const origKeys = new Set(Object.keys(original));
  const shadKeys = new Set(Object.keys(shadow));
  const allKeys = new Set([...origKeys, ...shadKeys]);
  const commonKeys = new Set([...origKeys].filter(k => shadKeys.has(k)));

  if (allKeys.size === 0) {
    return { isDivergent: false, reason: null };
  }

  // Jaccard distance: 1 - |intersection of matching values| / |union of all keys|
  let matchingValueCount = 0;
  const divergentFields = [];

  for (const key of commonKeys) {
    const origVal = JSON.stringify(original[key]);
    const shadVal = JSON.stringify(shadow[key]);
    if (origVal === shadVal) {
      matchingValueCount++;
    } else {
      divergentFields.push(key);
    }
  }

  // Keys only in one set count as divergent
  const onlyInOriginal = [...origKeys].filter(k => !shadKeys.has(k));
  const onlyInShadow = [...shadKeys].filter(k => !origKeys.has(k));

  const jaccardSimilarity = matchingValueCount / allKeys.size;
  const jaccardDistance = 1 - jaccardSimilarity;

  // Divergent if Jaccard distance > 0.5 (more different than similar)
  const isDivergent = jaccardDistance > 0.5;

  if (!isDivergent) {
    return { isDivergent: false, reason: null };
  }

  const reasons = [];
  if (divergentFields.length > 0) {
    reasons.push(`divergent fields: ${divergentFields.join(', ')}`);
  }
  if (onlyInOriginal.length > 0) {
    reasons.push(`missing in shadow: ${onlyInOriginal.join(', ')}`);
  }
  if (onlyInShadow.length > 0) {
    reasons.push(`extra in shadow: ${onlyInShadow.join(', ')}`);
  }

  return {
    isDivergent: true,
    reason: `Jaccard distance ${jaccardDistance.toFixed(3)}: ${reasons.join('; ')}`,
  };
}

/**
 * Extract the task category from a work item or output.
 * Falls back to 'unknown' if the category cannot be determined.
 *
 * @param {string} workItemId
 * @param {Object} output
 * @returns {string}
 */
function extractCategory(workItemId, output) {
  // Prefer explicit category from output metadata
  if (output?.category) return output.category;
  if (output?.task_type) return output.task_type;
  if (output?.type) return output.type;
  return 'unknown';
}

// ============================================================
// Check Shadow Exit Criteria
// ============================================================

/**
 * Check if all 4 shadow mode exit criteria are met:
 * 1. Minimum tasks processed >= min_tasks (default 50)
 * 2. Category coverage: encountered all expected task categories
 * 3. Divergence rate < 10%
 * 4. Time bound: within max_duration_days
 *
 * If all criteria are met, transitions the shadow run to trust_level_1.
 *
 * @param {string} shadowRunId
 * @returns {Promise<Object>} Criteria evaluation result.
 */
export async function checkShadowExitCriteria(shadowRunId) {
  const runResult = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode WHERE id = $1`,
    [shadowRunId]
  );

  if (runResult.rows.length === 0) {
    return { met: false, error: 'Shadow run not found' };
  }

  const run = runResult.rows[0];

  if (run.status !== 'shadow') {
    return { met: false, error: `Shadow run is in status '${run.status}', not 'shadow'` };
  }

  // Criterion 1: Minimum tasks
  const minTasksMet = run.tasks_processed >= run.min_tasks;

  // Criterion 2: Category coverage
  const expectedCategories = await getExpectedCategories(run.agent_id);
  const seenCategories = new Set(run.task_categories_seen || []);
  const missingCategories = expectedCategories.filter(c => !seenCategories.has(c));
  const categoryCoverageMet = missingCategories.length === 0;

  // Criterion 3: Divergence rate < 10%
  const divergenceRate = run.total_comparisons > 0
    ? (run.divergence_count / run.total_comparisons) * 100
    : 100;
  const divergenceMet = run.total_comparisons > 0 && divergenceRate < 10;

  // Criterion 4: Time bound (still within max_duration_days)
  const startedAt = new Date(run.started_at);
  const maxEnd = new Date(startedAt.getTime() + run.max_duration_days * 24 * 60 * 60 * 1000);
  const now = new Date();
  const withinTimeBound = now <= maxEnd;

  const allMet = minTasksMet && categoryCoverageMet && divergenceMet && withinTimeBound;

  // If time expired and criteria not met, mark as failed
  if (!withinTimeBound && !allMet) {
    await query(
      `UPDATE agent_graph.agent_shadow_mode
       SET status = 'failed', completed_at = now()
       WHERE id = $1`,
      [shadowRunId]
    );

    return {
      met: false,
      failed: true,
      criteria: {
        minTasks: { required: run.min_tasks, actual: run.tasks_processed, met: minTasksMet },
        categoryCoverage: { expected: expectedCategories, seen: [...seenCategories], missing: missingCategories, met: categoryCoverageMet },
        divergenceRate: { rate: Math.round(divergenceRate * 100) / 100, threshold: 10, met: divergenceMet },
        timeBound: { startedAt: run.started_at, maxEnd: maxEnd.toISOString(), met: withinTimeBound },
      },
    };
  }

  // If all criteria met, advance to trust_level_1
  if (allMet) {
    await query(
      `UPDATE agent_graph.agent_shadow_mode
       SET status = 'trust_level_1'
       WHERE id = $1`,
      [shadowRunId]
    );
  }

  return {
    met: allMet,
    failed: false,
    criteria: {
      minTasks: { required: run.min_tasks, actual: run.tasks_processed, met: minTasksMet },
      categoryCoverage: { expected: expectedCategories, seen: [...seenCategories], missing: missingCategories, met: categoryCoverageMet },
      divergenceRate: { rate: Math.round(divergenceRate * 100) / 100, threshold: 10, met: divergenceMet },
      timeBound: { startedAt: run.started_at, maxEnd: maxEnd.toISOString(), met: withinTimeBound },
    },
  };
}

/**
 * Get expected task categories for an agent from agent_configs or routing config.
 * Falls back to a default set based on agent type.
 *
 * @param {string} agentId
 * @returns {Promise<string[]>}
 */
async function getExpectedCategories(agentId) {
  // Attempt to derive from agent_configs metadata
  try {
    const result = await query(
      `SELECT agent_type FROM agent_graph.agent_configs WHERE id = $1`,
      [agentId]
    );

    if (result.rows.length > 0) {
      const agentType = result.rows[0].agent_type;
      // Default expected categories per agent type
      const categoryMap = {
        orchestrator: ['email_triage', 'email_strategy', 'email_respond', 'draft_review'],
        strategist: ['email_strategy'],
        executor: ['email_triage', 'email_respond'],
        reviewer: ['draft_review'],
        architect: ['daily_analysis'],
      };
      return categoryMap[agentType] || [];
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  return [];
}

// ============================================================
// Advance Trust Level
// ============================================================

/**
 * Check if the current trust level criteria are met and advance to the next level.
 *
 * Trust levels:
 * - Level 1 (suggest-with-review): 25 tasks, < 5% rejection rate -> Level 2
 * - Level 2 (autonomous-on-low-risk): 100 tasks, < 3% rejection rate -> Level 3
 * - Level 3 (full autonomous): terminal state -> completed
 *
 * @param {string} shadowRunId
 * @returns {Promise<Object>} Trust level evaluation result.
 */
export async function advanceTrustLevel(shadowRunId) {
  const runResult = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode WHERE id = $1`,
    [shadowRunId]
  );

  if (runResult.rows.length === 0) {
    return { advanced: false, error: 'Shadow run not found' };
  }

  const run = runResult.rows[0];

  if (run.status === 'trust_level_1') {
    return evaluateAndAdvance(run, {
      currentLevel: 1,
      nextStatus: 'trust_level_2',
      minTasks: 25,
      maxRejectionRate: 5,
    });
  }

  if (run.status === 'trust_level_2') {
    return evaluateAndAdvance(run, {
      currentLevel: 2,
      nextStatus: 'trust_level_3',
      minTasks: 100,
      maxRejectionRate: 3,
    });
  }

  if (run.status === 'trust_level_3') {
    // Level 3 is the terminal trust level; mark as completed
    await query(
      `UPDATE agent_graph.agent_shadow_mode
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [shadowRunId]
    );

    return {
      advanced: true,
      from: 'trust_level_3',
      to: 'completed',
      criteria: { note: 'Full autonomous reached, replacement protocol complete' },
    };
  }

  return {
    advanced: false,
    error: `Cannot advance from status '${run.status}'`,
  };
}

/**
 * Evaluate trust level criteria and advance if met.
 *
 * @param {Object} run - The shadow run record.
 * @param {Object} criteria
 * @param {number} criteria.currentLevel
 * @param {string} criteria.nextStatus
 * @param {number} criteria.minTasks
 * @param {number} criteria.maxRejectionRate
 * @returns {Promise<Object>}
 */
async function evaluateAndAdvance(run, { currentLevel, nextStatus, minTasks, maxRejectionRate }) {
  // Count tasks processed at this trust level
  // tasks_processed tracks cumulative across all phases;
  // for trust level evaluation, count comparisons since the level started.
  const levelTasksResult = await query(
    `SELECT COUNT(*) as cnt FROM agent_graph.shadow_mode_comparisons
     WHERE shadow_run_id = $1`,
    [run.id]
  );
  const totalTasks = parseInt(levelTasksResult.rows[0]?.cnt || '0', 10);

  const rejectionRate = totalTasks > 0
    ? (run.rejection_count / totalTasks) * 100
    : 100;

  const tasksMet = totalTasks >= minTasks;
  const rejectionMet = totalTasks > 0 && rejectionRate < maxRejectionRate;
  const allMet = tasksMet && rejectionMet;

  if (allMet) {
    await query(
      `UPDATE agent_graph.agent_shadow_mode
       SET status = $2
       WHERE id = $1`,
      [run.id, nextStatus]
    );
  }

  return {
    advanced: allMet,
    from: `trust_level_${currentLevel}`,
    to: allMet ? nextStatus : `trust_level_${currentLevel}`,
    criteria: {
      tasks: { required: minTasks, actual: totalTasks, met: tasksMet },
      rejectionRate: { rate: Math.round(rejectionRate * 100) / 100, threshold: maxRejectionRate, met: rejectionMet },
    },
  };
}

// ============================================================
// Check Trust Reset
// ============================================================

/**
 * Check if trust should reset for an agent due to:
 * 1. config_hash change (compared to the active shadow run's new_config_hash)
 * 2. model version change
 * 3. Rejection rate exceeds 10% in any 7-day window
 *
 * If a reset is triggered, marks the current run as failed and creates
 * a new shadow_mode entry starting at trust_level_1.
 *
 * @param {string} agentId
 * @returns {Promise<Object>} Reset evaluation result.
 */
export async function checkTrustReset(agentId) {
  // Find the active (non-completed, non-failed) shadow run for this agent
  const activeResult = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode
     WHERE agent_id = $1 AND status NOT IN ('completed', 'failed')
     ORDER BY started_at DESC LIMIT 1`,
    [agentId]
  );

  if (activeResult.rows.length === 0) {
    return { reset: false, reason: 'No active replacement in progress' };
  }

  const run = activeResult.rows[0];
  const resetReasons = [];

  // Check 1: config_hash change
  try {
    const configResult = await query(
      `SELECT config_hash, model FROM agent_graph.agent_configs WHERE id = $1`,
      [agentId]
    );

    if (configResult.rows.length > 0) {
      const currentConfig = configResult.rows[0];

      if (currentConfig.config_hash !== run.new_config_hash) {
        resetReasons.push(`config_hash changed: expected ${run.new_config_hash.slice(0, 8)}..., got ${currentConfig.config_hash.slice(0, 8)}...`);
      }

      // Check 2: model version change
      // Compare current model in agent_configs against the model at shadow start
      const historyResult = await query(
        `SELECT config_json FROM agent_graph.agent_config_history
         WHERE agent_id = $1 AND config_hash = $2
         ORDER BY created_at DESC LIMIT 1`,
        [agentId, run.new_config_hash]
      );

      if (historyResult.rows.length > 0) {
        const shadowStartModel = historyResult.rows[0].config_json?.model;
        if (shadowStartModel && currentConfig.model !== shadowStartModel) {
          resetReasons.push(`model changed: ${shadowStartModel} -> ${currentConfig.model}`);
        }
      }
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  // Check 3: rejection rate > 10% in last 7 days
  try {
    const recentResult = await query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE is_divergent = true) as divergent
       FROM agent_graph.shadow_mode_comparisons
       WHERE shadow_run_id = $1 AND created_at >= now() - interval '7 days'`,
      [run.id]
    );

    const total = parseInt(recentResult.rows[0]?.total || '0', 10);
    const divergent = parseInt(recentResult.rows[0]?.divergent || '0', 10);

    if (total > 0) {
      const recentRejectionRate = (divergent / total) * 100;
      if (recentRejectionRate > 10) {
        resetReasons.push(`7-day rejection rate ${recentRejectionRate.toFixed(1)}% exceeds 10% threshold`);
      }
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  if (resetReasons.length === 0) {
    return { reset: false, reason: 'All trust conditions hold' };
  }

  // Perform reset: mark current run as failed, create new at trust_level_1
  await query(
    `UPDATE agent_graph.agent_shadow_mode
     SET status = 'failed', completed_at = now()
     WHERE id = $1`,
    [run.id]
  );

  // Get the current config_hash for the new run
  let currentHash = run.new_config_hash;
  try {
    const configResult = await query(
      `SELECT config_hash FROM agent_graph.agent_configs WHERE id = $1`,
      [agentId]
    );
    if (configResult.rows.length > 0) {
      currentHash = configResult.rows[0].config_hash;
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) throw err;
  }

  const newRun = await query(
    `INSERT INTO agent_graph.agent_shadow_mode
     (agent_id, old_config_hash, new_config_hash, status, min_tasks, max_duration_days)
     VALUES ($1, $2, $3, 'trust_level_1', $4, $5)
     RETURNING *`,
    [agentId, run.new_config_hash, currentHash, run.min_tasks, run.max_duration_days]
  );

  return {
    reset: true,
    reasons: resetReasons,
    previousRunId: run.id,
    newRunId: newRun.rows[0].id,
    newStatus: 'trust_level_1',
  };
}

// ============================================================
// Get Replacement Status
// ============================================================

/**
 * Get the current shadow/trust state for an agent.
 * Returns the most recent active replacement, or the most recent completed one.
 *
 * @param {string} agentId
 * @returns {Promise<Object|null>} The replacement status, or null if none found.
 */
export async function getReplacementStatus(agentId) {
  // Prefer active (non-terminal) runs
  const activeResult = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode
     WHERE agent_id = $1 AND status NOT IN ('completed', 'failed')
     ORDER BY started_at DESC LIMIT 1`,
    [agentId]
  );

  if (activeResult.rows.length > 0) {
    const run = activeResult.rows[0];
    return formatStatus(run);
  }

  // Fall back to most recent completed/failed
  const recentResult = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode
     WHERE agent_id = $1
     ORDER BY started_at DESC LIMIT 1`,
    [agentId]
  );

  if (recentResult.rows.length === 0) {
    return null;
  }

  return formatStatus(recentResult.rows[0]);
}

/**
 * Format a shadow run record into a status summary.
 *
 * @param {Object} run
 * @returns {Object}
 */
function formatStatus(run) {
  const divergenceRate = run.total_comparisons > 0
    ? Math.round((run.divergence_count / run.total_comparisons) * 10000) / 100
    : null;

  return {
    id: run.id,
    agentId: run.agent_id,
    status: run.status,
    oldConfigHash: run.old_config_hash,
    newConfigHash: run.new_config_hash,
    tasksProcessed: run.tasks_processed,
    taskCategoriesSeen: run.task_categories_seen,
    divergenceRate,
    rejectionCount: run.rejection_count,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    minTasks: run.min_tasks,
    maxDurationDays: run.max_duration_days,
  };
}

// ============================================================
// Get Active Replacements
// ============================================================

/**
 * Get all in-progress replacements (shadow or any trust level).
 *
 * @returns {Promise<Object[]>} Array of active replacement statuses.
 */
export async function getActiveReplacements() {
  const result = await query(
    `SELECT * FROM agent_graph.agent_shadow_mode
     WHERE status NOT IN ('completed', 'failed')
     ORDER BY started_at DESC`
  );

  return result.rows.map(formatStatus);
}
