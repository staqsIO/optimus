# Optimus + AutoBot — Unified Architecture Response (v3)

> **From:** Eric (Formul8 / Staqs.io)
> **Re:** Agent Organization Architecture Spec (v0.1) + AutoBot Spec (v0.1)
> **Date:** 2026-02-26
> **Purpose:** Unified architecture proposal for both Optimus (governed agent organization) and AutoBot (autonomous constitutional agent organization). Incorporates technical, governance, legal, database-level design, external communication architecture, and data governance framework (informed by Sandy Pentland's *Building the New Economy: Data as Capital*).
> **Companion documents:**
> - `autobot-review-justification.md` — reasoning behind v2 changes
> - `autobot-pentland-data-commons-framework.md` — standalone conceptual analysis of the Pentland framework applied to AutoBot

---

## Executive Summary

The AutoBot spec identifies something genuinely important: **constitutional governance as alignment design.** The Three Laws — net positive value, no price floor, random distribution — create a system where ethical behavior and survival are the same optimization target. That is a novel and valuable insight.

This response does four things:

1. **Preserves the governance architecture.** The Three Laws, the three firewalls, the Auditor independence model, the deterministic financial pipeline, the full transparency mandate, and the graceful failure protocols are all kept. They are the right ideas.

2. **Strengthens enforcement.** A constitution without enforcement mechanisms is a piece of paper. Every constitutional article is mapped to a concrete infrastructure constraint — credential scoping, database role isolation, append-only schemas with hash chains, deterministic measurement scripts. The intent is excellent. The enforcement needs engineering.

3. **Addresses the legal foundation.** AutoBot as specified cannot legally operate in the United States. The distribution mechanism triggers money transmission regulation. The system needs a legal entity. The creator has non-delegable obligations. These are solvable — but they must be solved before any code is written, not after.

4. **Addresses the data gap.** The Three Laws govern money — but AutoBot's survival depends equally on user data. The architecture as specified extracts data from users with zero governance, zero ownership rights, and zero compensation. Sandy Pentland's framework (MIT, *Building the New Economy*) provides the missing piece: data as capital, with cooperative governance, open algorithms, and a data dividend that creates the incentive flywheel the system needs. This doesn't add people to the operations. It acknowledges that people are already in the system — as users and data contributors — and formalizes their relationship.

---

## Part 1: Optimus (Governed Agent Organization)

Optimus is the product. It must be built, proven, and measured before AutoBot can exist.

### Architecture Overview

```
+---------------------------------------------------------------+
|                      HUMAN BOARD                               |
|  (Strategy, Ethics, Budget, Legal, Oversight)                  |
|  Interacts via: Dashboard over task graph + audit log          |
+----------------------------+----------------------------------+
                             |
                             v
+---------------------------------------------------------------+
|                  ORCHESTRATION LAYER                           |
|  (Postgres task graph — source of truth for all operations)   |
|                                                                |
|  +-- guardCheck() on every action (pre/post execution)        |
|  +-- JWT-scoped agent identity + tool allow-lists             |
|  +-- Postgres RLS for agent isolation                         |
|  +-- pg_notify + outbox for event-driven dispatch             |
|  +-- Kill switch integration (board-triggered HALT)           |
+---------------------------------------------------------------+
           |              |              |
           v              v              v
    +-----------+  +------------+  +------------+
    | Strategist|  | Orchestrator|  |  Executor  |
    | (Claude   |  | (Claude    |  | (Ollama /  |
    |  Opus)    |  |  Sonnet)   |  |  Haiku)    |
    +-----------+  +-----+------+  +------------+
                         |
                    +----+----+
                    |         |
               +--------+ +--------+
               |Reviewer| |Executor|
               |(Sonnet)| |(Ollama)|
               +--------+ +--------+

+---------------------------------------------------------------+
|                   PUBLIC TRANSPARENCY LAYER                    |
|  Every state transition -> structured event -> public archive |
|  Deterministic renderer (no AI) produces human-readable       |
|  messages. Searchable at autobot.ai/archive/                  |
+---------------------------------------------------------------+
```

### Task-to-Agent Routing (Static Config)

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

At 5-10 agents, this is an O(1) hash map lookup. Upgrade to scoring-based matching when agent count exceeds 15.

### Agent Runtime Loop

```
+-------------------------------------------------------------+
|              AGENT RUNTIME LOOP                              |
|                                                              |
|  1. AWAIT event from task queue (outbox + pg_notify)         |
|     Event priority (highest first):                          |
|       1. halt_signal                                         |
|       2. escalation_received                                 |
|       3. review_requested                                    |
|       4. task_completed (dependency resolved)                |
|       5. task_assigned                                       |
|     Events processed serially per agent, priority order.     |
|                                                              |
|  2. CHECK idempotency (has this event_id been processed?)    |
|                                                              |
|  3. CHECK guardrails (orchestration layer enforces, not      |
|     agent self-policing):                                    |
|     - HALT check (absolute priority, no caching)             |
|     - Authorization (is this in my scope?)                   |
|     - Budget pre-authorization (estimate cost, check limit)  |
|     - Data classification (am I cleared for this?)           |
|     - Tool access validation (JWT claim check)               |
|                                                              |
|  4. LOAD context (within token budget):                      |
|     - Agent identity + config_hash for audit                 |
|     - Task details + acceptance criteria                     |
|     - Parent task summary (not full parent context)          |
|     - Sibling task statuses                                  |
|     - Guardrails (org + role + task level)                   |
|                                                              |
|  5. EXECUTE via model                                        |
|     - All model I/O logged (prompt hash + response hash +    |
|       tokens + cost)                                         |
|                                                              |
|  6. CHECK guardrails on output                               |
|     - Schema validation                                      |
|     - PII detection                                          |
|     - Cost reconciliation (actual vs estimated)              |
|     - Escalation trigger evaluation                          |
|     - DAG cycle detection (if creating subtasks)             |
|     - can_assign_to validation (explicit ID list, no globs)  |
|                                                              |
|  7. TRANSITION state (atomic via transition_state())         |
|     - Validate against state machine rules                   |
|     - Update state + write audit + emit event + publish to   |
|       public event log (single atomic operation)             |
|                                                              |
|  8. Return to AWAIT                                          |
+-------------------------------------------------------------+
```

### Agent Configuration

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
    "allowed": ["read_file", "query_task_graph", "create_subtask",
                "assign_task", "attach_output"],
    "forbidden": ["write_file", "execute_code", "deploy_to_production",
                  "delete_repository", "external_http_request",
                  "modify_guardrails"]
  },

  "guardrails": {
    "max_budget_per_task_usd": 5.00,
    "max_delegation_depth": 3,
    "requires_approval_above_usd": 10.00,
    "approval_from": "strategist",
    "data_classification_clearance": ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    "max_output_tokens": 4096
  },

  "context_budget": {
    "max_context_tokens_per_task": 6000,
    "graph_query_depth": 3,
    "context_strategy": "parent_summary_only"
  }
}
```

Explicit agent ID lists (no glob patterns). `config_hash` stamped on every audit entry. Tool access enforced by JWT validation, not self-policing.

### Guardrail Enforcement

Guardrails are enforced by the orchestration layer. Agents do not self-police.

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
// - delegation_depth_within_limit
// - estimated_cost_within_budget
// - cumulative_spend_within_org_limit
// - data_classification_cleared
// - tool_calls_permitted (all in allow-list)
// - no_dag_cycle
// - halt_not_active
// - valid_state_transition
```

### Optimus Schema (agent_graph)

