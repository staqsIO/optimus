---
title: "Agent Runtime"
section: 4
tier: operations
description: "Agent execution model, tool sandboxing, context management, and behavioral contracts"
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
