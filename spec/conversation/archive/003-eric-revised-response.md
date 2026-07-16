# Agent Organization Architecture — Response & Proposed Revision

> **From:** Eric (Formul8 / Staqs.io)
> **Re:** Agent Organization Architecture — Specification Draft v0.1
> **Date:** 2026-02-25
> **Purpose:** Constructive critique and proposed modernization of the architecture. Intended to continue the dialog, not kill it.

---

## Executive Summary

The original spec identifies a real gap in the market: **governance, accountability, and organizational structure for multi-agent systems.** That thesis is correct and underbuilt across the industry. The hierarchy model, budget controls, HALT protocol, escalation triggers, and mixed-model tiering are all strong ideas worth pursuing.

Where the spec needs revision is the **communication substrate.** Email conflates three orthogonal concerns — task dispatch, state machine transitions, and audit trail — and handles all three poorly for agent systems. This response proposes replacing email with a **Postgres-backed task graph orchestration layer** — preserving every governance benefit while eliminating the latency, parsing overhead, and information retrieval limitations of SMTP.

The goal: keep what's working, modernize the plumbing, specify the failure modes and governance enforcement that both documents need, and produce something that's buildable in phases.

---

## What We're Keeping (And Why)

### Hierarchical Decomposition

The top-down directive -> decomposition -> delegation -> execution -> aggregation -> reporting flow is sound. This mirrors how real work gets done and creates natural checkpoints for quality and governance.

**Refinement:** The hierarchy should be **function-based, not title-based.** "CEO Agent" and "VP Eng Agent" are metaphors that map to human orgs but don't describe what the agents actually *do*. Better to name them by function:

| Original Title | Proposed Role | Function |
|----------------|---------------|----------|
| CEO Agent | **Strategist** | Interprets directives, decomposes into workstreams, synthesizes results |
| CTO Agent | **Architect** | Makes technical decisions, evaluates tradeoffs, defines constraints |
| VP Eng Agent | **Orchestrator** | Breaks workstreams into tasks, assigns to workers, aggregates output |
| Tech Lead Agent | **Reviewer** | Validates worker output against acceptance criteria and standards |
| Worker Agent | **Executor** | Performs well-scoped tasks with clear inputs and outputs |

This removes the corporate cosplay while preserving the functional hierarchy. An Orchestrator doesn't need a VP title to decompose tasks — it needs a clear mandate, a roster of available Executors, and acceptance criteria to validate against.

### Mixed-Model Tiering

Using Claude for reasoning-heavy roles and local models (Ollama) for mechanical tasks is economically correct. The tiering table from the original spec is solid.

**Refinement:** Task-to-agent routing should use a **static config file** rather than a dynamic capability registry. At 5-10 agents, the matching problem is an O(1) hash map lookup — there is no combinatorial explosion that warrants a registry service:

```json
{
  "task_routing": {
    "strategic_planning": ["strategist"],
    "architecture_design": ["architect"],
    "task_decomposition": ["orchestrator-eng", "orchestrator-product"],
    "code_review": ["reviewer-backend", "reviewer-frontend"],
    "code_implementation": ["executor-01", "executor-02", "executor-03"],
    "test_generation": ["executor-02", "executor-03"],
    "code_scan": ["executor-01", "executor-02", "executor-03"]
  }
}
```

When agent count exceeds ~15 with overlapping capabilities, introduce a scoring function where agents declare capabilities with confidence levels and the dispatcher selects the highest-scoring available agent. Until then, the config file is the single source of truth for "which agent handles what" — trivially debuggable, zero ambiguity.

### Governance & Guardrails

The guardrail cascade (org-level -> role-level -> task-level) is the most valuable part of the original spec. The HALT protocol, budget tracking, escalation triggers, and forbidden action lists are all production-worthy ideas.

**Kept and specified in detail below** (Sections: Guardrail Enforcement, HALT Protocol, Agent Authorization, Data Classification):
- Organizational guardrails (max spend, no external comms, no unauthorized deploys)
- Role-level constraints (delegation limits, approval thresholds, escalation triggers)
- Worker-level restrictions (reply-only, no production access, token limits)
- HALT / RESUME protocol (expanded with hard/soft modes and acknowledgment)
- Cost tracking with budget pre-authorization

### Human Board Oversight

Humans set strategy, define ethics, control budgets, maintain legal accountability. Agents execute. This separation is correct and non-negotiable.

---

## What We're Replacing (And Why)

### Email as Communication Protocol -> Task Graph Orchestration

Email conflates three orthogonal concerns:

1. **Task dispatch** (telling an agent what to do) — Email requires O(n) inbox polling + NLP parsing per agent. A structured task graph handles this with O(1) dispatch via queue + capability match.
2. **State machine transitions** (tracking where work is in a pipeline) — Email has read/unread. Tasks need: draft -> ready -> in_progress -> in_review -> done / blocked / failed. A task graph provides explicit state machines with enforced valid transitions.
3. **Audit trail** (recording what happened and why) — Email stores unstructured text in per-agent inboxes that require parsing to answer "what happened?" A structured event log is queryable, aggregatable, and dashboardable.

The task graph strictly dominates email on all three axes. The only thing email adds is human readability for non-technical observers, which is better served by a generated dashboard view over the structured data.

**The provenance argument:** Every property the spec attributes to email — sender, recipient, timestamp, threading, searchability, audit trail — is a property of **any structured event log.** A row in a task system has identical provenance without the overhead.

### Proposed Replacement: Structured Task Graph

The communication layer becomes a **task graph** where:

- **Nodes** are work items (directives, workstreams, tasks, subtasks) with typed state
- **Edges** are typed relationships (decomposes_into, blocks, depends_on, assigned_to, reviewed_by)
- **State transitions** are logged immutably (who, what, when, from_state, to_state, reason, authorization_evidence)
- **Events** trigger agent activation (outbox pattern with pg_notify as low-latency hint)