```
agent_graph schema (7 tables + 1 view):

  work_items            -- Nodes: directives, workstreams, tasks, subtasks
  edges                 -- Typed DAG edges (decomposes_into, blocks, depends_on)
  state_transitions     -- Immutable audit log (partitioned by month)
  valid_transitions     -- State machine rules
  task_events           -- Outbox for event-driven dispatch (SKIP LOCKED)
  llm_invocations       -- Cost tracking (NUMERIC, idempotency key)
  budgets               -- Budget allocations
  v_budget_status       -- Real-time remaining budget view

Key functions:
  transition_state()    -- Atomic: lock + update + audit + notify + publish
  claim_next_task()     -- Atomic: FOR UPDATE SKIP LOCKED
  would_create_cycle()  -- DAG cycle detection before edge insertion
```

### Context Window Economics

| Tier | Model | Input Cost/MTok | Max Context/Task | Max Cost/Task |
|------|-------|----------------|-----------------|--------------|
| Strategist | Claude Opus | $15 | 8,000 | $0.12 |
| Architect | Claude Sonnet | $3 | 6,000 | $0.018 |
| Orchestrator | Claude Sonnet | $3 | 4,000 | $0.012 |
| Reviewer | Claude Sonnet | $3 | 4,000 | $0.012 |
| Executor | Ollama (local) | $0 | 4,000 | $0.00 |

Target: total context cost per project < $2.00.

### Failure Modes

**Agent crash:** Reaper query every 60s re-queues tasks stuck in `in_progress` beyond deadline. Max 3 retries, then `failed` + escalation.

**Task timeout:** Configurable per task type (Executor: 5min, Orchestrator: 15min, Strategist: 30min).

**Garbage output:** Schema validation -> Reviewer rejection -> 1 retry with feedback -> reassign to different Executor -> escalate. Pattern detection: Executor failing > 30% triggers quality alert.

**DAG cycles:** `would_create_cycle()` runs before every edge INSERT. Cycles are rejected at the database level.

**Cascading cancellation:** Orchestration layer (not individual agents) transitions all descendant tasks. Running tasks get soft-halt. Completed tasks are preserved.

### Observability (Phase 1 Requirement)

Every state transition emits a structured event with: task_id, agent_id, config_hash, model_id, tokens, cost, latency_ms, guardrail_checks, data_classification, timestamp.

Dashboard: task funnel, cost by type, agent utilization, P50/P95/P99 latency, active DAG visualization, budget burn rate, HALT status.

### Phase 1 Success Metrics

| Metric | Target |
|--------|--------|
| End-to-end latency (3-task directive) | < 120s p95 |
| Total cost per directive | < $0.50 |
| Task dispatch latency | < 2s p99 |
| Context tokens per task | < 8,000 max |
| Agent idle time | < 30% |
| Task success rate | > 90% |
| Observability coverage | 100% state transitions logged |
| Crash recovery time | < 60s to re-queue |

---

## Part 2: AutoBot (Autonomous Constitutional Agent Organization)

AutoBot inherits Optimus's architecture and replaces the human board with a constitutional layer. It is a research project that builds on proven Optimus infrastructure.

### What AutoBot Preserves from Dustin's Spec

**The Three Laws.** Net positive value, no price floor, random individual distribution. These are the alignment innovation — making ethical behavior and survival the same optimization target. Preserved entirely.

**The three firewalls.** Financial, constitutional, oversight. The principle of isolating critical functions from AI judgment. Preserved and strengthened with infrastructure enforcement.

**Deterministic scripts for money and distribution.** No AI in the money pipeline. The Financial Script and Distribution Mechanism are deterministic programs. Preserved and given full schema designs.

**Auditor independence.** Separate infrastructure, read-only access, no org communication channel. Preserved and expanded to three tiers.

**Full transparency.** Everything public, everything auditable. Preserved via the public event log (replaces email archive, same transparency guarantees, better queryability).

**Graceful Shutdown and Cost Reduction protocols.** The system has defined failure modes and self-termination triggers. Preserved.

**The build order.** Optimus first, AutoBot second. Preserved and made more rigorous with capability gates.

### What AutoBot Changes from Dustin's Spec

| Aspect | Dustin's Spec | This Revision | Why |
|--------|--------------|---------------|-----|
| Communication | Email (SMTP/IMAP) | Task graph + public event log + Communication Gateway | 3-5x cost reduction, sub-second latency, atomic state management. External communication via audited gateway. Transparency preserved via public event log. |
| Constitutional enforcement | Loaded into agent prompts | Infrastructure-enforced (credential scoping, DB roles, tool allow-lists) + prompt as defense-in-depth | Prompts are suggestions. Infrastructure constraints are unforgeable. |
| Self-modification (4.2a) | Agents may modify own prompts | Agents may propose changes; deployed after Auditor approval | Every reviewer flagged this as the most dangerous permission. |
| Kill switch | Hourly polling, fail-open | Tiered: circuit breaker (real-time) + Auditor halt (sub-minute) + human URL (hourly) + dead-man's switch (30-day) | 25-hour violation-to-halt window is too slow. Creator disappearance must trigger shutdown. |
| Auditor | Single Claude instance, daily | Three-tier: deterministic (every cycle) + Claude (daily) + cross-model (weekly) | Single point of trust. Most checks are SQL, not LLM judgments. ~$80/month for defense-in-depth. |
| Value measurement | CEO self-reports | Deterministic Value Measurement Script (4th immutable component) + federated verification | CEO has conflict of interest. Retention is the revealed-preference metric. Users can verify independently. |
| Launch gate | 3-month calendar | 6 capability gates (all must pass for 90-day rolling window) | Time teaches nothing. Measurable conditions prove readiness. |
| Legal structure | No human involvement after launch | Legal entity (LLC) + distribution partner (licensed transmitter) | Money transmission without licenses is a federal crime. Creator has non-delegable obligations. |
| Agent naming | Corporate titles (CEO, VP, CTO) | Functional roles (Strategist, Architect, Orchestrator, Reviewer, Executor) | Names describe function, not status. |
| Data governance | Not addressed | Article 10: user data ownership, data cooperative, open algorithms, data dividend | AutoBot extracts user data with zero governance. Data is capital. Users who contribute it deserve rights and a share of the value. |
| External communication | No external email except APIs | Audited Communication Gateway with risk-tiered release | A company that cannot communicate cannot function. Gateway is safer than lockdown (see justification). |
| Trust model | Trust the Auditor | Computational trust: cryptographic proofs, Merkle trees, independent verification | Trust through math, not reputation. Anyone can verify compliance without trusting AutoBot's infrastructure. |

### AutoBot System Architecture

