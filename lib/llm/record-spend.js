/**
 * Spend recorder for LLM / tool calls made OUTSIDE the agent loop.
 *
 * The agent loop (lib/runtime/agents/agent-loop.js) writes every LLM call to
 * agent_graph.llm_invocations, which is the table G1 (daily ceiling), G10
 * (per-agent cap) and the cost dashboards read. Schedulers and API handlers
 * that call a provider SDK directly (e.g. the research-source poller's OpenAI
 * web_search) never touched that table, so their spend was invisible to
 * governance — see STAQPRO-601.
 *
 * This is the missing primitive: a best-effort recorder any non-loop caller can
 * use to make its spend visible and cappable. Metering is a side effect of
 * operating (P3) — a failed insert must never break the operational path, so
 * this swallows its own errors and returns a status instead of throwing.
 *
 * SCOPE — what this does and does NOT wire:
 *   - Makes spend VISIBLE to G10 (per-agent daily SUM in guard-check.js) and to
 *     the financial cost dashboards / M6 daily-cost views (all SUM over
 *     llm_invocations.cost_usd). This is the "see" half of governance.
 *   - It does NOT debit the G1 `agent_graph.budgets` envelope. G1 enforcement is
 *     an atomic UPDATE on a reserved budget row (the agent loop's reserve→commit
 *     dance); replicating it for ad-hoc callers is out of scope here. Callers
 *     that need a hard cap should self-enforce via dailySpendUsd() (see the
 *     research-source poller).
 *
 * RLS DEPENDENCY (OPT-166 P2e-E1 — WIRED): agent_graph.llm_invocations carries
 * FORCE ROW LEVEL SECURITY. Its INSERT policy is `system_insert_invocations WITH
 * CHECK (is_system())` (sql/200) and its SELECT policy `agent_read_invocations`
 * has an `OR is_system()` branch (sql/001 baseline). Under the current superuser
 * pool RLS is inert; once STAQPRO-263 flips the pool off superuser, a bare
 * (agent-scoped) INSERT would fail-closed (silently, via the best-effort swallow
 * below) and a bare SELECT would return 0 rows — collapsing G10's daily spend
 * read to a false $0 and blowing the cap open. Both are therefore routed through
 * a system scope. The primitives (`recordSpend` / `dailySpendUsd`) take an
 * optional injected `exec` defaulting to the bare pooled `query`, so any existing
 * caller stays byte-identical and inert; the metered wrappers (`recordSpendMetered`
 * / `dailySpendMeteredUsd`) open `withSystemScope('metering')` and inject the
 * scoped executor. Metering being best-effort (P3), scope-acquisition failure
 * falls back to the bare path rather than breaking the operational flow.
 */
import { createHash } from 'crypto';
import { query, withSystemScope } from '../db.js';

/**
 * Per-1M-token pricing (USD) for the models used by direct (non-loop) callers.
 * Mirrors config/agents.json model pricing; kept local so this helper has no
 * dependency on the agent config registry. Embeddings bill input only.
 * OpenAI changes prices — re-verify against the OpenAI pricing page when adding
 * models or if cost_usd looks off. Last verified: 2026-06-02.
 */
const PRICING = {
  'gpt-4o-mini': { inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
  'gpt-4o': { inputCostPer1M: 2.5, outputCostPer1M: 10 },
  'text-embedding-3-small': { inputCostPer1M: 0.02, outputCostPer1M: 0 },
};

/** Cost in USD for token usage on a known model (0 if model/pricing unknown). */
export function tokenCostUsd(model, inputTokens = 0, outputTokens = 0) {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (Number(inputTokens) || 0) * p.inputCostPer1M / 1_000_000 +
    (Number(outputTokens) || 0) * p.outputCostPer1M / 1_000_000
  );
}

/**
 * Record a spend event to agent_graph.llm_invocations.
 *
 * @param {object} o
 * @param {string} o.agentId      Stable identity that exists in agent_configs (FK).
 * @param {string} o.model        Model/tool identifier (stored verbatim).
 * @param {number} [o.inputTokens]
 * @param {number} [o.outputTokens]
 * @param {number} [o.costUsd]    Pre-computed cost; if omitted, derived from tokens.
 * @param {number} [o.surchargeUsd] Flat per-call fee added on top (e.g. web_search tool).
 * @param {string} [o.taskId]     Free-form attribution (defaults to `${kind}:${agentId}`).
 * @param {string} [o.provider]   'openai' | 'anthropic' | ...
 * @param {string} [o.kind]       'llm' | 'embedding' | 'web_search' (label only).
 * @param {string} [o.idempotencyKey] Pass an explicit key ONLY when you need
 *   exactly-once recording for a retryable unit of work. The default key is
 *   seeded with time+entropy, i.e. deliberately NON-deduplicating: each call
 *   records a distinct row (the desired behavior for independent poll calls).
 *   So `ON CONFLICT DO NOTHING` only protects when a caller-supplied key repeats.
 * @param {Function} [o.exec] Scoped query executor (OPT-166 P2e-E1). Defaults to
 *   the bare pooled `query`, keeping every existing caller byte-identical and
 *   inert. Post pool-flip the llm_invocations INSERT policy requires is_system(),
 *   so metered callers inject a `withSystemScope('metering')` executor via
 *   `recordSpendMetered`. INERT until the flip.
 * @returns {Promise<{recorded: boolean, costUsd: number}>}
 */