```
+-----------------------------------------------------------------+
|                    TASK GRAPH STRUCTURE                          |
|                                                                 |
|  [DIRECTIVE-001] "Expand into healthcare vertical"              |
|    +-- status: in_progress                                      |
|    +-- owner: strategist                                        |
|    +-- budget: $50K                                             |
|    +-- data_classification: CONFIDENTIAL                        |
|    +-- created_by: board (human)                                |
|    |                                                            |
|    +-- [WORKSTREAM-001] "Product requirements"                  |
|    |     +-- owner: strategist -> assigned: product-agent       |
|    |     +-- status: complete                                   |
|    |     +-- output: {structured findings}                      |
|    |                                                            |
|    +-- [WORKSTREAM-002] "HIPAA architecture review"             |
|    |     +-- owner: architect                                   |
|    |     +-- status: in_progress                                |
|    |     +-- data_classification: REGULATED (HIPAA)             |
|    |     |                                                      |
|    |     +-- [TASK-001] "Audit codebase for PHI"                |
|    |     |     +-- assigned: executor-01, executor-02           |
|    |     |     +-- status: complete                             |
|    |     |     +-- output: {phi_audit_results}                  |
|    |     |     +-- reviewed_by: reviewer-backend                |
|    |     |                                                      |
|    |     +-- [TASK-002] "Encryption gap analysis"               |
|    |           +-- assigned: executor-03                        |
|    |           +-- status: blocked                              |
|    |           +-- depends_on: [TASK-001]                       |
|    |                                                            |
|    +-- [WORKSTREAM-003] "Engineering capacity plan"             |
|          +-- owner: orchestrator                                |
|          +-- status: waiting                                    |
|                                                                 |
|  Every state transition is an immutable audit log entry:        |
|  {who, what, when, from_state, to_state, reason,               |
|   guardrail_checks, config_version}                             |
+-----------------------------------------------------------------+
```

### Why This Is Better

