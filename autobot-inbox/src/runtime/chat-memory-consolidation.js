/**
 * Nightly chat-memory consolidation (chat overhaul P5).
 *
 * Runs ONLY on the Railway API scheduler (registered in src/index.js — the
 * M1 runner boots via lib/runtime/state/startup.js and never loads this), so
 * the job has a single host by construction.
 *
 * Idempotent under double-run: consolidateMemory only fires for buckets with
 * ≥10 active memories and ≥5 per type; consolidated outputs are content_hash-
 * deduped by saveMemory; superseding an already-superseded row is a no-op
 * UPDATE. A second run right after the first sees the shrunken bucket and
 * skips.
 */

import { query } from '../db.js';
import { consolidateMemory } from '../../../lib/runtime/agents/agent-memory.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { loadMergedConfig } from '../../../lib/runtime/config-loader.js';
import { pickCheapModel } from '../commands/agent-chat.js';

const MIN_MEMORIES_TO_CONSOLIDATE = 10; // matches consolidateMemory's own floor

export async function consolidateChatMemories() {
  const config = await loadMergedConfig();
  const modelKey = pickCheapModel(config);
  if (!modelKey) {
    console.warn('[chat-memory-consolidate] no haiku-class model configured — skipping');
    return;
  }
  const llm = createLLMClient(modelKey, config.models);

  // Minimal AgentLoop-shaped adapter: consolidateMemory only uses
  // agent.callLLM(system, user, {maxTokens, temperature}) and reads .text.
  const llmAdapter = {
    callLLM: async (system, user, opts = {}) => {
      const response = await callProvider(llm, {
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: opts.maxTokens || 500,
        temperature: opts.temperature ?? 0.1,
      });
      // G1 audit trail
      const costUsd = computeCost(response.inputTokens || 0, response.outputTokens || 0, llm.modelConfig);
      try {
        await query(
          `INSERT INTO agent_graph.llm_invocations (agent_id, model, input_tokens, output_tokens, cost_usd, task_id, created_at) VALUES ('chat-memory-consolidate', $1, $2, $3, $4, $5, now())`,
          [modelKey, response.inputTokens || 0, response.outputTokens || 0, costUsd, opts.taskId || null]
        );
      } catch { /* non-fatal */ }
      return response;
    },
  };

  const buckets = await query(
    `SELECT agent_id, COUNT(*) AS n FROM agent_graph.agent_memories
     WHERE agent_id LIKE 'chat:%' AND superseded_by IS NULL
     GROUP BY agent_id HAVING COUNT(*) >= $1`,
    [MIN_MEMORIES_TO_CONSOLIDATE]
  );
  if (buckets.rows.length === 0) {
    console.log('[chat-memory-consolidate] no buckets above threshold');
    return;
  }

  for (const row of buckets.rows) {
    try {
      const res = await consolidateMemory(row.agent_id, llmAdapter);
      console.log(`[chat-memory-consolidate] ${row.agent_id}: ${row.n} active → consolidated=${res.consolidated}, remaining=${res.remaining}`);
    } catch (err) {
      console.warn(`[chat-memory-consolidate] ${row.agent_id} failed (non-fatal): ${err.message}`);
    }
  }
}
