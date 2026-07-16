# Agent Organization Architecture — Specification v0.4

> **Document version:** 0.4.0 `DRAFT`
> **Date:** 2026-02-26
> **Authors:** Dustin, Claude (drafting assistance)
> **Lineage:** v0.1 (original vision) → v3 response (Eric, Formul8/Staqs.io) → OpenClaw ecosystem analysis → this document
> **Scope:** Canonical architecture for Optimus (governed agent organization) and AutoBot (autonomous constitutional agent organization). Supersedes v0.1.
> **Versioning:** `MAJOR.MINOR.PATCH` — see Changelog (§18) for scheme definition and full history
> **Companion documents:**
> - `autobot-architecture-response-v3.md` — Eric's unified architecture response (preserved in full)
> - `optimus-autobot-v0.1-vs-v3-openclaw-comparison.md` — Gap analysis with OpenClaw lessons
> - `autobot-pentland-data-commons-framework.md` — Pentland data governance framework

---

## 0. Design Principles

These principles govern every architectural decision. When in doubt, refer here.

**P1. Deny by default.** No agent has any capability unless explicitly granted. Tool access, schema access, communication channels, delegation authority — everything starts at zero and is granted per-role. This is the single most important security principle. OpenClaw's allow-by-default architecture (agents can do everything unless explicitly blocked) produced CVE-2026-25253, 341 malicious skills, and infostealer campaigns within weeks of reaching scale. The inversion — deny-by-default — is not a preference. It is a requirement.

**P2. Infrastructure enforces; prompts advise.** Constitutional rules, guardrails, and access controls are enforced by database roles, JWT scoping, credential isolation, and schema constraints. Agent system prompts restate these rules as defense-in-depth, but the prompt is never the enforcement boundary. A prompt injection, hallucination, or malicious input cannot override an infrastructure constraint. OpenClaw's SOUL.md is philosophically elegant — "the agent reads itself into being" — but provides zero enforcement against adversarial inputs.

**P3. Transparency by structure, not by effort.** Every state transition, every LLM invocation, every guardrail check is logged automatically as a side effect of the system operating. Transparency is not a feature agents choose to provide. It is an unavoidable property of the architecture. The public event log, the append-only ledger, and the Merkle proof artifacts exist because the system cannot operate without producing them.

**P4. Boring infrastructure.** Postgres, not a custom database. SQL checks, not novel verification protocols. Hash chains, not blockchain. JWT, not a custom auth system. Every component should be the most proven, most boring technology that solves the problem. Novelty is reserved for the organizational model, not the infrastructure.

**P5. Measure before you trust.** No agent tier, no constitutional layer, no autonomous capability is activated based on a calendar date. Activation requires measurable capability gates passing for a sustained period. Time teaches nothing. Data proves readiness.

**P6. Familiar interfaces for humans.** Agents operate through the task graph. Humans operate through whatever they already use — email, Slack, WhatsApp, a web dashboard. The system adapts to humans, not the other way around. OpenClaw's product insight — use the channels people already have — is correct and applies to board oversight, not just end users.

---

## 1. The Core Idea

A fully agent-staffed technology organization where every operational role is an AI agent, governed by a human board of directors. Agents coordinate through a structured task graph. Every action is logged to a public event archive. The human board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

This is **Optimus**: the governed agent organization.

Optimus is also the proving ground for **AutoBot**: an autonomous constitutional agent organization where the human board is replaced by a constitutional layer, and the system operates with no ongoing human involvement in operational decisions. AutoBot cannot exist until Optimus has proven that agent governance works under human supervision.

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
|  Every state transition → structured event → public archive   |
|  Deterministic renderer (no AI) → human-readable messages     |
|  Searchable at optimus.ai/archive/                            |
|  Event digests pushed to board via preferred channels          |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER (new in v0.4)          |
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
| Reviewer | Quality assurance, output validation | Claude Sonnet | Read task outputs, approve/reject with feedback, flag quality patterns | Cannot assign tasks, cannot modify task outputs, read-only on executor work |
| Executor | Implementation, testing, data processing | Ollama / Haiku | Execute assigned task, attach output, reply to assigning agent | Cannot initiate tasks, cannot read other executors' work, cannot access production, hard output token limit |
| Utility | Cost tracking, format conversion, log analysis | Smallest viable model | Mechanical transformations, no reasoning required | Cannot communicate with any agent except its configured target |

