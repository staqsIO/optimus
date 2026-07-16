## 3. The Task Graph
### Why Not Email

v0.1 proposed email for inter-agent communication. The task graph preserves email's accountability properties (sender, timestamp, audit trail) while adding atomicity (single-transaction state changes), DAG cycle detection, idempotent processing, structured typed dispatch, and 3-5x lower token cost per message (~200 tokens for a structured task record vs 2,000-10,000 for an email thread).

Email remains in the system for humans — an event digest service pushes structured summaries to board members' preferred channels (P6).

### Schema: `agent_graph`

```
agent_graph schema (12 tables + 5 views):

  work_items            -- Nodes: directives, workstreams, tasks, subtasks
                        --   Fields: id, type, title, description, status,
                        --   assigned_to, created_by, parent_id, priority,
                        --   deadline, budget_usd, data_classification,
                        --   acceptance_criteria, routing_class,
                        --   routing_class_final, context_profile_json,
                        --   created_at, updated_at
  edges                 -- Typed DAG edges (decomposes_into, blocks, depends_on)
  state_transitions     -- Immutable audit log (partitioned by month)
                        --   Fields: id, work_item_id, from_state, to_state,
                        --   agent_id, config_hash, timestamp, reason,
                        --   guardrail_checks_json, cost_usd
  valid_transitions     -- State machine rules (e.g., assigned → in_progress,
                        --   in_progress → completed | failed | blocked)
  task_events           -- Outbox for event-driven dispatch
                        --   Claimed via FOR UPDATE SKIP LOCKED
  llm_invocations       -- Cost tracking per call
                        --   Fields: id, agent_id, model, input_tokens,
                        --   output_tokens, cost_usd, task_id, prompt_hash,
                        --   response_hash, latency_ms, idempotency_key
  budgets               -- Budget allocations per directive/workstream
  agent_configs         -- Agent configuration (model, prompt_hash, tools,
                        --   guardrails, can_assign_to, communication_style,
                        --   success_metrics, workflow_phases). Versioned by config_hash.
  agent_config_history  -- Immutable log of all config changes per agent
  strategic_decisions   -- Decision records from Strategy Evaluation Protocol (§19)
  threat_memory         -- Append-only threat event log with scope dimensions,
                        --   8-class taxonomy, graduated escalation (see §8)
  tolerance_config      -- Board-managed escalation thresholds per threat class
  v_budget_status       -- Real-time remaining budget (regular view, NOT materialized)
  v_routing_class_effectiveness
                        -- Misclassification rate by task type (see §8)
  v_context_block_correlation
                        -- Context blocks loaded vs task outcome (see §8)
  v_cost_per_task_type_trend
                        -- Weekly avg cost/tokens/latency per task type (see §8)
  v_agent_efficiency_comparison
                        -- Per-agent cost and success rate for same task type (see §8)

Key functions:
  transition_state()    -- Atomic: lock + validate + update + audit +
                        --   notify + publish to event_log
  claim_next_task()     -- Atomic: FOR UPDATE SKIP LOCKED
  would_create_cycle()  -- DAG cycle detection before edge INSERT
  current_escalation_level(scope_type, scope_id)
                        -- Returns 0-4 based on weighted unresolved threat
                        --   count within configurable time window (see §8)
```

### Work Item State Machine

The `valid_transitions` table enforces these states and transitions. No other transitions are permitted — `transition_state()` rejects any attempt not in this table.

**States:**

| State | Description |
|-------|-------------|
| `created` | Work item exists but is not yet assigned to an agent |
| `assigned` | Assigned to an agent, awaiting pickup |
| `in_progress` | Agent has claimed the task and is actively working |
| `review` | Work complete, awaiting Reviewer approval |
| `completed` | Accepted by reviewer or supervisor; output is final |
| `failed` | Exhausted retries (max 3) or marked by supervisor |
| `blocked` | Waiting on a dependency (`depends_on` or `blocks` edge) |
| `cancelled` | Cancelled by board directive or HALT protocol |
| `timed_out` | Exceeded per-tier time limit; eligible for re-queue |

**Transitions:**

```
created ──→ assigned ──→ in_progress ──→ review ──→ completed
   │            │              │            │
   │            │              ├──→ failed   ├──→ in_progress (revision)
   │            │              │
   │            │              ├──→ blocked ──→ in_progress (unblocked)
   │            │              │
   │            │              └──→ timed_out ──→ assigned (re-queue)
   │            │
   │            └──→ cancelled
   │
   └──→ cancelled

failed ──→ assigned (retry, max 3)
```

**Key rules:**
- `completed` and `cancelled` are terminal — no outbound transitions
- `failed → assigned` only if retry count < 3; on 4th failure, `failed` is terminal and escalates to supervisor
- `blocked → in_progress` only when all blocking dependencies reach `completed`
- `timed_out → assigned` re-queues to the same or different agent (configurable)
- Every transition writes to `state_transitions` (immutable audit log) and emits to `task_events` (outbox)
- `review` state is optional for tasks with `data_classification` ≤ INTERNAL and `budget_usd` ≤ role median (low-risk operational tasks) — they transition directly `in_progress → completed`. The Orchestrator determines review eligibility at task creation based on these fields; agents cannot self-classify to skip review.

### Task Routing

