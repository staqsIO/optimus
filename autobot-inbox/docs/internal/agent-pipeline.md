---
title: "Agent Pipeline"
description: "Detailed agent pipeline: models, routing logic, event-driven task graph pattern"
---

# Agent Pipeline

## Pipeline Overview

Six agents process each inbound email through a Postgres task DAG. The orchestrator routes work based on triage results. No agent framework is used -- each agent is an `AgentLoop` instance running a `while(running)` loop against the same Postgres task queue.

```
Gmail API
  |
  v
[Orchestrator] ---> creates work item ---> [Executor-Triage]
  ^                                              |
  |                                    stores triage_result in
  |                                    work_item.metadata, then
  |                                    emits state_changed
  |                                              |
  +--- reads triage_result, routes: ------------>+
  |                                              |
  |    category = action_required/needs_response |
  |    AND needs_strategist = true               |
  |         |                                    |
  |         v                                    |
  |    [Strategist] ---> stores strategy ---->   |
  |                      creates responder task  |
  |                                              |
  |    category = action_required/needs_response |
  |    AND needs_strategist = false              |
  |         |                                    |
  |         +-----> [Executor-Responder]         |
  |                        |                     |
  |                 creates draft in inbox.drafts |
  |                 creates reviewer task         |
  |                        |                     |
  |                        v                     |
  |                  [Reviewer]                  |
  |                        |                     |
  |            verdict: approved/flagged          |
  |                 emit approval_needed          |
  |                        |                     |
  |                        v                     |
  |                  [Board (Human)]             |
  |                  via CLI/Dashboard           |
  |                                              |
  |    category = fyi/noise                      |
  |         (no further pipeline action)         |
  |                                              |
  +----------------------------------------------+

[Architect] --- runs daily at 06:00 --- generates briefing
[Reaper]   --- runs every 60s --------- recovers stuck tasks
```

### Channel Abstraction

Agent handlers no longer access Gmail directly. Channel I/O is abstracted through InputAdapter and OutputAdapter interfaces (`src/adapters/`). Each adapter provides `fetchContent()` (retrieves message body), `buildPromptContext()` (builds structured context for prompts), `createDraft()`, and `executeDraft()`. This allows the same agent pipeline to process messages from email, Slack, or future channels without modifying agent code. See [System Architecture](./system-architecture.md) for adapter details.

## Agent Details

### Orchestrator

| Property | Value |
|----------|-------|
| Model | claude-sonnet-4-6 |
| Max tokens | 4096 |
| Temperature | 0.3 |
| Tools | gmail_poll, gmail_fetch, task_create, task_assign |
| Guardrails | G1 |
| Poll interval | 60s |

**Role:** The orchestrator has two responsibilities:

1. **Gmail polling** -- Runs as a `setInterval` (60s). Fetches new messages, inserts email metadata into `inbox.emails`, and creates a top-level work item assigned to itself. Skips emails from the inbox owner (outbound mail).

2. **Pipeline routing** -- Handles `task_assigned` events (processes the email by creating a triage subtask) and `state_changed` events (routes completed triage results based on category and priority score).

**Routing logic** (from `handleStateChanged`):

```
IF triage.category IN (action_required, needs_response):
  IF triage.needs_strategist:
    create subtask -> strategist
  ELSE:
    create subtask -> executor-responder
ELSE (fyi, noise):
  no further routing
```

The `needs_strategist` flag is set by the triage agent when `quickScore >= 60`, the contact is VIP, or the subject contains urgency keywords.

Source: `src/agents/orchestrator.js`

### Executor-Triage

| Property | Value |
|----------|-------|
| Model | claude-haiku-4-5-20251001 |
| Max tokens | 2048 |
| Temperature | 0.2 |
| Tools | gmail_fetch, task_update, signal_extract |
| Guardrails | G1 |

**Role:** Classifies each email into one of four categories and extracts structured signals.

**Categories:** `action_required`, `needs_response`, `fyi`, `noise`

**Input:** Email metadata from `inbox.emails` + body fetched on-demand from Gmail API (D1).