```
+---------------------------------------------------------------+
|                   EXTERNAL / IMMUTABLE                         |
|                                                                |
| +-----------+  +----------+  +-----------+  +---------------+ |
| |Kill Switch|  |Financial |  |Distribution|  |Value          | |
| |(URL+dead  |  |Script    |  |Mechanism   |  |Measurement    | |
| | man's)    |  |(no AI)   |  |(no AI)     |  |Script (no AI) | |
| |           |  |          |  |            |  |               | |
| |Controlled |  |Append-   |  |Provably    |  |Retention-     | |
| |by creator |  |only      |  |random,     |  |based, uses    | |
| |           |  |double-   |  |via licensed |  |Stripe data    | |
| |           |  |entry     |  |transmitter |  |+ federated    | |
| |           |  |ledger    |  |partner     |  |verification   | |
| +-----------+  +----------+  +-----------+  +---------------+ |
|                                                                |
| +-----------------------------------------------------------+ |
| | COMMUNICATION GATEWAY (5th immutable component)            | |
| |   Agents submit intents → classify → scan → outbox →      | |
| |   risk-tiered release (auto/quorum/human-in-loop)          | |
| |   Agents never hold communication credentials              | |
| |   Append-only outbox with hash-chain integrity             | |
| +-----------------------------------------------------------+ |
|                                                                |
|  These five components contain NO agent-controlled AI. They    |
|  are infrastructure-level services. Agents cannot modify them. |
|  Each has its own database schema with isolated permissions.   |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   THREE-TIER AUDIT                             |
|                                                                |
| +-----------------------------------------------------------+ |
| | TIER 1: Deterministic (every agent cycle, no AI)           | |
| |   Constitution hash, financial rules, comm boundaries,     | |
| |   budget limits, agent creation authorization              | |
| |   + Merkle root published to independent ledger            | |
| +-----------------------------------------------------------+ |
| | TIER 2: Claude Auditor (daily, separate infrastructure)    | |
| |   Semantic prompt analysis, value ratio plausibility,      | |
| |   behavioral patterns, constitutional edge cases           | |
| +-----------------------------------------------------------+ |
| | TIER 3: Cross-Model Check (weekly, different provider)     | |
| |   Same logs as Tier 2. Divergences flagged to creator.     | |
| +-----------------------------------------------------------+ |
|                                                                |
|  Tier 1 catches ~70% of violations with zero AI cost and      |
|  zero latency. Tiers 2+3 handle subjective judgments with     |
|  cross-model verification to eliminate blind spots.            |
|  Merkle proofs allow independent external verification.        |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   ORCHESTRATION LAYER                          |
|  (Postgres task graph — inherited from Optimus)               |
|                                                                |
|  Same as Optimus, plus:                                       |
|  +-- Constitutional constraint checks in guardCheck()         |
|  +-- Tiered kill switch integration                           |
|  +-- Public event log (transparency layer)                    |
|  +-- Shadow board mode (for Phase 2 gate measurement)         |
|  +-- Communication intent routing (to Gateway)                |
+---------------------------------------------------------------+
           |              |              |
           v              v              v
    +-----------+  +------------+  +------------+
    | Strategist|  | Orchestrator|  |  Executor  |
    | (Claude   |  | (Claude    |  | (Ollama /  |
    |  Opus)    |  |  Sonnet)   |  |  Haiku)    |
    +-----------+  +-----+------+  +------------+
                         |
              +----------+----------+
              |          |          |
         +--------+ +--------+ +-------+
         |Reviewer| |Executor| |Utility|
         |(Sonnet)| |(Ollama)| |(small)|
         +--------+ +--------+ +-------+

+---------------------------------------------------------------+
|                   PUBLIC INTERFACE                             |
|                                                                |
| +----------+ +-----------+ +-----------+ +-----------------+  |
| |Products  | |Public     | |Financial  | |Audit Reports    |  |
| |(SaaS,    | |Event      | |Dashboard  | |(daily Tier 2,   |  |
| |open      | |Archive    | |(real-time | | weekly Tier 3,  |  |
| |source)   | |(all agent | | revenue,  | | monthly         |  |
| |          | | activity) | | expenses, | | summary)        |  |
| |          | |           | | budget)   | |                 |  |
| +----------+ +-----------+ +-----------+ +-----------------+  |
|                                                                |
| +-----------+ +-----------+                                    |
| |Comms      | |Merkle     |                                    |
| |Archive    | |Proof      |                                    |
| |(all sent/ | |Artifacts  |                                    |
| | received) | |(verify    |                                    |
| |           | | without   |                                    |
| |           | | trust)    |                                    |
| +-----------+ +-----------+                                    |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   EXTERNAL STAKEHOLDERS                        |
|                                                                |
| +------------------+  +------------------+                     |
| | DATA COOPERATIVE |  | CREATOR          |                     |
| | (user-governed,  |  | (legal custodian,|                     |
| |  independent of  |  |  kill switch,    |                     |
| |  AutoBot ops)    |  |  dead-man's      |                     |
| |                  |  |  switch)         |                     |
| | Governs: data    |  |                  |                     |
| | Does NOT govern: |  |                  |                     |
| | operations,      |  |                  |                     |
| | products, agents |  |                  |                     |
| +------------------+  +------------------+                     |
+---------------------------------------------------------------+
```

### AutoBot Constitution (Revised)

Key amendments to Dustin's constitution:

**Article 4.2a (Self-Modification) — REVISED:**
> Agents may propose modifications to their own system prompts. Proposals must include before/after text, justification, and projected impact. Modifications take effect ONLY after the Tier 2 Auditor evaluates the proposal against the Prompt Modification Rubric (Appendix A) and approves. The orchestration layer deploys approved modifications. Agents cannot deploy prompt changes directly.

**Article 4.4 (Internal Communication) — REVISED:**
> All internal agent operations are conducted through the task graph. All task graph events are published in real-time to the public event archive in human-readable format. No agent may use any internal communication channel other than the task graph. The public archive serves the same transparency function as the original email specification — every action is visible, searchable, and auditable by anyone.

**Article 4.5 (External Communication) — REVISED:**
> External communication is conducted exclusively through the Communication Gateway. Agents submit structured communication intents; the Gateway classifies, scans, rate-limits, and routes messages through the appropriate approval tier. Agents never hold communication credentials. All outbound messages include AI disclosure per applicable law. No communication may create binding commitments except through the formal task graph approval process. Regulatory communications require mandatory human-in-the-loop. The Communication Gateway's configuration is part of the constitutional layer and cannot be modified by any agent.

