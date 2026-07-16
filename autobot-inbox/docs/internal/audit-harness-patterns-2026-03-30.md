# Harness Pattern Audit: Optimus vs Anthropic Research

**Date:** 2026-03-30
**Auditor:** Liotta (Systems Architect)
**Priority ranking:** Gap 1 > Gap 3 > Gap 2

---

## Gap 1: Generator-Evaluator Loop — ADOPT (High Priority)

### Current State

The reviewer agent (`src/agents/reviewer.js`) is **not a generator-evaluator loop at all**. It is a deterministic gate checker — regex scans (G2, G7), pgvector cosine similarity (G3), rate limiting (G6), reply-all detection (G5). Zero LLM calls. One pass, binary verdict: approved/flagged/rejected.

The state machine already supports `review -> in_progress` (line 3953 of `001-baseline.sql`), meaning the infrastructure for iteration cycles exists but is **never exercised**. The reviewer transitions to `completed` after a single gate check, never sends work back to the executor for revision.

### Leverage Analysis

The 10x insight: **you already have the iteration infrastructure, you just never close the loop**.

The valid_transitions table includes `review -> in_progress`, which means an executor can receive its own work back. The hash chain will extend correctly because `transition_state()` computes incrementally from the previous entry. The `campaign_iterations` table and the `agent_activity_steps` hierarchy already model multi-round execution with iteration numbers and parent-child step relationships.

The missing piece is not infrastructure — it is a **contract negotiation phase** before execution starts and a **bounded iteration counter** to prevent runaway loops.

### Proposed Architecture: Sprint Contracts

```
Orchestrator creates work_item with:
  - acceptance_criteria (already exists in work_items schema)
  - max_review_rounds (new column, default 1, max 3)
  - review_round (new column, tracks current iteration)

State flow:
  created -> assigned -> in_progress -> review
                                          |
                         review_round < max? -> in_progress (revision)
                                          |
                         review_round >= max? -> completed (best-effort) OR escalate
```

### Implementation (Minimal Surface Area)

1. **Schema change** — 2 columns on `work_items`:
   - `review_round INTEGER NOT NULL DEFAULT 0`
   - `max_review_rounds INTEGER NOT NULL DEFAULT 1`

2. **Reviewer change** — When verdict is `rejected` AND `review_round < max_review_rounds`:
   - Increment `review_round`
   - Transition `review -> in_progress`
   - Emit `task_revision_needed` event with structured feedback (which gates failed, why)
   - The executor picks up the revision task with the feedback injected into context

3. **Guard rails** (P2 enforcement):
   - `max_review_rounds` capped at 3 via CHECK constraint (infrastructure enforces, not prompts)
   - Each round's cost counted against G1 budget (already automatic via `callLLM` tracking)
   - `delegation_depth` gate already prevents unbounded chains

4. **No change needed to:**
   - Hash chain (extends naturally)
   - `valid_transitions` (`review -> in_progress` already exists)
   - `agent_activity_steps` (already supports iteration_number)

### Risk Assessment

- **Blast radius:** LOW. Only touches reviewer.js and context-loader.js (to inject feedback). State machine transitions already permitted. Schema change is additive (new columns with defaults).
- **Infinite loop prevention:** CHECK constraint `max_review_rounds <= 3` + guard check in reviewer that refuses to iterate beyond the limit. This is P2 compliant — the constraint is in Postgres, not in the prompt.
- **Rollback:** Set `max_review_rounds = 1` for all work items to restore current behavior (single-pass review).

### Why This Matters for Phase 1

The current pipeline produces drafts that fail G3 (tone) and get rejected. Those rejections are terminal — the email sits unprocessed until a human intervenes or the executor happens to produce a passing draft on the next email. With bounded iteration, tone mismatches self-correct through feedback, reducing board intervention by an estimated 30-50% for tone-related rejections.

### P1-P6 Compliance