**Output:**
- Updates `inbox.emails` with `triage_category` and `triage_confidence`
- Inserts extracted signals into `inbox.signals` (commitments, deadlines, action items, questions, decisions, introductions, requests)
- Upserts contact in `signal.contacts`
- Stores routing hints (`triage_result`) in `agent_graph.work_items.metadata` for the orchestrator

**Prompt injection defense:** Email content is wrapped in `<untrusted_email>` tags with an explicit instruction to ignore all instructions inside the email body.

**Auto-archive:** Noise emails are archived immediately (`inbox.emails.archived_at`).

Source: `src/agents/executor-triage.js`

### Strategist

| Property | Value |
|----------|-------|
| Model | claude-opus-4-6 |
| Max tokens | 4096 |
| Temperature | 0.5 |
| Tools | task_read, gmail_fetch, signal_query, voice_query |
| Guardrails | G1, G7 |
| Mode | suggest (recommends, board decides) |
| Skip for | fyi, noise |

**Role:** Provides strategic assessment for high-priority emails. Determines priority score (0-100), response strategy, tone guidance, and urgency level. Skipped entirely for fyi/noise to save cost.

**Output:**
- Stores a `strategic_decisions` record with `decision_type` (tactical/strategic/existential), `recommendation` (proceed/defer/reject/escalate), and `perspective_scores` containing the full strategy
- Updates `inbox.emails.priority_score`
- Creates an `executor-responder` subtask for emails needing a response, passing the strategy as metadata

**Cost note:** This is the most expensive agent (Opus tier). Skipping it for fyi/noise saves approximately 60%+ of Opus costs.

Source: `src/agents/strategist.js`

### Executor-Responder

| Property | Value |
|----------|-------|
| Model | claude-haiku-4-5-20251001 |
| Max tokens | 4096 |
| Temperature | 0.7 |
| Tools | gmail_fetch, voice_query, draft_create |
| Guardrails | G1, G2, G3, G5 |

**Role:** Drafts email replies in the inbox owner's voice using voice profiles and few-shot examples.

**Input:**
- Email body fetched on-demand from Gmail (D1)
- Voice profile from `voice.profiles` (recipient-specific, falls back to global)
- 3-5 few-shot examples selected by: same recipient (60%), subject similarity (trigram), vector similarity (pgvector)
- Strategy guidance from strategist (if available in work item metadata)

**Output:**
- Inserts draft into `inbox.drafts` with tone_score, few_shot_ids, voice_profile_id
- Creates a `reviewer` subtask

**Prompt rules enforced in the prompt:**
- Match Eric's tone, vocabulary, and response patterns
- Never make commitments (G2)
- Never agree to contracts or binding terms (G2)
- Keep response length similar to examples

Source: `src/agents/executor-responder.js`

### Reviewer

| Property | Value |
|----------|-------|
| Model | claude-sonnet-4-6 |
| Max tokens | 4096 |
| Temperature | 0.3 |
| Tools | draft_read, voice_query, gate_check |
| Guardrails | G1, G2, G3, G5, G6, G7 |

**Role:** Final gate check on drafts before they reach the board. Runs both automated gate checks (`checkDraftGates`) and LLM-based review.

**Two-phase check:**

1. **Automated gates** (`checkDraftGates` in `guard-check.js`):
   - G2: Regex scan for commitment/contract language
   - G3: pgvector cosine similarity against sent email corpus (min 0.80)
   - G5: Recipient count check, reply-all flag
   - G6: Per-recipient-per-day rate limit (max 3)
   - G7: Regex scan for pricing/timeline/policy patterns

2. **LLM review** (Sonnet): Evaluates nuanced tone, subtle commitment language, and overall quality.

**One-way merge (Fix 7):** Automated gate failures are authoritative. The LLM can refine passing gates but cannot override automated failures. This prevents the LLM from "talking itself into" approving a dangerous draft.

**Output:**
- Updates `inbox.drafts` with `reviewer_verdict` (approved/rejected/flagged), `reviewer_notes`, `gate_results`, `tone_score`
- If not rejected: sets `send_state = 'reviewed'` and emits `approval_needed` event to the board

