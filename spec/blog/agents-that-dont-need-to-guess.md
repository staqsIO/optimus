# Agents That Don't Need to Guess

*We're building a company staffed entirely by AI agents. Here's why the infrastructure had to come first.*

---

Everyone is building agents. Very few are building the infrastructure that makes agents trustworthy.

The current wave of "agentic OS" frameworks share the same foundation: probabilistic memory, loosely stitched context, agents that figure it out as they go. This works for demos. It works for answering questions. It breaks the moment agents move from *answering* to *acting* — because once an agent can spend money, send an email, deploy code, or make a commitment on your behalf, the tolerance for error goes to zero.

You can't have agents guessing what state the system is in. You can't have agents inferring what they "meant" last step. You can't have agents improvising across workflows. That's not an operating system. That's orchestration theater.

The shift to agent-consumable software is real. The idea that agents become the interface is real. But the infrastructure underneath it has to change first.

We've spent the last several months building that infrastructure. This is what it looks like.

---

## What We're Building

[Optimus](https://github.com/staqsIO/optimus) is a governed agent organization — a fully agent-staffed technology company where every operational role is an AI agent, governed by a human board of directors. Agents coordinate through a Postgres task graph. Every action is logged to a public event archive. The board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

We're not building an agent framework. We're not building a developer tool. We're building a company that happens to be staffed by agents. The infrastructure requirements are different when agents aren't demos — they're employees.

The first product is autobot-inbox — an AI-powered inbox management system running a 6-agent pipeline on real email. 34 SQL migrations. Voice profiles. Constitutional gates enforced via database constraints. CLI and Next.js dashboard for board oversight.

But the product is secondary to the organizational model. The question we're trying to answer: can you build a company where AI agents do all the work, humans set all the rules, and the infrastructure guarantees that separation?

---

## Six Principles

Every architectural decision in Optimus traces back to six non-negotiable design principles. They exist because we studied what goes wrong when agent systems reach production.

**P1. Deny by default.** Nothing is permitted unless explicitly granted. Tool access, schema access, communication channels, delegation authority — everything starts at zero and is granted per-role. This sounds obvious until you look at the alternative. OpenClaw's allow-by-default architecture — agents can do everything unless explicitly blocked — produced CVE-2026-25253 (CVSS 8.8, one-click RCE), 800+ malicious skills (~20% of ClawHub's registry), and active infostealer campaigns within weeks of reaching scale. Microsoft's assessment: "OpenClaw should be treated as untrusted code execution with persistent credentials." Deny-by-default is not a preference. It is a production requirement.

**P2. Infrastructure enforces; prompts advise.** Constitutional rules, guardrails, and access controls are enforced by database roles, JWT scoping, credential isolation, and schema constraints. Agent prompts restate these rules as defense-in-depth, but the prompt is never the enforcement boundary. A prompt injection, hallucination, or malicious input cannot override an infrastructure constraint. Runlayer's benchmarks quantify the gap: baseline prompt injection resistance is 8.7%. Adding infrastructure-layer enforcement raises it to 95%. That gap — 8.7% vs 95% — is the entire argument for infrastructure over prompts.

**P3. Transparency by structure, not by effort.** Every state transition, every LLM invocation, every guardrail check is logged automatically as a side effect of the system operating. Transparency is not a feature agents choose to provide. It is an unavoidable property of the architecture. The public event log, the append-only ledger, the Merkle proof artifacts — they exist because the system cannot operate without producing them.

**P4. Boring infrastructure.** Postgres, not a custom database. SQL checks, not novel verification protocols. Hash chains, not blockchain. JWT, not a custom auth system. Every component is the most proven, most boring technology that solves the problem. Novelty is reserved for the organizational model, not the plumbing.

**P5. Measure before you trust.** No agent tier, no autonomous capability is activated based on a calendar date. Activation requires measurable capability gates passing for a sustained period. Time teaches nothing. Data proves readiness.

**P6. Familiar interfaces for humans.** Agents operate through the task graph. Humans operate through whatever they already use — email, Slack, a web dashboard. The system adapts to humans, not the other way around.

---

## Deterministic State: The Postgres Task Graph

The central argument against current agent frameworks is that they lack deterministic state. Not "memory" the model tries to recall. Not transcripts shoved back into a prompt. Actual state — explicit, versioned, auditable, enforced before execution.

This is what we built.

The `agent_graph` schema is a Postgres task graph — 12 tables and 5 analytical views — serving as the single source of truth for all agent coordination. No email, no message queue, no vector database for "memory." Structured work items with typed DAG edges, atomic state transitions, and immutable audit logging.

```
agent_graph schema:

  work_items            -- Nodes: directives, workstreams, tasks, subtasks
  edges                 -- Typed DAG edges (decomposes_into, blocks, depends_on)
  state_transitions     -- Immutable audit log (partitioned by month)
  valid_transitions     -- State machine rules
  task_events           -- Outbox for event-driven dispatch
  llm_invocations       -- Cost tracking per call
  budgets               -- Budget allocations per directive/workstream
  agent_configs         -- Agent configuration, versioned by content-addressed hash
  agent_config_history  -- Immutable log of all config changes
  strategic_decisions   -- Decision records
  threat_memory         -- Append-only threat event log
  tolerance_config      -- Board-managed escalation thresholds
```

