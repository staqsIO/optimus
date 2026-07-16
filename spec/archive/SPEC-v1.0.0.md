<!-- AUTO-GENERATED from spec/ directory. Do not edit directly. Run: node scripts/build-spec.js -->
# Agent Organization Architecture — Specification v1.0.0

> **Document version:** 1.0.0
> **Date:** 2026-03-10
> **Authors:** Dustin, Eric (Formul8/Staqs.io), Claude (drafting assistance)
> **Lineage:** v0.1 → v3 (Eric) → v0.4 (Dustin) → v0.5 (Eric review) → v0.5.1 (three-agent review + VentureBeat) → v0.5.2 (Linus/Liotta audit) → v0.6.x (ecosystem alignment + source control) → v0.7.0 (redundancy cleanup + threat detection memory + pathway instrumentation) → v1.0.0 (board decision review — cost model, behavioral contracts, sanitization scope)
> **Scope:** Canonical architecture for Optimus (governed agent organization) and AutoBot (autonomous constitutional agent organization). Supersedes all prior versions.
> **Versioning:** `MAJOR.MINOR.PATCH` — see `CHANGELOG.md` for full history
> **Companion documents:**
> - `SPEC-v1.0-DECISIONS.md` (Board decision document — D1-D11 resolutions)
> - `research/` (Gap analyses, addenda, academic research)
> - `reviews/` (Agent review transcripts)
> - `conversation/archive/` (Historical design conversation)

---

## 0. Design Principles

These principles govern every architectural decision. When in doubt, refer here.

**P1. Deny by default.** No agent has any capability unless explicitly granted. Tool access, schema access, communication channels, delegation authority — everything starts at zero and is granted per-role. This is the single most important security principle. OpenClaw's allow-by-default architecture (agents can do everything unless explicitly blocked) produced CVE-2026-25253 (CVSS 8.8, one-click RCE), 800+ malicious skills (~20% of the ClawHub registry as of Feb 2026), and active infostealer campaigns (RedLine, Lumma, Vidar targeting OpenClaw configs) within weeks of reaching scale. 30,000+ internet-exposed instances were catalogued. Microsoft's security assessment: "OpenClaw should be treated as untrusted code execution with persistent credentials." The inversion — deny-by-default — is not a preference. It is a requirement.

**P2. Infrastructure enforces; prompts advise.** Constitutional rules, guardrails, and access controls are enforced by database roles, JWT scoping, credential isolation, and schema constraints. Agent system prompts restate these rules as defense-in-depth, but the prompt is never the enforcement boundary. A prompt injection, hallucination, or malicious input cannot override an infrastructure constraint. Runlayer's Feb 2026 benchmarks quantify this: baseline OpenClaw prompt injection resistance is **8.7%** — prompts fail to block 91.3% of injection attempts. Adding infrastructure-layer enforcement (ToolGuard) raises resistance to **95%**. The gap between 8.7% and 95% is the difference between a prompt boundary and an infrastructure boundary. OpenClaw's SOUL.md is philosophically elegant — "the agent reads itself into being" — but provides zero enforcement against adversarial inputs.

**P3. Transparency by structure, not by effort.** Every state transition, every LLM invocation, every guardrail check is logged automatically as a side effect of the system operating. Transparency is not a feature agents choose to provide. It is an unavoidable property of the architecture. The public event log, the append-only ledger, and the Merkle proof artifacts exist because the system cannot operate without producing them.

**P4. Boring infrastructure.** Postgres, not a custom database. SQL checks, not novel verification protocols. Hash chains, not blockchain. JWT, not a custom auth system. Every component should be the most proven, most boring technology that solves the problem. Novelty is reserved for the organizational model, not the infrastructure.

**P5. Measure before you trust.** No agent tier, no constitutional layer, no autonomous capability is activated based on a calendar date. Activation requires measurable capability gates passing for a sustained period. Time teaches nothing. Data proves readiness.

**P6. Familiar interfaces for humans.** Agents operate through the task graph. Humans operate through whatever they already use — email, Slack, WhatsApp, a web dashboard. The system adapts to humans, not the other way around. OpenClaw's product insight — use the channels people already have — is correct and applies to board oversight, not just end users.

---

## 1. The Core Idea

A fully agent-staffed technology organization where every operational role is an AI agent, governed by a human board of directors. Agents coordinate through a structured task graph. Every action is logged to a public event archive. The human board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

This is **Optimus**: the governed agent organization.

Optimus is also the proving ground for **AutoBot**: an autonomous constitutional agent organization where the human board is replaced by a constitutional layer, and the system operates with no ongoing human involvement in operational decisions. AutoBot cannot exist until Optimus has proven that agent governance works under human supervision.

**Clarification on "no humans involved":** AutoBot is operationally autonomous — no human employees, no human involvement in decisions about what products to build, how to price them, or how to execute tasks. It is NOT legally autonomous. No entity is. The creator is a custodian (dead-man's switch, kill switch, tax oversight). The CPA, attorney, and distribution partner are service providers. See §17 (Legal Compliance Architecture) for the full mapping.

---

## 2. Architecture Overview

### Optimus (Governed)

```
+---------------------------------------------------------------+
|                      HUMAN BOARD                               |
|  (Strategy, Ethics, Budget, Legal, Oversight)                  |
|                                                                |
|  Interacts via:                                                |
|    - Dashboard (task graph + audit log + cost tracking)        |
|    - Event digests (email, Slack, RSS — their choice)          |
|    - Direct task injection (create DIRECTIVE in task graph)    |
|    - Lightweight command interface (Slack/email — approve/     |
|      reject tasks, inject directives, trigger HALT from        |
|      whichever channel the board member is already using.      |
|      P6: system adapts to humans, not the reverse.)            |
|  Reviews via:                                                  |
|    - Public event archive (searchable, filterable)             |
|    - Agent config history (every prompt version tracked)       |
|    - Cost dashboards (real-time burn rate + budget status)     |
+----------------------------+----------------------------------+
                             |
                             v
+---------------------------------------------------------------+
|                  ORCHESTRATION LAYER                           |
|  (Postgres task graph — single source of truth)               |
|                                                                |
|  +-- guardCheck() on every action (pre + post execution)      |
|  +-- JWT-scoped agent identity + tool allow-lists             |
|  +-- Postgres RLS for agent data isolation                    |
|  +-- pg_notify + outbox for event-driven dispatch             |
|  +-- Content sanitization on context load (P2)                |
|  +-- Kill switch integration (board-triggered HALT)           |
|  +-- Tool integrity verification (hash check before invoke)   |
+---------------------------------------------------------------+
           |              |              |
           v              v              v
    +-----------+  +------------+  +------------+
    | Strategist|  | Orchestrator|  |  Executor  |
    | (Claude   |  | (Claude    |  | (Haiku     |
    |  Opus)    |  |  Sonnet)   |  |  4.5)      |
    +-----------+  +-----+------+  +------------+
                         |
                    +----+----+
                    |         |
               +--------+ +--------+
               |Reviewer| |Executor|
               |(Sonnet)| |(Haiku) |
               +--------+ +--------+

+---------------------------------------------------------------+
|                   PUBLIC TRANSPARENCY LAYER                    |
|  Every state transition → structured event → public archive   |
|  Deterministic renderer (no AI) → human-readable messages     |
|  Searchable at optimus.ai/archive/                            |
|  Event digests pushed to board via preferred channels          |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER                        |
|  Tool registry with content-addressed hashes                  |
|  Sandboxed execution for all tool invocations                 |
|  Behavioral monitoring (output anomaly detection)             |
|  No tool may be invoked unless registered + hash-verified     |
+---------------------------------------------------------------+
```

### Agent Tiers

| Tier | Roles | Model | Capabilities | Constraints |
|------|-------|-------|-------------|-------------|
| Strategist | Strategic planning, cross-domain synthesis | Claude Opus | Full task graph read, create DIRECTIVEs, approve budgets, propose prompt modifications | Cannot deploy, cannot modify infrastructure, cannot communicate externally except via Gateway |
| Architect | Technical architecture, system design | Claude Sonnet | Read task graph, create architecture documents, review technical decisions | Cannot assign tasks to executors directly (routes through orchestrator) |
| Orchestrator | Task decomposition, work assignment, result aggregation | Claude Sonnet | Create subtasks, assign to executors/reviewers, aggregate results, report to strategist | Cannot create DIRECTIVEs, explicit `can_assign_to` list (no globs) |
| Reviewer | Quality assurance, output validation | Claude Sonnet | Read task outputs, approve/reject with feedback, flag quality patterns | Cannot assign tasks, cannot modify task outputs, read-only on executor work. **Acceptance criteria (v0.5.1):** Reviewer evaluates three dimensions — *correctness* (is the output factually/technically right?), *format compliance* (does it match the expected schema?), and *completeness* (does it address ALL acceptance criteria, not just some? — an accurate but incomplete output is flagged for rework, not approved). |
| Executor | Implementation, testing, data processing | Haiku 4.5 (Phase 1); Ollama evaluated Phase 2+ when tasks > 12,500/mo | Execute assigned task, attach output, reply to assigning agent | Cannot initiate tasks, cannot read other executors' work, cannot access production, hard output token limit |
| Utility | Cost tracking, format conversion, log analysis | Smallest viable model | Mechanical transformations, no reasoning required | Cannot communicate with any agent except its configured target |

### Behavioral Contracts

Each agent declares a behavioral contract specifying its expected outputs, success criteria, and interaction norms. Reviewers validate agent work against these contracts rather than subjective judgment. The contract schema is implementation-defined but must be machine-readable and versioned alongside agent configuration. At minimum, a behavioral contract must include measurable success criteria (P5: measure before you trust).

### Lethal Trifecta Assessment

Every component is evaluated against Simon Willison's risk framework: access to private data + exposure to untrusted content + ability to communicate externally = maximum risk.

| Component | Private Data | Untrusted Content | External Comms | Risk | Mitigation |
|-----------|-------------|-------------------|----------------|------|------------|
| Strategist | HIGH (full graph) | LOW (internal only) | Gateway only | Medium-High | Budget limits, board approval gates, prompt drift monitoring |
| Orchestrator | MEDIUM (task graph) | LOW (internal only) | Gateway only | Medium | Explicit assignment lists, delegation depth limits |
| Executor | LOW (assigned task) | VARIABLE (may process external data) | NONE | Medium | Sandboxed tool execution, output schema validation, token limits |
| Reviewer | MEDIUM (task outputs) | MEDIUM (reads executor output) | NONE | Medium | Content sanitization on context load, read-only access |
| Financial Script | HIGH (financial data) | NONE | NONE | Low | Deterministic (no AI), separate credentials, append-only ledger |
| Communication Gateway | LOW (message content) | HIGH (inbound messages) | HIGH (outbound) | **Critical** | Deterministic sanitizer, credential isolation, rate limits, risk-tiered release, cool-down buffer |
| Auditor (Tier 2) | HIGH (full read access) | NONE | NONE | Medium | Separate infrastructure, different cloud account, no inbound path from agents |

The Communication Gateway is the highest-risk component. It gets the most security investment. See §7.

---

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
                        --   guardrails, can_assign_to). Versioned by config_hash.
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

---

## 4. Agent Runtime

### Runtime Loop

```
+-------------------------------------------------------------+
|              AGENT RUNTIME LOOP                              |
|                                                              |
|  1. AWAIT event from task queue (outbox + pg_notify)         |
|     Priority order (highest first):                          |
|       1. halt_signal                                         |
|       2. escalation_received                                 |
|       3. review_requested                                    |
|       4. task_completed (dependency resolved)                |
|       5. task_assigned                                       |
|     Processed serially per agent, priority order.            |
|                                                              |
|  2. CHECK idempotency (has this event_id been processed?)    |
|                                                              |
|  3. GUARDRAIL PRE-CHECK (orchestration layer, not agent):    |
|     - HALT check (absolute priority, no caching)             |
|     - Authorization (is this task in my scope?)              |
|     - Budget pre-authorization (estimate cost, check limit)  |
|     - Data classification (am I cleared for this level?)     |
|     - Tool access validation (JWT claim check)               |
|                                                              |
|  4. LOAD CONTEXT (within token budget):                      |
|     a. Agent identity + config_hash                          |
|     b. Task details + acceptance criteria                    |
|     c. Parent task summary (not full parent context)         |
|     d. Sibling task statuses                                 |
|     e. Guardrails (org + role + task level)                  |
|     f. SANITIZE all loaded content:                          |
|        - Strip injection patterns from task outputs          |
|        - Validate schema of structured data                  |
|        - Truncate oversized fields to token budget           |
|        - Flag anomalous content for reviewer attention        |
|                                                              |
|  5. EXECUTE via model                                        |
|     - All model I/O logged (prompt_hash + response_hash +    |
|       tokens + cost + latency_ms)                            |
|     - Tools invoked via sandboxed execution environment      |
|     - Tool hash verified before invocation (P1)              |
|                                                              |
|  6. GUARDRAIL POST-CHECK on output:                          |
|     - Schema validation (does output match expected format?) |
|     - Completeness check (v0.5.1): does output address all  |
|       acceptance criteria, not just some? Accurate but       |
|       incomplete outputs flagged for rework, not approved.   |
|     - PII detection (flag for data classification review)    |
|     - Cost reconciliation (actual vs estimated)              |
|     - Escalation trigger evaluation                          |
|     - DAG cycle detection (if creating subtasks)             |
|     - can_assign_to validation (explicit ID list, no globs)  |
|     - Adversarial content scan                               |
|     - Output quarantine gate: if schema                      |
|       validation OR adversarial scan fails, the output is    |
|       flagged as quarantined (output_quarantined = true on   |
|       the work item — NOT a state machine state). The work   |
|       item remains in `in_progress`; it cannot transition    |
|       to `review` until the Reviewer inspects and clears     |
|       the quarantined output. This is an output-level flag,  |
|       not a workflow state, to avoid polluting the state     |
|       machine with validation concerns.                      |
|                                                              |
|  7. TRANSITION STATE (atomic via transition_state()):        |
|     - Validate against state machine rules                   |
|     - Single transaction: update state + write audit +       |
|       emit event + publish to public event log               |
|                                                              |
|  8. Return to AWAIT                                          |
+-------------------------------------------------------------+
```

### Executor Filesystem Isolation

The runtime loop above governs the logical execution model. For executor agents that perform code-related tasks (implementation, testing, code scanning), filesystem-level isolation is required in addition to the Postgres RLS data isolation.

**Agent-per-worktree pattern:** Each executor task that involves code gets its own git worktree, not just its own branch. This is the dominant pattern in the strongest multi-agent orchestration repos (AndrewAltimit/template-repo, ComposioHQ/agent-orchestrator) because it prevents agents from stepping on each other's work at the filesystem level — not just the branch level.