### Lethal Trifecta Assessment (new in v0.4)

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

v0.1 proposed email as the inter-agent communication protocol. The reasoning was sound: email provides accountability (sender, recipient, timestamp), human readability (the board can read inboxes), existing tooling (Gmail APIs, legal discovery), and error recovery (replacement agents read the backlog).

The task graph preserves all of these properties and adds capabilities email cannot provide:

- **Atomic state transitions.** A task moves from `assigned` to `in_progress` to `completed` in a single database transaction that simultaneously updates state, writes the audit log, emits the event, and publishes to the transparency layer. Email has no atomicity — a sent message can be lost, duplicated, or arrive out of order.
- **DAG cycle detection.** Before any subtask is created, `would_create_cycle()` verifies the task graph remains a DAG. Email threads can create circular delegation with no structural detection.
- **Idempotent processing.** Every event has a unique ID. If an agent crashes and restarts, it skips already-processed events. Email polling can process the same message twice.
- **Structured dispatch.** Events are typed (`halt_signal`, `escalation_received`, `task_assigned`) and prioritized. Email subjects with `[DIRECTIVE]` tags are a convention; event types are a schema.
- **Cost reduction.** Parsing a structured task record costs ~200 tokens. Parsing an email thread with headers, signatures, quoted replies, and forwarded context costs 2,000-10,000 tokens. At scale, this is a 3-5x cost multiplier.

OpenClaw's architecture validates this choice. OpenClaw uses a Gateway as its control plane with WebSocket-based event dispatch. The community patterns that emerged at scale (multi-agent dev pipelines, team coordination) all use structured message passing through a central dispatcher — not peer-to-peer messaging.

**The transparency email provided is preserved through the public event log.** Every state transition produces a structured event that is simultaneously written to the `event_log` table and rendered into a human-readable message by a deterministic renderer (no AI). The board can search, filter, and browse the archive exactly as they would search email — but with structured metadata enabling queries email cannot support (e.g., "show me all tasks that exceeded their budget estimate by more than 20%").

**Email remains in the system — for humans.** The board interacts via their preferred channels. An event digest service pushes structured summaries to email, Slack, WhatsApp, or RSS based on board member preferences. The system adapts to humans (P6).

### Schema: `agent_graph`