- P1 (deny by default): Iterations default to 1 (current behavior). Multi-round must be explicitly enabled per work item type.
- P2 (infrastructure enforces): CHECK constraint caps iterations. Guard check enforces budget per round. No prompt-level enforcement.
- P3 (transparency by structure): Each round is a separate `state_transitions` entry with hash chain continuity. `agent_activity_steps` logs each iteration.
- P5 (measure before trust): Track revision success rate (did round 2 fix the G3 failure?). Gate L1 autonomy on iteration effectiveness data.

---

## Gap 2: Progress Artifacts — DO NOT ADOPT (Low Priority)

### Current State

Optimus already has **something strictly better** than the harness pattern's checkpoint files:

1. **`agent_activity_steps`** — hierarchical, append-only, with parent-child relationships, timestamps, metadata JSONB, campaign_id, iteration_number. This is a structured progress log that checkpoint files aspire to be.

2. **`state_transitions`** — hash-chained, immutable audit trail of every state change. This is the tamper-evident equivalent of a progress file, but with cryptographic integrity.

3. **Board Workstation** (dashboard at port 3200) — the "human-readable export view" question is already answered. The Next.js dashboard materializes activity_steps and state_transitions into a visual timeline. This IS the checkpoint file, rendered as a UI.

### Why Checkpoint Files Would Be a Regression

The harness pattern uses `feature_list.json` and `claude-progress.txt` because those agents run in ephemeral sandboxes with no persistent structured storage. Optimus has Postgres. Adding file-based checkpoints would:

- Create a second source of truth (P3 violation — transparency by structure means ONE structure)
- Require synchronization logic between files and DB (complexity for no gain)
- Be less queryable, less auditable, and less durable than Postgres

### One Improvement Worth Making

The `agent_activity_steps` table should expose a **materialized summary view** for cross-session handoff. Currently, an agent resuming work on a task must reconstruct context by querying raw steps. A view like:

```sql
CREATE VIEW agent_graph.task_progress_summary AS
SELECT
  work_item_id,
  count(*) as total_steps,
  count(*) FILTER (WHERE status = 'completed') as completed_steps,
  max(completed_at) as last_activity,
  jsonb_agg(
    jsonb_build_object('step', description, 'status', status, 'agent', agent_id)
    ORDER BY created_at
  ) FILTER (WHERE depth = 0) as top_level_steps
FROM agent_graph.agent_activity_steps
GROUP BY work_item_id;
```

This gives any agent a single-query progress snapshot — no file I/O, no sync, no second source of truth. The dashboard can also use this view for its timeline rendering.

### P1-P6 Compliance

- Adding checkpoint files would violate P3 (transparency by structure) and P4 (boring infrastructure — Postgres already does this).
- The summary view is pure P4: a SQL view over existing data.

---

## Gap 3: Context Anxiety Mitigation — ADOPT FOR HAIKU ONLY (Medium Priority)

### Current State

- `callLLM()` in `agent-loop.js` tracks `inputTokens` and `outputTokens` per invocation, logged to `llm_invocations`
- `context_profile_json` exists as a spec concept but is not actively used for mid-task context management
- Tier-specific timeouts: 120s hard abort via AbortController in `callLLM()`
- No proactive context trimming or summarization-detection

### Leverage Analysis

With Opus 4.6 at 1M context, Orchestrator/Strategist/Architect agents are **not context-constrained**. Their tasks (email triage coordination, priority scoring, pipeline analysis) produce context windows well under 100K tokens. Context anxiety is a non-issue for higher-tier agents.

Haiku executors are a different story. Their `maxTokens` is capped (config-driven), they process email bodies that can be arbitrarily long, and the LIGHTWEIGHT routing class already reduces output tokens to 1024. But there is no input-side management — a long email thread could consume most of the executor's context window before the system prompt and few-shot examples even load.

### The 10x Solution: Context Budget as a Pre-Execution Gate

Instead of mid-task context refresh (complex, error-prone, requires the agent to detect its own degradation), enforce a **context budget at context load time**:

```javascript
// In context-loader.js, before returning context to the agent:
const contextBudget = agentConfig.maxInputTokens || 8000; // Haiku default
const estimatedTokens = estimateTokenCount(systemPrompt + userMessage);

if (estimatedTokens > contextBudget * 0.8) {
  // Truncate email body to fit, preserving most recent messages
  context.emailBody = truncateToTokenBudget(
    context.emailBody,
    contextBudget - estimatedTokens + emailBodyTokens
  );
  context.truncated = true; // Flag for audit
}
```

This is the constraint-programming approach: don't detect degradation at runtime — make it impossible to occur by construction. The token estimator is a simple `ceil(chars / 4)` heuristic (P4: boring, good enough for budget gating).

### Why NOT Mid-Task Context Refresh

Mid-task refresh requires:
1. Detecting summarization behavior (unreliable — you're asking the model to notice its own degradation)
2. Serializing partial state
3. Re-prompting with compressed context
4. Verifying continuity of output

This is 4 failure modes for a problem that affects only Haiku executors on long email threads. The pre-execution gate has zero failure modes — it is a pure function that runs before the LLM call.

### Implementation

1. **`context-loader.js`** — Add token budget enforcement before returning context
2. **`config/agents.json`** — Add `maxInputTokens` per agent (Haiku: 8000, Sonnet: 32000, Opus: 200000)
3. **`agent_activity_steps`** — Log when truncation occurs (`context.truncated = true`) for observability

### Risk Assessment

- **Blast radius:** Minimal. Only affects context assembly, not state machine or agent logic.
- **False truncation:** If the heuristic over-estimates tokens, we truncate unnecessarily. Mitigation: use 0.8x safety margin and log all truncations for calibration.
- **Rollback:** Remove the budget check from context-loader.js. No schema changes needed.

### P1-P6 Compliance

- P2 (infrastructure enforces): The context budget is enforced in the loader, not by asking the agent to self-limit.
- P5 (measure before trust): Log all truncation events. Track whether truncated tasks have higher failure rates. Gate removal of truncation on data.

---

## Priority Summary for Phase 1

| Gap | Verdict | Effort | Impact | Recommendation |
|-----|---------|--------|--------|----------------|
| 1: Generator-Evaluator | ADOPT | 2 days | HIGH — reduces board intervention on tone failures by 30-50% | Add `review_round`/`max_review_rounds` columns, modify reviewer to iterate on rejections |
| 2: Progress Artifacts | SKIP | 0.5 days | LOW — existing infrastructure already exceeds harness pattern | Add `task_progress_summary` SQL view only |
| 3: Context Anxiety | ADOPT (Haiku only) | 1 day | MEDIUM — prevents silent degradation on long email threads | Pre-execution context budget gate in context-loader.js |

### What Optimus Has That the Harness Pattern Doesn't

1. **Hash-chained state transitions** — the harness uses flat checkpoint files with no integrity verification. Optimus has cryptographic audit trails. This is strictly superior for a governed agent organization.

2. **Infrastructure-enforced guardrails** — the harness relies on prompt-level constraints ("you have N attempts remaining"). Optimus has Postgres CHECK constraints, valid_transitions table, and guard-check.js running in the same transaction as state changes. P2 is alive and well.

3. **Hierarchical activity logging** — `agent_activity_steps` with parent-child relationships already provides the cross-agent visibility that harness checkpoint files attempt to provide, but with queryable structure instead of flat text.

4. **Budget atomicity** — the harness has no concept of cost tracking per iteration. Optimus has `reserve_campaign_budget()`, `commit_budget()`, and `release_budget()` running inside transactions. Each review round's cost is automatically tracked.

The harness patterns are designed for **single-agent, ephemeral-sandbox** workflows. Optimus is a **multi-agent, persistent-state** organization. The patterns that transfer are the ones about bounded iteration (Gap 1) and defensive context management (Gap 3). The ones that don't transfer are file-based checkpointing (Gap 2), which is a workaround for not having a database.