At the current scale (5-15 agents), routing is a static configuration — an O(1) hash map lookup:

```json
{
  "task_routing": {
    "strategic_planning":    ["strategist"],
    "architecture_design":   ["architect"],
    "task_decomposition":    ["orchestrator-eng", "orchestrator-product"],
    "code_review":           ["reviewer-backend", "reviewer-frontend"],
    "code_implementation":   ["executor-01", "executor-02", "executor-03"],
    "test_generation":       ["executor-02", "executor-03"],
    "code_scan":             ["executor-01", "executor-02", "executor-03"]
  }
}
```

Upgrade to scoring-based matching when agent count exceeds 15.

### Cost-Aware Routing

The tier-based model assignment (Opus for Strategist, Sonnet for Orchestrator, Haiku for Executor) is the correct baseline, but not every task within a tier requires an LLM call. The ecosystem pattern emerging from ruflo/claude-flow and GitHub Agentic Workflows is to route each request to the cheapest handler that can do the job:

**Routing hierarchy (cheapest first):**

1. **Deterministic bypass** — if the task matches a known deterministic template (e.g., Service Specification Language compile from §18, format conversion, schema validation), execute without any LLM invocation. Cost: $0. The SSL compiler already handles ~80% of standard CRUD services deterministically; this routing layer makes that bypass explicit rather than implicit.

2. **Smallest viable model** — for tasks that require some reasoning but not full-tier capability (e.g., simple code formatting, test boilerplate generation, documentation updates), route to the tier's `fallback_model` instead of the primary model. This is already supported by the `fallback_model` field in agent configs — cost-aware routing activates it proactively rather than only on primary model failure.

3. **Full-tier model** — complex tasks that require the tier's primary model.

**Implementation:** The Orchestrator classifies each task at creation time using a lightweight heuristic (pattern matching on task type + acceptance criteria complexity, not an LLM call). Classification is stored on the work item as `routing_class` (DETERMINISTIC / LIGHTWEIGHT / FULL). The orchestration layer uses `routing_class` to select the execution path. Misclassification is caught by the Reviewer — if a DETERMINISTIC or LIGHTWEIGHT task fails review, it is re-queued at the next routing class up.

**Pathway instrumentation:** Two additional columns on `work_items` support routing effectiveness measurement (P5):
- `routing_class_final` — the routing class that actually completed the task. If a DETERMINISTIC task failed and was re-queued as LIGHTWEIGHT, this records LIGHTWEIGHT. Tracks misclassification rate.
- `context_profile_json` — JSONB recording which context blocks were loaded and their token counts (e.g., `{"agent_identity": 520, "task_details": 340, "parent_summary": 280, "prior_work_search": 0, "total_context_tokens": 1140}`). Populated by the orchestration layer at context-loading time (step 4), not by agents. Read-only to agents.

These columns feed the pathway analytical views in §8.

**Cost impact:** At Phase 1 volumes (100-300 executor tasks/day), if 30-40% of executor tasks can be handled deterministically and another 20-30% via fallback models, the executor cost line drops from $40-80/month to $15-35/month. The savings scale with volume.

### Agent Configuration

Agent definitions in `agents.md` compile to JSON config stored in `agent_configs`. The schema includes behavioral contracts for scored validation and progress tracking:

**Required fields per agent:**
- `identity` — role, responsibilities, capabilities
- `boundaries` — what the agent cannot or should not do
- `tools` — available functions and their usage constraints
- `delegation_rules` — when and how to route tasks to other agents
- `anti_patterns` — common failure modes and how to avoid them
- `communication_style` — output format and tone requirements for Reviewer validation
- `success_metrics` — measurable performance criteria for capability gate assessments
- `workflow_phases` — internal execution state progression with timing constraints

**Communication style specification:**
```yaml
communication_style:
  tone: analytical         # analytical | advisory | direct | conversational
  output_format: structured  # structured | prose | mixed
  framing: recommendation-first  # recommendation-first | evidence-first | options-list
  vocabulary_constraints:
    - "Never use hedging language ('might', 'perhaps') in triage classifications"
    - "Always cite specific gate IDs when flagging guardrail issues"
```

**Success metrics specification:**
```yaml
success_metrics:
  - metric: triage_accuracy
    description: "Classification matches human-corrected label"
    target: ">= 0.92"
    measurement: "Weekly sample of 50 triaged items vs board corrections"
  - metric: draft_approval_rate
    description: "Drafts approved without edit by board"
    target: ">= 0.85"
    measurement: "Rolling 14-day window"
```

**Workflow phases specification:**
```yaml
workflow_phases:
  - phase: context_load
    description: "Fetch voice profile + select few-shot examples"
    max_duration_ms: 5000
  - phase: draft
    description: "Generate response using loaded context"
    max_duration_ms: 15000
  - phase: self_check
    description: "Score draft against tone threshold before submission"
    max_duration_ms: 3000
    gate: "tone_score >= 0.80 or escalate"
```

The Reviewer loads the target agent's `communication_style` and `success_metrics` as evaluation criteria. The Orchestrator uses `workflow_phases` for progress tracking and timeout detection. Phase duration limits are advisory in Phase 1 (logged but not enforced).

Agent identity context grows from ~500 tokens to ~800-1,000 tokens with behavioral contracts included.