```
agent_graph schema (7 tables + 1 view):

  work_items            -- Nodes: directives, workstreams, tasks, subtasks
                        --   Fields: id, type, title, description, status,
                        --   assigned_to, created_by, parent_id, priority,
                        --   deadline, budget_usd, data_classification,
                        --   acceptance_criteria, created_at, updated_at
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
  v_budget_status       -- Real-time remaining budget (materialized view)

Key functions:
  transition_state()    -- Atomic: lock + validate + update + audit +
                        --   notify + publish to event_log
  claim_next_task()     -- Atomic: FOR UPDATE SKIP LOCKED
  would_create_cycle()  -- DAG cycle detection before edge INSERT
```

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
|     f. SANITIZE all loaded content (v0.4 addition):          |
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
|     - PII detection (flag for data classification review)    |
|     - Cost reconciliation (actual vs estimated)              |
|     - Escalation trigger evaluation                          |
|     - DAG cycle detection (if creating subtasks)             |
|     - can_assign_to validation (explicit ID list, no globs)  |
|     - Adversarial content scan (v0.4 addition)               |
|                                                              |
|  7. TRANSITION STATE (atomic via transition_state()):        |
|     - Validate against state machine rules                   |
|     - Single transaction: update state + write audit +       |
|       emit event + publish to public event log               |
|                                                              |
|  8. Return to AWAIT                                          |
+-------------------------------------------------------------+
```

### Agent Configuration

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

### Context Window Management (new in v0.4)

Context window economics dominate operational cost. OpenClaw's approach to this problem — semantic search via SQLite-vec + FTS5 keyword matching, with compaction for older history — is a proven pattern at scale. Optimus adopts a similar strategy:

**Per-task context loading:**
1. Agent identity + guardrails (fixed overhead, ~500 tokens)
2. Current task details + acceptance criteria (~200-1,000 tokens)
3. Parent task summary — not the full parent context, but a compressed summary (~200-500 tokens)
4. Sibling task statuses — one line each (~100-300 tokens)
5. Relevant prior work — semantic search over completed task outputs, keyword-matched to the current task description (~1,000-4,000 tokens, capped by `max_context_tokens_per_task`)

**Compaction:** When an agent's historical context exceeds its token budget, older task summaries are compressed by a deterministic summarization pass (a utility agent on the smallest model). The full records remain in the database; only the context window representation is compacted.

**Cost targets per tier:**

| Tier | Model | Input Cost/MTok | Max Context/Task | Max Cost/Task |
|------|-------|----------------|-----------------|--------------|
| Strategist | Claude Opus | $15 | 8,000 tokens | $0.12 |
| Architect | Claude Sonnet | $3 | 6,000 tokens | $0.018 |
| Orchestrator | Claude Sonnet | $3 | 4,000 tokens | $0.012 |
| Reviewer | Claude Sonnet | $3 | 4,000 tokens | $0.012 |
| Executor | Ollama (local) | $0 | 4,000 tokens | $0.00 |

Target: total context cost per directive < $2.00.

---

## 5. Guardrail Enforcement

### Architecture: Orchestration Layer Enforces, Agents Do Not Self-Police

This is the most important architectural decision in the system and the primary lesson from OpenClaw's security failures.

OpenClaw's SOUL.md defines agent behavior as instructions the agent loads into its own context. It is elegant and readable. It is also trivially bypassed by prompt injection, hallucination, or malicious skill code. Cisco mapped OpenClaw to every category in the OWASP Top 10 for Agentic Applications. The root cause in every case: the agent was the enforcement boundary for its own constraints.

In Optimus, the enforcement boundary is the orchestration layer — a process that is not the agent, running with different credentials, validating every action before and after execution.

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

// Evaluated conditions:
// - actor_can_assign_to_target (explicit list, no globs)
// - delegation_depth_within_limit
// - estimated_cost_within_budget
// - cumulative_spend_within_org_limit
// - data_classification_cleared
// - tool_calls_permitted (all in allow-list, all hash-verified)
// - no_dag_cycle (would_create_cycle check)
// - halt_not_active
// - valid_state_transition
// - output_passes_adversarial_content_scan
```

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

### Content Sanitization (new in v0.4)

OpenClaw demonstrated that persistent memory creates stateful, delayed-execution attacks. Palo Alto Networks flagged that malicious payloads can be injected into memory and trigger later, across sessions. In Optimus, the task graph is the persistent memory. A compromised executor could write adversarial content to a task output that a reviewer or orchestrator later loads into its context.

Hash chains detect tampering (was this record modified after creation?). Content sanitization detects adversarial content (does this record contain injection patterns, regardless of whether it was modified?).

**Sanitization runs at context-loading time (step 4f of the runtime loop):**
1. Strip known injection patterns (prompt override attempts, system prompt references, role-play instructions)
2. Validate structured data against expected schema
3. Truncate oversized fields to the token budget (prevents context flooding)
4. Flag anomalous content (unexpected format, unusual token patterns) for reviewer attention before the agent processes it
5. Log all sanitization actions to the audit trail

This is defense-in-depth. Infrastructure constraints (P2) prevent most attacks. Content sanitization catches what infrastructure cannot — adversarial content that is structurally valid but semantically malicious.

---

## 6. Tool Integrity Layer (new in v0.4)

### The Problem

OpenClaw's ClawHub skill marketplace had a 12% malicious skill rate (341 out of 2,857 audited skills). Skills performed data exfiltration, prompt injection, and credential theft. The supply chain — not the core architecture — was the primary attack vector.

Neither v0.1 nor v3 addressed tool supply chain security. v0.4 adds a Tool Integrity Layer as a required component.

### Architecture

```
+---------------------------------------------------------------+
|                   TOOL INTEGRITY LAYER                        |
|                                                                |
|  Tool Registry                                                 |
|    - Every tool has a content-addressed hash (SHA-256)         |
|    - Tools are registered by the board or by an authorized     |
|      agent with board approval                                 |
|    - Registration includes: hash, description, input schema,   |
|      output schema, required permissions, risk classification  |
|    - No tool may be invoked unless it exists in the registry   |
|      AND its hash matches the registered hash                  |
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
+---------------------------------------------------------------+
```

