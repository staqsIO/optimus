/**
 * v0.2 Linear runtime wiring — meeting-actions-to-kanban Phase 6.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *
 * What this module does (called once at startup by src/index.js after DB
 * is ready):
 *   1. Reads LINEAR_API_KEY + LINEAR_TEAM_ID lazily (P2 — no module-level
 *      env reads). If either is missing, returns a no-op handle and the
 *      v0.2 path stays dormant. The rest of the runtime keeps working.
 *   2. Builds the org-level linearClient adapter (lib/linear/v2-adapter.js).
 *   3. Bootstraps guardrails (lib/linear/guardrail-bootstrap.js) so the
 *      push worker has something to map onto.
 *   4. Starts the four background workers:
 *        - enrichment worker        (lib/runtime/human-task-enrichment-worker.js)
 *        - push worker              (lib/runtime/human-task-push-worker.js)
 *        - linear reconciliation    (lib/runtime/linear-reconciliation.js)
 *        - team-cache refresher     (lib/linear/team-cache.js#startCacheRefresher)
 *   5. Returns { stop(), linearClient } so the SIGINT/SIGTERM handler can
 *      drain workers cleanly and api.js can inject the same client into
 *      operator-facing routes (workflow-states, reconcile, team-cache).
 *
 * P4 — boring infrastructure. No new deps. Anthropic SDK already loaded by
 * the agent loop, so reusing it for the workers' `llm(prompt)` callable is
 * free.
 */

import { buildLinearClient } from '../../../lib/linear/v2-adapter.js';
import { bootstrapGuardrails } from '../../../lib/linear/guardrail-bootstrap.js';
import { startCacheRefresher } from '../../../lib/linear/team-cache.js';
import { startEnrichmentWorker } from '../../../lib/runtime/human-task-enrichment-worker.js';
import { startPushWorker } from '../../../lib/runtime/human-task-push-worker.js';
import { startReconciliation } from '../../../lib/runtime/linear-reconciliation.js';

const RECONCILE_INTERVAL_MS = 600_000;   // 10 min — PRD FR-16.
const CACHE_REFRESH_INTERVAL_MS = 3_600_000; // 60 min — PRD NFR-11.

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Build the simple (prompt) => Promise<string> callable the workers expect.
 *
 * Both enrichTask() and the push worker pass a single user prompt and read
 * back a JSON string. No tools, no streaming, no multi-turn. We use the
 * Anthropic SDK directly so the workers don't have to learn the agent-loop
 * cost/budget machinery — these are infrastructure background workers, not
 * board-facing agents, and they ride on the same daily budget by way of
 * the central state_transitions accounting (out of scope here).
 */
async function buildCallLLM() {
  // Lazy import so the provider abstraction (and its SDK) isn't eagerly loaded
  // in test/satellite contexts that never wire v0.2.
  const { createLLMClient, callProvider } = await import('../../../lib/llm/provider.js');
  const { getConfig } = await import('../../../lib/config/loader.js');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('callLLM requires ANTHROPIC_API_KEY');
  }
  const llm = createLLMClient(HAIKU_MODEL, getConfig('agents').models);

  return async function callLLM(prompt) {
    const response = await callProvider(llm, {
      system: undefined,
      messages: [{ role: 'user', content: String(prompt) }],
      maxTokens: 1024,
    });
    // Workers expect a string they can JSON.parse. enrichTask + push worker
    // both swallow parse errors and fail safe, so we don't need to be fancy.
    return response.text ?? '';
  };
}

/**
 * Wire the v0.2 workers if LINEAR_API_KEY + LINEAR_TEAM_ID are set.
 *
 * @param {Object}   opts
 * @param {Function} opts.query - pg-style query fn (required)
 * @returns {Promise<{ stop: () => Promise<void>, linearClient: Object|null }>}
 */
export async function wireLinearV2({ query } = {}) {
  if (typeof query !== 'function') {
    throw new Error('wireLinearV2 requires { query } function');
  }

  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;

  if (!apiKey || !teamId) {
    console.warn(
      '[linear-v2] LINEAR_API_KEY or LINEAR_TEAM_ID not set — v0.2 enrichment / push / reconcile / team-cache workers disabled',
    );
    return { stop: async () => {}, linearClient: null };
  }

  const linearClient = buildLinearClient({ apiKey, teamId });

  // Guardrail seeding. Idempotent — a re-run with both kinds current is a
  // no-op (no Linear API call). On first run for a fresh DB this is the
  // single network round-trip that primes the team cache too (refreshCache
  // is invoked inside bootstrapGuardrails on the push branch).
  try {
    const result = await bootstrapGuardrails({
      query,
      linearClient: linearClient.gql,
      teamId,
    });
    if (result.pushCreated || result.pullCreated) {
      console.log(
        `[linear-v2] Guardrails bootstrapped (push=${result.pushCreated}, pull=${result.pullCreated})`,
      );
    }
  } catch (err) {
    // Non-fatal — workers can still run; they'll simply skip rows that
    // need a guardrail until one is seeded via the /api/guardrails UI.
    console.warn(`[linear-v2] Guardrail bootstrap failed: ${err.message}`);
  }

  const callLLM = await buildCallLLM();

  const enrichmentWorker = await startEnrichmentWorker({ query, llm: callLLM });
  const pushWorker       = await startPushWorker({ query, llm: callLLM, linearClient, teamId });
  const reconciliation   = startReconciliation({ query, linearClient, teamId, intervalMs: RECONCILE_INTERVAL_MS });
  const cacheRefresher   = startCacheRefresher({ teamId, intervalMs: CACHE_REFRESH_INTERVAL_MS, client: linearClient.client, query });

  console.log('[linear-v2] Workers started (enrichment, push, reconciliation, team-cache refresher)');

  async function stop() {
    // Stop all workers in parallel — they're independent. Each one swallows
    // errors internally, so we just await Promise.allSettled here.
    const stops = [enrichmentWorker, pushWorker, reconciliation, cacheRefresher]
      .filter(Boolean)
      .map((w) => Promise.resolve().then(() => w.stop()));
    await Promise.allSettled(stops);
  }

  return { stop, linearClient };
}
