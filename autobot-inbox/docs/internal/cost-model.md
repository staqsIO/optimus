---
title: "Cost Model"
description: "LLM cost breakdown by agent and model tier, budget reservation pattern, daily ceiling enforcement"
---

# Cost Model

## Model Pricing

Three Claude model tiers are used, configured in `config/agents.json`:

| Model | Input ($/1M tokens) | Output ($/1M tokens) | Context Window | Max Output |
|-------|---------------------|----------------------|----------------|------------|
| claude-opus-4-6 | $5.00 | $25.00 | 200K | 128K |
| claude-sonnet-4-6 | $3.00 | $15.00 | 200K | 64K |
| claude-haiku-4-5-20251001 | $1.00 | $5.00 | 200K | 64K |

## Per-Agent Cost Profile

### Cost Estimate Per LLM Call

The `estimateCost()` function in `AgentLoop` uses a conservative estimate of 4000 input tokens and 2000 output tokens for budget reservation:

| Agent | Model | Estimated Cost/Call | Notes |
|-------|-------|-------------------|-------|
| orchestrator | Sonnet | $0.042 | Rarely makes LLM calls (routing is code-based) |
| strategist | Opus | $0.070 | Most expensive per call; skipped for fyi/noise |
| executor-triage | Haiku | $0.014 | Runs on every email |
| executor-responder | Haiku | $0.014 | Runs on action_required + needs_response |
| reviewer | Sonnet | $0.042 | Runs on every draft |
| architect | Sonnet | $0.042 | Once daily |

Formula: `(4000 * inputCostPer1M / 1,000,000) + (2000 * outputCostPer1M / 1,000,000)`

### Cost Per Email (Typical Pipeline)

A typical email flows through triage, and roughly 40-60% need a response:

| Scenario | Agents Involved | Estimated Cost |
|----------|----------------|---------------|
| Noise/FYI email | triage only | ~$0.004 |
| Needs response (no strategist) | triage + responder + reviewer | ~$0.060 |
| Needs response (with strategist) | triage + strategist + responder + reviewer | ~$0.130 |
| Action required (with strategist) | triage + strategist + responder + reviewer | ~$0.130 |

[UNVERIFIED] The average cost per email across all categories is approximately $0.004, which suggests the majority of inbound email is classified as fyi/noise. This figure would need to be verified against actual `llm_invocations` data in a production run.

### Daily Cost Projection

With a budget ceiling of $20/day:

| Volume | Estimated Daily Cost | Budget Utilization |
|--------|--------------------|--------------------|
| 50 emails (mostly fyi/noise) | ~$1-2 | 5-10% |
| 100 emails (30% needing response) | ~$3-5 | 15-25% |
| 200 emails (30% needing response) | ~$6-10 | 30-50% |

The $20 ceiling provides substantial headroom for typical inbox volumes.

## Budget Reservation Pattern

The budget system uses a three-phase pattern to prevent concurrent agents from overspending:

### Phase 1: Reserve

Before claiming a task, the agent reserves its estimated cost atomically:

```sql
-- agent_graph.reserve_budget(estimated_cost)
UPDATE agent_graph.budgets
  SET reserved_usd = reserved_usd + $estimated_cost
  WHERE scope = 'daily' AND period_start = CURRENT_DATE
    AND spent_usd + reserved_usd + $estimated_cost <= allocated_usd;
```

The `WHERE` clause is the critical concurrency control. If two agents try to reserve simultaneously and the combined reservation would exceed the budget, one will match zero rows and be denied. This prevents TOCTOU (time-of-check-time-of-use) races.

### Phase 2: Commit

After the LLM call completes, the reservation is converted to actual spend:

```sql
-- agent_graph.commit_budget(estimated_cost, actual_cost)
UPDATE agent_graph.budgets
  SET spent_usd = spent_usd + $actual_cost,
      reserved_usd = reserved_usd - $estimated_cost;
```

The difference between estimated and actual cost is freed back to the available pool.

### Phase 3: Release

On failure (handler throws, guard check fails), the reservation is released:

```sql
-- agent_graph.release_budget(estimated_cost)
UPDATE agent_graph.budgets
  SET reserved_usd = GREATEST(reserved_usd - $estimated_cost, 0);
```

### Database Safety Net

The `budgets_no_overspend` CHECK constraint provides a final backstop:

```sql
CONSTRAINT budgets_no_overspend CHECK (spent_usd + reserved_usd <= allocated_usd)
```

If application logic has a bug, the database rejects the transaction.

### Orphaned Reservation Recovery

The Reaper (`src/runtime/reaper.js`) runs every 60 seconds and recalculates `reserved_usd` based on the count of in-progress tasks. This cleans up reservations leaked by crashed agents that called `reserve_budget()` but never called `commit_budget()` or `release_budget()`.

## Daily Ceiling Enforcement (G1)

### Auto-Halt

When the daily budget is exhausted (`spent_usd >= allocated_usd`), `reserve_budget()` automatically inserts a financial halt signal:

```sql
INSERT INTO agent_graph.halt_signals (signal_type, reason, triggered_by)
VALUES ('financial', 'Daily budget ceiling reached', 'budget_guard');
```

This halts all agents immediately. The halt is checked every tick (with 2-second caching in the event bus).

### Warning Threshold

At 80% utilization (`spent_usd + reserved_usd > allocated_usd * 0.80`), a budget warning is surfaced in the guard check context. This warning does not block execution but can be used for alerting.

### Budget Reset

Daily budgets are scoped to `period_start = CURRENT_DATE`. A new budget row must be created for each day (typically via the seed or a scheduled job).

## Cost Tracking

Every LLM call is tracked in `agent_graph.llm_invocations`:

| Column | Purpose |
|--------|---------|
| `agent_id` | Which agent made the call |
| `task_id` | Which work item it was for |
| `model` | Model used |
| `input_tokens` | Actual input token count |
| `output_tokens` | Actual output token count |
| `cost_usd` | Computed cost |
| `latency_ms` | Response time |
| `prompt_hash` | SHA-256 of system prompt + user message (first 16 chars) |
| `response_hash` | SHA-256 of response text (first 16 chars) |
| `idempotency_key` | `{agentId}-{taskId}-{configHash}` (UNIQUE, prevents duplicate charges) |

### Cost Computation

Actual cost is computed from the API response token counts:

```javascript
computeCost(inputTokens, outputTokens) {
  return (inputTokens * modelConfig.inputCostPer1M / 1_000_000) +
         (outputTokens * modelConfig.outputCostPer1M / 1_000_000);
}
```

### Banker's Rounding

The database uses banker's rounding (`agent_graph.bankers_round()`) instead of Postgres's default `ROUND()` to avoid systematic rounding bias in cost accumulation. This is specified in spec section 12 (ROUND_HALF_EVEN).

## Cost Optimization Strategies

The architecture includes several cost-saving measures:

1. **Strategist skip for fyi/noise:** The Opus-tier strategist is skipped entirely for emails classified as fyi or noise, saving the most expensive per-call cost on 40-60% of emails.

2. **Haiku for execution:** Triage and response drafting use the cheapest model tier. Only routing (orchestrator), review, and strategy use more expensive models.

3. **Conservative token limits:** `maxTokens` is set per agent (2048 for triage, 4096 for most others) to avoid unnecessary output token spend.

4. **Idempotent retries:** The idempotency key on `llm_invocations` ensures that retried tasks do not produce duplicate API charges if the same agent/task/config combination is re-executed.

5. **120s timeout:** LLM calls have an AbortController timeout to prevent runaway costs from hung API calls.