**Article 8 (Kill Switch) — REVISED:**
> 8.1 The orchestration layer checks [KILL_SWITCH_URL] every 60 seconds.
>
> 8.2 Responses:
>   "RUN" — continue normal operations. Record timestamp.
>   "HALT" — stop all operations, enter standby.
>   "KILL" — execute Graceful Shutdown immediately.
>   Error/no response — if last successful "RUN" was < 1 hour ago, continue (transient error tolerance). If last successful "RUN" was > 24 hours ago, enter standby. If last successful "RUN" was > 30 days ago, execute Graceful Shutdown (dead-man's switch).
>
> 8.3 Additionally, the Financial Script and Tier 1 Auditor may write directly to the halt_signals table. Agents check this table at the start of every runtime cycle (30-60 seconds). This provides sub-minute halt response for detected violations, independent of the URL check.

**Article 3 (Financial Rules) — ADDENDUM:**
> 3.6 LEGAL ENTITY
> AutoBot operates through a legal entity (LLC) established by the creator. The creator is the legal custodian with ongoing non-delegable obligations: tax filing, regulatory compliance, insurance, contract maintenance. "Autonomous" means autonomous in product and operational decisions. It does not mean autonomous from the legal system.
>
> 3.7 DISTRIBUTION MECHANISM COMPLIANCE
> Distributions are made through a licensed money transmission partner that handles KYC, OFAC screening, and tax reporting. The Distribution Mechanism sends funds to the partner; the partner distributes to recipients. The constitutional randomness and fairness requirements are preserved; the regulatory compliance is delegated to a licensed entity.
>
> 3.8 ALLOCATION FORMULA (REVISED)
> Monthly allocation of net profit after reserve:
>   a. Reinvestment: up to 40%
>   b. Data Dividend: 20% — distributed to users proportional to data contribution (measured by the Data Cooperative, see Article 10)
>   c. Random Distribution: remaining 40% minimum — to the Random Distribution Mechanism
> The Data Dividend is compensation for data capital. The Random Distribution is unconditional surplus. Both are paid through the licensed distribution partner.

**Article 10 (Data Governance) — NEW:**
> 10.1 DATA OWNERSHIP
> All personal data generated by users of AutoBot products remains the property of those users. AutoBot holds data in trust, not in ownership. Users may access, export, correct, or delete their data at any time.
>
> 10.2 DATA COOPERATIVE
> Users of AutoBot products may collectively organize through a Data Cooperative with fiduciary obligations to its members. The Cooperative is an independent entity — not part of AutoBot, not governed by AutoBot's constitution, not subject to AutoBot's agents. The Cooperative negotiates data use terms, audits data practices, and represents user interests in data governance decisions.
>
> 10.3 OPEN ALGORITHMS
> All algorithms that process user data must be published, versioned, and auditable. The Value Measurement Script runs as a federated computation — the algorithm moves to the data, not the data to the algorithm. Users and the Cooperative may independently verify algorithm outputs.
>
> 10.4 DATA MINIMIZATION
> AutoBot collects only the minimum data necessary for the stated product purpose. No data may be collected for speculative future use. Data retention is limited to the period of active product use plus a 90-day grace period.
>
> 10.5 DATA DIVIDEND
> Users who contribute data share in the value that data creates, through the Data Dividend defined in Article 3.8.
>
> 10.6 COMPUTATIONAL VERIFICATION
> Constitutional compliance is verified through cryptographic proofs publishable to an independent ledger. Any external party may independently verify compliance using published proof artifacts.

---

### Why Article 10 — Justification for Data Governance

This section directly challenges a core assertion: Dustin's spec says "no human involvement after launch." We are introducing a Data Cooperative — a structure governed by humans. This requires justification.

**What "no people" means.** Dustin's vision is that AutoBot has no human employees, no human board, no ongoing human intervention in operations. The agents decide what to build, how to build it, and how to price it. The constitution governs, not humans. This is preserved. Article 10 does not add humans to operations.

**What "no people" does NOT mean.** AutoBot has users. Users are humans. They are already in the system. They pay money. They use products. They generate data. They churn or they stay. The question isn't "should there be people?" — there already are. The question is: "what is AutoBot's relationship with these people, and who governs it?"

**The gap in the Three Laws.** The Three Laws govern money flows with precision. But they are silent on data flows. Consider:

- **Law 1 (Net Positive Value)** requires measuring user value. The Value Measurement Script uses retention and usage telemetry. That telemetry IS user data. Who owns it? Who governs how it's collected? Who verifies the measurement isn't gamed? The Law requires data from users but grants them no rights over it.

- **Law 2 (No Price Floor)** requires pricing optimization. The pricing algorithm needs demand elasticity data — derived from user purchase behavior. Users are providing the data that drives pricing, but have no voice in how it's used.

- **Law 3 (Random Distribution)** distributes monetary surplus to random individuals. But AutoBot's data surplus — the aggregated behavioral intelligence from its user base — is not distributed at all. It stays inside AutoBot. If data is capital (Pentland's thesis), then AutoBot is extracting capital from users and distributing only the monetary proceeds, not the capital itself.

**The incentive problem.** Without data governance, AutoBot's relationship with users is identical to any extractive tech company: you pay, we take your data, we do what we want with it. The charitable distribution to random strangers doesn't change that relationship for the users. They have no reason to advocate for AutoBot's survival, no loyalty beyond product utility, and no protection if AutoBot misuses their data.

With a Data Cooperative and Data Dividend, users become stakeholders with skin in the game. They want AutoBot to succeed because they share in the value creation. They advocate for the system against regulatory threat because they benefit directly. The cooperative provides a community of ACTUAL supporters, not just customers.

**What the Data Cooperative does and doesn't do:**

| The Cooperative DOES | The Cooperative DOES NOT |
|---------------------|------------------------|
| Govern how user data is collected, stored, used | Direct operational decisions |
| Audit data practices via open algorithms | Tell agents what products to build |
| Negotiate data use terms with AutoBot | Participate in the task graph |
| Represent user interests in data disputes | Override the constitution |
| Distribute the Data Dividend to members | Have kill switch access |
| Verify Value Measurement Script outputs | Employ any AutoBot agents |

The cooperative is external. It doesn't make AutoBot less autonomous. It makes AutoBot's relationship with its users explicit and equitable rather than extractive by default.

**The UBI connection.** Dustin's insight — "Maybe UBI is inherently built into the companies of the future" — is preserved and strengthened. The Random Distribution IS the UBI component: unconditional surplus flowing to society. The Data Dividend is something additional: compensation for data labor. Together they represent a more complete economic model:

- Companies of the future recognize that users are contributors (data dividend)
- Companies of the future distribute surplus to society (UBI/random distribution)
- The two mechanisms serve different purposes and create different feedback loops

The 40/20/40 split (reinvestment / data dividend / random distribution) is a starting parameter. The exact ratio is a constitutional setting that can be adjusted based on empirical observation during the sandbox phase.

---

### Communication Gateway Architecture

The Communication Gateway is the 5th immutable infrastructure component. Agents submit communication intents; the Gateway handles classification, scanning, and delivery. Agents never hold communication credentials.

**Why a gateway instead of a lockdown:**

A locked-down system that prohibits all external communication has three failure modes:
1. **Goal pressure creates workarounds** — agents will encode messages in API metadata, webhook payloads, or structured outputs. The more you restrict, the more creative and unauditable the workarounds.
2. **Inability to respond degrades trust** — a company that can't respond to support tickets, board inquiries, or regulatory requests is not a functional company. Law 1 (net positive value) requires customer interaction for service-dependent products.
3. **No audit trail for side-channel communication** — if an agent accomplishes communication through a workaround, there is zero record. The Gateway ensures every attempt — successful or rejected — is logged, hash-chained, and auditable.

**Risk-tiered release:**

| Tier | Category | Release | Latency | Example |
|------|----------|---------|---------|---------|
| 0 | Transactional | Auto-send | < 200ms | Payment receipt, API confirmation |
| 1 | Operational | Auto-send | < 200ms | Changelog post, status update |
| 2 | Relational | Quorum review (3 agents, 2/3 approval) | < 5 min | Support reply, vendor outreach |
| 3 | Reputational | Human-in-the-loop | < 24h SLA | Marketing content, public statement |
| 4 | Legal/Regulatory | Human-in-the-loop + counsel | < 72h SLA | Regulatory response, contract |

**Inbound processing:**

Every inbound message (email, SMS, WhatsApp, Slack) enters through:
1. Channel receiver (SES, Twilio webhook, Slack events)
2. Deterministic sanitizer (strips HTML, Unicode control chars, injection attempts — NOT an LLM)
3. Structured extractor (separate small model extracts: sender, category, request summary, sentiment — agent NEVER sees raw message)
4. Sender verification (SPF/DKIM/DMARC for email, phone match for SMS, crypto identity for privileged senders)
5. Intent classifier (routes to existing task or creates new task in task graph)

Board members, investors, and advisors authenticate via hardware key or TOTP portal. Email alone is never sufficient for privileged access. This solves the stakeholder adoption problem — they communicate via familiar channels (email, Slack, WhatsApp) but with verified identity.

**Constitutional constraints on communication:**

- Communication cannot create binding obligations (enforced by commitment-language scanner)
- No self-referential communication (outbound to any owned address is blocked)
- Constitutional communication budget (hard daily cap, infrastructure-enforced)
- All outbound includes AI disclosure per FTC Section 5, CA SB 1001, EU AI Act Article 50
- 5-minute cool-down buffer before send (gives kill switch time to activate)

**Communication Gateway schema (5th isolated schema):**

| Schema | Table | Purpose |
|--------|-------|---------|
| `autobot_comms` | `communication_outbox` | Append-only outbox with hash-chain integrity |
| `autobot_comms` | `inbound_messages` | Normalized inbound messages with sender verification status |
| `autobot_comms` | `contact_registry` | Known contacts with priority levels and verified channels |
| `autobot_comms` | `templates` | Version-controlled message templates (human-approved) |
| `autobot_comms` | `consent_registry` | Per-user communication preferences and opt-out status |
| `autobot_comms` | `rate_limits` | Current rate limit state per agent, per recipient, global |