export async function recordSpend({
  agentId,
  model,
  inputTokens = 0,
  outputTokens = 0,
  costUsd,
  surchargeUsd = 0,
  taskId = null,
  provider = 'openai',
  kind = 'llm',
  idempotencyKey = null,
  exec = query,
}) {
  const total =
    (typeof costUsd === 'number' ? costUsd : tokenCostUsd(model, inputTokens, outputTokens)) +
    (Number(surchargeUsd) || 0);
  try {
    if (!agentId || !model) {
      throw new Error(`recordSpend requires agentId and model (got agentId=${agentId}, model=${model})`);
    }
    const key =
      idempotencyKey ||
      createHash('sha256')
        .update(`${agentId}:${kind}:${model}:${taskId || ''}:${Date.now()}:${Math.random()}`)
        .digest('hex')
        .slice(0, 32);
    // prompt_hash/response_hash are NOT NULL but there is no prompt/response for
    // a tool/embedding call. Store an opaque descriptor hash (not the raw label)
    // so audit queries that join on these columns never collide with a real
    // prompt hash. taskId here is a free-form label, not a work_items FK.
    const descHash = createHash('sha256').update(`${kind}:${model}:${taskId || ''}`).digest('hex').slice(0, 16);
    await exec(
      `INSERT INTO agent_graph.llm_invocations
         (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
          prompt_hash, response_hash, latency_ms, idempotency_key, account_id, provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        agentId,
        taskId || `${kind}:${agentId}`,
        model,
        Math.round(Number(inputTokens) || 0),
        Math.round(Number(outputTokens) || 0),
        total,
        descHash,
        descHash,
        null,
        key,
        null,
        provider,
      ]
    );
    return { recorded: true, costUsd: total };
  } catch (err) {
    console.warn(`[record-spend] failed to record ${kind} spend for ${agentId}: ${err.message}`);
    return { recorded: false, costUsd: total };
  }
}

/**
 * Today's total recorded spend (USD) for an agent identity. Used by direct
 * callers to self-enforce a daily cap before spending (G10-style, since
 * guard-check's G10 only runs inside the agent loop).
 *
 * @param {string} agentId
 * @param {Function} [exec] Scoped query executor (OPT-166 P2e-E1). Defaults to the
 *   bare pooled `query` (byte-identical/inert). Post pool-flip the SELECT resolves
 *   real rows only under is_system() (the `agent_read_invocations OR is_system()`
 *   branch) — metered callers inject a `withSystemScope('metering')` executor via
 *   `dailySpendMeteredUsd`; a bare read would silently return $0 and blow G10 open.
 */
export async function dailySpendUsd(agentId, exec = query) {
  try {
    const r = await exec(
      `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend
         FROM agent_graph.llm_invocations
        WHERE agent_id = $1 AND created_at >= CURRENT_DATE`,
      [agentId]
    );
    return r.rows[0]?.spend ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Metered variant of {@link recordSpend}: records the spend under a
 * `withSystemScope('metering')` executor so the llm_invocations INSERT satisfies
 * `is_system()` after the STAQPRO-263 pool flip. INERT today (superuser bypass).
 *
 * Metering is best-effort (P3) — if the system scope cannot be acquired we fall
 * back to the bare `recordSpend` rather than throw, so the operational path a
 * scheduler is on is never broken by a metering hiccup. `recordSpend` itself
 * already swallows INSERT failures, and the scope is released in `finally`.
 */
export async function recordSpendMetered(o = {}) {
  let scope;
  try {
    scope = await withSystemScope('metering', { reason: `record ${o.kind || 'llm'} spend` });
  } catch (err) {
    console.warn(`[record-spend] system scope unavailable, recording unscoped: ${err.message}`);
    return recordSpend(o);
  }
  try {
    return await recordSpend({ ...o, exec: scope });
  } finally {
    await scope.release();
  }
}

/**
 * Metered variant of {@link dailySpendUsd}: reads today's spend under a
 * `withSystemScope('metering')` executor so the SUM sees real rows post-flip
 * (a bare read would collapse to $0 and defeat the caller's self-enforced G10
 * cap). Best-effort: on scope-acquisition failure, falls back to the bare read.
 */
export async function dailySpendMeteredUsd(agentId) {
  let scope;
  try {
    scope = await withSystemScope('metering', { reason: 'daily spend cap read' });
  } catch {
    return dailySpendUsd(agentId);
  }
  try {
    return await dailySpendUsd(agentId, scope);
  } finally {
    await scope.release();
  }
}