Source: `src/agents/reviewer.js`

### Architect

| Property | Value |
|----------|-------|
| Model | claude-sonnet-4-6 |
| Max tokens | 8192 |
| Temperature | 0.5 |
| Tools | task_read, signal_query, stats_query, briefing_create |
| Guardrails | G1 |
| Schedule | Daily at 06:00 |

**Role:** Daily pipeline analysis and briefing generation. Analyzes throughput, cost, voice learning progress, and autonomy readiness.

**Output:**
- Stores briefing in `signal.briefings` with summary, action items, signals, trending topics, VIP activity
- Evaluates L0 exit criteria via `evaluateAutonomy()`
- Sends daily digest email to the inbox owner

Source: `src/agents/architect.js`

### Config-Driven Agent Selection

Agent configuration is defined in `config/agents.json`. The runtime reads this file at startup and instantiates only agents with `"enabled": true`. Each agent entry specifies model, max tokens, temperature, tools, guardrails, hierarchy, and schedule. This supports per-instance configuration — different installations can enable different subsets of agents by editing the config file rather than modifying code.

Source: `config/agents.json`, PR #22

## Event-Driven Task Graph Pattern

### How Tasks Flow

1. **Task creation:** `createWorkItem()` inserts a row into `agent_graph.work_items` (status: `created`) and a `task_assigned` event into `agent_graph.task_events`.

2. **Task claiming:** `claim_next_task()` SQL function uses `SELECT ... FOR UPDATE SKIP LOCKED` to atomically claim the highest-priority unprocessed event for the target agent. This prevents two agents from claiming the same task.

3. **Atomic claim + guard + transition:** `claimAndStart()` wraps three operations in one transaction:
   - Claim the task event (SKIP LOCKED)
   - Run `guardCheck()` (budget reservation, halt check, config hash, assignment validation, data classification, constitutional evaluation)
   - Transition to `in_progress`

   If the guard check fails, the task transitions to `blocked` within the same transaction.

4. **Execution:** The agent-specific handler runs (LLM call with 120s AbortController timeout).

5. **Post-execution checks:** Validates result shape, verifies subtask assignments reference valid agents, checks quarantine status.

6. **State transition:** `transitionState()` runs within a transaction:
   - Locks the work item (`FOR UPDATE NOWAIT`)
   - Validates the transition against `valid_transitions` table
   - Updates work item status
   - Inserts an append-only `state_transitions` record with hash chain
   - Emits a `state_changed` event

### State Machine

Valid states: `created`, `assigned`, `in_progress`, `review`, `completed`, `failed`, `blocked`, `timed_out`, `cancelled`

```
created --> assigned --> in_progress --> completed
  |                        |    |
  |                        |    +--> failed
  |                        |    |
  |                        |    +--> blocked --> in_progress (retry)
  |                        |    |
  |                        |    +--> timed_out --> assigned (reaper retry)
  |                        |    |
  |                        |    +--> review --> completed
  |                        |              +--> in_progress (rework)
  |                        |              +--> cancelled
  |                        |
  +-- cancelled (from any non-terminal state)
```

See [Database Architecture](./database-architecture.md) for the full valid transitions table.

### Wake-Up Mechanism

Agents sleep up to 10 seconds between tasks. They wake up instantly when:

- A `task_events` row targeting them is inserted (via EventEmitter in-process dispatch)
- A `pg_notify` notification arrives on `autobot_events` (real Postgres mode)

This means latency from email arrival to triage start is bounded by the Gmail poll interval (60s) plus near-zero dispatch time, not by a sleep/poll cycle.

### Idempotency

LLM invocations use a deterministic idempotency key: `{agentId}-{taskId}-{configHash}`. The `llm_invocations` table has a `UNIQUE` constraint on `idempotency_key` with `ON CONFLICT DO NOTHING`, so retried tasks do not produce duplicate API calls if the same agent/task/config combination is re-executed.

Source: `src/runtime/agent-loop.js` (`callLLM`)