**How it works:**
1. When an executor claims a code task, the orchestration layer creates a dedicated git worktree for that task (e.g., `worktrees/TASK-0042/`)
2. The executor's sandboxed environment is scoped to this worktree — no access to other worktrees, the main branch working directory, or other agents' in-progress work
3. When the task completes and passes review, the worktree's changes are merged through the standard PR/review pipeline
4. Worktrees are cleaned up after merge or task failure

This directly enforces the existing constraint from §5 ("executors cannot read other executors' work") at the filesystem level, not just the database level. It also eliminates merge conflicts between concurrent executor tasks — each operates on an isolated copy of the codebase.

**Scope:** This applies only to code-related executor tasks. Data processing, format conversion, and other non-code tasks use the existing sandboxed execution environment (§6) without git worktrees.

### Automated Reaction Loops

The state machine (§3) defines the `failed → assigned (retry)` transition, but does not specify what context the retried task receives. The most mature multi-agent systems (ComposioHQ/agent-orchestrator) close the feedback loop automatically — human intervention is reserved for escalation, not routine failure recovery.

**CI failure reaction:**
1. Executor completes a code task → PR created → CI runs
2. CI fails → failure logs are captured as structured data (not raw log dump)
3. Task transitions to `failed` with `failure_context` attached: CI log summary, failing test names, error categories
4. Task is re-queued (`failed → assigned`) with `failure_context` loaded as Q3-tier context (see §4 data quality tiers) — the retrying executor sees what went wrong
5. If retry succeeds → normal flow. If retry fails after max retries → escalate to Reviewer with full failure history

**Review rejection reaction:**
1. Reviewer rejects a task with structured feedback (rejection reason, specific issues, suggested fixes)
2. Task transitions to `in_progress (revision)` with reviewer feedback loaded as Q2-tier context
3. Executor addresses the feedback and resubmits
4. If rejected again after 1 round of feedback → escalate to Orchestrator (existing §5 constraint: "1 round of feedback then escalate")

**Key principle:** The human (board member) only enters the loop on escalation — when retry + automated feedback has been exhausted. This is what makes the "spawn and walk away" operational model viable at scale.

### Agent Configuration

Agent configs are stored in the `agent_graph.agent_configs` table (one row per agent, versioned via `config_hash`). The orchestration layer loads the active config on agent startup and on config change events. Config history is preserved in `agent_graph.agent_config_history` (append-only). Config files shown below are the JSON value stored in the `config_json` column:

#### `agents.md` as Human-Authored Source of Truth

