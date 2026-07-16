import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/prompt-drift-monitor');

/**
 * Prompt Drift Monitor (Article 4.2a)
 *
 * Tracks whether current agent prompt hashes have drifted from the ORIGINAL
 * approved prompts. Drift budget: 0.95 cosine similarity threshold.
 *
 * Measures against ORIGINAL (not previous version) to prevent cumulative drift.
 * Uses the agent_config_history table (append-only) to find the first recorded
 * config for each agent.
 *
 * P4: Boring infrastructure. SHA256 hash comparison as baseline;
 * full cosine similarity requires embeddings (deferred to Phase 3).
 */

/**
 * Check all active agents for prompt drift.
 *
 * @returns {Promise<Array<{agentId: string, originalHash: string, currentHash: string, isWithinBudget: boolean, drifted: boolean}>>}
 */
export async function checkPromptDrift() {
  const results = [];

  try {
    // Get all active agent configs
    const configs = await query(
      `SELECT id, config_hash FROM agent_graph.agent_configs WHERE is_active = true`
    );

    for (const config of configs.rows) {
      // Get the ORIGINAL config from history (first entry by created_at)
      const original = await query(
        `SELECT config_hash, prompt_hash FROM agent_graph.agent_config_history
         WHERE agent_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [config.id]
      );

      const originalHash = original.rows[0]?.config_hash || config.config_hash;
      const currentHash = config.config_hash;

      // Hash comparison: exact match means no drift at all.
      // Full cosine similarity over prompt embeddings deferred to Phase 3.
      const isWithinBudget = originalHash === currentHash;

      try {
        await query(
          `INSERT INTO agent_graph.prompt_drift_log
           (agent_id, original_prompt_hash, current_prompt_hash, cosine_similarity, is_within_budget, modification_count)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [config.id, originalHash, currentHash, isWithinBudget ? 1.0 : null, isWithinBudget, 0]
        );
      } catch (err) {
        // Table may not exist yet during migration rollout
        if (!err.message?.includes('does not exist')) throw err;
      }

      results.push({
        agentId: config.id,
        originalHash,
        currentHash,
        isWithinBudget,
        drifted: !isWithinBudget,
      });
    }
  } catch (err) {
    if (!err.message?.includes('does not exist')) {
      log.warn('Check failed:', err.message);
    }
  }

  return results;
}

/**
 * Get a summary report of prompt drift over the last 30 days.
 *
 * @returns {Promise<Array<{agent_id: string, checks: number, drift_violations: number, min_similarity: number|null}>>}
 */
export async function getPromptDriftReport() {
  try {
    const result = await query(
      `SELECT agent_id,
              COUNT(*) as checks,
              COUNT(*) FILTER (WHERE is_within_budget = false) as drift_violations,
              MIN(cosine_similarity) as min_similarity
       FROM agent_graph.prompt_drift_log
       WHERE created_at > now() - interval '30 days'
       GROUP BY agent_id`
    );
    return result.rows;
  } catch {
    return [];
  }
}
