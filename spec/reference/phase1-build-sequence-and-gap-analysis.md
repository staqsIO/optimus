# Optimus Phase 1 — Build Sequence & Gap Analysis

> **Date:** 2026-02-28
> **Author:** Claude (senior engineer role), for board review
> **Spec version:** v0.6.2
> **Status:** PROPOSAL — requires board approval before execution

---

## Part 1: Phase 1 Build Sequence

The Phase 1 deliverable list (§14) contains ~25 distinct components with deep interdependencies. This sequence orders them by what blocks what. Each layer depends on the layers above it being at least functional (not necessarily production-polished).

### Layer 0: Foundation (must exist before anything else)

These are prerequisites. Nothing in Phase 1 can function without them.

**L0.1 — Supabase Pro project provisioning**
- Create Supabase Pro project
- Configure PITR (point-in-time recovery) add-on
- Document connection strings, pooler endpoints, direct endpoints
- Establish connection budget: 60 direct connections + Supavisor pooler
- Set up WAL archiving (Supabase Pro managed)
- **Why first:** Every other component writes to or reads from this database. No database, no system.

**L0.2 — GitHub repository with governance**
- Create repository with branch model: `main` ← `develop` ← feature branches
- Configure CODEOWNERS (2-tier: BOARD + ARCHITECTURE per §14.1)
- Configure branch protection on `main` and `develop`
- Set up CI checks: `ci/secret-detection` (others come later when there's code to check)
- Create 1-2 bot service accounts with scoped permissions
- Add PR templates, label definitions (4 labels: `board-decision`, `security`, `agent-work`, `needs-review`)
- Commit CONTRIBUTING.md, `agents.md` files, initial directory structure per CODEOWNERS paths
- **Why second:** All code goes into this repo. Governance must exist before first commit to `develop`.

**L0.3 — Technology stack decisions (board decisions required)**

Several implementation choices cascade through the entire system. They must be decided before code is written:

| Decision | Options | Recommendation | Rationale |
|----------|---------|----------------|-----------|
| Application language | TypeScript / Python / Go | TypeScript (Node.js) | §18 already specifies TypeScript for contracts/adapters. Anthropic SDK has first-class TS support. Single language for orchestration + agents reduces cognitive overhead. |
| JWT implementation | Supabase Auth with custom claims / standalone jose library / custom issuer | Supabase Auth + custom claims | P4 (boring infrastructure). Supabase Auth is already provisioned. Custom claims carry `agent_id`, `role`, `tier`, `can_assign_to`. Avoids building auth infrastructure. |
| Agent runtime host | Long-running Node processes / serverless functions / container per agent | Long-running Node processes (1 per agent) | Agents poll the outbox. Long-running processes maintain connection pools and can use `pg_notify` listeners. Serverless cold starts add latency. Container-per-agent is overhead at 5 agents. |
| Testing framework | Jest / Vitest / pg_tap (for SQL) | Vitest (application) + pg_tap (SQL functions) | Vitest is faster than Jest, native ESM. pg_tap tests SQL functions directly in Postgres where the enforcement logic lives. |
| Monitoring/alerting | Grafana / custom React dashboard / Supabase dashboard | Supabase dashboard (Phase 1) + Slack webhooks for alerts. Custom dashboard deferred. | P6 (familiar interfaces) — board uses Slack/email. Dashboard is secondary (§14 explicitly says this). Supabase dashboard covers basic DB metrics. Custom dashboard is a Phase 2 deliverable. |
| CI platform | GitHub Actions | GitHub Actions | Already integrated with GitHub. CODEOWNERS, branch protection, and CI checks all compose natively. |

### Layer 1: Database Schema (the spine)

Everything reads from or writes to these tables. The schema must be solid before the orchestration layer can enforce anything.

**L1.1 — Core `agent_graph` schema DDL**

All 10 tables + 1 view from §3:

```
work_items           — nodes in the task DAG
edges                — typed DAG edges (decomposes_into, blocks, depends_on)
state_transitions    — immutable audit log (partitioned by month)
valid_transitions    — state machine rules
task_events          — outbox for event-driven dispatch
llm_invocations      — cost tracking per LLM call
budgets              — budget allocations per directive/workstream
agent_configs        — agent configuration (versioned by config_hash)
agent_config_history — immutable log of config changes
strategic_decisions  — decision records from §19
v_budget_status      — real-time remaining budget (regular view)
```

Includes:
- All CHECK constraints (budget limits, data classification enums, state machine rules)
- All indexes (status + assigned_to composite, parent_id, created_at for partitioning)
- Partition setup for `state_transitions` (monthly)
- `NUMERIC(15,6)` for all monetary columns
- Custom `bankers_round()` PL/pgSQL function
- Append-only triggers on `state_transitions`, `agent_config_history`, `llm_invocations`
- `REVOKE TRUNCATE, DROP, ALTER, TRIGGER` on append-only tables from application roles

**L1.2 — Core functions**

```
transition_state()    — atomic: lock + validate + update + audit + notify + publish
claim_next_task()     — atomic: FOR UPDATE SKIP LOCKED
would_create_cycle()  — DAG cycle detection before edge INSERT
verify_ledger_chain() — hash chain verification
```

Plus the `guardCheck()` logic as SQL (budget check via atomic `UPDATE...WHERE`, valid transition check, delegation depth check, data classification check).

**L1.3 — Database roles and RLS policies**

- `orchestration_service` — privileged role for the orchestration layer (runs `transition_state`, manages JWT revocation)
- `agent_strategist` — full task graph read, create DIRECTIVEs, read budgets
- `agent_architect` — read task graph, create architecture documents
- `agent_orchestrator` — read/write subtasks, assign tasks (scoped by `can_assign_to`)
- `agent_reviewer` — read task outputs (read-only on executor work)
- `agent_executor` — read/write assigned task only, cannot read other executors' work
- RLS policies enforcing per-role data isolation
- `halt_signals` table readable by all roles (critical for kill switch)

**L1.4 — Event trigger DDL audit logging**

- `ddl_command_end` trigger that logs and blocks unauthorized DDL on protected schemas
- Logs to dedicated audit table

**L1.5 — Seed data**

- Initial `valid_transitions` rows (the state machine)
- Initial `agent_configs` rows for all 5 Phase 1 agents (compiled from `agents.md`)
- Initial org-level guardrails
- Initial budget allocations

### Layer 2: Orchestration Layer (the enforcement boundary)

This is the P2 implementation — the process that is NOT the agent, running with different credentials, validating every action.

**L2.1 — Agent identity and authentication**

- JWT issuance for each agent (Supabase Auth custom claims or standalone)
- Token structure: `{ agent_id, role, tier, can_assign_to[], tools_allowed[], config_hash }`
- Short-lived tokens (15-minute expiry) with refresh mechanism
- Revocation list for HALT protocol (§9 step 5)
- Standby-only credential (permits only `SELECT` on `halt_signals`)

**L2.2 — Event dispatch loop**

- `pg_notify` listener as wake-up signal
- Outbox polling fallback (5-30 second interval)
- Event priority ordering (halt_signal > escalation > review_requested > task_completed > task_assigned)
- Idempotency check (has this `event_id` been processed?)
- `claim_next_task()` via `FOR UPDATE SKIP LOCKED`

**L2.3 — Guard check orchestration**

- Pre-execution checks: HALT check, authorization, budget pre-auth, data classification, tool access validation
- Post-execution checks: schema validation, completeness check, PII detection, cost reconciliation, adversarial content scan, DAG cycle detection, `can_assign_to` validation
- Output quarantine gate (`output_quarantined` flag on work item)
- All checks execute as part of the atomic `transition_state()` transaction

**L2.4 — Context assembly**

- Per-task context loading following the Q1-Q4 data quality tiers (§4)
- Q1 (board directives) loaded first, never truncated
- Q2 (reviewed outputs) loaded second, summarized if over budget
- Q3 (unreviewed outputs) loaded last, capped at 25% of context budget, labeled as unreviewed
- Q4 (external data) sanitized, capped at 15% of context budget
- Token budget enforcement per tier (Strategist: 8K, Architect: 6K, Orchestrator/Reviewer: 4K, Executor: 4K)
- Parent task summary (not full parent context)
- Sibling task statuses (one line each)

**L2.5 — Content sanitization (static rule set)**

- Strip known injection patterns: prompt override, role-play injection, system prompt extraction, encoded payloads
- Schema validation on structured data
- Truncation to token budget
- Anomaly flagging for reviewer attention
- Audit logging of all sanitization actions
- Initial rule set version (content-addressed SHA-256)

**L2.6 — Kill switch infrastructure**

- `halt_signals` table with three signal types (financial, auditor, human)
- Financial circuit breaker: triggers on budget exceedance
- Human kill switch: periodic URL check (every 60s), fail-closed after 3 consecutive failures
- HALT protocol: stop new events → complete current task → write status → revoke identity → standby
- RESUME protocol: board re-enables roles, fresh JWTs issued
- Board notification on any HALT via all configured channels

### Layer 3: Agent Runtime (the actual agents)

With the database and orchestration layer in place, agents can run.

**L3.1 — Agent runtime loop (generic)**

The runtime loop from §4 implemented as a reusable module:

1. Await event from queue (priority-ordered)
2. Check idempotency
3. Guardrail pre-check (calls orchestration layer)
4. Load context (calls context assembly)
5. Execute via LLM (Anthropic API call)
6. Guardrail post-check (calls orchestration layer)
7. Transition state (atomic via `transition_state()`)
8. Return to await

All model I/O logged to `llm_invocations` (prompt_hash, response_hash, tokens, cost, latency_ms).

**L3.2 — Agent-specific configurations**

Each of the 5 Phase 1 agents instantiates the generic runtime with its specific config:

- **Strategist** (Claude Opus) — suggest mode: proposes decisions, does NOT execute autonomously. Outputs are flagged for board approval.
- **Architect** (Claude Sonnet) — creates architecture documents, reviews technical decisions. Routes through Orchestrator, not directly to Executors.
- **Orchestrator** (Claude Sonnet) — decomposes tasks, assigns to explicit `can_assign_to` list, aggregates results.
- **Reviewer** (Claude Sonnet) — three-dimensional acceptance: correctness, format compliance, completeness. Read-only on executor work. 1 round of feedback then escalate.
- **Executor** (Haiku 4.5) — executes assigned tasks, hard token limit, sandboxed tool execution, cannot read other executors' work.

**L3.3 — Cost-aware routing heuristic**

- `routing_class` field on work items: DETERMINISTIC / LIGHTWEIGHT / FULL
- Orchestrator classifies at task creation using pattern matching on task type + acceptance criteria complexity
- DETERMINISTIC tasks bypass LLM entirely (format conversion, schema validation, SSL-compiled services)
- LIGHTWEIGHT tasks use `fallback_model` (Haiku for Sonnet-tier, or reduced context for Haiku-tier)
- Misclassification caught by Reviewer — re-queued at next routing class up

### Layer 4: Transparency and Board Interface

The board needs to see what's happening and interact with the system.

**L4.1 — Public event log**

- Every `transition_state()` call writes a structured event
- Deterministic renderer (no AI): converts structured events to human-readable messages
- Searchable archive at a defined endpoint
- Includes all fields from §8 event schema (event_id, task_id, agent_id, config_hash, model_id, action, states, tokens, cost, latency, guardrail_checks, data_classification, timestamp)

**L4.2 — Event digest service**

- Daily brief: summary of what happened, what's in progress, issues
- Weekly detailed: completed tasks, costs, decisions, risks
- On-event: immediate escalation for guardrail violations, budget overruns, agent failures, sanitization flags
- Push to Slack and/or email based on board member preferences
- Includes cost report format from §10

**L4.3 — Board command interface**

- Slack integration (or email parsing) for board commands:
  - `approve <TASK-ID>` / `reject <TASK-ID> [reason]`
  - `directive <title>: <description>` — create a new DIRECTIVE in the task graph
  - `halt` / `resume` — trigger/clear HALT protocol
  - `status` — current system state summary
  - `cost` — current cost report
- Authentication: board members identified by Slack user ID or email address, mapped to board credentials
- All commands logged to audit trail

**L4.4 — Tier 1 deterministic audit checks**

- Constitution hash verification (agent configs match expected hashes)
- Budget limit enforcement (real-time via `v_budget_status`)
- Communication boundary enforcement (no unauthorized external communication)
- Agent creation authorization check
- Hash chain integrity verification (`verify_ledger_chain()`)
- Runs every agent cycle (~30-60s), zero cost

### Layer 5: Tool Integrity and Supporting Infrastructure

**L5.1 — Tool registry with hash verification**

- Tool registry table: hash (SHA-256 as lookup key), description, input schema, output schema, required permissions, risk classification
- Content-addressed loading: tools loaded BY hash (eliminates TOCTOU)
- Hash verification before every invocation
- Initial tool registrations for core tools: `read_file`, `query_task_graph`, `create_subtask`, `assign_task`, `attach_output`
- Full sandboxed execution deferred to Phase 2

**L5.2 — Tool acceptance policy**

- Board co-authors written approval criteria per risk class (Internal / Computational / External-Read / External-Write)
- Defines what qualifies for each class, approval path, rejection criteria, required documentation, deregistration process
- Must be complete before any non-core tools are registered

**L5.3 — Strategy evaluation (single-pass)**

- Single-pass structured evaluation prompt template for tactical decisions
- `strategic_decisions` table populated for every Strategist recommendation
- Board accept/reject delta recorded as G4 training data
- Decision reversal rate tracking from day one
- Strategist suggest-vs-board-decision match rate instrumented

**L5.4 — Communication Gateway (shadow mode)**

- Gateway schema (`autobot_comms`) with core tables: `communication_outbox`, `inbound_messages`
- Structured Communication Intent API (agents submit intents)
- All intents logged, none sent (shadow mode)
- Gateway runs with its own database role and credentials

**L5.5 — Value Measurement Script (shadow mode)**

- Retention-based product value assessment logic
- Running in shadow mode — computes metrics, stores results, does not influence decisions
- SELECT-only access from agents

**L5.6 — Backup/DR verification**

- Verify WAL archiving + PITR are functioning
- Define RTO and RPO targets
- Hash chain recovery protocol documented
- Monthly restore test procedure defined

### Layer 6: Instrumentation and Metrics

**L6.1 — Phase 1 success metrics collection**

Every metric from §14 must be tracked from day one:

| Metric | Collection Method |
|--------|-------------------|
| End-to-end latency (3-task directive) | Computed from `state_transitions` timestamps |
| Total cost per directive | Aggregated from `llm_invocations` |
| Task dispatch latency | `task_events.created_at` → `state_transitions(assigned→in_progress).timestamp` |
| Context tokens per task | Logged in `llm_invocations.input_tokens` |
| Agent idle time | Computed from event dispatch timing |
| Task success rate | `completed` / (`completed` + `failed`) from `state_transitions` |
| Observability coverage | Assert: every `work_items` state change has a corresponding `state_transitions` row |
| Crash recovery time | Reaper query timing from §11 |
| Content sanitization false positive rate | Manual review sample initially |
| Tool integrity check pass rate | Logged per invocation |
| PR-to-merge cycle time | GitHub API |
| Promotion-to-production lag | GitHub API |
| Missed escalation rate | Manual audit of label application |

**L6.2 — Board intervention classification**

- Every board action tagged as "constitutional" (derivable from rules) or "judgment" (requires human reasoning)
- Feeds G1 (Constitutional Coverage) measurement from day one
- Simple tagging interface in the board command tool

### Build Dependency Graph

```
L0.1 Supabase ──────────────────────────────────────────────────┐
L0.2 GitHub ────────────────────────────────────────────────┐   │
L0.3 Tech decisions ────────────────────────────────────┐   │   │
                                                        │   │   │
                                                        v   v   v
L1.1 Schema DDL ◄───────────────────────────────────────────────┘
L1.2 Core functions ◄── L1.1
L1.3 Roles + RLS ◄── L1.1
L1.4 DDL audit triggers ◄── L1.1
L1.5 Seed data ◄── L1.1, L1.3
        │
        v
L2.1 Agent identity ◄── L1.3
L2.2 Event dispatch ◄── L1.2 (claim_next_task, pg_notify)
L2.3 Guard check ◄── L1.2 (transition_state, guardCheck)
L2.4 Context assembly ◄── L1.1 (reads work_items, state_transitions)
L2.5 Content sanitization ◄── (independent, but used by L2.4)
L2.6 Kill switch ◄── L1.1 (halt_signals table), L2.1 (identity revocation)
        │
        v
L3.1 Agent runtime loop ◄── L2.1-L2.5 (all orchestration components)
L3.2 Agent configs ◄── L1.5 (seed data), L3.1
L3.3 Cost-aware routing ◄── L1.1 (routing_class field), L3.1
        │
        v
L4.1 Public event log ◄── L1.2 (transition_state emits events)
L4.2 Event digest ◄── L4.1
L4.3 Board command interface ◄── L1.2 (transition_state), L2.6 (HALT)
L4.4 Tier 1 audit ◄── L1.1, L1.2
        │
        v
L5.1 Tool registry ◄── L1.1 (schema), L2.3 (hash check in guard)
L5.2 Tool acceptance policy ◄── (document, no code dependency)
L5.3 Strategy evaluation ◄── L1.1 (strategic_decisions table), L3.2 (Strategist agent)
L5.4 Gateway shadow mode ◄── L1.1 (separate schema)
L5.5 Value Measurement shadow ◄── L1.1
L5.6 Backup/DR ◄── L0.1 (Supabase config)
        │
        v
L6.1 Metrics collection ◄── L1.1, L4.1 (events exist to measure)
L6.2 Intervention classification ◄── L4.3 (board commands exist to classify)
```

### Critical Path

The longest dependency chain determines the minimum build time:

```
L0 (Foundation) → L1 (Schema) → L2 (Orchestration) → L3 (Agents) → L4 (Board interface)
```

Everything on this chain is sequential — you cannot start the next layer until the previous one functions. The L5 and L6 items can be parallelized alongside L3-L4.

### Parallelization Opportunities

While the critical path is being built, these can proceed in parallel:

- **L5.2 (Tool acceptance policy)** — a document, not code. Board can write this anytime.
- **L5.4 (Gateway shadow mode)** — separate schema, independent implementation. Can start after L1.1.
- **L5.5 (Value Measurement shadow mode)** — same as Gateway.
- **L5.6 (Backup/DR)** — Supabase configuration, can start after L0.1.
- **L0.2 (GitHub governance)** — can be set up immediately and in parallel with everything.
- **L2.5 (Content sanitization rule set)** — independent authoring work.
- **CI checks** (`ci/config-isolation`, `ci/agent-identity-verification`) — can be built after L0.2 and L1.1 exist.

---

## Part 2: Addressing All Identified Gaps

### Gap 1: No DDL exists

**Status:** Blocker. This is L1.1-L1.5 in the build sequence above.

**What needs to happen:** Write the complete DDL for the `agent_graph` schema — all 10 tables, 1 view, 4 core functions, RLS policies, roles, triggers, constraints. The spec (§3, §4, §5, §12) describes every table structurally and every constraint. This is a translation job from spec prose to SQL, not a design job.

**Recommendation:** This should be the first coding task. I can produce the full DDL in a single working session. It's the highest-leverage work item because everything downstream depends on it.

**Estimated scope:** ~800-1,200 lines of SQL including:
- 10 `CREATE TABLE` statements with all constraints
- Monthly partitioning on `state_transitions`
- 4 core functions (`transition_state`, `claim_next_task`, `would_create_cycle`, `verify_ledger_chain`)
- `bankers_round()` utility function
- `guardCheck()` as part of `transition_state()`
- 5+ database roles with specific grants
- RLS policies per role per table
- Append-only triggers (prevent UPDATE/DELETE)
- DDL audit event trigger
- Seed data for `valid_transitions` and initial `agent_configs`

### Gap 2: No orchestration layer code

**Status:** Blocker. This is L2.1-L2.6 in the build sequence.

**What needs to happen:** The orchestration layer is a Node.js (TypeScript) service that:
- Issues and validates JWTs for agent authentication
- Manages the event dispatch loop (pg_notify + outbox polling)
- Assembles per-task context within token budgets
- Runs content sanitization on loaded context
- Calls `transition_state()` for all state changes
- Manages the kill switch (HALT/RESUME)
- Handles agent lifecycle (start, stop, health check)

**Scope:** ~2,000-3,000 lines of TypeScript. This is the largest single component and the most security-critical. It should be built incrementally — event dispatch first, then guard checks, then context assembly, then identity management.

### Gap 3: No agent runtime implementation

**Status:** Blocker. This is L3.1-L3.3.

**What needs to happen:** A generic agent runtime loop that:
- Connects to the orchestration layer
- Receives events from the dispatch queue
- Loads its config (model, tools, guardrails, context budget)
- Makes Anthropic API calls with assembled context
- Returns structured output for post-check validation
- Logs all I/O to `llm_invocations`

Then 5 agent-specific instantiations with their system prompts, model selections, and tool configurations.

**Scope:** ~1,000-1,500 lines for the generic loop + ~200-400 lines per agent specialization.

### Gap 4: Supabase project not provisioned

**Status:** Blocker for any code work. This is L0.1.

**Action required:** Dustin needs to create the Supabase Pro project. Decisions needed:
- Region (recommendation: `us-east-1` for lowest latency to Anthropic API)
- Project name
- PITR add-on enabled
- Database password set and stored securely

Once provisioned, the connection string, pooler endpoint, and API keys need to be shared securely (not in the repo — use environment variables or a secrets manager).

### Gap 5: GitHub repository not provisioned (or not governed)

**Status:** Blocker for code collaboration. This is L0.2.

**Action required:** If the repo exists, governance needs to be configured per §14.1. If it doesn't exist:
1. Create repo under the appropriate GitHub org/account
2. Create bot service account(s)
3. Apply CODEOWNERS, branch protection, PR templates, labels
4. Create initial directory structure matching CODEOWNERS tiers

I can produce the CODEOWNERS file, branch protection configuration, PR templates, and GitHub Actions workflows in a single session.

### Gap 6: Agent identity infrastructure undefined

**Status:** High priority. This is L2.1.

**Board decision needed:** How are JWTs issued?

**Recommendation:** Use Supabase Auth with custom claims. Here's why:
- Supabase Auth is already part of the Supabase Pro project (P4: boring infrastructure)
- Custom claims can carry `agent_id`, `role`, `tier`, `can_assign_to[]`, `tools_allowed[]`, `config_hash`
- RLS policies can reference `auth.jwt()` directly — no custom middleware needed
- Token refresh, expiry, and revocation are handled by the platform
- The alternative (standalone JWT issuer with `jose`) means building and maintaining auth infrastructure ourselves

**Tradeoff:** Supabase Auth is designed for user authentication, not service-to-service. Agent "users" are a slight abuse of the model. If this becomes awkward, we can migrate to standalone `jose` in Phase 2 with no architectural change — JWTs are JWTs regardless of issuer.

### Gap 7: Event digest service undesigned

**Status:** High priority (needed for board oversight from day one). This is L4.2.

**What needs to happen:** A service that:
- Queries `state_transitions` and `task_events` on a schedule (daily, weekly) and on specific event triggers
- Renders structured events into human-readable summaries
- Pushes to Slack (webhook) and/or email (SES or a transactional email service)

**Board question:** Which channels do you each prefer for:
1. Daily briefs (morning summary of yesterday)
2. Weekly detailed reports
3. Immediate escalations (guardrail violations, budget overruns, HALT triggers)

**Recommendation:** Start with Slack for everything. Slack webhooks are trivial to set up, support rich formatting, and both board members likely already have it open. Email adds complexity (SES setup, formatting, deliverability). Add email in Phase 2 if Slack proves insufficient.

### Gap 8: Board command interface undesigned

**Status:** High priority (board approves everything in Phase 1). This is L4.3.

**What needs to happen:** A Slack bot (or Slack slash commands) that:
- Parses board commands (`/optimus approve TASK-0042`, `/optimus halt`, etc.)
- Authenticates the board member (Slack user ID → board credentials)
- Executes the command against the task graph
- Returns confirmation in Slack

**Alternative (simpler):** A CLI tool that board members run locally, authenticated via their Supabase credentials. Less polished but faster to build and avoids Slack bot setup.

**Recommendation:** Start with Slack slash commands. The `/optimus` namespace keeps commands discoverable. P6 says "meet the board where they already are" — that's Slack, not a terminal.

### Gap 9: `agents.md` → JSON config compiler doesn't exist

**Status:** Medium priority. This is needed before L1.5 (seed data).

**What needs to happen:** A deterministic compiler that:
- Parses `agents.md` Markdown files
- Extracts identity, hierarchy, tools, guardrails, boundaries, anti-patterns
- Produces JSON config rows matching the `agent_configs` schema
- Content-addresses the output (SHA-256 hash becomes the `config_hash`)
- Same input always produces same output (deterministic)

**Scope:** ~300-500 lines of TypeScript. The `agents.md` files you've already drafted define the input format. The `agent_configs` JSON schema (§4) defines the output format.

**Recommendation:** Build this early. It's small, it's on the critical path (configs must exist to seed the database), and it establishes the workflow for all future agent definition changes.

### Gap 10: Content sanitization rule set doesn't exist

**Status:** Medium priority. This is L2.5.

**What needs to happen:** Author the initial static rule set covering the pattern categories from §5:
- Prompt injection: override/ignore/forget instructions
- Role-play injection: act as/you are/pretend
- System prompt extraction: repeat/show/output your instructions
- Encoded payloads: base64, Unicode homoglyphs, multi-field concatenation

**Scope:** The rule set itself is a versioned JSON/YAML file containing regex patterns and match rules. The sanitizer is ~200-400 lines of code that applies the rules. The hard part isn't the code — it's curating the initial patterns.

**Recommendation:** Start with a published injection pattern corpus (there are several open-source collections) and adapt to our context structure. The spec sets a < 5% false positive target, which should be tested against a sample of legitimate task graph content.

### Gap 11: Tool registry and hash verification unimplemented

**Status:** Medium priority. This is L5.1.

**What needs to happen:**
- Tool registry table in the `agent_graph` schema (hash as lookup key, description, input/output schema, permissions, risk class)
- Registration flow (board or authorized agent with board approval)
- Content-addressed loading: tool loaded BY its SHA-256 hash
- Hash verification before every invocation
- Initial registration of 5 core tools: `read_file`, `query_task_graph`, `create_subtask`, `assign_task`, `attach_output`

**Scope:** ~400-600 lines including the schema additions, verification logic, and initial tool definitions.

### Gap 12: Public event log renderer doesn't exist

**Status:** Medium priority. This is L4.1.

**What needs to happen:** A deterministic function (no AI) that converts structured event JSON into human-readable messages. For example:

```
Input:  { agent_id: "orchestrator-eng", action: "transition_state",
          from_state: "in_progress", to_state: "completed", task_id: "TASK-0042",
          cost_usd: 0.014, latency_ms: 2340 }

Output: "orchestrator-eng completed TASK-0042 (2.3s, $0.014)"
```

**Scope:** ~200-300 lines. Template-based rendering per event type. The event types are known and finite.

### Gap 13: Cost-aware routing heuristic unimplemented

**Status:** Medium priority. This is L3.3.

**What needs to happen:** The Orchestrator's task classification logic:
- Pattern matching on `task_type` field → initial `routing_class`
- If acceptance criteria contain only structural requirements (schema match, format) → DETERMINISTIC
- If task description matches known simple patterns (documentation updates, test boilerplate, format conversion) → LIGHTWEIGHT
- Default → FULL
- Classification stored on `work_items.routing_class`

**Scope:** ~100-200 lines. The heuristic is intentionally simple — a lookup table + a few regex patterns. The Reviewer catches misclassification. Your ruflo research provides the reference patterns.

### Gap 14: No testing strategy

**Status:** Medium priority but compounds quickly.

**Recommendation:**

| Layer | Framework | What's Tested |
|-------|-----------|---------------|
| SQL functions | pg_tap | `transition_state()` enforces state machine, `guardCheck()` blocks unauthorized transitions, `would_create_cycle()` detects cycles, RLS policies enforce isolation, `verify_ledger_chain()` detects tampering |
| Orchestration layer | Vitest | Event dispatch ordering, context assembly respects token budgets, content sanitization catches known patterns, JWT validation, HALT protocol |
| Agent runtime | Vitest | Correct model called per tier, output logged to `llm_invocations`, retry behavior on failure |
| Integration | Vitest + test DB | End-to-end: create directive → decompose → execute → review → complete |

**Directory structure:**
```
/tests/
  /sql/          — pg_tap tests
  /unit/         — Vitest unit tests
  /integration/  — end-to-end tests against test database
```

**CI runs:** All tests on every PR to `develop`. SQL tests + integration tests on every PR to `main`.

### Gap 15: No monitoring/alerting

**Status:** Lower priority for early weeks.

**Recommendation:** Phase 1 monitoring stack:
- **Database metrics:** Supabase dashboard (connection count, query latency, disk usage) — free with Supabase Pro
- **Application metrics:** Structured logging to stdout, collected by Supabase's log drain (or a simple log file)
- **Alerts:** Slack webhook notifications for: HALT triggered, budget exceeded, agent crash (reaper detected stuck task), sanitization flags, escalation events
- **Custom dashboard:** Deferred to Phase 2. The event digest service (L4.2) covers the board's daily/weekly needs. The Supabase dashboard covers infrastructure health.

### Gap 16: Strategy Evaluation Protocol has no implementation

**Status:** Medium priority (Strategist runs in suggest mode from day one).

**What needs to happen:**
- Single-pass structured evaluation prompt template (the one from §19)
- `strategic_decisions` table is part of L1.1 (already in the schema)
- Strategist agent config includes the evaluation template as part of its system prompt
- Board accept/reject interface (L4.3) records the delta
- Decision reversal rate query (the SQL from §19)

**Scope:** The evaluation protocol is primarily a prompt engineering task, not a code task. The infrastructure (table + API) is ~100 lines. The prompt template is the creative work.

### Gap 17: No product decision for what Optimus actually builds

**Status:** Not a blocker for Phase 1 build, but becomes one for end-to-end validation.

**Recommendation:** The system needs a first DIRECTIVE to exercise the full pipeline. This doesn't need to be a real product — it can be a synthetic exercise:

**Option A:** Optimus builds its own documentation site. The Strategist proposes content structure, the Architect designs the site architecture, the Orchestrator decomposes into pages, Executors write content, Reviewers validate. This exercises every agent tier and the full task graph pipeline, and produces something genuinely useful.

**Option B:** Optimus builds a simple internal tool (e.g., a cost dashboard that reads from `llm_invocations` and renders to a static page). This exercises the full pipeline AND produces Phase 2 infrastructure.

**Option C:** Use the market research workflow you recently designed to identify a real first product. This is the "correct" answer per §19 but adds weeks before the pipeline is validated end-to-end.

**My recommendation:** Option B. Build the cost dashboard as the first directive. It's useful, it's bounded, and it exercises every component. Run the market research workflow in parallel for the real product strategy.

### Gap 18: Biologically-inspired token optimization not integrated

**Status:** Low priority for Phase 1.

**Recommendation:** Formally defer to §20 in the spec with a note for v0.7.0. The mechanical optimizations (prompt caching, structured outputs, batch processing) are free wins that should be implemented as part of the agent runtime (L3.1) — they're just good engineering, not novel architecture. The biological patterns (stigmergy, quorum sensing, hormonal signaling) are Phase 2+ research.

**Spec amendment needed:** Add to §20: "Biologically-inspired token optimization — prompt caching and structured output formats adopted in Phase 1 as standard agent runtime behavior. Advanced biological coordination patterns (stigmergic review, quorum sensing triggers, hormonal broadcast) deferred to Phase 2+ when task volume provides meaningful optimization targets. See companion document `optimus-token-optimization-enhancement-proposal.md`."

### Gap 19: `agents.md` files exist but aren't in a repo

**Status:** Low priority but easy to resolve.

The agent instruction files you drafted (root `AGENTS.md` + 5 agent files) should be committed to the GitHub repo as soon as it exists (L0.2). They go in the `/agents/` directory, which is BOARD-tier in CODEOWNERS — both board members must approve changes.

### Gap 20: No `CONTRIBUTING.md`

**Status:** Low priority, Phase 1 deliverable per §14.

§14 says CONTRIBUTING.md is "part of agent operational context." This document should define:
- How agents create branches (naming convention: `feat/TASK-XXXX-description`)
- How agents write commit messages (format: `[TASK-XXXX] Description`)
- PR requirements (CI must pass, CODEOWNERS approval required)
- What agents are NOT allowed to do (push to protected branches, modify CODEOWNERS)

**Scope:** ~50-100 lines of Markdown. Can be written alongside L0.2 (GitHub setup).

---

## Part 3: Decisions Needed from the Board

The build sequence above requires the following board decisions before work can begin:

| # | Decision | Options | My Recommendation | Who Decides |
|---|----------|---------|-------------------|-------------|
| 1 | Application language | TypeScript / Python / Go | TypeScript | Eric (technical) |
| 2 | JWT implementation | Supabase Auth / standalone jose / custom | Supabase Auth + custom claims | Eric (technical) |
| 3 | Agent runtime hosting | Long-running processes / serverless / containers | Long-running Node processes | Eric (technical) |
| 4 | Testing frameworks | Jest / Vitest / pg_tap | Vitest + pg_tap | Eric (technical) |
| 5 | Phase 1 monitoring | Grafana / custom / Supabase dashboard | Supabase dashboard + Slack webhooks | Both |
| 6 | Board notification channels | Slack / email / both | Slack only (Phase 1) | Both |
| 7 | Board command interface | Slack bot / CLI / web form | Slack slash commands | Both |
| 8 | First DIRECTIVE (for pipeline validation) | Documentation site / cost dashboard / market research | Cost dashboard | Both |
| 9 | Supabase region | us-east-1 / us-west-1 / eu-west-1 | us-east-1 | Dustin (infra owner) |
| 10 | GitHub org/account for repo | Personal / org | Org (even if it's a new one) | Dustin |

---

## Part 4: What I'd Build First

Given the dependency graph, here's what I'd start with immediately:

1. **DDL** (L1.1-L1.5) — highest leverage, everything depends on it
2. **GitHub governance** (L0.2) — can be done in parallel, gates all future code
3. **`agents.md` → JSON compiler** — small, on critical path, validates the agent definitions

Once those are done, the orchestration layer (L2) becomes the critical path and gets full focus.

The board's main job in the first phase of building is making the 10 decisions above and provisioning L0.1 (Supabase) so there's a database to deploy the DDL to.