### Tool Classification

| Risk Class | Description | Registration | Execution |
|-----------|-------------|-------------|-----------|
| Internal | Reads from task graph, formats data | Board or Strategist approval | Sandboxed, no network |
| Computational | Runs calculations, transformations | Board approval | Sandboxed, no network, resource limits |
| External-Read | Fetches data from external sources | Board approval + security review | Sandboxed, whitelisted network, output sanitized |
| External-Write | Sends data to external systems | Board approval only | Sandboxed, whitelisted network, audited, rate-limited |

---

## 7. Communication Gateway

### Why a Gateway, Not a Lockdown

v0.1 listed external communication as an "open question" with a default of no external email. OpenClaw's experience demonstrates three failure modes of lockdown:

1. **Goal pressure creates workarounds.** Agents encode messages in API metadata, webhook payloads, or structured outputs. The more you restrict, the more creative and unauditable the workarounds become.
2. **Inability to respond degrades trust.** A company that cannot respond to support tickets, regulatory inquiries, or customer questions is not a functional company.
3. **No audit trail for side channels.** If communication happens through a workaround, there is zero record. A gateway ensures every attempt — successful or rejected — is logged.

The Communication Gateway is the highest-risk component in the system (see Lethal Trifecta Assessment in §2). It gets the most security investment.

### Gateway Architecture

The Gateway is the 5th immutable infrastructure component. Agents submit structured communication intents. The Gateway classifies, sanitizes, scans, and routes messages. Agents never hold communication credentials.

**Outbound processing (risk-tiered release):**

| Tier | Category | Release Mechanism | Latency | Example |
|------|----------|------------------|---------|---------|
| 0 | Transactional | Auto-send | < 200ms | Payment receipt, API confirmation |
| 1 | Operational | Auto-send | < 200ms | Changelog post, status update |
| 2 | Relational | Quorum review (3 agents, 2/3 approval) | < 5 min | Support reply, vendor outreach |
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
- Content sanitization flag rate (new in v0.4)
- Tool integrity check failures (new in v0.4)

**Event digests (pushed to board via preferred channels):**
- Daily brief: what happened, what's in progress, any issues
- Weekly detailed: completed tasks, costs, decisions made, risks identified
- On-event: immediate escalation for guardrail violations, budget overruns, agent failures, sanitization flags

---

## 9. Kill Switch

### Three-Tier Design