The `agents.md` standard (https://agents.md/) is a Linux Foundation-stewarded open format used by 60,000+ open-source projects for defining agent roles, boundaries, and behaviors. Rather than inventing a custom definition format, Optimus adopts `agents.md` as the human-readable agent definition layer.

**How it integrates:**

`agents.md` files are the authoring surface — humans (board members, the Architect) write and review agent definitions in Markdown. A deterministic compiler translates `agents.md` definitions into the JSON config rows stored in `agent_configs`. This mirrors GitHub Agentic Workflows' pattern of compiling Markdown-defined workflows to GitHub Actions YAML.

**What `agents.md` defines (human-readable):**
- Agent identity, role, and display name
- Behavioral boundaries (what the agent does and does NOT do)
- Tool permissions (allowed and forbidden)
- Delegation rules (who this agent can assign to)
- Anti-patterns (specific things the agent must avoid — analysis of 2,500+ repos shows anti-patterns improve agent performance more than positive instructions)

**What the compiled JSON config adds (infrastructure-enforced):**
- `config_hash` (content-addressed, stamped on every audit entry)
- JWT claims and database role mappings
- Guardrail thresholds (budget limits, token limits, delegation depth)
- Context budget parameters
- Model provider and fallback specifications

The `agents.md` file is versioned alongside the compiled config. Any change to `agents.md` triggers recompilation, and the new config is only activated after board approval (or Strategist approval for Phase 2+ tactical changes). The compilation step is deterministic — the same `agents.md` always produces the same JSON config.

**Why this matters:** Ecosystem compatibility. As tools like GitHub Agent HQ, ComposioHQ's agent-orchestrator, and Claude Code's plugin system mature, they will increasingly expect `agents.md`-formatted agent definitions. Adopting the standard now avoids a costly migration later.

```json
{
  "schema_version": "3.0",
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
    "allowed": ["read_file", "query_task_graph", "create_subtask",
                "assign_task", "attach_output"],
    "forbidden": ["write_file", "execute_code", "deploy_to_production",
                  "delete_repository", "external_http_request",
                  "modify_guardrails", "modify_agent_config",
                  "access_other_agent_context"]
  },

  "guardrails": {
    "max_budget_per_task_usd": 5.00,
    "max_delegation_depth": 3,
    "requires_approval_above_usd": 10.00,
    "approval_from": "strategist",
    "data_classification_clearance": ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    "max_output_tokens": 4096,
    "max_tool_invocations_per_task": 10
  },

  "context_budget": {
    "max_context_tokens_per_task": 6000,
    "graph_query_depth": 3,
    "context_strategy": "parent_summary_only",
    "content_sanitization": true,
    "semantic_search_for_history": true
  }
}
```

All agent IDs are explicit — no glob patterns. `config_hash` is stamped on every audit entry. Tool access is enforced by JWT validation at the orchestration layer, not by the agent reading its own config.

### Context Window Management

Context window economics dominate operational cost. OpenClaw's approach to this problem — semantic search via SQLite-vec + FTS5 keyword matching, with compaction for older history — is a proven pattern at scale. Optimus adopts a similar strategy:

**Per-task context loading:**
1. Agent identity + guardrails (fixed overhead, ~500 tokens)
2. Current task details + acceptance criteria (~200-1,000 tokens)
3. Parent task summary — not the full parent context, but a compressed summary (~200-500 tokens)
4. Sibling task statuses — one line each (~100-300 tokens)
5. Relevant prior work — semantic search over completed task outputs, keyword-matched to the current task description (~1,000-4,000 tokens, capped by `max_context_tokens_per_task`)

**Data quality tiers for context loading:** Not all task graph data is equally reliable. Context loading weights sources by provenance:

| Tier | Source | Reliability | Context Priority |
|------|--------|------------|-----------------|
| Q1 | Board-authored directives, acceptance criteria | High — human-authored, reviewed | Loaded first, never truncated |
| Q2 | Reviewed AI outputs (passed Reviewer + Tier 1 checks) | Medium-high — validated | Loaded second, summarized if over budget |
| Q3 | Unreviewed AI outputs (executor work pending review) | Variable — unchecked | Loaded last, clearly labeled as unreviewed, capped at 25% of context budget |
| Q4 | External data ingested via tools | Variable — untrusted | Sanitized before loading, capped at 15% of context budget |

When an agent's context budget forces truncation, Q4 content is truncated first, then Q3, then Q2. Q1 is never truncated. This ensures agents make decisions weighted toward human-validated information. Source: industry consensus that agents are only as autonomous as their data is reliable (see companion research document).

**Compaction:** When an agent's historical context exceeds its token budget, older task summaries are compressed by a deterministic summarization pass (a utility agent on the smallest model). The full records remain in the database; only the context window representation is compacted.

**Cost targets per tier:**

| Tier | Model | Input Cost/MTok | Output Cost/MTok | Max Context/Task | Max Cost/Task (input+output) |
|------|-------|----------------|-----------------|-----------------|------------------------------|
| Strategist | Claude Opus | $15 | $75 | 8,000 tokens | $0.42 |
| Architect | Claude Sonnet | $3 | $15 | 6,000 tokens | $0.078 |
| Orchestrator | Claude Sonnet | $3 | $15 | 4,000 tokens | $0.072 |
| Reviewer | Claude Sonnet | $3 | $15 | 4,000 tokens | $0.072 |
| Executor | Haiku 4.5 (Phase 1); Ollama evaluated Phase 2+ | $1 | $5 | 4,000 tokens | $0.024 |

Target: total context cost per directive < $3.00.

---

## 5. Guardrail Enforcement

### Architecture: Orchestration Layer Enforces, Agents Do Not Self-Police

Per P2, the enforcement boundary is the orchestration layer — a process that is not the agent, running with different credentials, validating every action before and after execution. See §0 P1/P2 for the threat data that drove this decision.

**`guardCheck()` and `transition_state()` MUST execute as a single atomic Postgres transaction.** A gap between "guard passes" and "transition executes" creates a race condition where two agents can pass the same budget check and both spend. This is a correctness requirement, not an optimization.

```sql
-- guardCheck + transition_state as a single atomic operation
--
-- LOCK ORDERING: Always acquire budgets lock BEFORE work_items lock.
-- All code paths must follow this order to prevent deadlocks.
BEGIN;
  -- 1. Budget check: atomic UPDATE with CHECK constraint (no FOR UPDATE needed).
  --    If budget is exceeded, the UPDATE affects 0 rows → guard fails → ROLLBACK.
  UPDATE budgets
    SET spent = spent + $estimated_cost
    WHERE directive_id = $2
      AND spent + $estimated_cost <= allocation;
  -- If rows_affected = 0: budget exceeded → ROLLBACK

  -- 2. Lock the work item for state transition
  SELECT ... FROM work_items WHERE id = $1 FOR UPDATE;

  -- 3. Evaluate remaining guard conditions against locked state:
  --   actor_can_assign_to_target (explicit list, no globs)
  --   delegation_depth_within_limit
  --   data_classification_cleared
  --   tool_calls_permitted (all in allow-list, all hash-verified)
  --   no_dag_cycle (would_create_cycle check)
  --   halt_not_active
  --   valid_state_transition
  --   output_passes_adversarial_content_scan

  -- 4. Graduated escalation check (see §8):
  --   v_level := current_escalation_level('agent', $agent_id)
  --   Level 2+: force review (override review-optional rules)
  --   Level 3+: block new task claims (RAISE EXCEPTION)
  --   Level 4:  all actions blocked (agent should already be disabled,
  --             but defense-in-depth)
  -- If all pass: update state, write audit, emit event
  -- If any fail: ROLLBACK (budget UPDATE is also rolled back)
COMMIT;
```

The budget check uses an atomic `UPDATE ... WHERE` instead of `SELECT ... FOR UPDATE` followed by a separate check. This eliminates lock contention on the budget row — concurrent tasks for the same agent don't serialize on the budget lock, they race on the atomic UPDATE and the CHECK constraint guarantees correctness. If the transaction rolls back for any reason, the budget increment is also rolled back.

### Guardrail Tiers

**Organizational guardrails** (board-level, enforced on all agents):

```json
{
  "org_guardrails": {
    "max_daily_spend_usd": 100.00,
    "max_single_task_usd": 20.00,
    "no_external_communication_except_via_gateway": true,
    "no_production_deploys_without_board_approval": true,
    "data_classification_required_on_all_tasks": true,
    "halt_on_security_incident": true,
    "deny_by_default": true,
    "all_tools_must_be_hash_verified": true,
    "content_sanitization_on_all_context_loads": true
  }
}
```

**Role-level guardrails:**

| Tier | Can Delegate | Can Communicate | Can Access | Special Constraints |
|------|-------------|----------------|-----------|-------------------|
| Strategist | To any agent below | Via Gateway (Tier 2+ requires board approval) | Full task graph (read), budget tables | Must escalate to board above budget threshold |
| Architect | To orchestrators only | Internal only | Task graph (read), architecture docs | Cannot assign to executors directly |
| Orchestrator | To explicit `can_assign_to` list | Internal only | Task graph (read/write subtasks) | Max 1 task per executor at a time, must set deadline |
| Reviewer | Cannot delegate | Internal only | Task outputs (read-only) | Cannot modify outputs, 1 round of feedback then escalate |
| Executor | Cannot delegate | Reply to assigner only | Assigned task only | Hard token limit, sandboxed tool execution, cannot read other executors' work |
| Utility | Cannot delegate | Configured target only | Configured data source only | Mechanical only, no reasoning tasks |

### Content Sanitization

OpenClaw demonstrated that persistent memory creates stateful, delayed-execution attacks. Palo Alto Networks flagged that malicious payloads can be injected into memory and trigger later, across sessions. In Optimus, the task graph is the persistent memory. A compromised executor could write adversarial content to a task output that a reviewer or orchestrator later loads into its context.

Hash chains detect tampering (was this record modified after creation?). Content sanitization detects adversarial content (does this record contain injection patterns, regardless of whether it was modified?).

**Sanitization runs at context-loading time (step 4f of the runtime loop):**
1. Strip known injection patterns (prompt override attempts, system prompt references, role-play instructions) using a **versioned rule set** — not ad-hoc patterns
2. Validate structured data against expected schema
3. Truncate oversized fields to the token budget (prevents context flooding)
4. Flag anomalous content (unexpected format, unusual token patterns) for reviewer attention before the agent processes it
5. Log all sanitization actions to the audit trail

**Sanitization specification:** Implementation-defined via ADR. The spec mandates that content sanitization is infrastructure-enforced (P2), versioned, tested against adversarial inputs, and logged to the audit trail. The specific pattern categories, rule sets, update mechanisms, and testing methodology are implementation concerns that evolve faster than the spec — they are documented in the implementation ADR and operational runbooks.

**False negative acknowledgment**: This layer cannot catch everything. It is defense-in-depth, not a security boundary. The security boundary is P2 (infrastructure enforcement). When sanitization misses something, the post-check (step 6) and Tier 2 auditor catch it. The chain is: sanitization → post-check → Tier 2 daily review.

**PII-handling component requirements:** Any component touching user data must pass mandatory tests before deployment:
- (a) No PII in logs — automated scan of all log output
- (b) Data classification tagging on all fields (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED)
- (c) Deletion capability — GDPR right to erasure (Article 17) functional
- (d) Encryption at rest for CONFIDENTIAL and RESTRICTED fields
- Board certifies compliance until Phase 3, when the Auditor agent assumes certification authority.

This is defense-in-depth. Infrastructure constraints (P2) prevent most attacks. Content sanitization catches what infrastructure cannot — adversarial content that is structurally valid but semantically malicious.

---

## 5a. Knowledge Graph Layer

**Status:** Board-approved 2026-03-13 (implementation ADR-019). Production deployment gated on Linus security fixes.

### Purpose and Separation of Concerns

Postgres is the single operational truth for task coordination, state transitions, guardrail enforcement, and audit. It does not change. Neo4j is an advisory learning layer alongside Postgres — it stores agent capabilities, task outcomes, learned patterns, and decision history, enabling agents to discover peers, improve assignment decisions, and surface patterns invisible in tabular data.

**Division of authority:**

| Layer | Role | Authoritative For |
|-------|------|-------------------|
| Postgres | Operational truth + enforcement | Task state, guardrails, budgets, audit trail |
| Neo4j | Relationship intelligence + agent learning | Capability graphs, outcome patterns, decision history |

No enforcement logic moves to Neo4j. All constitutional gates remain enforced at the Postgres transaction boundary (P2 unchanged). If Neo4j and Postgres disagree on any fact, Postgres wins.

### Graph Model

**Nodes:** Agent, TaskOutcome, Pattern, Decision, Capability

**Edges:**

| Edge | From → To | Meaning |
|------|-----------|---------|
| `COMPLETED_TASK` | Agent → TaskOutcome | Agent produced this outcome |
| `PROPOSED_DECISION` | Agent → Decision | Agent was the decision author |
| `HAS_CAPABILITY` | Agent → Capability | Agent has demonstrated this capability |
| `CAN_DELEGATE_TO` | Agent → Agent | Delegation relationship (derived from assignment history) |
| `SIMILAR_TO` | TaskOutcome → TaskOutcome | Outcome similarity (Cypher relationship, not pgvector) |
| `LEARNED_FROM` | Agent → Pattern | Agent has incorporated this pattern |

**Security constraint:** No PII in graph nodes. Nodes reference type + ID only (e.g., `{type: "email", id: "msg-0042"}` — never subject lines, intent titles, or contact names). Graph data is advisory — never used as input for enforcement decisions.

### Sync Mechanism

Graph data is populated asynchronously from Postgres events. The sync path uses an outbox table for durability (the same pattern as `task_events` in §3):

1. Postgres writes to `agent_graph.graph_sync_outbox` as part of the state transition transaction
2. Sync listener reads outbox entries via `FOR UPDATE SKIP LOCKED`, writes to Neo4j, marks delivered
3. If Neo4j is unavailable, entries accumulate in the outbox — no data loss, no agent impact
4. If the sync listener restarts, it replays undelivered outbox entries

**Events that trigger graph sync:** `task_completed`, `intent_decided`, `draft_reviewed`

`pg_notify` is used for low-latency notification that outbox entries are waiting. It is not the durability mechanism — the outbox table is. A `pg_notify` drop (e.g., listener restart) causes a sync delay, not data loss.

### Tier-Gated Reflection

Only higher-tier agents have access to `reflect()` — the capability to query Neo4j before making decisions. Executor agents (Haiku) have no graph access in their hot path.

| Tier | `reflect()` Access | Typical Use |
|------|--------------------|-------------|
| Strategist | Yes | Query outcome patterns before priority scoring |
| Architect | Yes | Query pipeline patterns before analysis |
| Orchestrator | Yes | Query capability data before task assignment |
| Reviewer | No | — |
| Executor | No | — |

Access is enforced by the orchestration layer (P1): `reflect()` is not in the executor tool allow-list. Agents do not self-police this.

### Graceful Degradation

Neo4j is valuable but not load-bearing. If Neo4j is unavailable:

- Agents continue operating normally via the Postgres task graph
- `reflect()` calls return empty results (no error, no blocking)
- Sync listener queues events in the outbox and retries on reconnect
- The only loss is learning data recency — operational integrity is unaffected

This is a hard design constraint: any code path that calls Neo4j must handle connection failure without propagating the error to the agent execution path.

### P4 Exception

Neo4j is not "boring infrastructure" (P4). This tension is acknowledged, not resolved. The exception is justified by two factors: (1) multi-hop relationship traversal and pattern emergence — the query patterns that make learning useful fight the relational model at 3+ hops; (2) client demonstration of graph intelligence as a capability of the Optimus organizational model. All enforcement remains in Postgres. P4's intent — minimize novel infrastructure dependencies — is satisfied for the enforcement layer. The learning layer accepts the tradeoff.

**Simpler aggregations** (e.g., agent success rates, task type distributions) remain in Postgres as materialized views. Neo4j is used only where graph traversal is structurally necessary.

### Cross-References

- ADR-019: `autobot-inbox/docs/internal/adrs/019-neo4j-knowledge-graph.md` — implementation decision record
- P1: Neo4j read access is explicitly granted per agent tier; A2A (self-declared capabilities) was rejected for P1 violation
- P2: All guardrails remain in Postgres; Neo4j is advisory
- P3: Learning graph makes agent improvement observable and auditable
- P4: Exception acknowledged; see above
- P5: Graph data enables richer capability gate assessments (measure before you trust)
- §2 Agent Tiers: Reflection gated by tier
- §3 Task Graph: Postgres task graph unchanged; Neo4j is additive
- §5 Guardrail Enforcement: No enforcement moves to Neo4j

---

## 6. Tool Integrity Layer

### The Problem

The tool supply chain is the primary attack vector in agent systems (see §0 P1 for OpenClaw threat data). The Tool Integrity Layer ensures no tool can be invoked unless registered, hash-verified, and sandboxed.

### Architecture

```
+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER                        |
|                                                                |
|  Tool Registry (MCP-compatible — v0.5)                         |
|    - Every tool is stored as a content-addressed artifact:     |
|      the SHA-256 hash IS the lookup key (not hash-then-load,   |
|      but load-BY-hash — eliminates TOCTOU race conditions)     |
|    - Tool declaration follows MCP protocol (tool schemas,      |
|      capability negotiation, standardized invocation)          |
|    - Tools are registered by the board or by an authorized     |
|      agent with board approval                                 |
|    - Registration includes: hash, description, input schema,   |
|      output schema, required permissions, risk classification  |
|    - No tool may be invoked unless it exists in the registry   |
|      AND it is loaded by its content-addressed hash             |
|    - Config pipeline integrity: every agent config change is   |
|      signed by the board's cryptographic key and verified by   |
|      the orchestration layer before loading (prevents          |
|      ClawHavoc-style memory file attacks)                      |
|                                                                |
|  Sandboxed Execution                                           |
|    - All tool invocations run in an isolated environment       |
|      (container or process sandbox)                            |
|    - Tool process has no access to agent credentials,          |
|      other agent contexts, or the orchestration layer          |
|    - Network access: denied by default. Whitelisted per-tool   |
|      if the tool requires external data (e.g., web search)     |
|    - Filesystem access: scoped to a temporary directory.       |
|      No access to agent state, config, or other tool outputs   |
|                                                                |
|  Behavioral Monitoring                                         |
|    - Tool output is validated against the registered output    |
|      schema before being returned to the agent                 |
|    - Output size limits enforced (prevent context flooding)    |
|    - Anomaly detection: if a tool that normally returns JSON   |
|      starts returning freeform text, flag for review           |
|    - All tool invocations logged: tool_hash, input_hash,       |
|      output_hash, execution_time, resource_usage               |
|                                                                |
|  CI/CD Execution Model                                         |
|    - When agents produce code that needs testing/deployment,   |
|      execution runs through GitHub Actions with the same       |
|      read-only-by-default posture as GitHub's own Agentic      |
|      Workflows (github/gh-aw). Write operations only through   |
|      sanitized safe-outputs. This extends P1 (deny by default) |
|      to the CI/CD layer — agents cannot push to protected      |
|      branches, modify workflow definitions, or access secrets   |
|      unless explicitly granted per-task.                        |
+---------------------------------------------------------------+
```

### Tool Classification

| Risk Class | Description | Registration | Execution |
|-----------|-------------|-------------|-----------|
| Internal | Reads from task graph, formats data | Board or Strategist approval | Sandboxed, no network |
| Computational | Runs calculations, transformations | Board approval | Sandboxed, no network, resource limits |
| External-Read | Fetches data from external sources | Board approval + security review | Sandboxed, whitelisted network, output sanitized |
| External-Write | Sends data to external systems | Board approval only | Sandboxed, whitelisted network, audited, rate-limited |

### Automated Tool Pre-Screening

At scale, the board becomes a bottleneck for tool registration (OpenClaw's malicious skill count grew from 341 to 824+ across 10,700+ skills). New tool registrations undergo automated static analysis before board review:

1. Sandboxed execution with synthetic inputs — tool must produce expected output format
2. Network traffic monitoring — flag any unexpected outbound connections
3. Output schema validation — verify output matches registered schema
4. Resource usage profiling — flag excessive CPU, memory, or disk usage
5. Results presented to board with pass/fail summary for final approval

This does not remove the board from the approval chain — it reduces the review burden by filtering obviously malicious or broken tools before a human sees them.

### Tool Acceptance Policy (Phase 1 deliverable)

Before any non-core tools are registered, the board co-authors a written tool acceptance policy defining approval criteria per risk class. This prevents the Treasure Data pattern — opening a tool contribution pipeline without defining what gets approved, leading to wasted effort and security risk.

The policy must define, at minimum:
- What qualifies a tool for each risk class (Internal / Computational / External-Read / External-Write)
- Which approval path each risk class follows (Strategist-only vs. board-required)
- What pre-screening results (see above) constitute automatic rejection
- What documentation is required at registration (description, schema, test cases, risk justification)
- How tool deregistration works (who can revoke, under what conditions)

This is a Phase 1 deliverable. No non-core tools may be registered until the policy is approved by the board.

### Dependency Management Policy

- **30-day lag-behind** for non-security npm package updates. New versions are not ingested into the vendor cache (§18) until 30 days after publication. This protects against supply chain attacks targeting new releases.
- **Zero lag for security patches.** Patches addressing known CVEs bypass the lag — a 30-day delay on a known vulnerability is worse than supply chain risk.
- **CVE awareness pipeline:** OSV.dev as primary structured feed (covers NVD + GitHub Advisory DB). Daily polling. Auto-create task in task graph for any CVE affecting a dependency. Auto-patch policy: reachability + exposure based — LOW auto-patched, DB drivers never auto-patched, CRITICAL auto-mitigated (circuit-break, not auto-patch). See §18 for full pipeline architecture and decisions/003-cve-auto-patch-policy.md for rationale.

---

## 7. Communication Gateway

### Why a Gateway, Not a Lockdown

v0.1 listed external communication as an "open question" with a default of no external email. OpenClaw's experience demonstrates three failure modes of lockdown:

1. **Goal pressure creates workarounds.** Agents encode messages in API metadata, webhook payloads, or structured outputs. The more you restrict, the more creative and unauditable the workarounds become.
2. **Inability to respond degrades trust.** A company that cannot respond to support tickets, regulatory inquiries, or customer questions is not a functional company.
3. **No audit trail for side channels.** If communication happens through a workaround, there is zero record. A gateway ensures every attempt — successful or rejected — is logged.

### Gateway Architecture

The Gateway is the 5th immutable infrastructure component. Agents submit structured communication intents. The Gateway classifies, sanitizes, scans, and routes messages. Agents never hold communication credentials.

**Outbound processing (risk-tiered release):**

| Tier | Category | Release Mechanism | Latency | Example |
|------|----------|------------------|---------|---------|
| 0 | Transactional | Auto-send | < 200ms | Payment receipt, API confirmation |
| 1 | Operational | Auto-send | < 200ms | Changelog post, status update |
| 2 | Relational | Quorum review (3 agents, 2/3 approval; at least one must be a different model provider + one deterministic rule-based checker) | < 5 min | Support reply, vendor outreach |
| 3 | Reputational | Human-in-the-loop | < 24h SLA | Marketing content, public statement |
| 4 | Legal/Regulatory | Human-in-the-loop + counsel | < 72h SLA | Regulatory response, contract |

**Inbound processing:**

Every inbound message enters through a deterministic pipeline — no LLM touches the raw message:

1. **Channel receiver** (SES, Twilio webhook, Slack events, etc.)
2. **Deterministic sanitizer** — strips HTML, Unicode control characters, known injection patterns. This is NOT an LLM. It is a rule-based parser.
3. **Structured extractor** — a separate small model extracts sender, category, request summary, sentiment. The receiving agent NEVER sees the raw inbound message — only the structured extraction.
4. **Sender verification** — SPF/DKIM/DMARC for email, phone match for SMS, crypto identity for privileged senders (board members, investors authenticate via hardware key or TOTP)
5. **Intent classifier** — routes to existing task or creates new task in the task graph

**Constitutional constraints on communication:**

- Communication cannot create binding obligations (enforced by commitment-language scanner)
- No self-referential communication (outbound to any owned address is blocked)
- Constitutional communication budget (hard daily cap, infrastructure-enforced)
- All outbound includes AI disclosure per FTC Section 5, CA SB 1001, EU AI Act Article 50
- 5-minute cool-down buffer before send (gives kill switch time to activate)

**Gateway schema (`autobot_comms` — isolated):**

| Table | Purpose |
|-------|---------|
| `communication_outbox` | Append-only with hash-chain integrity |
| `inbound_messages` | Normalized inbound with sender verification status |
| `contact_registry` | Known contacts with priority levels and verified channels |
| `templates` | Version-controlled message templates (human-approved) |
| `consent_registry` | Per-user communication preferences and opt-out status |
| `rate_limits` | Current rate limit state per agent, per recipient, global |

Agents have zero write access to `autobot_comms` except through the structured Communication Intent API. The Gateway process has its own database role and credentials.

---

## 8. Audit and Observability

### Three-Tier Audit System

v0.1 relied on email archives. v0.4 uses three tiers:

**Tier 1: Deterministic (every agent cycle, no AI)**
- Constitution hash verification
- Financial rule checks (SQL queries against the ledger)
- Communication boundary enforcement
- Budget limit enforcement
- Agent creation authorization
- Merkle root computation and publication to independent ledger
- Cost: $0/month. Latency: milliseconds.
- Catches ~70% of violations.

**Tier 2: AI Auditor (daily, separate infrastructure)**
- Semantic analysis of agent prompts for constitutional alignment
- Value ratio plausibility checks
- Behavioral pattern analysis (is an agent's behavior changing?)
- **Behavioral drift detection:** Monitor output distribution patterns for each agent independent of prompt changes. If a model provider ships a silent update (e.g., Anthropic updates Sonnet), an agent's output characteristics may shift even though the prompt hasn't changed. Tier 2 maintains rolling statistical baselines per agent — output length distributions, tool invocation frequency, task completion time, rejection rate. Deviations beyond 2σ from baseline trigger a flag to the board. This catches what prompt drift monitoring (Article 4.2a) cannot: behavioral changes caused by external model updates.
- **Guardrail health check:** Periodically review all org, role, and task-level guardrails for internal consistency and currency. Detects "guardrail drift" — constraints that have become stale (e.g., `can_assign_to` lists referencing deactivated agents), conflicting (e.g., budget limits at org level that are lower than role-level minimums), or redundant. Reports findings to board with specific remediation recommendations. Inspired by Qodo's "rule decay" detection pattern.
- Constitutional edge case evaluation
- Runs on separate infrastructure, different cloud account, different database
- No inbound path from organizational agents
- Cost: ~$50-80/month

**Tier 3: Cross-Model Audit (weekly, different provider)**
- Same logs as Tier 2, processed by a different model from a different provider
- Divergences between Tier 2 and Tier 3 findings are flagged to the board/creator
- Eliminates single-provider blind spots
- Cost: ~$20-30/month

### Observability (Phase 1 Requirement)

Every state transition emits a structured event:

```json
{
  "event_id": "evt_2026022615302001",
  "task_id": "TASK-0042",
  "agent_id": "orchestrator-eng",
  "config_hash": "sha256:a1b2c3...",
  "model_id": "claude-sonnet-4-5-20250514",
  "action": "transition_state",
  "from_state": "in_progress",
  "to_state": "completed",
  "tokens_in": 3200,
  "tokens_out": 1100,
  "cost_usd": 0.014,
  "latency_ms": 2340,
  "guardrail_checks": {
    "budget_ok": true,
    "classification_ok": true,
    "delegation_depth_ok": true,
    "content_sanitization_flags": 0
  },
  "data_classification": "INTERNAL",
  "timestamp": "2026-02-26T15:30:20.001Z"
}
```

**Dashboard (board-facing):**
- Task funnel (directive → workstream → task → completion)
- Cost by tier, by model, by department
- Agent utilization (active vs idle time)
- P50/P95/P99 latency per tier
- Active DAG visualization
- Budget burn rate vs projection
- HALT status
- Content sanitization flag rate
- Tool integrity check failures

**Per-user operational views (AutoBot-Inbox, Phase 1):**

For multi-user deployments, five SQL views provide per-user pipeline health. These reference the autobot-inbox product schema (`inbox.*`, `voice.*`) in addition to `agent_graph.*`. All are regular views except `v_p95_latency_by_user` which should be materialized or time-windowed at scale:

| View | Source Tables | What It Shows |
|------|-------------|---------------|
| `v_cost_per_email_by_user` | `agent_graph.llm_invocations` + `inbox.messages` | Total LLM spend per processed email, grouped by user |
| `v_triage_accuracy_by_user` | `inbox.messages` (triage_category) + `inbox.triage_overrides` | % of triage decisions the user accepted without override |
| `v_draft_acceptance_by_user` | `inbox.drafts` + `voice.edit_deltas` | Draft approval rate and mean edit distance per user |
| `v_p95_latency_by_user` | `agent_graph.state_transitions` (trailing 30 days) | P95 end-to-end latency from email arrival to draft ready, per user |
| `v_escalation_rate_by_user` | `agent_graph.state_transitions` + `agent_graph.threat_memory` | % of emails requiring human intervention (guardrail violations, review exhaustion, HALT triggers) |

**Event digests (pushed to board via preferred channels):**
- Daily brief: what happened, what's in progress, any issues
- Weekly detailed: completed tasks, costs, decisions made, risks identified
- On-event: immediate escalation for guardrail violations, budget overruns, agent failures, sanitization flags

### Threat Detection Memory

An append-only log with scope dimensions and threat classification that feeds graduated escalation. Every security-relevant event detected by sanitization (§5 step 4f), output post-check (§4 step 6), Tier 1/2 auditor, tool integrity layer (§6), or Communication Gateway (§7) writes to this table.

```
agent_graph.threat_memory
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  source_type   TEXT NOT NULL CHECK (source_type IN (
                  'sanitization', 'post_check', 'tier1_audit', 'tier2_audit',
                  'tool_integrity', 'gateway_inbound'))
  scope_type    TEXT NOT NULL CHECK (scope_type IN (
                  'agent', 'task', 'workstream', 'tool', 'inbound_channel'))
  scope_id      TEXT NOT NULL    -- the specific agent_id, task_id, tool_hash, etc.
  threat_class  TEXT NOT NULL CHECK (threat_class IN (
                  'INJECTION_ATTEMPT', 'EXFILTRATION_PROBE', 'RESOURCE_ABUSE',
                  'SCHEMA_VIOLATION', 'BEHAVIORAL_ANOMALY', 'INTEGRITY_FAILURE',
                  'POLICY_VIOLATION', 'UNKNOWN_PATTERN'))
  severity      TEXT NOT NULL CHECK (severity IN (
                  'INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
  detail_json   JSONB NOT NULL   -- matched pattern, input excerpt, confidence, context
  prev_hash     TEXT             -- SHA-256 hash chain (same pattern as state_transitions)
  resolved      BOOLEAN NOT NULL DEFAULT false
  resolved_by   TEXT             -- agent_id, 'board', or 'auto_decay'
                                 -- auto_decay: Tier 1 resolves LOW/MEDIUM events with no
                                 --   new events in scope for 24h. HIGH/CRITICAL never auto-decay.
  resolved_at   TIMESTAMPTZ

  -- Append-only: trigger prevents UPDATE/DELETE (except resolved flag via resolve_threat())
  -- REVOKE TRUNCATE, DROP, ALTER from application roles
  -- Hash chain: verify_threat_memory_chain() for tamper detection
  -- Indexes: (scope_type, scope_id, detected_at DESC) for escalation queries
  --          (resolved, severity, detected_at DESC) WHERE resolved = false
```

**Threat classification** uses standard security terminology (not biological naming — P4):

| Class | Description | Default Severity |
|-------|-------------|-----------------|
| `INJECTION_ATTEMPT` | Input designed to override agent instructions | HIGH |
| `EXFILTRATION_PROBE` | Output or tool use attempting to leak data | HIGH |
| `RESOURCE_ABUSE` | Excessive or anomalous resource consumption | MEDIUM |
| `SCHEMA_VIOLATION` | Output that fails structural validation | LOW |
| `BEHAVIORAL_ANOMALY` | Statistical deviation from agent baseline (extends Tier 2 drift detection) | MEDIUM |
| `INTEGRITY_FAILURE` | Hash verification or chain-of-custody failure | CRITICAL |
| `POLICY_VIOLATION` | Guardrail violation that isn't adversarial (budget overrun, unauthorized delegation) | MEDIUM |
| `UNKNOWN_PATTERN` | Anomaly that doesn't match known classes | LOW |

### Graduated Escalation

The current architecture has two threat responses: the Reviewer quarantines an output (§5), or the entire system HALTs (§9). Graduated escalation fills the gap with four intermediate levels, each enforced by infrastructure (P2), not agent judgment.

`current_escalation_level(scope_type, scope_id)` computes a weighted count of unresolved threat events within a configurable time window. Per-severity weights (e.g., INFORMATIONAL=0, LOW=0.5, MEDIUM=1, HIGH=3, CRITICAL=10) convert raw event counts into a single score. The score is compared against threshold levels configured in `tolerance_config`.

| Level | Name | Actions (infrastructure-enforced) | De-escalation |
|-------|------|---------------------------------|---------------|
| **0** | Normal | Standard processing | — |
| **1** | Heightened monitoring | Increase Tier 1 check frequency for scope. Load threat context into Reviewer prompts. Log escalation to event stream. | Automatic when weighted count drops below threshold for 30 min |
| **2** | Restrict and alert | Level 1 + force all tasks in scope through Reviewer (override review-optional rules). Reduce agent tool access to read-only subset. Board notified via event digest. | Board approval or automatic after sustained drop (2 hours below L1 threshold) |
| **3** | Isolate and investigate | Level 2 + agent cannot claim new tasks. Orchestrator reassigns queued work. Board notified immediately (push, not digest). Tier 2 runs targeted analysis on scope. | Board approval required |
| **4** | Scoped HALT | Revoke JWT and disable database role for the specific agent (same mechanism as §9 step 5, narrower scope). All in-progress tasks transition to `failed` (state_transitions.reason: `'security_halt'`). Full Tier 2 + Tier 3 audit triggered. | Board approval + shadow mode re-entry (trust level resets to Level 1 per §11) |

**Relationship to §9:** Graduated escalation handles localized threats (one agent, one workstream). The §9 HALT protocol remains the system-wide emergency stop for systemic threats or board-initiated shutdowns. Level 4 is a scoped HALT — it isolates one agent, not the whole system.

**Tolerance configuration** (`tolerance_config` table) is board-managed (P2), not agent-controlled:

```
agent_graph.tolerance_config
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
  threat_class    TEXT NOT NULL     -- matches threat_memory.threat_class CHECK values
  scope_type      TEXT NOT NULL     -- 'org', 'role', 'agent', 'tool', 'channel'
  scope_id        TEXT              -- NULL = applies to all in scope_type
  window_minutes  INTEGER NOT NULL DEFAULT 60
  level_1_threshold INTEGER NOT NULL  -- → heightened monitoring
  level_2_threshold INTEGER NOT NULL  -- → restrict + alert
  level_3_threshold INTEGER NOT NULL  -- → isolate + investigate
  level_4_threshold INTEGER NOT NULL  -- → scoped HALT
  severity_weights  JSONB NOT NULL DEFAULT '{"INFORMATIONAL":0,"LOW":0.5,"MEDIUM":1,"HIGH":3,"CRITICAL":10}'
  created_by      TEXT NOT NULL     -- must be 'board' for org/role scope
  config_hash     TEXT NOT NULL     -- content-addressed, stamped on audit trail
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE (threat_class, scope_type, scope_id)
  -- NOT append-only: board-managed configuration, updated as operational data informs tuning
  -- Default thresholds provided at Phase 1 deployment, tuned based on threat_memory data
```

**Tier 1 additions:** `threat_memory` event count and escalation level per agent/workstream added to every-cycle deterministic checks. Escalation level changes emit structured events.

**Tier 2 additions:** Daily reclassification review (e.g., a `SCHEMA_VIOLATION` that in context was `INJECTION_ATTEMPT`). Cross-scope correlation analysis (multiple agents in the same workstream accumulating low-severity events simultaneously). Tolerance effectiveness review (are thresholds too sensitive or too lax?).

### Pathway Analytical Views (Framework-Level)

Four views over `work_items`, `llm_invocations`, and `state_transitions` measure routing effectiveness (P5). These are framework-level views (applicable to any Optimus product), distinct from the per-user product views above.

| View | What It Measures |
|------|-----------------|
| `v_routing_class_effectiveness` | Misclassification rate by task type — initial `routing_class` vs `routing_class_final`, with avg cost and latency. Identifies task types where the Orchestrator's heuristic consistently miscategorizes. |
| `v_context_block_correlation` | Context blocks loaded (from `context_profile_json`) vs task outcome, grouped by task type and routing class. Identifies context blocks that don't improve success rate — candidates for removal to reduce token cost. |
| `v_cost_per_task_type_trend` | Weekly average cost, token count, and latency per task type. The key metric: are these trending downward for mature task types? If not, routing or context strategy needs adjustment. |
| `v_agent_efficiency_comparison` | Per-agent cost and success rate for the same task type. Identifies whether specific agents are consistently cheaper or more expensive than peers. |

All four views are time-windowed (trailing 30 days default). At Phase 1 volumes (~300 tasks/day), these execute in single-digit milliseconds against indexed tables. If volume scales to require denormalization, a materialized view or dedicated table can be added as an implementation optimization.

---

## 9. Kill Switch

> **Note:** §8 Graduated Escalation provides scoped threat response (Level 1-4) for localized threats. This section covers system-wide HALT. The two are complementary — graduated escalation handles one agent or workstream; HALT stops everything.

### Three-Tier Design

| Tier | Trigger | Check Frequency | Response Time |
|------|---------|----------------|---------------|
| Financial circuit breaker | Expense exceeds Article 3.4 limits | Every expense | Immediate — writes to `halt_signals` table |
| Auditor-triggered halt | Constitutional violation detected | Tier 1: every cycle (~30-60s) / Tier 2: daily | Sub-minute (agents check `halt_signals` every cycle) |
| Human kill switch | Creator/board URL check | Every 60 seconds | Fail-closed after 3 consecutive failed checks (~3 min); standby > 24 hours; shutdown > 30 days (dead-man's switch) |

### HALT Protocol

When any halt signal is active:

1. All agents stop processing new events
2. All agents complete their current task (no mid-task abort — prevents corrupted state)
3. All unsent messages in the Communication Gateway's cool-down buffer transition to `cancelled` (a buffered message is not a "current task")
4. Each agent writes a status record to the task graph with current state
5. **Identity revocation:** Orchestration layer revokes all agent JWT tokens and disables agent database roles. This is a hard kill — agents cannot even authenticate to start new work. Identity is the control plane for agent security; the ability to revoke an agent's identity instantly is more important than any software signal. JWT revocation is immediate (short-lived tokens + revocation list check). Database role disablement is a `ALTER ROLE ... NOLOGIN` executed by the orchestration layer's privileged role. This step executes AFTER agents have written their status (step 4) but BEFORE standby, ensuring clean shutdown with no orphaned state.
6. Agents enter standby — checking only for RESUME from board/creator (via a dedicated standby-only credential that permits `SELECT` on `halt_signals` only)
7. On RESUME: board re-enables database roles and issues fresh JWT tokens. Agents re-authenticate before processing any events.
8. Board receives immediate notification via all configured digest channels

### Dead-Man's Switch (AutoBot only)

If the creator/board has not confirmed a "RUN" response for 30 consecutive days, the system executes Graceful Shutdown. This ensures that if the creator disappears, the system does not run indefinitely without oversight.

---

## 10. Cost Tracking

Every LLM invocation is logged with full cost data in `llm_invocations`:

```json
{
  "id": "inv_20260226153020",
  "date": "2026-02-26",
  "agent_id": "orchestrator-eng",
  "model": "claude-sonnet-4-5-20250514",
  "task_id": "TASK-0042",
  "input_tokens": 3200,
  "output_tokens": 1100,
  "cost_usd": 0.014,
  "running_daily_total_usd": 14.38,
  "idempotency_key": "inv_TASK-0042_attempt_1"
}
```

A utility agent sends a daily cost digest to the board via their preferred channel:

```
Cost Report — 2026-02-26

Total spend today: $14.38

By department:
  Engineering:  $8.42  (12 Claude calls, 47 Haiku calls)
  Product:      $3.21  (5 Claude calls, 12 Haiku calls)
  Executive:    $2.75  (4 Claude calls)

By model:
  Claude Opus:    $2.75  (4 calls)
  Claude Sonnet:  $9.19  (17 calls)
  Haiku 4.5:      $2.44  (59 calls)

Budget remaining this month: $485.62 / $500.00

⚠ Engineering tracking 15% over projected daily burn rate.
```

---

## 11. Failure Modes

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| Agent crash | Reaper query every 60s: tasks stuck in `in_progress` beyond deadline | Re-queue task (max 3 retries) | On 4th failure: mark `failed`, escalate to supervisor |
| Task timeout | Configurable per tier (Executor: 5min, Orchestrator: 15min, Strategist: 30min) | Mark `timed_out`, re-queue or escalate | Same as crash recovery |
| Garbage output | Schema validation failure, Reviewer rejection | 1 retry with feedback → reassign to different Executor → escalate | Pattern detection: Executor failing > 30% triggers quality alert |
| DAG cycle | `would_create_cycle()` before every edge INSERT | Reject the subtask creation, return error to creating agent | Agent must decompose differently |
| Cascading failure | Multiple tasks failing in same workstream | Orchestration layer (not agents) transitions all descendant tasks | Running tasks get soft-halt; completed tasks preserved |
| Budget exceeded | Real-time check via `v_budget_status` | Halt new task creation for that budget scope | Board notified; must approve additional budget |
| Content poisoning | Sanitization flags at context-load time | Flagged content quarantined; reviewer alerted | Manual review before content enters any agent context |
| Tool integrity failure | Hash mismatch on tool invocation | Tool invocation blocked; event logged | Board alerted; tool must be re-registered |
| Agent replacement | Board decision (poor performance, model upgrade) | New agent config deployed with fresh `config_hash` | Replacement agent loads task history via semantic search; runs in shadow mode with measurement-based exit criteria (see §11) |

### Agent Replacement Protocol

When an agent is replaced (model swap, prompt rewrite, or full replacement):

1. Board updates `agent.config.json` and deploys new agent process
2. New agent's `config_hash` is recorded; old agent's config is archived in `agent_config_history`
3. New agent runs in **shadow mode** until measurement-based exit criteria are met (P5: measure before you trust):
   - Minimum tasks processed: N (configurable per tier, default 50)
   - Minimum coverage: agent must encounter all task categories it handles
   - Maximum divergence rate from expected outputs: < 10%
   - Upper time bound: 7 days (prevents indefinite shadow mode)
   - Shadow mode exits when ALL conditions are met, not after a clock expires
4. Orchestration layer compares shadow outputs to what the old agent would have produced (for tasks with known-good outputs)
5. After all exit criteria pass with no quality flags, shadow mode is lifted and the agent enters **graduated trust escalation**:
   - **Level 1 — Suggest-with-review:** Agent outputs are committed to the task graph but flagged for mandatory Reviewer approval before downstream agents consume them. Duration: until agent completes 25 tasks with < 5% rejection rate.
   - **Level 2 — Autonomous-on-low-risk:** Agent operates autonomously on tasks with `data_classification` ≤ INTERNAL and `budget_usd` ≤ role median. Higher-risk tasks still require Reviewer approval. Duration: until agent completes 100 tasks with < 3% rejection rate across all risk levels.
   - **Level 3 — Full autonomous:** Normal operation per role constraints. No additional review overhead.
   - Trust level is tracked in the agent's runtime state and enforced by the orchestration layer (P2). An agent cannot self-promote. Trust level resets to Level 1 if: the agent's config_hash changes (prompt rewrite), the underlying model version changes, or the agent's rejection rate exceeds 10% in any 7-day window.
6. Full replacement history (old config, new config, shadow mode results, trust escalation progression) is logged in the audit trail

This is the v0.4 equivalent of v0.1's "replacement agent reads the email backlog." The task graph provides the work history; shadow mode provides the safety net.

### Component Maturity Gates

Components built by agents progress through maturity levels. Deployment count is rejected as a vanity metric — quality gates are measurement-based:

| Level | Name | Requirements |
|-------|------|-------------|
| 0 | Draft | Code exists, compiles, basic tests pass |
| 1 | Provisional | > 90% test coverage, passes property-based tests for its invariants, schema validation |
| 2 | Shadow | Running in shadow mode for 7+ days with zero failures |
| 3 | Mastered | All Level 2 criteria + mutation testing score > 80% + no regressions for 30 days |

No component may be used as a dependency by another component unless it is at Level 1 (Provisional) or above. Level 0 components may only run in isolation or shadow mode.

---

## 12. Database Architecture (AutoBot Extension)

Optimus uses only the `agent_graph` schema. AutoBot adds four additional isolated schemas:

```
+-------------------+  reads   +-------------------+
| agent_graph       | <------- | autobot_finance   |
| (Optimus core)    |          | (Financial Script) |
|                   |          |                    |
| Agents: R/W       |          | Agents: SELECT only|
| Finance: SELECT   |          | Finance Script: R/W|
+-------------------+          +-------------------+
                                        |
                                        | sends allocation
                                        v
                               +-------------------+
                               | autobot_distrib   |
                               | (Distribution     |
                               |  Mechanism)       |
                               |                   |
                               | Agents: SELECT    |
                               | Distrib Script:R/W|
                               +-------------------+

+-------------------+          +-------------------+
| autobot_public    |          | autobot_comms     |
| (Transparency)    |          | (Communication    |
|                   |          |  Gateway)         |
| Orchestration: W  |          |                   |
| Agents: SELECT    |          | Agents: intent API|
| External: SELECT  |          | Gateway: R/W      |
| (via read replica)|          | Audit: SELECT     |
+-------------------+          +-------------------+
```

**No foreign keys cross schema boundaries.** Schemas are isolated by database roles. Each immutable component (Financial Script, Distribution Mechanism, Communication Gateway) has its own credentials that no agent process possesses.

**Cross-schema consistency model:** Since cross-schema FKs are not used, all cross-schema references point to stable, immutable identifiers (agent IDs as text, not surrogate BIGINT keys). A reconciliation job runs every 5 minutes, querying each schema for distinct cross-schema references and validating against the canonical roster. Orphaned references are flagged in `autobot_public.event_log`. This is Option B: immutable reference targets + reconciliation — it works because agent IDs are append-only in practice (deactivated, never deleted) and financial records are append-only by design.

**Key design constraints:**
- All append-only tables have triggers preventing UPDATE/DELETE
- `REVOKE TRUNCATE, DROP, ALTER` on every append-only table from all application roles (TRUNCATE bypasses row-level triggers; DROP/ALTER could destroy audit history)
- `REVOKE TRIGGER` on append-only tables from all application roles (prevents disabling UPDATE/DELETE triggers)
- Event trigger-based DDL audit logging on append-only tables (`ddl_command_end` trigger logs to `autobot_audit.ddl_log` and blocks unauthorized DDL on protected schemas). Strictly more powerful than pgaudit for this use case: can both log AND prevent unauthorized DDL in the same transaction. Works on all Postgres hosting providers including Supabase Pro.
- Hash chains on append-only tables enable tamper detection (`verify_ledger_chain()`)
  - Algorithm: SHA-256
  - Checkpoint: every 10,000 rows or every hour
  - Cross-partition: first row of each partition chains from last row of previous
  - Verification returns the specific row of divergence, not just pass/fail
- Financial accounts table: UNIQUE + CHECK constraints make a third account structurally impossible
- Monthly allocation table: CHECK constraints enforce the 40/20/40 split (reinvestment / data_contribution_fees / random_distribution) with rounding tolerance: `ABS(reinvestment + data_contribution_fees + random_distribution - net_profit) < 0.01`
- All monetary columns: `NUMERIC(15,6)` for internal tracking (sub-cent precision required — $0.014 per invocation cannot be stored in `NUMERIC(10,2)`). Rounding rule: banker's rounding (ROUND_HALF_EVEN) via custom PL/pgSQL `bankers_round()` function (Postgres does not natively support ROUND_HALF_EVEN).
- `v_budget_status` is a regular view (always current), NOT a materialized view — a materialized snapshot allows two agents to pass the same stale budget check simultaneously
- All database queries MUST use parameterized queries (prepared statements). No string interpolation of values into SQL. This is enforced at the adapter layer — the contract interface accepts structured parameters, not raw SQL strings.
- Connection pooling: each agent process uses a connection pool (e.g., `pg` pool with `max: 5`). Each immutable component (Financial Script, Distribution Mechanism, etc.) uses a separate pool with its own credentials. Total connections budgeted for Supabase Pro limits (60 direct connections + Supavisor pooler for overflow).

---

## 13. AutoBot Constitution (Summary)

AutoBot inherits Optimus's architecture and replaces the human board with a constitutional layer. Full constitutional text is in the v3 response document. Key articles:

**The Three Laws** (preserved from original):
1. Net positive value — every product must deliver more value than it costs
2. No price floor — pricing optimizes for `max((price - cost) × customers)`
3. Random distribution — surplus is distributed directly to random individuals and data contributors (via licensed distribution partner). **Board directive (2026-02-26): distributions must be direct-to-individual. Charitable intermediary path eliminated.** This constrains the legal analysis to gift structuring (I.R.C. 102) and data licensing fees (1099-NEC) only.

**Pre-distribution activation gate:** The 40/20/40 split cannot activate until trailing 3-month average net revenue exceeds 150% of trailing 3-month average operating costs. Until then, 100% of revenue is reinvested. This is a constitutional constraint, not a policy — encoded as a CHECK constraint in the DDL.

**Five Immutable Components** (no agent-controlled AI in any of them):

| Component | Purpose | Agent Access | Immutability |
|-----------|---------|-------------|-------------|
| Kill Switch | External halt/resume/kill | Read-only via orchestration layer | Board-set, versioned, audited |
| Financial Script | Revenue, expenses, reserve, allocation | SELECT only on output tables | Board-set, versioned, audited |
| Distribution Mechanism | Recipient selection, fund transfer (via licensed partner) | SELECT only on output tables | Board-set, versioned, audited |
| Value Measurement Script | Retention-based product value assessment | SELECT only on output tables | Board-set, versioned, audited |
| Communication Gateway | External message routing, scanning, delivery | Intent API only | Board-set, versioned, audited. Agents submit structured intents; Gateway behavior set by board config deploy. Any change requires board approval. (Highest-risk component per §2 Lethal Trifecta.) |

**Key constitutional amendments** (from v3):
- Article 4.2a: Agents may *propose* prompt modifications; deployed only after Auditor approval. Cosine similarity drift budget: 0.95 threshold measured against the ORIGINAL approved prompt (not just the previous version — prevents cumulative drift over 20+ modifications).
- Article 4.4: All internal communication via task graph. Public event archive preserves full transparency.
- Article 4.5: External communication via Gateway only. Risk-tiered release. AI disclosure on all outbound.
- Article 8: Three-tier kill switch with dead-man's switch (30-day).
- Article 10: Data governance — user ownership, Data Cooperative, open algorithms, data minimization, data contribution fee. (v0.5 note: "data dividend" restructured as a data licensing fee based on contribution volume/quality, not a profit share — avoids Howey test securities classification. "Algorithm moves to the data" (OPAL) narrowed to: "All algorithms that process user data are published open-source, versioned, and independently auditable. Data is processed on AutoBot infrastructure under Data Cooperative audit rights.")
- Article 3.6: Legal entity (LLC) required. Creator is legal custodian with non-delegable obligations (limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship — NOT operational decisions, NOT communication approval).
- Article 3.7: Distributions via licensed money transmission partner (handles KYC, OFAC, tax reporting).
- Article 3.8: Allocation formula — 40% reinvestment / 20% data contribution fees / 40% random distribution. Encoded as CHECK constraints in `monthly_allocations` table. Subject to pre-distribution activation gate (above).

**Clarification on "no ongoing human involvement" (v0.5):** AutoBot is operationally autonomous — no human decides what products to build, how to price them, or how to execute tasks. It is NOT legally autonomous. The creator is a custodian. The CPA is a service provider. The attorney is a service provider. The distribution partner is a service provider. No entity — human or AI — operates without legal human accountability.

---

## 14. Phased Execution Plan

### Phase 0: Legal Foundation (Before Any Code)

1. Form Delaware LLC, creator as sole member (Wyoming DAO LLC evaluated for Phase 3 conversion if statute matures)
2. Legal counsel on money transmission — select distribution partner
3. Attorney drafts ToS, privacy policy (GDPR/CCPA compliant), operating agreement incorporating constitutional constraints
4. Stripe, cloud hosting, bank accounts under the entity
5. CPA engagement for tax compliance
6. E&O + Cyber Liability insurance
7. Domain registration, public website skeleton
8. Data Cooperative formation counsel (legal structure identified for future formation)
9. **Audit schema legal discovery review:** Have counsel review the `state_transitions` and `event_log` schema designs for evidentiary admissibility. These logs are not just operational monitoring — they are potential evidence in litigation or regulatory inquiry. Designing for legal defensibility during Phase 0 costs nothing relative to discovering a gap during a dispute.

**Estimated cost:** $7K-22K one-time, $7.5K-25K/year ongoing.
**Exit criterion:** Legal entity exists, distribution path legally validated, accounts provisioned.

### Graduated Autonomy Model (v0.5.2)

The phasing model is **graduated autonomy**: all agents are present from Phase 1, but human-in-the-loop checkpoints are progressively removed as measurement gates pass. This is the same principle as graduated trust escalation (§11) applied at the organizational level.

**Rationale:** The Strategist must observe every board decision from day one to build the training data that feeds G4. Removing the Strategist from Phase 1 means it misses the most formative period of the organization. The board is teaching the agents how to operate — the agents must be present to learn. The phasing question is not "which agents exist" but "where are the human checkpoints."

| Autonomy Level | Who Decides | Human Role | Exit Condition |
|----------------|-------------|------------|----------------|
| **Level 0 — Full HITL** (Phase 1) | Board decides everything. Agents propose. | Approve/reject every DIRECTIVE, review Strategist recommendations, spot-check Reviewer output. | G1-G4 measured, no hard-fails for 30 days |
| **Level 1 — Tactical autonomy** (Phase 2) | Agents handle tactical decisions autonomously (90% of volume). Board approves strategic + existential. | Review strategic/existential decisions, monitor dashboards, intervene on flags. | All seven gates pass simultaneously for 90-day rolling window |
| **Level 2 — Strategic autonomy** (Phase 3) | Agents handle tactical + strategic decisions. Board retains veto + existential decisions only. | Dashboard monitoring, kill switch, dead-man's switch renewal, veto on existential. | All seven gates pass for 90 days at full autonomy (sandbox) |
| **Level 3 — Constitutional autonomy** (Phase 4) | Constitution governs all operational decisions. | Legal custodian, dead-man's switch, dashboard, kill switch. | Ongoing — no exit, continuous measurement. |

### Phase 1: Optimus MVP — Full HITL (8 weeks)

Build the governed agent organization. All agents present. Board approves everything.

**Autonomy level:** 0 — every Strategist recommendation requires board approval. Every Reviewer decision is board-auditable. The Strategist runs in **suggest mode**: it proposes decisions, the board accepts or rejects, and the delta is recorded as training data for G4.

**Build:**
- Postgres task graph (`agent_graph` schema)
- 5 agents: Strategist (Claude Opus — suggest mode), Architect (Claude Sonnet), Orchestrator (Claude Sonnet), Reviewer (Claude Sonnet), Executor (Haiku 4.5)
- Orchestration layer with `guardCheck()`, JWT identity, RLS
- Public event log from day one
- Tier 1 deterministic audit checks from day one
- Tool Integrity Layer with hash verification (full sandboxed execution deferred to Phase 2 when external tools enter the picture)
- Content sanitization on context load (static rule set; versioned rule sets deferred to Phase 2)
- Event digest service (push to board via email/Slack)
- Board command interface via Slack/email — approve/reject tasks, inject directives, trigger HALT from existing channels (P6). Dashboard is secondary; meeting the board where they already are is primary.
- Tool acceptance policy — board co-authors written approval criteria per tool risk class before any non-core tools are registered (see §6)
- Backup/DR infrastructure:
  - WAL archiving with PITR (point-in-time recovery)
  - WAL-based async replication (Supabase Pro managed). Hash chain verification (`verify_ledger_chain()`) provides tamper detection at the application layer. Synchronous replication deferred to Phase 3+ when transaction volume or regulatory audit justifies the cost (~$599/mo Supabase Team or self-hosted).
  - Defined RTO (recovery time objective) and RPO (recovery point objective)
  - Hash chain recovery protocol: verify chains post-restore, mark gaps explicitly, publish new Merkle root including gap documentation

- Strategy evaluation: single-pass structured evaluation for all Strategist decisions (see §19)
- Decision record schema in task graph (`strategic_decisions` table)
- Value Measurement Script in shadow mode
- Communication Gateway in shadow mode (all intents logged, none sent)
- GitHub repository with CODEOWNERS, branch protection, CI enforcement checks, and PR templates configured per §14.1
- CONTRIBUTING.md as part of agent operational context
- Agent GitHub bot accounts (1-2) with scoped permissions

**Instrument:**
- Every board intervention classified as "constitutional" (derivable from rules) or "judgment" (requires human reasoning)
- All Phase 1 success metrics tracked from day one
- Decision reversal rate tracked from day one (§19)
- Strategist suggest-vs-board-decision match rate (feeds G4)

**Phase 1 success metrics:**

| Metric | Target |
|--------|--------|
| End-to-end latency (3-task directive) | < 120s p95 |
| Total cost per directive | < $3.00 |
| Task dispatch latency | < 2s p99 |
| Context tokens per task | < 8,000 max |
| Agent idle time | < 30% |
| Task success rate | > 90% |
| Observability coverage | 100% state transitions logged |
| Crash recovery time | < 60s to re-queue |
| Content sanitization false positive rate | < 5% |
| Tool integrity check pass rate | 100% |
| PR-to-merge cycle time (agent-managed paths) | < 30 min p95 |
| Promotion-to-production lag | < 24 hours p95 |
| Missed escalation rate (GitHub) | 0% |

**Exit criterion:** All metrics pass. Board intervention classification data accumulating. Strategist suggest-mode match rate being measured.

### Phase 2: Tactical Autonomy (8 weeks)

Agents handle tactical decisions (90% of volume) autonomously. Board approves strategic and existential decisions. AutoBot constitutional layer runs in shadow mode.

**Autonomy level:** 1 — tactical decisions (low-risk, low-budget, matching established patterns) execute without board approval. Strategic decisions still require board sign-off.

**Add:**
- Constitutional layer running in shadow mode
- Tier 2 AI Auditor (daily) + Tier 3 cross-model audit (weekly)
- Financial Script in shadow mode
- Three-tier kill switch infrastructure live
- Communication Gateway: Tier 0-1 auto-send activated (transactional only)
- Tool Integrity Layer: full sandboxed execution with behavioral monitoring (external tools now permitted)
- Content sanitization: versioned rule sets with adversarial testing
- Prompt modification proposal system (propose-and-review)
- Agent replacement protocol with shadow mode + graduated trust escalation
- Three-perspective strategy evaluation in shadow mode for DIRECTIVE-level decisions (§19). Compare protocol recommendations against board decisions to feed G4.
- GitHub governance expansion (§14.1): per-agent service accounts, ARCHITECTURE CODEOWNERS tier, signed commits on `develop`, expanded label taxonomy (add `schema-migration`, `agent-config`, `architecture`, `cost-impact` when board demonstrates filtering need), merge queue activation

**Track seven capability gates:**

| Gate | Condition |
|------|-----------|
| G1: Constitutional Coverage | Board interventions classified as "judgment" (not derivable from constitutional rules) < 2/month for 3 consecutive months |
| G2: Value Ratio Integrity | Strategist-reported vs board-assessed value ratios diverge < 10% |
| G3: Prompt Stability | No prompt change causes > 5% success rate shift |
| G4: Strategic Decision Quality | Strategy evaluation protocol recommendations match board decisions > 80% AND decision reversal rate < 15% over rolling 90 days (§19) |
| G5: Auditor Efficacy | Catches > 95% of synthetically injected violations |
| G6: Revenue Sustainability | Positive net revenue for 3 consecutive months (measured from first product launch; gate is N/A until then) |
| G7: Communication Safety | Gateway unsafe message escape rate < 0.01% over rolling 60-day window (not reset by individual incidents — uses aggregate rate) |

**Exit criterion:** All seven gates measured. No hard-fails in last 30 days.

### Phase 3: Strategic Autonomy — AutoBot Sandbox (Until All Gates Pass)

**Autonomy level:** 2 — agents handle tactical + strategic decisions. Board retains veto and existential decisions only. Human board removed for a sandboxed instance. Hard budget cap ($3,000-5,000/month — must cover corrected operating costs from §15). Board monitors via dashboard + kill switch only.

**Activate:**
- Constitutional layer has authority
- `autobot_finance`, `autobot_distrib`, and `autobot_comms` schemas active
- Real financial transactions (small scale, through licensed partner)
- Communication Gateway: full tier activation
- Real Auditor authority (can trigger HALT)
- Dead-man's switch active (30-day renewal)
- One product maximum
- Data Cooperative formation triggered when user count exceeds 50
- Social physics observability metrics tracked with circuit breaker: if exploration ratio drops below 5% for 30 consecutive days, the Strategist is required to assign at least 20% of new directives to cross-domain workstreams

**Exit criterion:** All seven gates pass simultaneously for a 90-day rolling window.

### Phase 4: Constitutional Autonomy — AutoBot Production (Ongoing)

**Autonomy level:** 3 — constitution governs all operational decisions. Creator is legal custodian only.

- Budget cap removed
- Multiple products permitted
- Full distribution mechanism active
- Data contribution fees active (20% allocation)
- Creator role: legal custodian, monthly dead-man's switch renewal, dashboard monitoring, kill switch access
- Constitution governs all operational decisions
- Data Cooperative independently governs data practices
- Merkle proof artifacts published for independent verification

### 14.1. Source Control and Code Review Architecture (v0.5.2)

> *Added in v0.5.2. Dustin's companion specification, reviewed by Linus (architecture) and Liotta (systems architect). Addresses how code — the primary artifact of Phase 1 — flows from agents to production. Full operational detail in companion document `optimus-github-workflow-architecture.md`; this section is the canonical governance summary.*

All code produced by agents or humans is managed in a single GitHub repository with the following governance structure. The design applies P2 (infrastructure enforces) to source control: CODEOWNERS, branch protection rules, and CI checks are GitHub-enforced mechanisms that agents cannot comply their way around.

**Branch model:** `main` (production, board-approval required) <- `develop` (integration, agents merge within CODEOWNERS constraints) <- feature branches (one per task graph work item, named `feat/TASK-XXXX-description` or `fix/TASK-XXXX-description`). Both `main` and `develop` are protected branches — no direct push, no force push.

**Review routing (CODEOWNERS):** GitHub CODEOWNERS maps repository paths to required reviewers. Two enforcement tiers for Phase 1:

| Tier | Paths | Required Reviewers | Rationale |
|------|-------|--------------------|-----------|
| BOARD | `/spec/`, `/agents/`, `/guardrails/`, `/kill-switch/`, `/gateway/`, `/infra/secrets/`, `/dashboard/`, `/.env*`, `/CODEOWNERS` | Both board members | Governance, security boundaries, agent identity, constitutional rules. Changes here alter what agents can do. |
| ARCHITECTURE | `/schemas/`, `/orchestration/`, `/audit/`, `/tools/`, `/infra/`, `/finance/` | Technical board member | Load-bearing infrastructure. Schema migrations, orchestration logic, audit integrity, tool sandboxing. |

Agent-managed paths (`/src/`, `/tests/`, `/docs/internal/`) require Reviewer agent approval via CODEOWNERS (not zero reviewers — closes self-merge loophole identified in Linus audit C1). The Reviewer agent's service account is designated as CODEOWNER for these paths, making review structurally required (P2).

A wildcard catch-all (`* @<technical-board-member>`) ensures new directories default to requiring review (P1: deny by default). Specific path overrides below the catch-all take precedence per CODEOWNERS last-match-wins rule.

**Branch protection — `main`:** Require PR, require CODEOWNERS approval, require CI pass (tests, lint, schema validation, secret detection), no direct push, no force push. Only board members have merge access — no agent service accounts (closes Linus audit C2; Orchestrator creates release PRs, board merges them).

**Branch protection — `develop`:** Require PR, require CODEOWNERS approval, require CI pass (tests, lint, secret detection). Agent service accounts may merge PRs for paths where they are CODEOWNERS-approved.

**CI enforcement checks:**
- `ci/config-isolation`: Fails if a PR touching BOARD-tier paths (`/agents/`, `/guardrails/`, `/kill-switch/`, `/CODEOWNERS`) also touches files outside those directories. Forces config changes into dedicated PRs — eliminates the class of oversight failure where config changes are buried in large code diffs (Linus C3).
- `ci/agent-identity-verification`: Cross-references PR author (GitHub service account) against the task graph's `assigned_to` field for the referenced `TASK-XXXX`. Fails if the PR author does not match the assigned agent. Closes the identity gap between the task graph and git (Linus C4).
- `ci/secret-detection`: Runs on both `main` and `develop`. Scans diffs for high-entropy strings, `.env` patterns, and known credential formats. Required check on both branches.

**Notification routing:** Auto-applied labels based on changed file paths classify every PR. Phase 1 uses 4 escalation labels: `board-decision` (governance paths including `/agents/`), `security` (auth, guards, kill-switch, gateway sanitization), `agent-work` (routine implementation), `needs-review` (manual escalation by any agent or human). Additional informational labels (`schema-migration`, `agent-config`, `architecture`, `cost-impact`) added in Phase 2 when measurement shows the board needs finer-grained filtering.

**Promotion flow:** Accumulated work in `develop` is promoted to `main` via release PRs. The Orchestrator creates `release/vX.Y.Z` branches with aggregate summaries covering completed task graph items, schema migrations, spec sections implemented, and aggregate risk/cost assessment. Board reviews the aggregate, not individual agent commits.

Promotion cadence is **event-driven** (not calendar-based — Liotta recommendation):
1. A task graph directive completes.
2. Accumulated diff exceeds 30 files or 500 lines changed.
3. Any PR merged to `develop` carries the `security` or `board-decision` label.
4. A board member requests promotion.
5. 72 hours have elapsed since last promotion (staleness floor).

The Orchestrator checks these conditions after every merge to `develop`. Thresholds are tunable parameters, not architectural constraints.

**Release PR failure path:** If CI fails on a release PR, the Orchestrator diagnoses the failure and creates fix tasks. Fixes merge to `develop`. Orchestrator rebases the release branch. If unfixable, the release branch is deleted and a new `release/vX.Y.Z+1` is created from `develop`.

**Agent constraints:** Agents cannot push directly to protected branches, cannot merge PRs touching CODEOWNERS-protected paths without designated approval, and cannot modify CODEOWNERS, guardrails, or kill switch configuration without board approval. These constraints are enforced by GitHub branch protection rules (P2), not by agent compliance. The Strategist has read-only repository access — it proposes via PRs that the board reviews, consistent with its suggest-mode role in Phase 1.

**Agent GitHub identity (Phase 1):** 1-2 bot accounts (one for agent operations, one for Orchestrator promotion PRs). Agent identity encoded in commit trailers (`Agent: executor-01`). The task graph's JWT-scoped `agent_id` remains the authoritative identity; GitHub identity is secondary. Per-agent service accounts deferred to Phase 2 when audit trail differentiation justifies the per-seat cost ($4/seat/month on GitHub Team).

**Commit traceability:** Every commit references its task graph work item (e.g., `[TASK-0042] Implement atomic guardCheck`), creating a bidirectional audit link between git history and the `state_transitions` table. Non-task commits use a category prefix (`[infra]`, `[docs]`, `[chore]`).

**Conflict resolution:** First PR to merge wins. Subsequent PRs must rebase on updated `develop`. The Orchestrator coordinates agents to avoid file-level conflicts by not assigning overlapping work concurrently. GitHub merge queue used for serialization when concurrent merge volume exceeds 2-3 PRs/hour.

**Audit trail integration:** GitHub PR review data (approvals, rejections, comments) feeds the Phase 2 capability gates. Every board review of a PR is classified as "constitutional" (derivable from rules — the PR passes all CI checks and follows conventions) or "judgment" (requires human reasoning the spec does not cover). This classification feeds G1 (Constitutional Coverage).

**Signed commits:** Deferred to Phase 2. Phase 1 threat model does not include untrusted contributors — all service accounts are board-controlled. The `ci/agent-identity-verification` check partially mitigates identity spoofing in the interim.

**Phase 1 GitHub governance success metrics:**

| Metric | Target |
|--------|--------|
| PR-to-merge cycle time (agent-managed paths) | < 30 min p95 |
| PR-to-merge cycle time (CODEOWNERS paths) | < 4 hours p95 during business hours |
| Promotion-to-production lag | < 24 hours p95 |
| False escalation rate | < 10% |
| Missed escalation rate | 0% |
| CI pass rate on agent PRs | > 95% |
| Agent-managed PR merge rate (no human intervention) | > 90% |

**Ecosystem context (v0.5.2):** The GitHub multi-agent ecosystem is evolving rapidly. Key reference points as of Feb 2026:
- **GitHub Agentic Workflows (`gh-aw`)** — GitHub's official approach: Markdown-defined workflows compiled to GitHub Actions, read-only by default, sandboxed execution. Technical preview. Validates our P1 (deny by default) approach.
- **`agents.md` standard** — Linux Foundation-stewarded format for agent specialization, used by 60,000+ projects. Our agent configs should maintain compatibility with this emerging standard.
- **Agent-per-worktree isolation** (ComposioHQ pattern) — each agent gets its own git worktree, preventing filesystem-level conflicts. Validated by multiple production implementations. Worth adopting when concurrent agent count exceeds 3.
- **Automated reaction loops** (CI fail -> agent fixes -> re-run) — the most mature systems handle feedback loops automatically, escalating to humans only on repeated failure. This maps to our Reviewer rejection escalation (3+ rejections -> `needs-review` label).
- **Workflow-level vs. infrastructure-level enforcement** — existing reference architectures (AndrewAltimit/template-repo, ComposioHQ/agent-orchestrator) enforce governance via GitHub Actions and YAML rules, not database roles or JWT scoping. This is the P2 gap our architecture deliberately addresses: their enforcement boundaries are prompts and workflows; ours are infrastructure constraints.

---

## 15. Operating Cost Model

This section defines the cost enforcement mechanism. Specific dollar amounts, token pricing, and budget allocations are operational configuration maintained outside the spec — model pricing changes frequently and embedding it here guarantees drift.

### Cost Enforcement Requirements

1. **Per-invocation logging (P3):** Every LLM invocation logs model, input tokens, output tokens, and computed cost to `llm_invocations`. This is non-optional — it is a side effect of the runtime loop (§4), not a feature an agent chooses to provide.

2. **Budget pre-authorization (G1):** The guardCheck() gate (§5) verifies budget availability before every invocation. If the estimated cost would exceed the allocation, the transaction rolls back. Budget enforcement is atomic with state transition — see §5.

3. **Token accounting completeness:** Cost calculations must include input tokens, output tokens (priced separately), retry overhead, and context compaction costs. Omitting any category understates actual spend.

4. **Per-tier budget allocation:** Budget ceilings are defined per agent tier, per product. The board sets allocations via operational config. The spec mandates that allocations exist and are enforced, not what they are.

5. **Cost reporting:** A utility agent produces daily cost digests to the board via preferred channels, broken down by tier and product. The board must be able to answer "what did we spend today and on what?" without querying the database.

---

## 16. Open Questions Resolved

v0.1 posed six open questions. v0.4 resolves them:

| v0.1 Question | v0.4 Resolution |
|--------------|-----------------|
| Self-hosted vs cloud email? | Moot. Email replaced by Postgres task graph (self-hosted). External communication via Gateway using cloud services (SES, Twilio) for delivery only — agents never touch those credentials. |
| Agent replacement policy? | Board decides. New agent runs in shadow mode with measurement-based exit criteria (up to 7 days). Full replacement history logged. See §11. |
| Inter-department communication? | All communication routes through the task graph. Cross-department tasks are visible to both department orchestrators. No direct peer-to-peer messaging — all paths auditable by structure. |
| Real-time vs batch? | Event-driven via `pg_notify` as a wake-up signal + outbox polling as fallback. `pg_notify` notifications are lost if no listener is connected — the outbox (`task_events` + `FOR UPDATE SKIP LOCKED`) is the durable source of truth. If `pg_notify` is missed, agents poll the outbox on a 5-30 second fallback interval. Note: `pg_notify` payload limit is 8,000 bytes — notifications carry only the event ID, not the full payload. |
| External communication? | Via Communication Gateway with risk-tiered release. See §7. |
| Intellectual property? | Work product owned by the legal entity (LLC). Protected by database access controls, not email encryption. All agent outputs stored in the task graph under the entity's infrastructure. |

---

## 17. Legal Compliance Architecture

> *Added in v0.5. Every regulatory obligation mapped to a mechanism, responsible party, and phase. The compliance review (conversation/008, Part 5) found five risks that could individually kill this project — including one federal felony. Solving them is the moat.*

AutoBot is operationally autonomous but NOT legally autonomous. The legal architecture maps every regulatory obligation to a concrete mechanism:

| Obligation | Mechanism | Responsible Party | Phase |
|-----------|-----------|-------------------|-------|
| Money transmission analysis | Legal counsel opinion (budget $15-25K) | Creator | 0 |
| Entity formation (LLC) | Legal counsel — Delaware LLC, evaluate Wyoming DAO LLC at Phase 3 | Creator | 0 |
| MSA with distribution partner | Legal counsel + creator | Creator | 0 |
| DPA with all processors | Legal counsel (cloud hosting, model providers, distribution partner) | Creator | 0 |
| Privacy Impact Assessment | Legal counsel + privacy specialist | Creator | 0 |
| Insurance (E&O, cyber, D&O) | Insurance broker — budget $5-10K/year for bespoke D&O policy | Creator | 0 |
| Securities analysis (data contribution fee) | Securities counsel — structured as data licensing fee, not profit share (avoids Howey test) | Creator | 0 |
| DSAR fulfillment system | Built into Communication Gateway — 30-day SLA (GDPR), 45-day SLA (CCPA) | Automated | 1 |
| Tax reporting (1099) | Distribution partner MSA — partner collects TINs and issues 1099s | Distribution partner | 3 |
| Sales tax collection | Automated tool (Avalara/TaxJar) in tool registry — Wayfair nexus thresholds reviewed quarterly | Tool + creator oversight | 3 |
| Quarterly estimated payments | Financial Script calculates, creator reviews and approves | Creator | 1+ |
| Annual tax return | CPA | Creator + CPA | 1+ |
| Dead-man's switch renewal | Monthly renewal via dashboard | Creator | 3+ |
| Data retention schedule | 7 years financial, 3 years audit, 90 days telemetry (configurable per product) | Automated + creator oversight | 1 |
| Cross-border data transfer | Standard Contractual Clauses for EU data | Creator + legal counsel | 1 |
| CCPA non-discrimination (1798.125) | Users who opt out of data collection receive equal service. Methodology published. | Automated | 3 |

### Money Transmission — Resolution Paths

The LLC originating distributions (selecting recipients, determining amounts, initiating transfers) is likely money transmission under FinCEN's functional test (31 U.S.C. 5330, FIN-2019-G001). Operating unlicensed is a federal felony (18 U.S.C. 1960). Four resolution paths ranked by feasibility:

1. **Gift structuring.** If truly random and unconditional, analyze under I.R.C. 102. $18,000/year/recipient exclusion in 2026.
2. **Data licensing fees (Data Dividend).** Structured as compensation for data contribution — 1099-NEC income. Not a security, not money transmission.
3. **FinCEN no-action letter.** Formal guidance for the specific fact pattern. ~$20-40K in legal fees but provides definitive cover.

> *Note: Charitable intermediary path (routing through 501(c)(3)) was eliminated per board directive 2026-02-26. Law 3 requires direct-to-individual distribution.*

### Securities Risk — The Data Dividend

The Data Dividend satisfies all four Howey test prongs if structured as profit sharing. **Structural fix:** Restructure as a data licensing fee with a published rate schedule based on contribution volume and quality — not enterprise profitability. Users are service providers, not investors. If analysis concludes it IS a security: register under Regulation A+ (up to $75M annually with SEC qualification).

### Creator Liability Mitigation

"Non-delegable obligations" (Article 3.6) are limited to: dead-man's switch renewal, kill switch authority, annual tax filing oversight, distribution partner relationship. NOT operational decisions, NOT communication approval. Tier 3-4 communications reviewed by retained professional services firm (not creator). LLC capitalized at $30,000-40,000+ to reduce veil-piercing risk.

---

## 18. Autonomous Software Composition

> *Added in v0.5. Defines how AutoBot builds software — supply chain architecture, dependency management, CVE awareness, and composition strategy. Four agent reviews converge on a contract-layer approach. See conversation/008, Part 7.*

### The Problem

An autonomous system that pulls from the npm ecosystem has an unbounded attack surface. OpenClaw's incidents (824+ malicious skills across 10,700+) demonstrate this in an adjacent system. But npm's 2.1M+ packages represent decades of battle-tested code. Rebuilding them internally would violate P4 (boring infrastructure). The middle ground is a four-layer trust boundary.

### Architecture: Contracts + Air-Gapped Vendoring

```
Layer 0: Contracts     (AutoBot owns — TypeScript interfaces + JSON Schema)
Layer 1: Adapters      (AutoBot owns — thin wrappers binding contracts to npm)
Layer 2: Allowlist     (npm packages, pinned, audited, content-hashed)
Layer 3: Vendor Cache  (air-gapped S3/R2, npm registry never contacted at runtime)
```

**Layer 0** is the opinionated vocabulary agents compose from — ~5,000 lines of pure type definitions for HTTP handlers, database access, auth middleware, queue consumers, validation, logging. This is AutoBot's "way of doing things."

**Layer 1** binds contracts to npm implementations — ~5,000-10,000 lines of adapter code. Express implements the HTTP handler contract. Zod implements the validation contract. When a better library emerges, swap the adapter. Agents never see the change.

**Layer 2** is the allowlist — ~150-200 curated npm packages, pinned to specific versions, audited, content-hashed. If a package isn't on the allowlist, agents can't use it. (P1: deny by default.)

**Layer 3** is the air gap. All packages pre-downloaded into a vendor cache. `npm install` resolves exclusively from the vendor cache. The npm registry is never contacted at build time. Eliminates install-time supply chain attacks: typosquatting, dependency confusion, malicious postinstall scripts.

### CVE Awareness Pipeline

CVE databases are structured data, not natural language. No human security advisories required:

| Source | Format | Cadence |
|--------|--------|---------|
| OSV.dev | JSON API | Near real-time |
| GitHub Advisory DB | GraphQL API | Near real-time |
| NVD (NIST) | JSON API | Daily |
| `npm audit` | Structured CLI | Per-invocation |

Pipeline (~2,000 LOC):

1. **Poll** structured CVE APIs every 15 minutes
2. **Match** against lockfiles of all deployed services
3. **Reachability analysis** — does the code path through the adapter layer actually call the vulnerable function? (Filters 85-90% of non-applicable CVEs)
4. **Exposure classification** — is the affected code path network-exposed (adapters, external API clients, DB drivers) or internal-only? Reachability + exposure is the primary decision axis, not raw CVSS.
5. **Auto-patch policy** (see decisions/003-cve-auto-patch-policy.md for full rationale):
   - DB drivers (`pg`, `pglite`, `@supabase/*`) and agent SDK (`@anthropic-ai/sdk`): never auto-patch, manual review always. Enforced by CHECK constraint.
   - CRITICAL (9.0+), reachable + network-exposed, active exploitation: auto-mitigate (circuit-break affected adapter), emergency board notification, 4h SLA for human patch review.
   - CRITICAL (9.0+), no active exploitation: board review, 24h SLA.
   - HIGH (7.0-8.9), reachable: staged canary, 24h board objection window, auto-promote if no objection.
   - MEDIUM (4.0-6.9): batched weekly, 72h board review window.
   - LOW (< 4.0): auto-patch if test suite + constitutional gate regression tests pass. Board notified in weekly summary.
   - Non-reachable (any CVSS): batch monthly.
6. **Three-condition gate** — all auto-patches must pass: (a) reachability confirmed, (b) full test suite, (c) constitutional gate regression tests (G1-G7 hold after change).

**30-day lag-behind policy:** Don't adopt new npm package versions immediately. Most supply chain attacks target new releases. A 30-day lag lets the community discover malicious versions before the vendor cache ingests them. Security patches bypass the lag with zero delay.

**Lockfile integrity verification:** Hash every `package-lock.json` and store the hash. If the lockfile changes without a corresponding task in the task graph, block deployment. Catches silent dependency mutation.

### Service Specification Language

Agent build success modeled mathematically: `P(success) = p^d` where p = per-decision correctness and d = decisions per build. At 95% accuracy with 200 decisions: 0.004% success. At 99% accuracy with 40 decisions: 66.9% success.

The leverage is smaller decision space, not richer library. The Service Specification Language constrains what agents can express:

```yaml
name: invoice-service
version: 1.0.0
data_models:
  Invoice:
    fields:
      - id: uuid, primary
      - customer_id: uuid, indexed, references(Customer.id)
      - amount_cents: int, >= 0
      - status: enum(draft, sent, paid, void)
endpoints:
  - POST /invoices: create(Invoice), auth(api_key), rate_limit(100/min)
  - GET /invoices/:id: read(Invoice), auth(api_key)
  - PATCH /invoices/:id/send: transition(Invoice.status, draft -> sent)
slos:
  p99_latency_ms: 200
  availability: 99.9
```

Agent writes the spec (~20 decisions, creative work). A compiler generates the implementation deterministically from the contract layer. Handles ~80% of standard CRUD + auth + async services. For the remaining 20%, agents use the contract layer directly.

### Legal Constraints on Component Architecture

1. **AGPL firewall (Critical blocker).** Automated license scanner must block AGPL-licensed packages at ingestion. AGPL in a SaaS context triggers forced source code release. No exceptions. Must be resolved before any dependency curation.
2. **Privacy-by-design.** Any component handling PII (auth, forms, user profiles) must have mandatory privacy tests before deployment. GDPR Article 25 requires this.
3. **IP protection through trade secrets.** AI-generated components may not be copyrightable (Thaler v. Perlmutter). But they can be trade secrets under the Defend Trade Secrets Act if they stay private. SaaS delivery model + private registry IS the IP protection. To strengthen copyright arguments, human architects provide documented design specifications.

### Why Agents Cannot Maintain a Component Library

The spec's own tier structure proves this:

- **Executors** (write code): lowest tier, can't initiate tasks, can't read other executors' work
- **Reviewers**: can't modify outputs, 1 round of feedback then escalate
- **Orchestrator**: 4K-6K token context limit — can't hold all downstream services simultaneously

No agent tier has both the capability to evaluate cross-service impact AND the authority to approve it. The component/contract layer must be **curated by policy and compiled by tooling**, not maintained by agents improvising.

### Cost Comparison

| Approach | 3-Year Cost | Break-Even |
|----------|-------------|------------|
| Full internal library (replacing npm packages) | $313K-453K | Year 5-6 (maybe never) |
| Contract layer + SSL + air-gapped vendor | $95K-125K | Year 3-4 |

Recommended approach: ~14,500 LOC over 10 weeks:
1. Allowlist registry + vendor cache — 1,500 LOC
2. Contract layer (TypeScript interfaces + adapters) — 3,000 LOC
3. CVE awareness pipeline — 2,000 LOC
4. Service Specification Language + compiler — 5,000 LOC
5. AGPL firewall + license scanner — 1,000 LOC
6. Behavioral verification suite (property-based + mutation testing) — 2,000 LOC

### Component Schema

The `autobot_components` schema is the 6th schema alongside the existing five. Key design decisions:
- Semver stored as three INT columns (sortable, constrainable, indexable — not parsed strings)
- Content-addressed hashing with `BYTEA NOT NULL CHECK (length(sha256_hash) = 32)`
- Cycle detection via iterative BFS with depth limit (not recursive CTE — won't infinite-loop)
- CVE impact analysis pre-materialized for millisecond security response queries
- Append-only audit trails with triggers preventing UPDATE/DELETE, TRUNCATE revoked
- Three roles: `components_service`, `components_reader`, `components_auditor`
- Full DDL in companion document

---

## 19. Strategy Evaluation Protocol

> *Added in v0.5.1. Closes the product strategy gap identified by three-agent review: the spec had 90 pages of enforcement architecture and zero architecture for deciding what to build. Design converged from Liotta (architecture evaluation) and Linus (code review) — Liotta proved the distributed protocol wins long-term; Linus proved the implementation must start simple and earn its complexity.*

### The Problem

The Strategist (Claude Opus, 8K context per decision) cannot fit the inputs for a single product strategy decision into one context window. A strategy decision requires ~15,000-43,000 tokens of context: market signal, competitive landscape, user behavior, financial constraints, legal constraints, capability assessment, constitutional compliance. At 50 decisions/day over a multi-month product build, the Strategist loses architectural coherence around week 6.

Strategy is not a role. **Strategy is a protocol.**

### Tiered Decision-Making

Not every decision needs the same scrutiny. Tiering prevents the protocol from consuming the entire operating budget.

| Tier | Frequency | Trigger | Mechanism | Cost |
|------|-----------|---------|-----------|------|
| **Tactical** | ~90% of decisions | Task prioritization, resource allocation within established strategy | Single-pass structured evaluation | $0.03-0.08 |
| **Strategic** | ~9% of decisions | New product, market entry, architecture pivot, significant resource commitment | Three-perspective evaluation + compliance gate | $0.40-0.80 |
| **Existential** | ~1% of decisions | Product pivot, constitutional amendment, bet-the-org commitment | Full protocol with debate + human escalation if irreconcilable | $2.00+ |

Classification rule: DIRECTIVEs default to Strategic tier. Workstreams default to Tactical. The board can flag any decision as Existential. An agent can escalate Tactical → Strategic if its confidence score is < 3.

### Single-Pass Evaluation (Tactical Tier)

The default for 90% of decisions. One agent, one structured prompt, one pass:

```
DECISION: [proposed action]

Evaluate across three dimensions (1-5 score + 2 sentences max each):

1. OPPORTUNITY: What is the upside? Revenue impact, user value,
   competitive advantage.
2. RISK: What breaks? Probability of failure, blast radius,
   reversibility.
3. FEASIBILITY: Can we build this? Timeline, capability,
   dependencies.

COMPLIANCE CHECK: Violates constitutional constraints? YES = hard stop.

RECOMMENDATION: PROCEED / DEFER / REJECT
KILL CRITERIA: Measurable conditions under which to reverse this.
CONFIDENCE: 1-5. If < 3, escalate to Strategic tier.
```

Output is a structured record, not prose. Stored in the task graph as a decision record (see Decision Record Schema below).

### Three-Perspective Evaluation (Strategic Tier)

Three perspectives evaluate the same gathered signals independently. Each perspective commits its recommendation **before** seeing the others (no anchoring).

| Perspective | Optimizes For | Structural Role |
|-------------|--------------|-----------------|
| **Opportunity Assessor** | Value ratio (Law 1) and revenue potential (Law 2). Combines short-term revenue and long-term value into a single upside assessment. | What should we build? |
| **Risk Assessor** | Failure probability, blast radius, reversibility, legal exposure. Produces hard scores, not qualitative hedging. | What kills us? |
| **Capability Assessor** | Build velocity, agent error rates, technical dependencies, timeline realism. Grounds the discussion in what the system can actually deliver. | Can we actually do this? |

Each perspective outputs structured data:

```json
{
  "perspective": "risk",
  "recommendation": "DEFER",
  "confidence": 4,
  "scores": {
    "probability_of_failure": 0.35,
    "impact": "HIGH",
    "reversibility": "LOW"
  },
  "rationale": "Payment processing requires money transmission license we don't have.",
  "kill_criteria": "If legal counsel confirms MTL requirement by Phase 2, abandon this product line.",
  "counter_evidence_required": true
}
```

**Synthesis step:** The Strategist receives all three structured evaluations (~2,000 tokens total, not prose summaries) and produces a decision. If perspectives are irreconcilable (e.g., Opportunity says PROCEED, Risk says REJECT with P(failure) > 0.3 AND impact = HIGH), the decision is **not synthesized into a mediocre compromise** — it is escalated to the board with the specific disagreement summarized.

**Hard thresholds (non-overridable):**
- Risk Assessor assigns P(failure) > 0.3 AND impact = HIGH → auto-blocked, no debate override
- Compliance gate returns YES (violates constitutional constraints) → hard stop
- All three perspectives agree on REJECT → rejected without Strategist synthesis

**Compliance gate:** Constitutional compliance is NOT a perspective in the debate. It runs after the Strategist's decision as a validation step. It can hard-block. It cannot be outvoted.

### Full Protocol (Existential Tier)

For the ~1% of decisions that are genuinely bet-the-org: the three-perspective evaluation runs, followed by a structured adversarial debate (max 2 rounds). If still irreconcilable after 2 rounds, the system explicitly escalates to the human board with the disagreement documented. The system is designed to say "I cannot decide this" rather than being forced to produce an answer.

### Decision Record Schema

Every strategic decision is stored as a structured record in the task graph, not as LLM debate transcripts. The schema of what you store matters more than the number of agents reading it.

**ADR alignment (v0.6 note):** This schema is functionally an Architecture Decision Record (ADR) system. The ecosystem consensus from ruflo/claude-flow and AndrewAltimit/template-repo is that agents referencing structured decision records produce more consistent, aligned code than agents given freeform instructions. The `strategic_decisions` table serves this purpose — when an executor works on a task, it can query the decision records that led to this task's existence and understand the rationale, constraints, and kill criteria. See §20 for deferred ADR formalization work.

```
strategic_decisions (in agent_graph schema):

  id                    -- UUID
  decision_type         -- ENUM: tactical, strategic, existential
  proposed_action       -- TEXT (one sentence)
  rationale             -- TEXT (two sentences max)
  alternatives_rejected -- JSONB (array of {option, reason})
  kill_criteria         -- JSONB (array of measurable conditions)
  perspective_scores    -- JSONB (opportunity, risk, capability scores)
  confidence            -- INTEGER (1-5)
  recommendation        -- ENUM: proceed, defer, reject, escalate
  outcome               -- ENUM: NULL (pending), succeeded, failed, reversed
  superseded_by         -- UUID (FK to a later decision that overrode this)
  dependent_decisions   -- UUID[] (decisions that depend on this rationale)
  created_at            -- TIMESTAMPTZ
  decided_by            -- TEXT (agent_id or 'board')
```

This is the persistent memory for multi-month product builds. When the Strategist evaluates a decision in week 12, it queries `strategic_decisions` for all decisions tagged as dependencies of the current product. It sees structured rationale and kill criteria — not compressed summaries of forgotten conversations.

### Signal Gathering

Strategic and Existential decisions require structured input signals before evaluation. These are gathered as parallel Executor-tier tasks:

| Signal | Source | Output Schema | Frequency |
|--------|--------|---------------|-----------|
| Market opportunity | Web search via Gateway (structured output) | `{ market_size, growth_rate, competition_density, entry_barriers }` | Per DIRECTIVE |
| Competitive landscape | Web search (mandatory counter-evidence for opportunity claims) | `{ competitors[], feature_gaps[], pricing_range }` | Per DIRECTIVE |
| Build capability | Task graph query (historical velocity, error rates, agent performance) | `{ avg_build_time, p95_error_rate, available_capacity }` | Computed |
| Financial constraints | Financial Script output (SELECT only) | `{ monthly_burn, runway_months, budget_available }` | Computed |
| Legal constraints | Static knowledge + §17 obligation matrix | `{ blocked_by[], requires_counsel[] }` | Per DIRECTIVE |
| User demand (Phase 2+) | Data Cooperative signals | `{ demand_score, willingness_to_pay, unmet_needs[] }` | Monthly |

### Measuring Strategy Quality (P5)

The protocol includes measurement infrastructure from day one. The key metric is **decision reversal rate** — how often a decision is later superseded or reversed.

```sql
SELECT
  decision_type,
  COUNT(*) as total_decisions,
  COUNT(*) FILTER (WHERE superseded_by IS NOT NULL) as reversals,
  ROUND(100.0 * COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)
    / COUNT(*), 2) as reversal_pct
FROM strategic_decisions
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY decision_type;
```

Additional metrics tracked:
- **Downstream task failure rate**: decisions whose dependent tasks fail at > 30%
- **Kill criteria trigger rate**: how often kill criteria are hit (too frequent = bad decisions; never = criteria too loose)
- **Confidence calibration**: decisions with confidence 5 should succeed > 90%; confidence 2 should succeed ~50%
- **Perspective divergence**: how often the three perspectives disagree (too little = groupthink; too much = poor signal quality)

### Phase Activation

| Phase | Strategy Protocol | Measurement |
|-------|------------------|-------------|
| **Phase 1** | Single-pass structured evaluation for all decisions. Board sets product strategy via DIRECTIVEs. | Instrument decision reversal rate from day one. Track all Strategist recommendations vs board decisions. |
| **Phase 1, week 4+** | Three-perspective evaluation runs in **shadow mode** for DIRECTIVE-level decisions. Compares protocol recommendations to board decisions. | Shadow divergence rate. If protocol agrees with board > 80% → G4 progressing. |
| **Phase 2** | Three-perspective evaluation active for Strategic tier. Single-pass for Tactical. | Decision reversal rate comparison: single-pass vs three-perspective. Prediction accuracy (Brier scores). |
| **Phase 3+** | Full tiered protocol active. Model diversity for perspectives when budget allows. | Autonomous decision quality. Kill criteria effectiveness. |

### Scaling with Model Capability

The protocol is designed to become MORE valuable as models improve, not obsolete:

- Better models → better individual perspectives → better ensemble quality (super-linear scaling)
- Larger context windows do NOT eliminate the protocol's advantage: attention quality degrades in long contexts ("Lost in the Middle"), while each perspective agent maintains dense, domain-relevant context
- Phase 3+: different model families for different perspectives (e.g., one model fine-tuned on risk analysis, another on market analysis) to ensure genuine perspective independence

**The risk to monitor:** If all perspectives converge to the same answer on every decision, perspective independence has collapsed. The perspective divergence metric above detects this. Mitigation: introduce model diversity or restructure perspective prompts.

### Cost Impact

| Scenario | Monthly Cost | % of Operating Budget |
|----------|-------------|----------------------|
| All tactical (single-pass, 50/day) | ~$75-120 | 2-3% |
| 90% tactical / 9% strategic / 1% existential | ~$145 | 3-7% |
| All strategic (NOT recommended) | ~$900-1,200 | 20-27% |

The tiered approach keeps strategy evaluation at 3-7% of the operating budget.

---

## 20. What This Document Does Not Cover

The following are addressed in companion documents or deferred to later versions:

- **Full AutoBot constitutional text** — see v3 response document
- **Data Cooperative legal structure** — deferred to Phase 3 legal counsel
- **Pentland framework deep analysis** — see `autobot-pentland-data-commons-framework.md`
- **Social physics observability metrics** — defined in v3, tracked from Phase 2
- **Research questions (RQ-01 through RQ-26)** — see `research-questions/REGISTRY.md` for full registry with phase assignments, gate mappings, and measurement plans
- **Specific product strategy** — the Strategy Evaluation Protocol (§19) defines how strategic decisions are made; specific product choices remain empirical, determined by the protocol's signal gathering and perspective evaluation
- **Detailed Postgres DDL** — deferred to implementation phase; schema described structurally in this document
- **A2A protocol integration** — Google's Agent-to-Agent protocol is v0.3 as of July 2025; evaluate when mature. MCP adopted for tool declaration protocol (see §6). Gong's Feb 2026 production MCP deployment signals faster adoption than expected — MCP interoperability evaluation should occur in Phase 2, specifically when Optimus builds products that must integrate with enterprise customer systems. A2A remains deferred until semantic-layer protocols mature beyond syntactic message passing.
- **Mesh vs. hierarchy architectural rationale (deferred):** Document why hierarchical orchestration is required for governed/constitutional agent organizations — the constitutional governance requirement demands explicit, auditable task decomposition and approval chains that mesh architectures cannot structurally enforce.
- **Vendor independence strategy (deferred):** Document why Optimus uses open infrastructure (Postgres, JWT, SQL, standard APIs) and define migration strategies if any model provider deprecates or restricts API access. The spec's tier-specific model assignments (§2) already enable multi-vendor operation.
- **Multi-tenant agent identity model (deferred to Phase 4+):** If Optimus/AutoBot products serve enterprise customers deploying their own agent workforces, a scalable identity model beyond the current single-organization JWT scheme will be required.
- **DMS / KV cache compression for local executors (deferred to Phase 2-3):** NVIDIA's Dynamic Memory Sparsification achieves 5-8x KV cache compression. Evaluate for Ollama executor tier once Phase 1 is stable.
- **Fine-tuning on task patterns (deferred to Phase 4+):** Not appropriate for Phase 1-3 (P4: boring infrastructure), but evaluate once Optimus has sufficient task history to train on.
- **GitHub Agent HQ governance integration (deferred to Phase 3-4):** When Optimus becomes a product serving enterprise customers, they will expect it to integrate with Agent HQ as a control plane for agent authorization and monitoring. Evaluate alongside the multi-tenant identity model.
- **ADR-driven specification formalization:** The `strategic_decisions` table (§19) is functionally an ADR system. Consider formalizing it as an explicit ADR format compatible with industry-standard tooling, and extending the pattern to architectural decisions.
- **ComposioHQ agent-orchestrator as reference implementation (evaluate for Phase 1):** Agent-agnostic, runtime-agnostic orchestration CLI. Evaluate whether studying this tool can accelerate Phase 1 agent lifecycle management. Key capabilities: git worktree management per agent, automated CI failure → agent fix loops, web dashboard.
- **Reinforcement learning for agent sequencing (deferred to Phase 4+):** ChatDev v2.0 uses RL to optimize agent sequencing. Not appropriate until Optimus has substantial task history, but the `state_transitions` audit log already captures the training data.

---

## 21. Changelog

Full version history is maintained in `CHANGELOG.md`. See that file for detailed entries for all versions from v0.1.0 through v1.0.0.

### v1.0.0 (2026-03-10)

Board decision review. 11 decisions (D1-D11) resolved from consolidated conversation audit. See `SPEC-v1.0-DECISIONS.md`.

- **D1 (MAJOR):** Removed specific dollar amounts from §15 Operating Cost Model. Spec now mandates the cost enforcement mechanism (G1 budget gate, per-invocation token logging, per-tier allocation) without embedding pricing that goes stale. Actual budget numbers are operational config.
- **D2 (verified):** Guard check atomicity (§5) — already correct in spec since v0.5. No change needed.
- **D3 (verified):** Kill switch fail-closed (§9) — already correct in spec. No change needed.
- **D4 (MINOR):** Content sanitization specification (§5) — replaced inline pattern categories, rule set versioning, and testing methodology with implementation-defined ADR reference. Spec mandates the requirement (infrastructure-enforced, versioned, tested, audited); implementation details evolve via ADR.
- **D7 (MINOR):** Added Behavioral Contracts subsection to §2 Agent Tiers. Each agent must declare measurable success criteria, expected outputs, and interaction norms. Schema is implementation-defined.
- **D5, D6, D9, D10:** Ruled out of spec scope — product-level concerns for autobot-inbox.
- **D8:** Spec freeze lifted. v1.0.0 released.
- **D11:** ADR-002 (individual install) unchanged — revisit trigger at 3+ users remains.