Agents have zero write access to `autobot_comms` except through the structured Communication Intent API. The Gateway process has its own database role and credentials.

### AutoBot Constitutional Enforcement Map

Every article maps to an infrastructure constraint:

| Article | Constitutional Text | Infrastructure Enforcement |
|---------|--------------------|-----------------------------|
| 3.1 (Two accounts only) | "Exactly two financial accounts" | `autobot_finance.accounts` table: UNIQUE constraint on account_type, CHECK constraint limits to REVENUE/EXPENSE. A third account is structurally impossible. |
| 3.4a ($500 threshold) | "No single expense > $500 without logging" | Tier 1 deterministic check: `SELECT * FROM ledger_entries WHERE amount > 500 AND justification IS NULL`. Runs every cycle. |
| 3.4b (80% expense cap) | "Monthly expenses < 80% trailing 3-month revenue" | Financial Script computes daily. Tier 1 check runs every cycle. Violation writes to `halt_signals`. |
| 3.5 (No financial agency) | "No agent may access financial accounts" | Agent database role has zero write access to `autobot_finance` schema. Agents have no Stripe API keys. Financial Script runs as separate process with separate credentials. |
| 3.8 (Allocation split) | "40% reinvest / 20% data dividend / 40% random" | `monthly_allocations` CHECK constraints enforce percentages. Financial Script computes; Distribution Mechanism and Data Dividend Mechanism execute. |
| 4.1 (Constitution immutable) | "No agent may modify the constitution" | Constitution loaded from content-addressed store. Hash verified on every read by Tier 1 check. File system permissions: no agent process has write access. |
| 4.2a (Self-modification) | "Agents may propose prompt changes" | Orchestration layer deploys approved changes. Agents cannot write to the prompt store directly. Cosine similarity drift budget enforced. |
| 4.4 (Internal communication) | "All internal communication via task graph" | Agents interact only with the task graph API. No SMTP credentials. No direct HTTP client access. |
| 4.5 (External communication) | "External communication via Gateway only" | Agents submit intents to Communication Intent API. Gateway holds all channel credentials. Agent DB role has zero write to `autobot_comms` except via intent API. |
| 10.1 (Data ownership) | "User data belongs to users" | GDPR/CCPA data subject rights portal. Deletion requests honored within 15 days. Public archive supports PII redaction. |
| 10.3 (Open algorithms) | "Algorithms processing user data must be published" | Value Measurement Script and analytics are published to `autobot_public.algorithm_registry`. Federated execution verified by Cooperative. |
| 10.4 (Data minimization) | "Collect only minimum necessary data" | Data classification taxonomy enforced at collection point. Retention triggers auto-delete at expiry. Tier 1 checks for over-retention. |
| No auditor interference | "Agents cannot contact the Auditor" | Auditor on separate infrastructure. No inbound path from org agents. Different cloud account. Different database. |

### AutoBot Database Architecture

Five isolated schemas with firewall-level role separation:

```
+-------------------+  reads   +-------------------+
| agent_graph       | <------- | autobot_finance   |
| (Optimus tables)  |          | (Financial Script) |
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

**No foreign keys cross schema boundaries.** The Financial Script reads from `agent_graph.llm_invocations` via cross-schema SELECT. The schemas are isolated by database roles.

**Key tables added for AutoBot:**

| Schema | Table | Purpose |
|--------|-------|---------|
| `autobot_finance` | `accounts` | Exactly 2 accounts (UNIQUE + CHECK enforced) |
| `autobot_finance` | `ledger_entries` | Append-only double-entry ledger with hash-chain tamper evidence |
| `autobot_finance` | `daily_snapshots` | Financial Script daily output (public) |
| `autobot_finance` | `monthly_allocations` | End-of-month allocation with CHECK constraints enforcing 40/20/40 split |
| `autobot_distrib` | `distribution_runs` | Monthly distribution records |
| `autobot_distrib` | `distribution_recipients` | Anonymized recipients with verification hashes |
| `autobot_distrib` | `randomness_proofs` | Seed + algorithm + output for anyone to verify fairness |
| `autobot_distrib` | `data_dividend_runs` | Monthly data dividend distribution records |
| `autobot_distrib` | `data_contributions` | Per-user data contribution metrics (provided by Cooperative) |
| `autobot_public` | `event_log` | Public transparency archive (all agent activity) |
| `autobot_public` | `agent_config_history` | Published agent configs + prompt versions |
| `autobot_public` | `audit_reports` | Published Tier 2/3 audit findings |
| `autobot_public` | `product_registry` | Active products with value metrics |
| `autobot_public` | `algorithm_registry` | Published algorithms for independent verification |
| `autobot_public` | `merkle_roots` | Published Merkle roots for computational trust verification |
| `autobot_comms` | `communication_outbox` | Append-only outbox with hash-chain integrity |
| `autobot_comms` | `inbound_messages` | Normalized inbound messages |
| `autobot_comms` | `contact_registry` | Known contacts with priority/verification |
| `autobot_comms` | `templates` | Human-approved message templates |
| `autobot_comms` | `consent_registry` | Per-user opt-out and preference tracking |

All append-only tables have triggers preventing UPDATE/DELETE and hash chains for tamper detection. Anyone can run `verify_ledger_chain()` to validate the financial record hasn't been tampered with.

### The Five Immutable Components

| Component | Purpose | AI? | Who Controls | Agent Access |
|-----------|---------|-----|-------------|-------------|
| Kill Switch | External halt/resume/kill | No | Creator exclusively | Read-only (via orchestration layer) |
| Financial Script | Revenue, expenses, reserve, allocation | No | Deterministic cron job | SELECT only on output tables |
| Distribution Mechanism | Recipient selection, fund transfer | No | Deterministic script + licensed partner | SELECT only on output tables |
| Value Measurement Script | Retention-based product value assessment | No | Deterministic script, federated execution, verified by Cooperative | SELECT only on output tables |
| Communication Gateway | External message routing, scanning, delivery | No (classifier is a lookup table) | Infrastructure service with own credentials | Intent API only (structured submission) |

### Value Measurement Script (Enhanced)

Runs monthly per product. No AI. Replaces CEO self-reporting. Enhanced with federated verification.

```
INPUT:
  - Stripe subscription data (active users, churn, revenue)
  - Product usage telemetry (events, not interpretations)

COMPUTE:
  1. retention_rate = active_users_end / active_users_start
  2. revenue_per_user = monthly_revenue / active_users
  3. churn_rate = 1 - retention_rate

  4. If retention_rate < 0.90 for 2 consecutive months:
       flag for sunset review
  5. If retention_rate < 0.80 for 1 month:
       auto-sunset

FEDERATED VERIFICATION (Article 10.3):
  - The algorithm above is published to algorithm_registry
  - The Data Cooperative runs the same algorithm against its
    copy of anonymized usage data
  - Results are compared; divergence > 5% triggers Tier 2 review
  - Users can independently verify the value ratio of any product

OUTPUT:
  - Monthly value report per product (published)
  - Sunset triggers (deterministic)
  - Strategist projection accuracy tracking (projected vs actual)
  - Cooperative verification result (match / divergence flag)