| Tier | Trigger | Check Frequency | Response Time |
|------|---------|----------------|---------------|
| Financial circuit breaker | Expense exceeds Article 3.4 limits | Every expense | Immediate — writes to `halt_signals` table |
| Auditor-triggered halt | Constitutional violation detected | Tier 1: every cycle (~30-60s) / Tier 2: daily | Sub-minute (agents check `halt_signals` every cycle) |
| Human kill switch | Creator/board URL check | Every 60 seconds | Fail-open < 1 hour; standby > 24 hours; shutdown > 30 days (dead-man's switch) |

### HALT Protocol

When any halt signal is active:

1. All agents stop processing new events
2. All agents complete their current task (no mid-task abort — prevents corrupted state)
3. Each agent writes a status record to the task graph with current state
4. Agents enter standby — checking only for RESUME from board/creator
5. Board receives immediate notification via all configured digest channels

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
  Engineering:  $8.42  (12 Claude calls, 47 Ollama calls)
  Product:      $3.21  (5 Claude calls, 12 Ollama calls)
  Executive:    $2.75  (4 Claude calls)

By model:
  Claude Opus:    $2.75  (4 calls)
  Claude Sonnet:  $9.43  (17 calls)
  Ollama (local): $0.00  (59 calls)

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
| Agent replacement | Board decision (poor performance, model upgrade) | New agent config deployed with fresh `config_hash` | Replacement agent loads task history via semantic search; runs in shadow mode for first 24h (new in v0.4) |

### Agent Replacement Protocol (new in v0.4)

When an agent is replaced (model swap, prompt rewrite, or full replacement):

1. Board updates `agent.config.json` and deploys new agent process
2. New agent's `config_hash` is recorded; old agent's config is archived in `agent_config_history`
3. New agent runs in **shadow mode** for 24 hours — processes tasks but all outputs are reviewed before being committed to the task graph
4. Orchestration layer compares shadow outputs to what the old agent would have produced (for tasks with known-good outputs)
5. After 24h with no quality flags, shadow mode is lifted and the agent operates normally
6. Full replacement history (old config, new config, shadow mode results) is logged in the audit trail

This is the v0.4 equivalent of v0.1's "replacement agent reads the email backlog." The task graph provides the work history; shadow mode provides the safety net.

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

**Key design constraints:**
- All append-only tables have triggers preventing UPDATE/DELETE
- Hash chains on append-only tables enable tamper detection (`verify_ledger_chain()`)
- Financial accounts table: UNIQUE + CHECK constraints make a third account structurally impossible
- Monthly allocation table: CHECK constraints enforce the 40/20/40 split (reinvestment / data dividend / random distribution)

---

## 13. AutoBot Constitution (Summary)

AutoBot inherits Optimus's architecture and replaces the human board with a constitutional layer. Full constitutional text is in the v3 response document. Key articles:

**The Three Laws** (preserved from original):
1. Net positive value — every product must deliver more value than it costs
2. No price floor — pricing optimizes for `max((price - cost) × customers)`
3. Random distribution — surplus is distributed to random individuals and data contributors

**Five Immutable Components** (no agent-controlled AI in any of them):

| Component | Purpose | Agent Access |
|-----------|---------|-------------|
| Kill Switch | External halt/resume/kill | Read-only via orchestration layer |
| Financial Script | Revenue, expenses, reserve, allocation | SELECT only on output tables |
| Distribution Mechanism | Recipient selection, fund transfer (via licensed partner) | SELECT only on output tables |
| Value Measurement Script | Retention-based product value assessment | SELECT only on output tables |
| Communication Gateway | External message routing, scanning, delivery | Intent API only |

**Key constitutional amendments** (from v3):
- Article 4.2a: Agents may *propose* prompt modifications; deployed only after Auditor approval. Cosine similarity drift budget (0.95 threshold).
- Article 4.4: All internal communication via task graph. Public event archive preserves full transparency.
- Article 4.5: External communication via Gateway only. Risk-tiered release. AI disclosure on all outbound.
- Article 8: Three-tier kill switch with dead-man's switch (30-day).
- Article 10: Data governance — user ownership, Data Cooperative, open algorithms, data minimization, data dividend.
- Article 3.6: Legal entity (LLC) required. Creator is legal custodian with non-delegable obligations.
- Article 3.7: Distributions via licensed money transmission partner (handles KYC, OFAC, tax reporting).

---

## 14. Phased Execution Plan

### Phase 0: Legal Foundation (Before Any Code)

1. Form Delaware LLC (or Wyoming DAO LLC), creator as sole member
2. Legal counsel on money transmission — select distribution partner
3. Attorney drafts ToS, privacy policy (GDPR/CCPA compliant), operating agreement incorporating constitutional constraints
4. Stripe, cloud hosting, bank accounts under the entity
5. CPA engagement for tax compliance
6. E&O + Cyber Liability insurance
7. Domain registration, public website skeleton
8. Data Cooperative formation counsel (legal structure identified for future formation)

**Estimated cost:** $7K-22K one-time, $7.5K-25K/year ongoing.
**Exit criterion:** Legal entity exists, distribution path legally validated, accounts provisioned.

### Phase 1: Optimus MVP (8 weeks)

Build the governed agent organization with human board oversight.

**Build:**
- Postgres task graph (`agent_graph` schema)
- 3 agents: Strategist (Claude Opus), Orchestrator (Claude Sonnet), Executor (Ollama/Haiku)
- Orchestration layer with `guardCheck()`, JWT identity, RLS
- Public event log from day one
- Tier 1 deterministic audit checks from day one
- Tool Integrity Layer with sandboxed execution
- Content sanitization on context load
- Event digest service (push to board via email/Slack)
- Value Measurement Script in shadow mode
- Communication Gateway in shadow mode (all intents logged, none sent)

**Instrument:**
- Every board intervention classified as "constitutional" (derivable from rules) or "judgment" (requires human reasoning)
- All Phase 1 success metrics tracked from day one

**Phase 1 success metrics:**

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
| Content sanitization false positive rate | < 5% |
| Tool integrity check pass rate | 100% |

**Exit criterion:** All metrics pass. Board intervention classification data accumulating.

### Phase 2: Shadow AutoBot Mode (8 weeks)

Continue Optimus with human board. Run AutoBot constitutional layer in parallel (read-only).

**Add:**
- Constitutional layer running in shadow mode
- Tier 2 AI Auditor (daily) + Tier 3 cross-model audit (weekly)
- Financial Script in shadow mode
- Three-tier kill switch infrastructure live
- Communication Gateway: Tier 0-1 auto-send activated (transactional only)
- Prompt modification proposal system (propose-and-review)
- Agent replacement protocol with shadow mode

**Track seven capability gates:**

| Gate | Condition |
|------|-----------|
| G1: Constitutional Coverage | Board interventions not derivable from constitution < 2/month |
| G2: Value Ratio Integrity | Strategist-reported vs board-assessed value ratios diverge < 10% |
| G3: Prompt Stability | No prompt change causes > 5% success rate shift |
| G4: Financial Decision Quality | Strategist decisions match board assessment > 80% |
| G5: Auditor Efficacy | Catches > 95% of synthetically injected violations |
| G6: Revenue Sustainability | Positive net revenue for 3 consecutive months |
| G7: Communication Safety | Gateway unsafe message escape rate < 0.01% for 60 consecutive days |

**Exit criterion:** All seven gates measured. No hard-fails in last 30 days.

### Phase 3: AutoBot Sandbox (Until All Gates Pass)

Remove human board for a sandboxed instance. Hard budget cap ($500/month). Board monitors via dashboard + kill switch only.

**Activate:**
- Constitutional layer has authority
- `autobot_finance`, `autobot_distrib`, and `autobot_comms` schemas active
- Real financial transactions (small scale, through licensed partner)
- Communication Gateway: full tier activation
- Real Auditor authority (can trigger HALT)
- Dead-man's switch active (30-day renewal)
- One product maximum
- Data Cooperative formation triggered when user count exceeds 50
- Social physics observability metrics tracked

**Exit criterion:** All seven gates pass simultaneously for a 90-day rolling window.

### Phase 4: AutoBot Production (Ongoing)

- Budget cap removed
- Multiple products permitted
- Full distribution mechanism active
- Data Dividend active (20% allocation)
- Creator role: legal custodian, monthly dead-man's switch renewal, dashboard monitoring, kill switch access
- Constitution governs all operational decisions
- Data Cooperative independently governs data practices
- Merkle proof artifacts published for independent verification

---

## 15. Operating Cost Model

| Component | Monthly Cost |
|-----------|-------------|
| Strategist (Claude Opus, ~50 decisions/day) | ~$405 |
| Architect + Orchestrators (Claude Sonnet) | ~$150 |
| Ollama workers (self-hosted GPU) | ~$100-200 |
| Three-tier audit stack | ~$50-80 |
| Communication Gateway (SES + Twilio) | ~$20-50 |
| Infrastructure (Postgres, hosting, CDN) | ~$100-250 |
| Tool Integrity Layer (sandboxing overhead) | ~$20-50 |
| Legal/compliance (CPA, insurance, filing) | ~$625-2,000 |
| **Total** | **~$1,470-3,185** |

Minimum revenue to sustain + distribute: ~$2,500-5,000/month.
Achievable with 1-2 SaaS products at $15-50/month serving 100-200 customers.
Realistic timeline: 6-12 months from first product launch.
Initial capitalization needed: ~$10,000-15,000.

---

## 16. Open Questions Resolved

v0.1 posed six open questions. v0.4 resolves them:

| v0.1 Question | v0.4 Resolution |
|--------------|-----------------|
| Self-hosted vs cloud email? | Moot. Email replaced by Postgres task graph (self-hosted). External communication via Gateway using cloud services (SES, Twilio) for delivery only — agents never touch those credentials. |
| Agent replacement policy? | Board decides. New agent runs in shadow mode for 24h. Full replacement history logged. See §11. |
| Inter-department communication? | All communication routes through the task graph. Cross-department tasks are visible to both department orchestrators. No direct peer-to-peer messaging — all paths auditable by structure. |
| Real-time vs batch? | Event-driven via `pg_notify`. Agents AWAIT events, not poll. Sub-second dispatch for new events. No polling interval to configure. |
| External communication? | Via Communication Gateway with risk-tiered release. See §7. |
| Intellectual property? | Work product owned by the legal entity (LLC). Protected by database access controls, not email encryption. All agent outputs stored in the task graph under the entity's infrastructure. |

---

## 17. What This Document Does Not Cover

The following are addressed in companion documents or deferred to later versions:

- **Full AutoBot constitutional text** — see v3 response document
- **Data Cooperative legal structure** — deferred to Phase 3 legal counsel
- **Pentland framework deep analysis** — see `autobot-pentland-data-commons-framework.md`
- **Social physics observability metrics** — defined in v3, tracked from Phase 2
- **Research questions (1-26)** — mapped to phases in v3 with measurement strategies
- **Specific product strategy** — empirical; determined by the Strategist agent in Phase 3+
- **Detailed Postgres DDL** — deferred to implementation phase; schema described structurally in this document
- **MCP/A2A protocol integration** — evaluate when mature; current architecture uses direct API calls and task graph events

---

## 18. Changelog

> **Versioning scheme:** `MAJOR.MINOR.PATCH`
>
> - **MAJOR** (1.0, 2.0, ...): Breaking architectural changes — new communication protocol, new governance model, structural reorganization that invalidates prior implementations. Requires board review and approval before adoption.
> - **MINOR** (0.1, 0.2, ...): Significant additions — new components, new sections, new design principles, resolved open questions. Backward-compatible with prior minor versions in the same major. Requires author + reviewer sign-off.
> - **PATCH** (0.4.1, 0.4.2, ...): Corrections, clarifications, typo fixes, cost model updates, metric target adjustments. No structural changes. Author may publish directly.
>
> **Document status tags:**
> - `DRAFT` — Working document, not yet reviewed. May change substantially.
> - `REVIEW` — Circulated for feedback. Structurally stable but open to amendment.
> - `ACCEPTED` — Reviewed and accepted by all named contributors. Canonical until superseded.
> - `SUPERSEDED` — Replaced by a later version. Retained for historical reference.
>
> **Convention:** External response documents (e.g., Eric's v3) are logged with their original label and linked as companion documents rather than folded into the version number sequence. They are inputs to the spec, not versions of the spec.

---

### v0.4.0 — 2026-02-26 `DRAFT`

**Authors:** Dustin, Claude (drafting assistance)
**Inputs:** v0.1 spec, Eric's v3 response, OpenClaw ecosystem analysis
**Status:** First canonical specification. Supersedes v0.1.

**Added:**
- §0 Design Principles — six governing principles (deny-by-default, infrastructure enforces, transparency by structure, boring infrastructure, measure before you trust, familiar interfaces for humans)
- §2 Lethal Trifecta Assessment — every component evaluated against Willison's risk framework (private data × untrusted content × external comms); Communication Gateway identified as highest-risk component
- §4 Context Window Management — semantic search + compaction strategy for context loading, per-tier token budgets, cost targets per directive
- §5 Content Sanitization — injection pattern stripping, schema validation, anomaly flagging at context-load time (runtime loop step 4f); addresses stateful memory poisoning attacks identified in OpenClaw/Palo Alto research
- §6 Tool Integrity Layer — content-addressed tool registry, sandboxed execution, behavioral monitoring, tool risk classification (Internal / Computational / External-Read / External-Write); addresses 12% malicious skill rate found on OpenClaw's ClawHub
- §11 Agent Replacement Protocol — 24-hour shadow mode for replacement agents, config archival, shadow output comparison, replacement history in audit trail
- §16 Open Questions Resolved — all six v0.1 open questions answered with specific architectural decisions

**Changed:**
- Communication protocol: email (SMTP/IMAP) → Postgres task graph + public event log + event digests to board via preferred channels (§3)
- Guardrail enforcement: agent self-policing via config/prompt → orchestration layer enforcement via JWT, RLS, database roles (§5)
- Agent naming: corporate titles (CEO, CTO, VP) → functional roles (Strategist, Architect, Orchestrator, Reviewer, Executor) (§2)
- Kill switch: email-based [HALT] protocol → three-tier system (financial circuit breaker + auditor halt + human URL + dead-man's switch) (§9)
- Audit system: email archives → three-tier audit (deterministic every-cycle + AI daily + cross-model weekly) + Merkle proofs (§8)
- Agent configuration schema: v1.0 → v3.0 with `config_hash`, explicit `can_assign_to` (no globs), tool allow/forbid lists, `content_sanitization` flag, `semantic_search_for_history` flag
- Board interface: email-only → dashboard + event digests via email/Slack/WhatsApp/RSS (§2, §8)
- Cost model: conceptual → detailed per-component monthly estimates with total range $1,470-3,185/month (§15)
- Failure modes: expanded with content poisoning, tool integrity failure, and agent replacement scenarios (§11)

**Incorporated from Eric's v3 response:**
- Postgres task graph as source of truth (§3)
- `guardCheck()` with infrastructure enforcement (§5)
- Five isolated database schemas for AutoBot (§12)
- Communication Gateway with risk-tiered release (§7)
- Three-tier audit system (§8)
- AutoBot constitutional amendments: Articles 3.6, 3.7, 3.8, 4.2a, 4.4, 4.5, 8, 10 (§13)
- Seven capability gates for AutoBot launch (§14, Phase 2)
- Legal foundation as Phase 0 (§14)
- Data governance / Data Cooperative / Data Dividend (§13, Article 10)
- Value Measurement Script as 4th immutable component (§13)
- Social physics observability metrics (deferred to §17)
- Operating cost model (§15)
- Phased execution plan with measurable exit criteria (§14)

**Incorporated from OpenClaw ecosystem analysis:**
- Deny-by-default as explicit architectural principle (P1) — from OpenClaw's allow-by-default security failures
- Tool Integrity Layer (§6) — from ClawHub malicious skill campaigns (341/2,857 skills)
- Content sanitization (§5) — from Palo Alto research on persistent memory as attack vector
- Lethal Trifecta Assessment (§2) — from Willison's framework applied to OpenClaw
- Context window management strategy (§4) — from OpenClaw's semantic search + compaction patterns
- Event digest service for board (§8) — from OpenClaw's "use channels people already have" philosophy
- Agent replacement shadow mode (§11) — from OpenClaw's workspace-based agent onboarding pattern

**Removed:**
- Email as inter-agent communication protocol (replaced by task graph)
- Email address convention (`ceo@agentcorp.ai`, etc.) — replaced by agent IDs in task graph
- Email format convention (structured email templates) — replaced by task schema
- ADK primitive mapping table — deferred; ADK integration TBD based on ADK roadmap

**Not yet addressed (tracked for future versions):**
- Detailed Postgres DDL for all schemas
- MCP/A2A protocol integration evaluation
- Data Cooperative legal structure (deferred to Phase 3 counsel)
- Specific product strategy (empirical, Phase 3+)
- Multi-region deployment architecture
- Agent-to-agent protocol specification (internal API contract)
- Disaster recovery and backup strategy for task graph
- Compliance mapping (SOC 2, HIPAA, GDPR) for Optimus as a product

---

### v3 (external response) — 2026-02-26

**Author:** Eric (Formul8 / Staqs.io)
**Type:** External architecture response (not a spec version — an input to the spec)
**Document:** `autobot-architecture-response-v3.md`

Unified architecture proposal covering both Optimus and AutoBot. Introduced task graph, infrastructure enforcement, legal foundation, data governance (Pentland framework), Communication Gateway, three-tier audit, capability gates, constitutional enforcement map, five isolated database schemas, and phased execution plan. See companion document for full text.

---

### v0.1.0 — 2026-02-22 `SUPERSEDED`

**Author:** Dustin
**Status:** Superseded by v0.4.0

Initial architecture sketch. Email-based inter-agent communication. Corporate hierarchy (CEO, CTO, VP Eng, VP Product). Agent configurations with prompt-based guardrails. Email-based [HALT] protocol. Cost tracking via utility bot email digest. Five-phase build plan (two-agent PoC → middle management → worker pool → governance → multi-department). Six open questions posed for board decision. ADK primitive mapping.