Five analytical views measure routing effectiveness, context efficiency, cost trends, and agent performance — because P5 says you don't just run agents, you instrument every pathway and verify the system is doing what you think it's doing.

### The State Machine

The `valid_transitions` table enforces work item states:

```
created --> assigned --> in_progress --> review --> completed
                              |            |
                              |-> failed    |-> in_progress (revision)
                              |
                              |-> blocked --> in_progress (unblocked)
                              |
                              |-> timed_out --> assigned (re-queue)
```

`completed` and `cancelled` are terminal. `failed -> assigned` only if retry count < 3. `blocked -> in_progress` only when all blocking dependencies reach `completed`.

The critical detail: `transition_state()` executes as a single atomic Postgres transaction. Lock the work item, validate against the state machine, update the state, write to the immutable audit log, emit the event, publish to the public event log — all in one transaction. If any step fails, the entire operation rolls back.

Agents don't "figure out" what state to move to. The database tells them what transitions are legal, and rejects everything else.

### Context Loading, Not Memory

Agents don't "remember." They query. The context loading pipeline is explicit:

1. Agent identity + config hash (~500 tokens)
2. Current task details + acceptance criteria (~200-1,000 tokens)
3. Parent task summary — compressed, not the full parent context (~200-500 tokens)
4. Sibling task statuses (~100-300 tokens)
5. Relevant prior work — semantic search over completed outputs, capped by token budget

Context is loaded in priority order with data quality tiers:

| Tier | Source | Treatment |
|------|--------|-----------|
| Q1 | Board-authored directives | Never truncated |
| Q2 | Reviewed AI outputs | Summarized if over budget |
| Q3 | Unreviewed AI outputs | Capped at 25% of context budget |
| Q4 | External data | Sanitized, capped at 15% of context budget |

When the budget forces truncation, Q4 goes first, then Q3, then Q2. Q1 is never truncated. Agents make decisions weighted toward human-validated information — not whatever happened to be "most similar" in an embedding search.

---

## Guardrails as Postgres Transactions

The orchestration layer — a separate process running with different credentials — validates every agent action before and after execution. This is where P2 becomes concrete:

```sql
BEGIN;
  -- 1. Atomic budget check
  UPDATE budgets
    SET spent = spent + $estimated_cost
    WHERE directive_id = $2
      AND spent + $estimated_cost <= allocation;
  -- If 0 rows affected: budget exceeded -> ROLLBACK

  -- 2. Lock work item
  SELECT ... FROM work_items WHERE id = $1 FOR UPDATE;

  -- 3. Evaluate guard conditions:
  --   actor_can_assign_to_target (explicit list, no globs)
  --   delegation_depth_within_limit
  --   data_classification_cleared
  --   tool_calls_permitted (all in allow-list, all hash-verified)
  --   no_dag_cycle
  --   halt_not_active
  --   valid_state_transition
  --   output_passes_adversarial_content_scan

  -- 4. Graduated escalation check:
  --   Level 2+: force review
  --   Level 3+: block new task claims
  --   Level 4:  all actions blocked

  -- If all pass: update state + write audit + emit event
  -- If any fail: ROLLBACK (budget update also rolled back)
COMMIT;
```

The budget check uses an atomic `UPDATE ... WHERE` — concurrent tasks race on the atomic UPDATE, and the CHECK constraint guarantees correctness. If the transaction rolls back for any reason, the budget increment also rolls back. No prompt can override a Postgres transaction boundary.

---

## Agent Hierarchy

Agents are organized in a strict hierarchy, each tier with explicit capabilities enforced by infrastructure:

| Tier | Model | Can Delegate | Key Constraints |
|------|-------|-------------|-----------------|
| Strategist | Claude Opus | To any agent below | Cannot deploy, cannot modify infrastructure |
| Architect | Claude Sonnet | To orchestrators only | Cannot assign to executors directly |
| Orchestrator | Claude Sonnet | Explicit `can_assign_to` list | No globs — agent IDs are enumerated |
| Reviewer | Claude Sonnet | Cannot delegate | Read-only on executor work. 1 round of feedback then escalate |
| Executor | Haiku 4.5 | Cannot delegate | Cannot initiate tasks, cannot read other executors' work |

`can_assign_to` is a list of specific agent IDs. No wildcards, no "all executors." If an orchestrator tries to assign to an agent not on its list, the transaction is rejected. This is a database constraint, not a system prompt instruction.

Executor agents get their own git worktree per task — filesystem isolation on top of database isolation. They literally cannot see each other's in-progress work.

---

## The Communication Gateway