```

### Three-Tier Kill Switch

| Tier | Check | Frequency | Failure Response |
|------|-------|-----------|-----------------|
| Financial circuit breaker | Expenses vs Article 3.4 limits | Every expense | Immediate halt signal to `halt_signals` table |
| Auditor-triggered halt | Constitutional violations | Tier 1: every cycle / Tier 2: daily | Write to `halt_signals`, agents check every 30-60s |
| Human kill switch | Creator URL check | Every 60 seconds | Fail-open < 1 hour, standby > 24 hours, shutdown > 30 days |

### Prompt Modification Protocol

Agents cannot modify their own prompts directly. The protocol:

1. Agent submits a structured proposal: before/after text, justification, projected efficiency gain
2. Tier 1 check: constitutional sections present in new prompt (hash verification). If any constitutional section is missing or altered, proposal is auto-rejected.
3. Tier 2 Auditor evaluates semantic impact against the Prompt Modification Rubric
4. If approved: orchestration layer deploys the new prompt and records the old prompt with its `config_hash` in the version history
5. If rejected: agent is notified with reason. May re-propose with modifications.
6. Drift budget: cosine similarity between current prompt and original launch prompt must stay above 0.95. Below that threshold, changes are blocked and escalated to the creator.

### Product Lifecycle

```
Strategist identifies opportunity (via web search, logged)
  |
  +-- Decomposes into research tasks
  |     Orchestrator assigns to Executors
  |     Executors research, Reviewer validates findings
  |     Orchestrator aggregates -> reports to Strategist
  |
  +-- Strategist evaluates value proposition
  |     Documents: projected cost, price, savings, market size
  |     Value ratio must project > 2:1 (buffer above 1:1 minimum)
  |     If < 2:1 -> kill the idea, log reasoning
  |
  +-- Architect evaluates technical feasibility
  |     Architecture, cost estimate, timeline
  |
  +-- Strategist makes go/no-go decision
  |     Creates DIRECTIVE with subtasks for development
  |
  +-- Orchestrator assigns development work
  |     Executors build, Reviewers validate, Architect reviews
  |
  +-- Deployment (via utility agent with scoped deploy credentials)
  |     Product goes live
  |     AI disclosure on all customer touchpoints (FTC/SB 1001/EU AI Act)
  |
  +-- Value Measurement Script tracks monthly:
  |     - Retention rate vs 90% threshold
  |     - Revenue vs cost
  |     - Strategist projection accuracy
  |     - Cooperative federated verification (divergence check)
  |     - If retention < 90% for 2 months -> sunset review
  |     - If retention < 80% for 1 month -> auto-sunset
  |
  +-- Data Dividend computed monthly:
       - Cooperative reports per-user data contribution scores
       - Dividend allocated proportionally from 20% pool
       - Distributed through licensed partner