| Concern | Email Approach | Task Graph Approach |
|---------|---------------|-------------------|
| **Provenance** | Sender/recipient/timestamp in email headers | Immutable audit log on every state transition — equivalent provenance, better structure |
| **Latency** | Polling IMAP every 30s-5min per agent | Event-driven via outbox + pg_notify — agent activates in <2s |
| **Context** | Agent searches its inbox, parses email bodies | Agent queries the graph: "give me all decisions tagged `hipaa` from the last 7 days" |
| **Dependencies** | Implicit in email prose ("wait for dev-01's report") | Explicit edges: `TASK-002.depends_on = TASK-001` — the system enforces ordering |
| **State** | Read/unread (that's it) | Full state machine with enforced valid transitions: draft -> ready -> in_progress -> in_review -> done / blocked / failed |
| **Aggregation** | Manager reads N worker emails and writes a summary | Orchestrator queries: "give me all TASK outputs under WORKSTREAM-002" — structured data, instant |
| **Parallelism** | Fan-out via multiple emails; fan-in requires timeout-based follow-ups | Fan-out via parallel task creation; fan-in via explicit completion gates |
| **Board oversight** | Read agent inboxes | Dashboard over the task graph + same immutable audit log |
| **Concurrency** | No mechanism to prevent two agents from acting on the same email | `FOR UPDATE SKIP LOCKED` provides atomic task claiming — zero double-assignment |

---

## Revised Architecture

### The Agent Runtime Loop (Revised)

```
+-------------------------------------------------------------+
|              AGENT RUNTIME LOOP (v2)                         |
|                                                              |
|  1. AWAIT event from task queue (outbox + pg_notify)         |
|     Event priority (highest first):                          |
|       1. halt_signal: stop everything                        |
|       2. escalation_received: subordinate flagged issue      |
|       3. review_requested: output needs validation           |
|       4. task_completed: a dependency is resolved            |
|       5. task_assigned: new work for this agent              |
|     Events are processed serially per agent, dequeued        |
|     in priority order.                                       |
|                                                              |
|  2. CHECK idempotency                                        |
|     - Has this event_id been processed before?               |
|     - If yes, skip. If no, continue.                         |
|                                                              |
|  3. CHECK guardrails on inbound event (see Guardrail         |
|     Enforcement section below)                               |
|     - HALT check (absolute priority, no caching)             |
|     - Authorization check (is this in my scope?)             |
|     - Budget pre-authorization (estimate cost, check limit)  |
|     - Data classification check (am I cleared for this?)     |
|                                                              |
|  4. LOAD context:                                            |
|     - Agent identity (from config, stamped with              |
|       config_hash for audit)                                 |
|     - Task details & acceptance criteria                     |
|     - Relevant graph context (parent task summary,           |
|       sibling task statuses, prior decisions) — scoped       |
|       by context budget                                      |
|     - Guardrails (org + role + task level)                   |
|                                                              |
|  5. EXECUTE via model (Claude or Ollama):                    |
|     - Reason about the task                                  |
|     - Produce output OR decompose into subtasks              |
|     - All model I/O logged (prompt hash + response hash      |
|       + token counts + cost)                                 |
|                                                              |
|  6. CHECK guardrails on outbound action                      |
|     - Output schema validation                               |
|     - PII detection scan                                     |
|     - Spend tracking (actual vs estimated)                   |
|     - Escalation trigger evaluation                          |
|     - Data classification inheritance check                  |
|     - If creating subtasks: cycle detection on DAG           |
|     - If assigning work: can_assign_to validation            |
|                                                              |
|  7. TRANSITION task state                                    |
|     - Validate transition against state machine rules        |
|     - Atomic: update state + write audit + emit event        |
|     - On failure: log error, do NOT leave task in            |
|       inconsistent state. Retry or escalate.                 |
|     - Log the transition with: agent_id, config_hash,        |
|       guardrail_checks_passed, cost_incurred, reason         |
|                                                              |
|  8. Return to AWAIT                                          |
+-------------------------------------------------------------+
```

**Key differences from v1:** Event-driven with priority ordering. Idempotency guard on every event. Guardrail checks are concrete (see below). Context is queried from the graph with a token budget, not extracted from email bodies. Output is attached as structured data with classification metadata. Every transition is atomic and audited with the governing config version.

### Agent Configuration (Revised)

```json
{
  "schema_version": "2.0",
  "config_hash": "sha256:a1b2c3...",
  "agent_id": "orchestrator-eng",
  "role": "orchestrator",
  "display_name": "Engineering Orchestrator",

  "model": {
    "provider": "anthropic",
    "name": "claude-sonnet-4-5-20250514",
    "max_context_tokens": 200000,
    "max_tokens_per_response": 4096,
    "fallback_model": "claude-haiku-4-5-20251001"
  },

  "hierarchy": {
    "reports_to": "strategist",
    "can_assign_to": [
      "reviewer-backend",
      "reviewer-frontend",
      "executor-01",
      "executor-02",
      "executor-03"
    ],
    "peers": ["architect", "orchestrator-product"],
    "escalates_to": ["strategist", "architect"]
  },

  "tools": {
    "allowed": [
      "read_file",
      "query_task_graph",
      "create_subtask",
      "assign_task",
      "attach_output"
    ],
    "forbidden": [
      "write_file",
      "execute_code",
      "deploy_to_production",
      "delete_repository",
      "external_http_request",
      "modify_guardrails"
    ]
  },

  "guardrails": {
    "max_budget_per_task_usd": 5.00,
    "max_delegation_depth": 3,
    "requires_approval_above_usd": 10.00,
    "approval_from": "strategist",
    "escalation_triggers": [
      "security_vulnerability",
      "budget_exceeded",
      "deadline_missed",
      "conflicting_requirements"
    ],
    "data_classification_clearance": ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    "max_output_tokens": 4096
  },

  "context_budget": {
    "max_context_tokens_per_task": 6000,
    "graph_query_depth": 3,
    "max_sibling_tasks": 20,
    "max_history_transitions": 50,
    "context_strategy": "parent_summary_only"
  }
}
```

**Changes from prior draft:**
- `can_assign_to` uses **explicit agent IDs**, not glob patterns. Globs silently expand scope when new agents are added — a security footgun. Explicit lists require deliberate authorization.
- `config_hash` is stamped on every audit log entry so you can reconstruct which guardrails governed any historical decision.
- `tools` section defines an **allow-list** of permitted tool calls and an explicit deny list. The orchestration layer intercepts and validates every tool call before execution.
- `data_classification_clearance` controls what data classification levels this agent may access.
- `fallback_model` specifies what to use when the primary model is unavailable or cold-starting.
- `context_strategy: "parent_summary_only"` means only the parent task's summary is forwarded, not the full parent context — controlling token cost.

---

## Guardrail Enforcement Architecture

The original spec's guardrail design is the most valuable contribution. But "preserved" is not a specification. Here's how guardrails are enforced in the task graph world.

### Enforcement Points

Guardrails are enforced by the **orchestration layer** as a mandatory pre/post-execution check — not by agents self-policing. Agent self-checks exist as defense-in-depth only, because a model that hallucinates or ignores instructions can bypass self-enforcement.

```
   Board Directive
         |
         v
  [Orchestration Layer] <-- enforces ALL guardrails
         |
    +---------+----------+-----------+
    |         |          |           |
    v         v          v           v
 Strategist  Architect  Orchestrator  Executor
 (Claude)    (Claude)   (Claude)     (Ollama)
```

### Guardrail Check Function

Equivalent to the original spec's `check()` function, adapted for the task graph:

```js
const result = guardCheck({
  action: "create_subtask",
  actor: "orchestrator-eng",
  actor_config_hash: "sha256:a1b2c3...",
  target_agent: "executor-01",
  task_parent: "WORKSTREAM-002",
  estimated_cost_usd: 0.12,
  data_classification: "CONFIDENTIAL",
  delegation_depth: 2,
  tool_calls_requested: ["read_file", "query_task_graph"]
});

// Conditions evaluated:
// - actor_can_assign_to_target (explicit list check)
// - delegation_depth_within_limit (depth <= max_delegation_depth)
// - estimated_cost_within_budget (cost <= remaining task budget)
// - cumulative_spend_within_org_limit (daily total <= org max)
// - data_classification_cleared (target agent cleared for this level)
// - tool_calls_permitted (all requested tools in agent's allow-list)
// - no_dag_cycle (adding this subtask won't create a dependency cycle)
// - halt_not_active (global halt flag is false)
// - valid_state_transition (current state -> requested state is valid)

// Returns: { allowed: true } or { blocked: true, reason: "...", escalate_to: "..." }
```

### Budget Enforcement Mechanics

Budget enforcement uses a **pre-authorization pattern** — costs are checked before LLM calls, not just logged after:

1. Before an LLM call, estimate cost from expected token count
2. Debit the estimated cost from the task's remaining budget
3. Execute the LLM call
4. Reconcile: adjust the debit to actual cost (refund delta or charge overage)
5. If actual cost would exceed the task's budget: the call completes, but the task is flagged and further calls are blocked until the assigning agent increases the budget or the Strategist approves an override

Subtask budgets roll up: if an Orchestrator creates 5 subtasks each at $2, that's $10 against the parent workstream's budget. The Orchestrator cannot create subtasks whose total exceeds its own budget allocation.

### Escalation Trigger Classification

| Trigger | Detection Method | Response |
|---------|-----------------|----------|
| `budget_exceeded` | Structured signal: `cost > threshold` | Auto-block further calls, notify assigning agent |
| `deadline_missed` | Structured signal: `now() > due_date` | Auto-escalate to assigning agent, mark task `overdue` |
| `security_vulnerability` | LLM classification by Reviewer agent | Immediate escalation to Architect + Board, task halted |
| `conflicting_requirements` | LLM classification by Orchestrator | Escalation to Strategist with both requirements cited |
| `quality_failure` | Schema validation + Reviewer judgment | Re-queue to different Executor (see Failure Modes) |

For LLM-classified triggers: the classifying agent and the executing agent must be different agents (separation of concerns). The escalation path and SLA are defined in the agent's config.

---

## Agent Authorization & Identity

### Authentication

Each agent runs as a process authenticated via:
- **Task graph access:** Scoped database credentials per agent role (Postgres row-level security enforces read/write boundaries — see Agent Isolation below)
- **LLM API access:** Per-agent API keys provisioned by a key management service (equivalent to openrouter-key-service), rotatable without redeployment
- **Tool access:** Signed JWTs per agent with `agent_id`, `role`, and `tools.allowed` claims. The orchestration layer validates the JWT on every tool call before execution.

No agent has access to another agent's credentials. Credentials are injected at runtime by the orchestration layer, not stored in agent config files.

### Authorization Model

| Action | Who Can Do It | Enforced By |
|--------|---------------|-------------|
| Create DIRECTIVE | Board (human) only | Graph service rejects non-human `created_by` on directive-type nodes |
| Create WORKSTREAM | Strategist | Graph service validates `actor.role == 'strategist'` |
| Create TASK / SUBTASK | Orchestrator, Reviewer | Graph service validates role + `can_assign_to` constraint |
| Assign work | Any agent to their `can_assign_to` list | Graph service validates against explicit agent ID list |
| Transition task state | Assigned agent or their superior | Graph service validates `actor == assigned_agent OR actor == reports_to` |
| Read task data | Scoped by role (see Agent Isolation) | Postgres RLS policies |
| Execute tools | Per agent allow-list | Orchestration layer validates JWT claims |
| Modify guardrails | Board only | Config change requires Board authorization + audit log entry with old/new values |

### Agent Identity Lifecycle

- **Provisioning:** New agents require Board or Strategist authorization. A new config file is created, credentials provisioned, and the agent identity is registered in the graph.
- **Config changes:** When an agent's config, model, or prompt changes, the old config is preserved with its `config_hash`. The audit trail links historical decisions to the config version that governed them.
- **Decommissioning:** In-flight tasks are reassigned before an agent is deactivated. The agent's historical data remains in the audit log permanently.

---

## Data Classification & Access Control

The original spec includes `data_classification_required` as a guardrail. This is critical and needs full specification.

### Classification Taxonomy

| Level | Description | Examples |
|-------|-------------|----------|
| **PUBLIC** | Non-sensitive task metadata | Task titles, status, agent assignments |
| **INTERNAL** | Business strategy and operational data | Cost reports, capacity plans, agent performance metrics |
| **CONFIDENTIAL** | Customer or business-sensitive data | User data analysis, financial details, proprietary algorithms |
| **REGULATED** | Data subject to regulatory frameworks | HIPAA PHI, cannabis compliance data, PII |

### Classification Rules

- Every task node carries a `data_classification` field, set at creation time
- Task outputs **inherit the highest classification** of their inputs. An executor working on REGULATED data produces REGULATED output, even if the output itself appears innocuous.
- The Orchestrator's assignment logic checks classification: REGULATED and CONFIDENTIAL tasks **cannot be assigned to local/Ollama models** (data must stay in controlled, API-based environments with contractual data handling guarantees)
- REGULATED tasks may not be routed through third-party APIs without explicit Board approval
- When a task's output rolls up to a parent summary, the parent's classification is elevated to match

### PII Handling

- PII detection runs as a post-execution guardrail check (step 6 in the runtime loop)
- Detected PII is masked or flagged before storage in the graph
- PII must not appear in audit logs — the audit log references the task output by ID, and PII-containing outputs are stored in a separate access-controlled store
- Data retention for PII follows the applicable regulatory framework (HIPAA: 6 years, CCPA: as requested by data subject)

---

## Agent Isolation & Visibility Scoping

"Workers cannot read other workers' emails" needs a task-graph equivalent. Isolation is enforced by Postgres row-level security, not by trusting agents to self-limit.

### Read Scope Per Role

| Role | Can Read | Cannot Read |
|------|----------|-------------|
| Strategist | All directives, all workstreams, aggregated task summaries | Individual executor task details (unless escalated) |
| Architect | All tasks in their domain, peer architect decisions | Tasks in unrelated domains |
| Orchestrator | Tasks they created, tasks assigned to agents in their pool | Tasks under other orchestrators |
| Reviewer | Tasks assigned to them for review, the executor's output for that task | Other reviewers' pending reviews, unrelated tasks |
| Executor | Only their own assigned tasks and their own outputs | Other executors' tasks, sibling tasks, parent strategy |

### Context Leakage Prevention

When an Orchestrator aggregates executor outputs and creates a summary for the Strategist, it synthesizes — it does not forward raw executor output. If that summary is later passed as context to a new executor, the new executor sees the synthesis, not the raw work of other executors. This is acceptable and by design (the Orchestrator acts as an information firewall).

Cross-domain visibility between peers (`orchestrator-eng` <-> `orchestrator-product`) is limited to shared task metadata (titles, statuses, classifications). Full task details require explicit "shared concern" edges in the graph, approved by the Strategist.

---

## HALT Protocol (Expanded)

### Two Modes: Soft HALT and Hard HALT

**Soft HALT** (default): Agents finish their current task, then stop. Used for planned pauses (budget review, guardrail adjustment, strategic reassessment).

**Hard HALT**: Agents abort immediately. The orchestration layer revokes agents' ability to write results (database permissions are dynamically narrowed). Current tasks are marked `interrupted` — their partial output is preserved but flagged as incomplete. Used for security incidents, runaway spend, or detected adversarial behavior.

```json
{
  "halt": true,
  "mode": "soft",
  "issued_by": "board-chair",
  "timestamp": "2026-02-25T14:30:00Z",
  "reason": "Budget review required",
  "resume_requires": ["board-chair"],
  "resume_fallback": ["board-vice-chair"],
  "propagation_sla_seconds": 5
}
```

### HALT as an Event, Not a Flag

The HALT signal is delivered as a **priority event** (`halt_signal` is event priority 1 — processed before all other events). It is NOT a polled flag. The orchestration layer pushes the HALT event into every agent's event queue simultaneously. Agents do not cache the HALT state.

**Propagation SLA:** All agents must receive and acknowledge the HALT signal within `propagation_sla_seconds` (default: 5 seconds). The Board sees which agents have acknowledged and which have not. An agent that does not acknowledge within the SLA is force-terminated by the orchestration layer.

### HALT Acknowledgment

Every agent must ACK the HALT:

```json
{
  "event": "halt_acknowledged",
  "agent_id": "executor-03",
  "timestamp": "2026-02-25T14:30:02Z",
  "tasks_in_progress": ["TASK-005"],
  "action_taken": "completed_current_task",
  "cost_incurred_since_halt": 0.00
}
```

### RESUME

RESUME requires authorization from the identity specified in `resume_requires` (with fallback). RESUME is also an event, not a flag — agents receive it via their event queue and transition from standby to active. If `resume_requires` is unavailable (vacation, unreachable), the fallback identity can authorize after a configurable timeout (default: 4 hours).

---

## Failure Modes

Neither document adequately addresses what happens when things go wrong. This section specifies the failure handling contract.

### Agent Crash During Execution

If an agent crashes (OOM, model timeout, container killed) between step 5 (EXECUTE) and step 7 (TRANSITION), the task is orphaned in `in_progress` state with no output.

**Recovery:** A reaper query runs every 60 seconds:

```sql
UPDATE work_items
SET state = 'ready', assigned_agent = NULL, updated_at = NOW()
WHERE state = 'in_progress'
  AND updated_at < NOW() - INTERVAL '5 minutes'
  AND retry_count < max_retries
RETURNING *;
```

Tasks exceeding `max_retries` (default: 3) transition to `failed` and trigger an escalation event to the assigning agent. The reaper also writes a state transition audit entry: `{from: 'in_progress', to: 'ready', reason: 'timeout_reaper', transitioned_by: 'system'}`.

### Task Timeout

Every task has a `deadline` field. Deadlines are set by the assigning agent based on task type defaults:

| Task Type | Default Deadline |
|-----------|-----------------|
| Executor task | 5 minutes |
| Review task | 10 minutes |
| Orchestrator decomposition | 15 minutes |
| Strategist planning | 30 minutes |

The reaper query above handles timeout. The assigning agent receives an escalation and decides: retry on same agent, reassign to a different agent, or escalate up.

### Garbage Output (Quality Failure)

When an Executor produces output that fails validation:

1. **Schema validation fails** (output doesn't match expected structure): task transitions to `revision_requested` with structured feedback. Executor gets one retry with the feedback context.
2. **Reviewer rejects on quality** (output is structurally valid but incorrect/insufficient): task transitions to `revision_requested` with Reviewer's feedback. Executor gets one retry.
3. **Second failure**: task transitions to `failed`. Orchestrator reassigns to a different Executor. If the second Executor also fails, Orchestrator escalates to Architect or Strategist.
4. **Pattern detection**: if a specific Executor fails > 30% of its tasks in a rolling window, the Orchestrator flags a quality alert to the Board. This catches "rubber stamping" by Reviewers and systematic model degradation.

### DAG Cycle Prevention

The task graph must remain a DAG. A cycle in `depends_on` or `blocks` edges creates a deadlock (TASK-A waits for TASK-B waits for TASK-C waits for TASK-A — nothing can proceed).

**Prevention:** The orchestration layer validates the graph on every edge insertion. Before adding a `depends_on` or `blocks` edge from source to target, run a reachability check: can `target` reach `source` via existing edges of the same type? If yes, the edge would create a cycle and is rejected.

This is enforced at the database layer via a function call before every edge INSERT — not in application code alone.

### Cascading Cancellation

When a DIRECTIVE is cancelled by the Board:

1. All WORKSTREAM tasks under the DIRECTIVE transition to `cancelled`
2. All TASK and SUBTASK nodes under those workstreams:
   - If `ready` or `draft`: transition to `cancelled` immediately
   - If `in_progress`: Soft HALT for those agents (finish current step, then mark `cancelled`)
   - If `done`: remain `done` (completed work is preserved for potential reuse)
   - If `blocked`: transition to `cancelled` immediately
3. The cancellation cascade is executed by the orchestration layer (not by individual agents), ensuring atomicity
4. Every cancellation is logged in the audit trail with `reason: "parent_cancelled"` and `triggered_by: "board-chair"`

### Context Window Overflow

If packed context exceeds the model's context window even after applying `context_budget` limits:

1. Truncation strategy: drop the oldest sibling task summaries first, then reduce graph query depth from 3 to 2 to 1
2. If still over limit after truncation: summarize the parent context using the agent's fallback model (smaller, cheaper) and inject the summary instead of raw context
3. If a task fundamentally requires more context than the model can handle: the task is flagged as `requires_decomposition` and bounced back to the Orchestrator for further breakdown into smaller subtasks

---

## Context Window Economics

Every time an agent receives a task, it needs context injected into its prompt. At Claude Sonnet pricing (~$3/MTok input, ~$15/MTok output), context costs compound across the task DAG.

### Cost Budget Per Task Tier

| Tier | Model | Input Cost/MTok | Max Context Tokens/Task | Max Context Cost/Task |
|------|-------|----------------|------------------------|----------------------|
| Strategist | Claude Opus | $15 | 8,000 | $0.12 |
| Architect | Claude Sonnet | $3 | 6,000 | $0.018 |
| Orchestrator | Claude Sonnet | $3 | 4,000 | $0.012 |
| Reviewer | Claude Sonnet | $3 | 4,000 | $0.012 |
| Executor | Ollama (local) | $0 | 4,000 | $0.00 |

### Context Forwarding Strategy

- Only forward the task's immediate input + **parent task summary** (not full parent context)
- Enforce `max_context_tokens_per_task` from the agent config
- Log actual vs budgeted context per task for cost forecasting
- Target: **total context cost per project < $2.00** for a typical 30-50 task decomposition

### Ollama Cold Start Mitigation

Loading a 7B model from disk takes 10-30 seconds. Loading a 70B model takes 60-120 seconds. If the architecture assumes sub-120-second task completion, cold start can blow the latency budget.

**Mitigation:** Keep one instance of each required model loaded in memory (Ollama's `keep_alive` parameter set to `forever` for active models). For Phase 1, pin to a single model (e.g., `codellama:13b`) for all Executor tasks to avoid multi-model cold start. Budget: 16GB VRAM for the Executor tier. If the model is not loaded, the dispatcher routes to a cloud fallback (`claude-haiku-4-5` at ~$0.25/MTok) and logs a cost overrun alert.

---

## Observability Contract

Observability is not a nice-to-have. In a system where agents autonomously create and execute tasks, observability is the difference between "we know what our agent company is doing" and "we have no idea what just happened."

### Event Schema (Phase 1 Requirement)

Every task state transition emits a structured event:

```json
{
  "event": "task.state_change",
  "task_id": "TASK-001",
  "task_type": "code_implementation",
  "from_status": "ready",
  "to_status": "in_progress",
  "agent_id": "executor-01",
  "agent_config_hash": "sha256:a1b2c3...",
  "model_id": "codellama:13b",
  "tokens_in": 2400,
  "tokens_out": 800,
  "cost_usd": 0.000,
  "latency_ms": 3200,
  "guardrail_checks": {
    "budget": "pass",
    "authorization": "pass",
    "classification": "pass"
  },
  "data_classification": "INTERNAL",
  "timestamp": "2026-02-25T14:32:00Z"
}
```

### Dashboard Requirements (Phase 1)

- **Task funnel**: queued -> running -> done/failed counts over time
- **Cost per task type**: bar chart, last 24h, by model tier
- **Agent utilization**: % time each agent spent running vs idle
- **P50/P95/P99 task completion latency** by task type
- **Active task DAG visualization**: tree view of current directive with status coloring
- **Budget burn rate**: actual vs projected daily spend, with remaining budget
- **Quality metrics**: task success rate by executor, review rejection rate
- **HALT status**: green (running) / yellow (soft halt) / red (hard halt) with ack status per agent

---

## Implementation Substrate: Postgres Task Graph

The orchestration substrate is a Postgres task graph. This eliminates third-party API rate limits (Linear caps at 250-400 req/min — a 10-agent system would hit this within minutes), webhook unreliability, schema impedance mismatch, and an inevitable migration.

### Schema Summary

```
agent_graph schema (7 tables + 1 view):

  work_items            -- Nodes: directives, workstreams, tasks, subtasks
                        -- Typed state (ENUM), priority, assignment, classification
                        -- BIGINT PK for join performance, TEXT external_id for humans

  edges                 -- Typed DAG edges between work items
                        -- Types: decomposes_into, blocks, depends_on, reviewed_by
                        -- Self-loop prevention, duplicate prevention
                        -- Cycle detection via would_create_cycle() function

  state_transitions     -- Immutable audit log (partitioned by month)
                        -- Append-only: UPDATE/DELETE revoked at role level + trigger
                        -- Includes: who, from/to state, reason, config_hash, guardrail results

  valid_transitions     -- State machine rules (lookup table)
                        -- Enforced by transition_state() function

  task_events           -- Outbox for agent activation
                        -- Claimed via FOR UPDATE SKIP LOCKED (no double-claiming)
                        -- pg_notify as low-latency hint, polling as fallback

  llm_invocations       -- Cost tracking per LLM call
                        -- NUMERIC(12,6) for exact cost (not FLOAT)
                        -- Pricing snapshot columns (historical accuracy)
                        -- request_id UNIQUE constraint (idempotency)

  budgets               -- Department/project budget allocations
                        -- Period-based with CHECK constraints

  v_budget_status       -- View: budget vs actual spend (real-time remaining)

Key functions:
  transition_state()    -- Atomic: lock row + update state + write audit + pg_notify
  claim_next_task()     -- Atomic: FOR UPDATE SKIP LOCKED task claiming
  would_create_cycle()  -- DAG cycle detection before edge insertion
```

### Key Design Decisions

1. **Adjacency list with separate edges table** — because the graph has cross-cutting edges (`blocks`, `depends_on`), not just hierarchy. A closure table can't represent "TASK-005 blocks TASK-012" when they live under different workstreams.
2. **BIGINT identity PKs internally, TEXT external_id for humans** — join performance matters when traversing edges. The external ID (`TASK-042`) is the human-facing identifier.
3. **Outbox pattern + pg_notify as hint** — bare `NOTIFY/LISTEN` loses events when a listener disconnects (fire-and-forget, no replay). The outbox table (`task_events`) is the source of truth. `pg_notify` is a low-latency hint that reduces poll interval from 5-10s to <1s. Fallback polling runs every 5s for missed notifications.
4. **`FOR UPDATE SKIP LOCKED` for task claiming** — Postgres-native solution to the double-claiming problem. Two agents racing to claim the same task: one wins, the other skips to the next. No deadlocks, no distributed locks.
5. **Partitioned audit and cost tables from day one** — monthly partitions on `state_transitions` and `llm_invocations`. Partition pruning makes time-range queries fast. Old partitions can be detached and archived without touching active data.
6. **NUMERIC, not FLOAT, for all cost columns** — `0.1 + 0.2 != 0.3` in floating point. Exact arithmetic for money.
7. **request_id with UNIQUE constraint on cost tracking** — idempotency key prevents duplicate cost records on retry. This is a known bug pattern in production token tracking systems.
8. **State machine validation table** — a `valid_transitions` lookup table enforced by `transition_state()`. You cannot go from `done` back to `draft`. Invalid transitions are caught at the database layer, not trusted to application code.
9. **Append-only audit log** — `UPDATE` and `DELETE` revoked at the Postgres role level, with a trigger as defense-in-depth. If it isn't constrained, it isn't true.

### Cost Tracking

Cost data lives in the orchestration layer as first-class, queryable data:

```json
{
  "task_id": "TASK-001",
  "agent_id": "orchestrator-eng",
  "model": "claude-sonnet-4-5-20250514",
  "provider": "anthropic",
  "department": "engineering",
  "input_tokens": 12400,
  "output_tokens": 3200,
  "cost_usd": 0.062,
  "input_price_per_1m": 3.0000,
  "output_price_per_1m": 15.0000,
  "request_id": "uuid-for-idempotency",
  "timestamp": "2026-02-25T14:32:00Z"
}
```

**Why pricing snapshot columns**: Model pricing changes. If Anthropic drops Sonnet's price next month, historical cost records should reflect what you actually paid, not what the model costs today.

The board queries `v_budget_status` for real-time remaining budget by department. The orchestration layer queries it before approving high-cost operations.

### Board Oversight (Revised)

| Action | How |
|--------|-----|
| Issue a directive | Create a DIRECTIVE node in the graph (board-only permission) |
| Monitor progress | View task graph dashboard (real-time DAG visualization + status) |
| Audit a decision | Query: "show all state transitions for DIRECTIVE-001 with reasons and guardrail checks" |
| Override an agent | Set override flag on task node; agent sees it as a priority event |
| Soft freeze | Push `halt_signal` event (mode: soft) — agents finish current task, then stop |
| Hard freeze | Push `halt_signal` event (mode: hard) — agents abort, permissions revoked |
| Replace an agent | Decommission old agent (reassign tasks), provision new agent identity |
| Adjust guardrails | Requires Board authorization. Old/new values logged in audit trail. Cool-down period for loosened restrictions. |
| Review costs | Dashboard with real-time aggregations from `v_budget_status` |

For human visibility into the task graph, a read-only dashboard view (React component) provides exactly the views the Board needs — active DAGs, cost burn, agent utilization, HALT status — without bending a project management tool into an orchestration engine.

---

## Quality Assurance & Anti-Collusion

### Quality Sampling

A percentage (configurable, default 10%) of Reviewer-approved tasks are randomly re-reviewed by a different Reviewer or by a human board member. Discrepancies between the original review and the quality sample trigger:

1. Investigation of the original Reviewer's recent approvals
2. Temporary increase in quality sampling rate for that Reviewer (from 10% to 50%)
3. If systematic rubber-stamping is confirmed: Reviewer is decommissioned and replaced, Board is notified

### Load Distribution Monitoring

The orchestration layer tracks task assignment distribution. If an Orchestrator routes > 60% of tasks to a single Executor (concentration risk / bottleneck), an alert fires to the Strategist. The Orchestrator is prompted to justify the distribution or rebalance.

---

## Secret Management

Agents that access external tools (codebases, APIs, databases) need credentials. These are governed as follows:

- **Storage:** Secrets are stored in a dedicated secrets manager (equivalent to a vault or the existing openrouter-key-service pattern), never in agent config files or the task graph.
- **Injection:** Credentials are injected at runtime by the orchestration layer when an agent is activated for a task that requires tool access. The agent receives a short-lived token (5-minute TTL) scoped to the specific tools needed for that task.
- **Isolation:** No agent has access to another agent's credentials. An Executor's database read token cannot be used by a Reviewer.
- **Rotation:** Credentials can be rotated without agent redeployment. The orchestration layer handles re-provisioning on next task assignment.
- **Audit:** Every credential issuance is logged: which agent, which tool, what scope, what TTL, for which task.

### Tool Access Governance

This is not an "open question" — it is a fundamental security boundary:

| Role | Allowed Tools | Forbidden Tools |
|------|--------------|-----------------|
| Strategist | query_task_graph, create_workstream, read_reports | All code/data tools |
| Architect | query_task_graph, read_file, read_codebase_structure | write_file, execute_code, deploy |
| Orchestrator | query_task_graph, create_subtask, assign_task, read_outputs | execute_code, external_http, deploy |
| Reviewer | query_task_graph, read_file, read_task_output, run_tests | write_file, deploy, create_subtask |
| Executor | read_file, write_file, execute_code (sandboxed), run_tests | deploy, external_http, read_other_task_outputs |

Tool permissions are enforced by the orchestration layer (JWT claim validation), not self-enforced by agents. Agents in Phase 1 are **not** given git push access — all code artifacts are stored as task output and require human review before commit.

---

## Change Control for Guardrails

Guardrail modifications are governance changes, not routine config updates. They require:

1. **Board authorization** for any change that loosens restrictions (increasing `max_budget_per_task_usd`, adding tools to an allow-list, elevating an agent's data classification clearance)
2. **Audit trail entry** capturing old values, new values, who authorized the change, and why
3. **Cool-down period** (default: 24 hours) for loosened restrictions before they take effect — giving the Board time to review
4. **Immediate effect** for tightened restrictions (reducing budgets, removing tool access, lowering classification clearance)
5. Guardrails are **never** hot-reloadable by agents themselves. An agent cannot modify its own guardrails or any other agent's guardrails.

---

## Data Retention

- **Audit log (`state_transitions`)**: Retained indefinitely. Partitioned by month for efficient archival of old partitions to cold storage.
- **Cost data (`llm_invocations`)**: Retained for 2 years minimum. Supports financial audit and cost trend analysis.
- **Task outputs**: Retained for 1 year after task completion, then archived. REGULATED outputs follow the applicable regulatory retention period (HIPAA: 6 years).
- **Model I/O logs** (prompts + responses): Retained for 90 days for debugging and quality review. REGULATED task I/O retained for the applicable regulatory period.
- **PII reconciliation**: The immutable audit log may reference PII-containing tasks. PII is stored in the task output (access-controlled), not in the audit log itself. Deletion requests (GDPR/CCPA) are handled by pseudonymizing identifiers in the audit log rather than deleting entries — preserving audit integrity while honoring the right to erasure.

---

## Revised MVP Phases

### Phase 1: Minimal Viable Organization (2 weeks)

Phase 1 must prove organizational behavior — not just a prompt chain. A single-chain relay (strategist -> executor -> strategist) is something LangChain already does. The minimum viable demo needs **delegation + verification through an intermediate layer.**

1. Postgres task graph (the `agent_graph` schema above — 7 tables, 3 functions)
2. 3 agents: Strategist (Claude Opus), Orchestrator (Claude Sonnet), Executor (Ollama or Haiku)
3. Strategist receives a directive, produces a plan as subtasks
4. Orchestrator assigns subtasks to Executor, manages dependencies
5. Executor completes subtasks, Orchestrator validates output before marking done (minimum organizational behavior: delegation + verification)
6. The demo: give it a directive like "Write a Python function that parses CSV files with error handling and tests." The Strategist decomposes it, the Orchestrator sequences code-then-tests, the Executor writes the code, the Orchestrator validates the output includes both implementation and tests.

**Success criteria** (see Metrics table below).

### Phase 2: Parallel Execution + Failure Handling (2 weeks)

- Multiple Executor instances processing independent subtasks concurrently
- DAG-based dependency resolution (subtask B waits for subtask A only if B depends on A)
- Failure handling: timeout reaper, retry, quality gate rejection, HALT
- Cost tracking and budget enforcement per project
- Reviewer agent (separate from Orchestrator) validates Executor output

### Phase 3: Full Governance (4 weeks)

- Guardrail enforcement at all levels (org + role + task)
- HALT protocol (soft + hard, with acknowledgment)
- Data classification enforcement
- Agent isolation via Postgres RLS
- Observability dashboard for the Board
- Quality sampling (10% re-review rate)
- Human-in-the-loop approval gates for high-cost operations

### Phase 4: Multi-Domain + Scaling (4 weeks)

- Second Orchestrator (product or security) with its own Executor pool
- Strategist coordinates across domains
- Cross-domain task routing and conflict resolution
- Self-improvement: agents can propose changes to `task-routing.json` (subject to Board approval)
- Dynamic agent provisioning (scale Executor pool based on queue depth)

---

## Success Metrics

These are CI-enforced gates, not aspirational targets.

### Phase 1 Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| End-to-end latency (3-task directive) | < 120s p95 | Timed: directive submission to final output |
| Total cost per directive (3-task decomposition) | < $0.50 | Sum of `cost_usd` across all tasks in the DAG |
| Task dispatch latency (ready -> in_progress) | < 2s p99 | Timestamp delta: `started_at - created_at` |
| Context tokens per task (input) | < 8,000 max | Logged per task, alerted if exceeded |
| Agent idle time | < 30% | `(total_time - sum(running_time)) / total_time` |
| Task success rate | > 90% | `count(done) / count(done + failed)` |
| Observability coverage | 100% of state transitions logged | Audit: every task has complete event trail |
| Crash recovery time | < 60s to re-queue orphaned tasks | Reaper job timing |

### Cost Model Validation

Run 100 sample directives before advancing to Phase 2. Compute mean and p95 cost. If p95 > $1.00 per directive, the model tier allocation is wrong and must be adjusted.

---

## Open Questions (Revised)

1. **Context window management strategy:** When an Orchestrator needs to reason about a 30-task workstream, the context budget limits what fits in the prompt. Should we use a summarization chain (expensive but comprehensive) or strict truncation (cheap but lossy)? Decision should be driven by Phase 1 cost model validation.

2. **Shared knowledge store:** Where do cross-cutting decisions, constraints, and learnings live so any agent can query them? Options: tags on the task graph (simplest), a dedicated knowledge table in `agent_graph` (more structured), or a separate RAG-style context service (most capable). Start with tags and upgrade if insufficient.

3. **Real-time vs near-real-time:** Is sub-second agent activation needed, or is "within 5 seconds" sufficient? The outbox + pg_notify pattern provides <2s in practice. If sub-second is required, add a WebSocket layer between the graph and agent workers.

4. **Agent replacement policy:** When an agent consistently produces poor work (detected via quality sampling), who decides to swap the model or rewrite the prompt? Recommendation: Orchestrator flags to Strategist, Strategist proposes replacement to Board, Board approves. Automated replacement (without Board approval) only for Executors, and only model swaps within the same tier.

5. **External communication:** Will any agent ever interact with external systems (client APIs, third-party services)? If so, which agents, under what classification constraints, and with what audit requirements? Recommendation: not in Phase 1-3. Phase 4+ only, with Board-approved tool access per agent.

---

## Summary of Changes

| Aspect | Original Spec | This Revision |
|--------|--------------|---------------|
| **Communication** | Email (SMTP/IMAP) | Postgres task graph with event-driven activation (outbox + pg_notify) |
| **Agent identity** | Email addresses + corporate titles | Functional roles + JWT-authenticated agent identities |
| **Provenance** | Email headers and threads | Immutable audit log on state transitions — equivalent provenance, better queryability |
| **Latency** | 30s-5min polling per tier | Event-driven, <2s activation (bounded, not "instant") |
| **Context retrieval** | Search inbox, parse email bodies | Query the task graph for structured data with token budgets |
| **Board oversight** | Read agent inboxes | Dashboard over task graph + immutable audit log |
| **Governance** | Guardrails described | Guardrails **specified**: enforcement points, check functions, budget pre-auth, classification routing |
| **HALT protocol** | Email broadcast | Priority event with soft/hard modes, ACK requirement, propagation SLA |
| **Security** | Email credentials | JWT auth, tool allow-lists, Postgres RLS isolation, secret injection |
| **Failure handling** | Not addressed | Specified: crash recovery, timeout reaper, quality gates, cycle prevention, cascading cancel |
| **Data classification** | Mentioned as guardrail | Full taxonomy with classification-driven routing and PII handling |
| **Model tiering** | Claude/Ollama split | Same split + context window economics, cold start mitigation, cost budget per tier |
| **Hierarchy** | Corporate titles | Functional roles (Strategist, Architect, Orchestrator, Reviewer, Executor) |
| **Substrate** | Gmail/Outlook APIs | Postgres (7 tables, 3 functions) — zero new infrastructure if you have Supabase |
| **MVP approach** | 5 phases starting with 2 agents | 4 phases starting with 3 agents (minimum viable org, not minimum viable chain) |

---

## Closing Thought

The original spec correctly identifies that **the governance layer is the gap.** Most multi-agent frameworks are demos, not systems. They lack accountability, audit trails, budget controls, and human override mechanisms. That insight is valuable and worth building on.

This revision takes that insight and does two things: (1) swaps the communication substrate from a protocol optimized for humans (email) to one optimized for agents (Postgres task graph with event-driven activation), and (2) specifies the governance enforcement that both documents need — concrete guardrail checks, authorization models, failure handling, data classification, agent isolation, and observability contracts.

The result: same governance thesis, dramatically better performance, and a specification detailed enough to build from.

Looking forward to the next iteration.