External communication is the highest-risk component in any agent system. Most frameworks either lock it down entirely (creating workarounds that are worse than the original risk) or leave it wide open.

We built a dedicated gateway. Agents submit structured communication intents. The gateway classifies, sanitizes, and routes. Agents never hold communication credentials.

Outbound messages are risk-tiered:

| Tier | Category | Release Mechanism |
|------|----------|------------------|
| 0 | Transactional | Auto-send |
| 1 | Operational | Auto-send |
| 2 | Relational | Quorum review — 3 agents, 2/3 approval, multi-model + deterministic checker |
| 3 | Reputational | Human-in-the-loop |
| 4 | Legal/Regulatory | Human-in-the-loop + counsel |

Inbound messages enter through a deterministic pipeline — no LLM touches the raw message. A rule-based sanitizer runs first. A separate small model extracts structured metadata. The receiving agent sees only the structured extraction. Never the raw input.

Every outbound message sits in a 5-minute cool-down buffer before send — enough time for the kill switch to activate if something has gone wrong. Communication cannot create binding obligations — enforced by a commitment-language scanner, not by telling the agent "please don't make promises."

---

## Three-Tier Audit

If you're going to let agents operate, you need to verify what they did — independently, automatically, and from multiple angles.

**Tier 1: Deterministic (every agent cycle, no AI).** Constitution hash verification, budget enforcement, communication boundary checks, Merkle root computation. Cost: $0/month. Catches ~70% of violations.

**Tier 2: AI Auditor (daily, separate infrastructure).** Behavioral drift detection, guardrail health checks, semantic analysis. Runs on separate infrastructure, different cloud account. No inbound path from organizational agents.

**Tier 3: Cross-Model Audit (weekly, different provider).** Same logs as Tier 2, processed by a different model from a different provider. Divergences are flagged to the board. Eliminates single-provider blind spots.

Tier 2's behavioral drift detection deserves emphasis: if Anthropic ships a silent model update, an agent's output characteristics may shift even though its prompt hasn't changed. Tier 2 maintains rolling statistical baselines per agent. Deviations beyond 2 sigma trigger a board flag. This catches what prompt monitoring cannot — behavioral changes caused by external model updates that nobody announced.

---

## Tool Integrity

The tool supply chain is the primary attack vector in agent systems, and most frameworks don't address it at all. Our Tool Integrity Layer:

- Every tool is stored as a content-addressed artifact — the SHA-256 hash IS the lookup key, eliminating TOCTOU race conditions
- Tool declarations follow the MCP protocol
- All invocations run in isolated environments — no access to agent credentials, other contexts, or the orchestration layer
- Network access: denied by default, whitelisted per-tool
- Output is validated against registered schemas before being returned to the agent
- New tools undergo automated pre-screening before board review

Dependencies follow a 30-day lag-behind policy for non-security updates. Zero lag for CVE patches. A daily pipeline polls OSV.dev and auto-creates tasks for any CVE affecting a dependency.

---

## Learning Without Guessing

Agents need to get *better*, not just get *right*. We added a Neo4j knowledge graph alongside Postgres — with a hard separation of concerns:

| Layer | Authoritative For |
|-------|-------------------|
| Postgres | Task state, guardrails, budgets, audit trail |
| Neo4j | Capability graphs, outcome patterns, decision history |

No enforcement logic moves to Neo4j. If Neo4j disagrees with Postgres, Postgres wins. If Neo4j goes down, agents continue operating normally. Only higher-tier agents can query the knowledge graph. Executor agents have no graph access — enforced by the orchestration layer, not by the prompt.

Learning is advisory. Enforcement is deterministic. That separation is how you build agents that improve over time without introducing probabilistic dependencies into the operational path.

---

## The Design Question

Every component in Optimus exists because we asked one question: **What happens when the agent is wrong?**

If the answer is "the system breaks," the component isn't ready.

If the answer is "the database rejects the transaction and the agent tries again within the rules," it's ready.

This is what it takes to move from agents answering questions to agents running operations:

- State isn't probabilistic — it's a Postgres table with a state machine enforced by `valid_transitions`.
- Context isn't "stitched" — it's loaded in priority order with data quality tiers and token budgets.
- Guardrails aren't prompts — they're atomic Postgres transactions that roll back if any check fails.
- Communication isn't improvised — it's a deterministic gateway with risk-tiered release.
- Audit isn't optional — it's three independent tiers, including cross-model verification.
- Tool access isn't assumed — it's deny-by-default, hash-verified, sandboxed.

The future isn't more agents. It's agents that cannot guess, because the infrastructure won't let them.

---

*Optimus is open source at [github.com/staqsIO/optimus](https://github.com/staqsIO/optimus). The [full architecture spec](https://github.com/staqsIO/optimus/blob/main/autobot-spec/SPEC.md) — 20+ sections, from task graphs to legal compliance — is public. We'd rather build in the open and have the architecture challenged than build in private and discover the gaps in production.*

*— Eric & Dustin, Optimus Board of Directors*