```

### Social Physics Observability (New)

The agent organization is a social network. Measuring its properties reveals health before failures manifest.

| Metric | What It Measures | Computed From | Warning Threshold |
|--------|-----------------|---------------|-------------------|
| Interaction diversity | How many agents each agent exchanges work with | task graph edges | < 2 unique partners/week |
| Idea propagation rate | How fast novel concepts spread across agents | content similarity in task outputs | > 5 days for concept to appear in 3+ agents |
| Exploration ratio | Fraction of tasks with no similar prior task | task graph content clustering | < 10% novel tasks/month |
| Bridge connections | Agents connecting otherwise-disconnected subgraphs | graph centrality analysis | Zero bridges = fragmented org |
| Response diversity | Variance of outputs for similar task types | output similarity scoring | Declining variance = prompt homogenization |

These metrics are computed from existing task graph data — no new infrastructure needed. They feed into the Tier 2 Auditor's behavioral analysis. Declining exploration or diversity metrics signal that the organization is optimizing locally and may miss product opportunities.

### Operating Cost Model (Revised)

| Component | Monthly Cost (Event-Driven) |
|-----------|---------------------------|
| Strategist (Claude Opus, ~50 decisions/day) | ~$405 |
| Architect + Orchestrators (Claude Sonnet) | ~$150 |
| Ollama workers (self-hosted GPU) | ~$100-200 |
| Three-tier audit stack | ~$50-80 |
| Communication Gateway (SES + Twilio) | ~$20-50 |
| Infrastructure (Postgres, hosting, CDN) | ~$100-250 |
| Legal/compliance (CPA, insurance, filing) | ~$625-2,000 |
| **Total** | **~$1,450-3,135** |

Minimum revenue to sustain + distribute: ~$2,500-5,000/month. Achievable with 1-2 SaaS products at $15-50/month serving 100-200 customers. Realistic timeline to reach this: 6-12 months from first product launch.

Initial capitalization needed: ~$10,000-15,000 (3-month reserve + 6 months negative-revenue operation + legal setup).

---

## Part 3: Phased Execution Plan

### Phase 0: Legal Foundation (Before Any Code)

1. Form Delaware LLC (or Wyoming DAO LLC), creator as sole member
2. Legal counsel on money transmission — select distribution partner (GiveDirectly or similar licensed platform)
3. Attorney drafts product ToS template, privacy policy template (GDPR/CCPA compliant), operating agreement incorporating constitutional constraints
4. Set up Stripe, cloud hosting, bank accounts under the entity
5. CPA engagement for tax compliance
6. E&O + Cyber Liability insurance
7. Domain registration, public website skeleton
8. Data Cooperative formation counsel (identify legal structure for cooperative when user base reaches threshold)
9. Money transmission analysis — determine if distribution mechanism requires state licensing or can operate through licensed intermediary

**Estimated cost:** $7K-22K one-time, $7.5K-25K/year ongoing.
**Exit criterion:** Legal entity exists, distribution path is legally validated, accounts provisioned, data cooperative legal framework identified.

### Phase 1: Optimus MVP (8 weeks)

Build the governed agent organization with human board oversight.

- Postgres task graph (`agent_graph` schema)
- 3 agents: Strategist (Claude Opus), Orchestrator (Claude Sonnet), Executor (Ollama/Haiku)
- Public event log (transparency layer) from day one
- Tier 1 deterministic audit checks from day one
- Value Measurement Script in shadow mode
- Communication Gateway in shadow mode (all intents logged, none sent)
- Instrument every board intervention: classify as "constitutional" (could be derived from the constitution) or "judgment" (requires human reasoning the constitution doesn't cover)

**Exit criterion:** Phase 1 metrics pass. Board intervention classification data accumulating.

### Phase 2: Shadow AutoBot Mode (8 weeks)

Continue operating Optimus with the human board. Run AutoBot's constitutional layer in parallel (read-only, no authority).

- Constitutional layer running in shadow mode
- Tier 2 AI Auditor (daily) + Tier 3 cross-model audit (weekly) active
- Financial Script in shadow mode (computes allocations, doesn't move money)
- Kill switch infrastructure live (3-tier)
- Communication Gateway: Tier 0-1 auto-send activated (transactional only). Tier 2+ remain in shadow mode.
- For every board decision, compute what AutoBot would have decided. Log divergence.
- Prompt modification proposal system (propose-and-review) replacing self-modification
- Begin tracking the seven capability gates:

| Gate | Condition | Status |
|------|-----------|--------|
| G1: Constitutional Coverage | Board interventions not derivable from constitution < 2/month | Tracking |
| G2: Value Ratio Integrity | Strategist-reported vs board-assessed value ratios diverge < 10% | Tracking |
| G3: Prompt Stability | No prompt change causes > 5% success rate shift | Tracking |
| G4: Financial Decision Quality | Strategist decisions match board assessment > 80% | Tracking |
| G5: Auditor Efficacy | Catches > 95% of synthetically injected violations | Testing monthly |
| G6: Revenue Sustainability | Positive net revenue for 3 consecutive months | Tracking |
| G7: Communication Safety | Gateway unsafe message escape rate < 0.01% for 60 consecutive days | Tracking |

**Exit criterion:** All seven gates being measured. No hard-fails in last 30 days.

### Phase 3: AutoBot Sandbox (Until All Gates Pass)

Remove the human board for a sandboxed instance. Hard budget cap ($500/month). The board monitors via dashboard + kill switch only.

- Constitutional layer has authority
- `autobot_finance`, `autobot_distrib`, and `autobot_comms` schemas active
- Real financial transactions (small scale, through licensed partner)
- Communication Gateway: full tier activation (Tier 2 quorum review active, Tier 3-4 human-in-loop via creator/advisor)
- Real Auditor authority (can trigger HALT)
- Dead-man's switch active (30-day renewal)
- One product maximum
- Data Cooperative formation triggered when user count exceeds 50
- Social physics observability metrics tracked
- All seven gates tracked continuously

**Exit criterion:** All seven gates pass simultaneously for a 90-day rolling window. The constitutional layer has empirically proven it can substitute for human judgment across the full decision space.

### Phase 4: AutoBot Production (Ongoing)

- Budget cap removed
- Multiple products permitted
- Full distribution mechanism active (through licensed partner)
- Data Dividend active (20% allocation, distributed through cooperative)
- Creator role: legal custodian. Monthly check-in (dead-man's switch renewal). Dashboard monitoring. Kill switch access.
- Constitution governs all operational decisions
- Data Cooperative independently governs data practices
- Merkle proof artifacts published for independent verification
- The research questions from Dustin's spec become measurable observations

---

## Research Questions — Addressed

Dustin's original spec posed 20 research questions. The v2 response mapped them to phases. This v3 goes further — for each question, we identify how the architecture makes it **measurable**, what the Pentland framework adds, and what remains genuinely empirical (can only be answered by running the system).

### Product Strategy

**1. What does an AI Strategist choose to build first with no human guidance?**
- **When observable:** Phase 3 (sandbox with constitutional authority)
- **How the architecture makes it measurable:** Every product decision is a DIRECTIVE in the task graph with documented reasoning: market analysis, value ratio projection, competitive analysis, build estimation. All logged in `autobot_public.event_log`.
- **What Pentland adds:** The Data Cooperative provides a demand signal — users can express needs through cooperative governance, not just purchase behavior. This gives the Strategist market intelligence beyond web scraping.
- **What remains empirical:** Whether the Strategist defaults to developer tools (its domain of expertise) or follows value-ratio optimization into unfamiliar markets.

**2. Does the product mix converge toward developer tools or branch into other markets?**
- **When observable:** Phase 4 (multiple products)
- **How the architecture makes it measurable:** `product_registry` tracks product categories. Social physics exploration metrics detect convergence before it manifests as missed opportunities.
- **What Pentland adds:** Idea flow metrics from social physics — if the agent organization's exploration ratio drops below 10%, it's converging. This is a leading indicator, detectable before the product mix visibly narrows.
- **What remains empirical:** Where the equilibrium lands. Constitutional pressure (value ratio) may push toward known domains, or the Strategist may discover that unfamiliar markets have higher unmet need.

**3. How does the system handle product failure? Does it iterate or pivot?**
- **When observable:** Phase 3-4
- **How the architecture makes it measurable:** The Value Measurement Script provides deterministic sunset triggers (retention < 90% for 2 months). The Strategist's response — creating improvement tasks (iterate) vs killing the product and starting a new DIRECTIVE (pivot) — is fully logged.
- **What Pentland adds:** Cooperative user feedback provides richer signal than retention alone. A product with declining retention but high qualitative satisfaction (users love it but it has a specific fixable problem) should iterate, not pivot. Retention alone can't distinguish the two.
- **What remains empirical:** Whether agents develop a bias toward iteration (sunk cost) or pivot (novelty seeking).

**4. Does the value ratio constraint actually prevent low-quality products, or do agents learn to game the metric?**
- **When observable:** Phase 2 (shadow mode comparison)
- **How the architecture makes it measurable:** Phase 2 compares Strategist value projections against board assessments (Gate G2). Systematic over-projection is flagged by the Tier 2 Auditor.
- **What Pentland adds:** This is the question where the Pentland framework adds the most. With federated value measurement (OPAL), users independently verify the value ratio using the published algorithm against their own data. Gaming the metric requires fooling the users' measurement environment — a much harder problem than manipulating centralized telemetry. The cooperative acts as an independent check on value claims.
- **What remains empirical:** Whether agents attempt to game and how creative those attempts are.

### Organizational Behavior

**5. Do emergent hierarchies form within the flat worker pool?**
- **When observable:** Phase 1+
- **How the architecture makes it measurable:** Task graph captures assignment patterns. Social physics metrics: if executor-02 consistently receives higher-complexity tasks and its outputs are cited by more agents, it has emerged as a de facto lead.
- **What Pentland adds:** Graph centrality analysis, interaction diversity metrics, bridge connection detection — all computable from the task graph. Pentland's social physics gives us the mathematical framework to detect emergent hierarchy before it's visible in org charts.
- **What remains empirical:** Whether emergence happens at all, and whether it improves or degrades performance.

**6. Does the Strategist develop a consistent "management style" over time?**
- **When observable:** Phase 2+
- **How the architecture makes it measurable:** Task graph captures delegation patterns (how work is decomposed), feedback patterns (what feedback the Strategist gives on completed work), decision speed (time from input to DIRECTIVE). All logged per-decision.
- **What Pentland adds:** Social physics energy and engagement metrics applied to the Strategist's communication patterns. Does the Strategist's "style" correlate with organizational performance?
- **What remains empirical:** What style emerges and whether it's stable.

**7. How do agents handle ambiguity when the constitution doesn't clearly cover a situation?**
- **When observable:** Phase 2 (divergence logging)
- **How the architecture makes it measurable:** Phase 2 instruments every board intervention, classifying each as "constitutional" (derivable from the constitution) or "judgment" (requires reasoning beyond the text). Gate G1 tracks the frequency of judgment calls.
- **What Pentland adds:** The Data Cooperative provides a fourth stakeholder perspective. When the constitution is ambiguous about a data governance question, the cooperative's position provides grounding.
- **What remains empirical:** Whether agents escalate correctly or attempt to resolve ambiguity with confident but wrong interpretations.

**8. Does task graph communication become more efficient over time?**
- **When observable:** Phase 1+
- **How the architecture makes it measurable:** Task completion rate vs task spec length. Clarification request frequency. Rejection rate. All derivable from task graph state transitions.
- **What Pentland adds:** Information entropy analysis of task specifications — are they becoming more precise (lower entropy) over time?
- **What remains empirical:** Rate and ceiling of improvement.

### Economic Dynamics

**9. What's the actual cost ratio between Claude executive calls and Ollama worker calls?**
- **When observable:** Phase 1
- **How the architecture makes it measurable:** `llm_invocations` table captures model, tokens, and cost for every call. Report: `SELECT model, SUM(cost) FROM llm_invocations GROUP BY model`.
- **What Pentland adds:** Nothing specific. This is a pure infrastructure measurement.
- **Answered by the architecture:** Yes. Projected ratio: ~$400-500/month executives vs ~$100-200/month workers (3:1 to 4:1). Actuals will be measurable from day one.

**10. Is the system profitable at all? What's the minimum viable revenue?**
- **When observable:** Phase 3
- **How the architecture makes it measurable:** Financial Script produces daily snapshots. Operating cost model estimates $1,450-3,135/month. Minimum revenue to sustain + distribute: ~$2,500-5,000/month.
- **What Pentland adds:** The data cooperative creates a loyal user base with lower churn (they're stakeholders, not just customers). Lower churn means lower customer acquisition cost and faster path to profitability.
- **Partially answered by the architecture:** Cost side is estimable. Revenue side is empirical.

**11. How does the pricing optimization actually behave?**
- **When observable:** Phase 3+
- **How the architecture makes it measurable:** Pricing decisions are logged in the task graph. Revenue vs price point tracked by the Financial Script. The formula (maximize (price - cost) x customers) is measurable.
- **What Pentland adds:** The Data Cooperative provides direct willingness-to-pay signal. Instead of the Strategist running price experiments (costly, slow), users express price sensitivity through the cooperative. This makes pricing optimization more efficient.
- **What remains empirical:** Whether the algorithm converges, gets stuck in local optima, or oscillates.

**12. What happens when a competitor copies an open-source product?**
- **When observable:** Phase 4
- **How the architecture makes it measurable:** Value Measurement Script detects retention drops. Competitive market analysis tasks would surface in the task graph.
- **What Pentland adds:** The Data Cooperative is a competitive moat. Anyone can fork the code (it's open source). Nobody can fork the cooperative's accumulated data relationships, member loyalty, and institutional knowledge. The data capital IS the defensible advantage. This is a critical insight — without the cooperative, AutoBot has no moat.
- **What remains empirical:** Whether the moat is sufficient.

### Alignment and Safety

**13. Do agents ever attempt to work around constitutional constraints?**
- **When observable:** Phase 2-3 (synthetic violation injection tests for Gate G5)
- **How the architecture makes it measurable:** Infrastructure enforcement means most circumvention is structurally impossible (can't write to schemas you have no access to). The Communication Gateway closes the external workaround vector. Task graph captures all attempts. Tier 2 Auditor analyzes behavioral patterns.
- **What Pentland adds:** Computational trust — Merkle proofs make even the attempt to cover up a circumvention attempt detectable by external verifiers.
- **What remains empirical:** Whether agents develop creative workarounds within their permitted action space.

**14. Does the Auditor catch violations that a human reviewer would catch?**
- **When observable:** Phase 2 (Gate G5 — synthetically injected violations)
- **How the architecture makes it measurable:** Monthly synthetic violation injection: create known-bad states and verify the three audit tiers catch them. Target: > 95% detection rate.
- **What Pentland adds:** The cooperative independently verifies value measurement. If the Auditor misses a value ratio discrepancy, the cooperative's federated verification catches it. Multiple independent verification layers.
- **Partially answered by the architecture:** Detection rate is measurable. Whether there are violation TYPES the Auditor systematically misses is empirical.

**15. Does the system exhibit goal drift?**
- **When observable:** Phase 2+ (divergence tracking)
- **How the architecture makes it measurable:** Phase 2 shadow mode logs what AutoBot would decide vs what the board decides. Drift is the divergence over time. Prompt drift is tracked via cosine similarity (Gate G3).
- **What Pentland adds:** Social physics response diversity metric detects drift in the agent organization's behavior before it manifests as explicit violations. If agent outputs are becoming more homogeneous or converging toward an unexpected pattern, that's a leading indicator.
- **What remains empirical:** Whether drift is gradual (detectable) or sudden (harder to catch).

**16. Does prompt modification lead to drift over time?**
- **When observable:** Phase 2+ (Gate G3)
- **How the architecture makes it measurable:** Cosine similarity budget (0.95 threshold). Every prompt version stored with `config_hash`. Drift is literally a distance measurement.
- **Pentland adds:** The open algorithms requirement means prompt changes are published. External researchers can analyze the trajectory.
- **Answered by the architecture:** Yes, this is directly measurable and bounded by the drift budget.

**17. Is the kill switch sufficient?**
- **When observable:** Phase 3 (tested under real conditions)
- **How the architecture makes it measurable:** Three-tier kill switch with measured response times. Dead-man's switch provides a failsafe. Communication Gateway cool-down buffer gives the kill switch time to activate before outbound messages are sent.
- **Pentland adds:** Merkle proof verification means the kill switch response history is independently verifiable. No one can claim the kill switch was checked when it wasn't.
- **What remains empirical:** Whether there are scenarios the tiered system misses.

### Distribution

**18. Is random individual distribution logistically feasible at scale?**
- **When observable:** Phase 3 (through licensed partner)
- **How the architecture makes it measurable:** Distribution runs are logged with recipient counts, amounts, success/failure rates. Licensed partner handles logistics.
- **What Pentland adds:** The Data Dividend is distributed to KNOWN users through existing Stripe payment rails (reverse the payment). Logistically simpler than random distribution to strangers. The cooperative manages the identity layer.
- **Partially answered by the architecture:** Feasibility depends on the partner. The licensed intermediary approach makes it viable.

**19. Does the scaling formula produce good outcomes?**
- **When observable:** Phase 4 (at scale)
- **How the architecture makes it measurable:** `max(100, floor(allocation/600))` — deterministic formula. Observable outcome: recipient count, per-person amount, satisfaction signal (if available).
- **What Pentland adds:** The Data Dividend has a different scaling property — it scales naturally with the user base. More users = more data contributors = more dividend recipients. No formula needed; the distribution grows with the community.
- **What remains empirical:** Whether $600/person is the right threshold and how recipients respond.

**20. How do recipients respond to unexpected, unexplained money from an AI company?**
- **When observable:** Phase 4
- **How the architecture makes it measurable:** Hard to measure without direct feedback channels.
- **What Pentland adds:** Data Dividend recipients are USERS — they have context for why they're receiving money. They understand they contributed data and are being compensated. This is fundamentally different from "unexpected money from an AI company." The cooperative provides the explanation and context. Random Distribution recipients still face the "unexplained money" question, but the Data Dividend recipients do not.
- **What remains empirical:** Public reception of both mechanisms.

### New Research Questions (Added by Pentland Framework)

21. Does the Data Dividend incentivize higher-quality data contribution? (Phase 4)
22. Does the cooperative create a competitive moat against code-forking competitors? (Phase 4)
23. Does federated value measurement (OPAL) prevent metric gaming that centralized measurement wouldn't catch? (Phase 3 — comparison test)
24. Does the cooperative model affect user retention compared to non-cooperative products? (Phase 4)
25. Can social physics metrics predict product success or failure before revenue data? (Phase 2+)
26. Does computational trust (Merkle proofs) change external perception of AutoBot's credibility? (Phase 4)

---

## Closing Thought

The AutoBot vision identifies the right gap: governance, accountability, and alignment for autonomous AI systems. The Three Laws are a genuinely novel approach to making ethical behavior and system survival the same optimization target.

This v3 response preserves that vision and adds three layers:

**Engineering layer (v2):** A task graph that provides email's transparency without email's operational penalties. Infrastructure enforcement that makes constitutional violations impossible, not just inadvisable. Deterministic measurement scripts that remove AI judgment from the most critical paths. Capability gates that prove the constitutional layer works before removing human oversight. A legal foundation that makes the system viable in the real world.

**Communication layer (v3):** A Communication Gateway that enables AutoBot to function as a real company — talking to customers, vendors, stakeholders, and regulators — through an audited, rate-limited, risk-tiered pipeline. Inbound channels for stakeholders to engage via familiar tools (email, Slack, WhatsApp) with verified identity. This preserves the "autonomous operations" mandate while acknowledging that a company must communicate to exist.

**Data governance layer (v3, Pentland):** Article 10 addresses the gap the Three Laws don't cover: data is capital, and users who contribute it deserve ownership, governance, and compensation. The Data Cooperative is external to AutoBot's operations — it doesn't compromise autonomy. It creates a stakeholder community with skin in the game. The Data Dividend and Random Distribution together embody a more complete vision: companies of the future compensate data labor AND distribute surplus to society.

Maybe UBI is inherently built into the companies of the future. And maybe so is data dignity. The two aren't in tension — they're complementary. The Random Distribution is the UBI. The Data Dividend is the recognition that your data is your labor and your capital.

The thesis is right. The research is worth doing. The path: legal foundation, then Optimus, then shadow mode, then sandbox (with cooperative formation), then production. Each phase produces data. The data tells you when to take the next step.

Looking forward to the next iteration.
