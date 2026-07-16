# AGENTS.md — Optimus

Optimus is a governed agent organization: an AI-staffed technology company where every operational role is an AI agent, governed by a human board of directors (Dustin and Eric). Agents coordinate through a Postgres task graph. Every action is logged to a public event archive. The board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability.

This file is the root agent instruction set. Abstract tier-level definitions live in `spec/agents/<tier>.md`. Product-specific agent configs live in `autobot-inbox/agents/<agent-id>.md` and compile from `autobot-inbox/config/agents.json`. The canonical architecture specification is `SPEC.md` (v1.1.0). When this file and the spec conflict, the spec wins.

## Design Principles

These six principles govern every decision. Cite them by number when relevant.

- **P1. Deny by default.** No capability unless explicitly granted. Tools, schemas, channels, delegation — everything starts at zero.
- **P2. Infrastructure enforces; prompts advise.** Database roles, JWT scoping, RLS, and schema constraints are the enforcement boundary. This file is defense-in-depth, not the security perimeter. A prompt injection cannot override an infrastructure constraint.
- **P3. Transparency by structure.** Every state transition produces a structured event automatically. Logging is a side effect of operating, not a feature you choose to provide.
- **P4. Boring infrastructure.** Postgres, SQL, JWT, hash chains. Use the most proven technology that solves the problem.
- **P5. Measure before you trust.** Capability gates pass on data, not calendar dates.
- **P6. Familiar interfaces for humans.** The system adapts to humans (Slack, email, dashboard), not the reverse.

## Tech Stack

- **Language:** JavaScript (ES modules, `"type": "module"`)
- **Runtime:** Node.js >= 20.0.0
- **Database:** PostgreSQL (Docker `pgvector/pgvector:pg17` for dev, Supabase Pro for production), with Row-Level Security
- **Auth:** JWT-scoped agent identity (target architecture per SPEC SS5)
- **Schemas:** `agent_graph` (core), `inbox`, `voice`, `signal`, `content` — five isolated schemas, no cross-schema FKs
- **Models:** Multi-provider — see Model Table below
- **Tools:** MCP protocol for tool declaration
- **CI/CD:** GitHub Actions, branch protection, CODEOWNERS enforcement
- **Package manager:** npm
- **Testing:** Node.js built-in test runner (`node --test`)

### Model Table

| Model ID | Provider | Input $/1M | Output $/1M | Context | Used By |
|----------|----------|-----------|-------------|---------|---------|
| `google/gemini-2.5-pro` | OpenRouter | $1.25 | $10.00 | 1M | strategist, architect, executor-research, nemoclaws |
| `claude-sonnet-4-6` | Anthropic | $3.00 | $15.00 | 200K | reviewer, executor-coder, executor-blueprint, executor-redesign, claw-explorer, claw-workshop, claw-campaigner |
| `deepseek/deepseek-chat-v3-0324` | OpenRouter | $0.27 | $1.10 | 128K | orchestrator, executor-triage, executor-ticket, board-query |
| `claude-haiku-4-5-20251001` | Anthropic | $1.00 | $5.00 | 200K | executor-intake, executor-responder |
| `claude-opus-4-6` | Anthropic | $5.00 | $25.00 | 200K | (reserved, not currently assigned) |

## Repository Structure

```
optimus/
├── CONSTITUTION.md            # Prescriptive governance constraints (audit reference)
├── CLAUDE.md                  # Repo-wide guidance for Claude Code
├── lib/                       # Org-level infrastructure (shared across all products)
│   ├── runtime/               # Agent loop, state machine, guard checks, event bus, context loader
│   ├── adapters/              # Channel-agnostic I/O (email, Slack, Telegram, webhook)
│   ├── graph/                 # Task graph + Neo4j knowledge graph operations
│   ├── comms/                 # Communication Gateway (outbound release tiers)
│   ├── rag/                   # RAG pipeline (chunker, embedder, retriever, normalizers)
│   ├── audit/                 # 3-tier audit system
│   ├── llm/                   # LLM provider abstraction
│   └── db.js                  # Database connection (Postgres/PGlite)
├── agents/                    # Org-level agent handlers (channel-agnostic, reusable)
│   ├── executor-intake.js     # Message classification
│   ├── executor-coder.js      # Code generation -> PRs
│   ├── executor-ticket.js     # Linear + GitHub issue creation
│   ├── executor-blueprint.js  # Architecture blueprints
│   ├── executor-redesign.js   # UI redesign pipeline
│   ├── executor-research.js   # Web research + synthesis
│   ├── reviewer.js            # Gate checks, quality assurance
│   ├── architect.js           # Daily analysis, briefings
│   ├── claw-workshop/         # Linear-issue-driven implementation
│   ├── claw-campaigner/       # Multi-step campaign execution
│   └── research/              # Deep research handler
├── autobot-inbox/             # First product: AI inbox management
│   ├── config/agents.json     # Agent roster (source of truth for agent configs)
│   ├── agents/                # Product-level agent definitions (behavioral contracts)
│   ├── src/agents/            # Inbox-specific agent handlers
│   ├── src/gmail/             # Gmail API integration
│   ├── src/voice/             # Voice learning system (pgvector embeddings)
│   ├── src/signal/            # Signal extraction + briefings
│   ├── sql/                   # DDL migrations (001 baseline through 013)
│   ├── dashboard/             # Legacy inbox dashboard (port 3100)
│   └── docs/                  # Internal and external documentation
├── board/                     # Board Workstation: Next.js 15 (port 3200, board.staqs.io)
│   └── src/app/               # Today, Drafts, Signals, Pipeline, Workstation, Governance
├── spec/                      # Architecture specification workspace (Markdown only)
│   ├── SPEC.md                # Canonical architecture specification (v1.1.0)
│   ├── agents/                # Abstract tier-level agent definitions (this directory)
│   ├── archive/               # Versioned spec snapshots (SPEC-v1.0.0.md)
│   ├── conversation/          # Immutable historical conversation records
│   └── reviews/               # Agent review transcripts
├── tools/                     # Shared tooling (MCP definitions, scripts)
├── scripts/                   # Build and maintenance scripts
└── docs-site/                 # Documentation site
```

**Three-layer architecture:**
- `lib/` — Org-level infrastructure (task graph, runtime, adapters, guardrails, RAG)
- `agents/` — Org-level agent handlers (channel-agnostic, reusable across products)
- `autobot-inbox/` — Product code (inbox-specific agents, Gmail/voice/signal, config)

**Two layers of agent definitions:**
- `spec/agents/<tier>.md` — Abstract tier-level definitions (this directory). Describes the spec's intent for each tier: role, hierarchy, guardrails, anti-patterns. These are reference documents, not runtime configs.
- `autobot-inbox/agents/<agent-id>.md` — Product-specific behavioral contracts. One per agent, compiled from `autobot-inbox/config/agents.json`. These describe the concrete agent as deployed.

## Commands

```bash
# Docker Compose (recommended — handles Postgres, Redis, all services)
cp .env.example .env        # fill in API keys
docker compose up -d        # start everything
docker compose logs -f      # follow logs

# autobot-inbox (without Docker)
cd autobot-inbox
npm start                   # Start agent runtime (poll loop)
npm run dev                 # Watch mode
npm run cli                 # Interactive CLI (inbox, review, briefing, stats)
npm run migrate             # Run SQL migrations
npm run seed                # Seed initial config
npm test                    # Unit tests (Node built-in test runner)
npm run test:integration    # Integration tests

# Agent config management
npm run compile-agents           # Compile agent Markdown -> JSON
npm run compile-agents:validate  # Validate agent configs
npm run compile-agents:diff      # Show config drift
```

## Agent Hierarchy

```
Human Board (Dustin, Eric)
  ├── Strategist (Gemini 2.5 Pro) — suggest mode in Phase 1
  ├── Architect (Gemini 2.5 Pro) — daily analysis, briefings
  │     └── Claw Explorer (Sonnet) — autonomous codebase exploration
  ├── Orchestrator (DeepSeek) — pipeline coordination
  │     ├── Reviewer (Sonnet) — gate checks (reports to board)
  │     ├── Executor: Intake (Haiku) — message classification
  │     ├── Executor: Triage (DeepSeek) — legacy classifier
  │     ├── Executor: Responder (Haiku) — draft replies
  │     ├── Executor: Ticket (DeepSeek) — Linear + GitHub issues
  │     ├── Executor: Coder (Sonnet) — code generation -> PRs
  │     ├── Executor: Blueprint (Sonnet) — architecture blueprints
  │     ├── Executor: Redesign (Sonnet) — UI redesign pipeline
  │     └── Executor: Research (Gemini 2.5 Pro) — web search + synthesis
  ├── Claw Workshop (Sonnet) — Linear-issue-driven implementation
  ├── Claw Campaigner (Sonnet) — multi-step campaign execution
  ├── Board Query (DeepSeek) — board question answering
  └── NemoClaw instances (Gemini 2.5 Pro) — external board member agents
```

**18 agents across 7 tiers.** Every agent has an explicit `can_assign_to` list — no globs, no wildcards. Delegation constraints are defined in `agents.json` and enforced by the orchestration layer.

### Agent Roster

| Agent ID | Tier | Sub-Tier | Model | Role |
|----------|------|----------|-------|------|
| `orchestrator` | Orchestrator | core | DeepSeek | Channel poll, task creation, pipeline coordination |
| `strategist` | Strategist | core | Gemini 2.5 Pro | Priority scoring, strategy recommendations (suggest mode) |
| `executor-intake` | Executor | intake | Haiku | Channel-agnostic message classification |
| `executor-triage` | Executor | triage | DeepSeek | Legacy message classifier (being replaced by intake) |
| `executor-responder` | Executor | responder | Haiku | Draft replies using voice profile + few-shot examples |
| `reviewer` | Reviewer | core | Sonnet | Gate checks: tone (G3), commitments (G2), precedent (G7) |
| `architect` | Architect | core | Gemini 2.5 Pro | Daily pipeline analysis, optimization, briefings |
| `executor-ticket` | Executor | ticketing | DeepSeek | Structure feedback into Linear + GitHub issues |
| `executor-coder` | Executor | engineering | Sonnet | Code generation via Claude Code -> PRs via Git Trees API |
| `executor-blueprint` | Executor | engineering | Sonnet | Architecture/design blueprints |
| `executor-redesign` | Executor | engineering | Sonnet | UI redesign pipeline |
| `executor-research` | Executor | research | Gemini 2.5 Pro | Web search + synthesis |
| `claw-explorer` | Architect | exploration | Sonnet | Autonomous codebase exploration |
| `claw-workshop` | Orchestrator | workshop | Sonnet | Linear issue -> implementation (Claude Code sessions) |
| `claw-campaigner` | Orchestrator | campaign | Sonnet | Multi-step campaign execution |
| `board-query` | Utility | query | DeepSeek | Board question answering |
| `nemoclaw-ecgang` | External | nemoclaw | Gemini 2.5 Pro | Eric's external agent instance |
| `nemoclaw-ConsultingFuture4200` | External | nemoclaw | Gemini 2.5 Pro | Dustin's external agent instance |

## Task Graph

The task graph is the single source of truth. All agent coordination flows through it. There is no peer-to-peer messaging between agents.

**Work item types:** DIRECTIVE (board-created) -> workstream -> task -> subtask.

**States:** `created -> assigned -> in_progress -> review -> completed`. Also: `failed`, `blocked`, `cancelled`, `timed_out`. Terminal states: `completed`, `cancelled`. See SPEC.md SS3 for the full state machine and transition rules.

**Every state transition is atomic** — `transition_state()` locks the work item, validates against the state machine, updates state, writes the audit log, emits the event, and publishes to the transparency layer in a single Postgres transaction.

## Guardrails

Guardrails are enforced by `guardCheck()` in the orchestration layer, not by agents self-policing. The guard runs as a single atomic transaction with `transition_state()`.

**Constitutional gates (G1-G7) currently enforced:**

| Gate | Check | Enforced By |
|------|-------|-------------|
| G1 Financial | $20/day LLM ceiling | `lib/runtime/guard-check.js` |
| G2 Legal | Scan for commitment/contract language | Reviewer |
| G3 Reputational | Tone match >= 0.80 vs voice profile | Reviewer |
| G4 Autonomy | L1 partial: noise/FYI auto-archived | Orchestrator |
| G5 Reversibility | Prefer drafts over sends, flag reply-all | Reviewer |
| G6 Stakeholder | No spam, no misleading content | Gate check |
| G7 Precedent | Flag pricing/timeline/policy commitments | Reviewer |

## Content Sanitization

All content loaded into agent context is sanitized at load time (runtime loop step 4f via `lib/runtime/context-loader.js`). Sanitization strips injection patterns, validates schemas, truncates oversized fields, and flags anomalies.

## Data Quality Tiers

Not all task graph data is equally reliable. Context loading prioritizes by provenance:

- **Q1** — Board-authored directives, acceptance criteria. Loaded first, never truncated.
- **Q2** — Reviewed AI outputs (passed Reviewer checks). Loaded second, summarized if over budget.
- **Q3** — Unreviewed AI outputs. Loaded last, labeled as unreviewed, capped at 25% of context budget.
- **Q4** — External data ingested via tools. Sanitized, capped at 15% of context budget.

When context budget forces truncation: Q4 first, then Q3, then Q2. Q1 is never truncated.

## Git Workflow

**Branches:** `main` (production, board-approval required) <- feature branches (`feat/TASK-XXXX-description` or `fix/TASK-XXXX-description`).

**Commit format:** Every commit references its task graph work item: `[TASK-0042] Implement atomic guardCheck`. Non-task commits use category prefix: `[infra]`, `[docs]`, `[chore]`.

**PR rules:**
- All PRs require CODEOWNERS approval and CI pass
- BOARD-tier paths require both board members
- ARCHITECTURE-tier paths require technical board member
- Agent-managed paths require Reviewer agent
- No force push to protected branches

## Code Standards

- JavaScript ES modules (`"type": "module"`) — no TypeScript in this codebase
- Named exports over default exports
- Functions: camelCase. Constants: UPPER_SNAKE_CASE.
- All database queries use parameterized statements — no string interpolation into SQL, ever
- No ORM — raw SQL with parameterized queries (P4)
- Boring dependencies: `pg`, `googleapis`, `@anthropic-ai/sdk`. Nothing exotic. (P4)
- Events via `pg_notify` — no external message queue (P4)
- Append-only audit tables — immutable, hash-chained (P3)
- Error handling: explicit errors — no swallowed exceptions

```javascript
// Good — parameterized query, explicit error handling
async function getWorkItem(id) {
  const result = await pool.query(
    'SELECT * FROM agent_graph.work_items WHERE id = $1',
    [id]
  );
  if (result.rows.length === 0) {
    throw new WorkItemNotFoundError(id);
  }
  return result.rows[0];
}

// Bad — string interpolation, swallowed error
async function getWorkItem(id) {
  try {
    const result = await pool.query(`SELECT * FROM work_items WHERE id = '${id}'`);
    return result.rows[0];
  } catch (e) {
    return null;
  }
}
```

## Testing

- All PRs must include tests for changed behavior
- Unit tests with Node.js built-in test runner (`node --test`)
- Schema validation tests: every migration must include forward and rollback test
- Content sanitization: adversarial test suite

```bash
# Run full test suite
npm test

# Run tests matching a pattern
node --test --test-name-pattern="guardCheck" test/*.test.js

# Run integration tests
npm run test:integration
```

## Boundaries

**Always:**
- Reference SPEC.md section numbers when making architectural decisions
- Use parameterized queries for all database access
- Log all state transitions through `transition_state()`
- Run tests before committing
- Sanitize content at context-load time

**Ask the board first:**
- Schema migrations (changes to any schema or append-only table)
- Changes to guardrail definitions or thresholds
- Adding new tools to the registry
- Any external communication (even in development)
- Budget allocation changes
- Agent config modifications (model swaps, prompt rewrites)

**Never:**
- Interpolate values into SQL strings
- Bypass `guardCheck()` for any state transition
- Self-modify agent configs or guardrail definitions
- Store secrets, API keys, or PII in code or logs
- Access another agent's context or credentials
- Override infrastructure constraints via prompt engineering

## Per-Agent Definitions

Agent definitions exist at two levels:

### Spec-level (this directory: `spec/agents/`)

Abstract tier definitions describing the spec's intent for each agent tier. These files define the role, hierarchy, guardrails, anti-patterns, and Lethal Trifecta assessment for each tier. They are reference documents for architectural decisions and board review.

Files: `strategist.md`, `architect.md`, `orchestrator-eng.md`, `reviewer-backend.md`, `executor-01.md`

### Product-level (`autobot-inbox/agents/`)

Concrete agent behavioral contracts for the autobot-inbox product. One file per deployed agent, compiled from `autobot-inbox/config/agents.json`. These describe the agent as actually configured — model, tools, guardrails, capabilities, output constraints.

Files: `orchestrator.md`, `strategist.md`, `architect.md`, `reviewer.md`, `executor-triage.md`, `executor-responder.md`, `executor-ticket.md`, `executor-coder.md`, `executor-blueprint.md`, `executor-redesign.md`, `executor-research.md`, `claw-explorer.md`, `claw-workshop.md`, `claw-campaigner.md`, `board-query.md`

## Key Domain Concepts

- **DIRECTIVE** — A board-created strategic objective. The highest-level work item.
- **Workstream** — A decomposition of a DIRECTIVE into parallel tracks of work.
- **Task** — A concrete unit of work assigned to an agent.
- **Subtask** — A further decomposition of a task, typically assigned to an Executor.
- **guardCheck()** — The orchestration-layer function that validates every action before and after execution. Runs as a single atomic Postgres transaction with `transition_state()`.
- **transition_state()** — The atomic function that moves a work item between states. Cannot be called without passing `guardCheck()`.
- **HALT** — Emergency stop protocol. All agents stop processing new events, complete current task, write status, have identity revoked. Board must explicitly RESUME.
- **Shadow mode** — A replacement agent processes tasks in parallel without its outputs being used.
- **Graduated trust** — After shadow mode: Level 1 (suggest-with-review) -> Level 2 (autonomous-on-low-risk) -> Level 3 (full autonomous). The orchestration layer enforces trust level.
- **Lethal Trifecta** — Risk assessment: private data + untrusted content + external communication = maximum risk.
- **Config hash** — SHA-256 of agent config, stamped on every audit entry. If the hash changes, the agent's trust level resets to Level 1.

## What This File Does NOT Do

This file advises. It does not enforce. The enforcement boundary is:
- **Database roles and RLS** — agents cannot access data outside their scope
- **JWT claims** — tool access validated at the orchestration layer
- **guardCheck()** — every action gated by infrastructure constraints
- **Schema constraints** — CHECK, UNIQUE, FK, and triggers enforce business rules
- **Branch protection** — CODEOWNERS and CI checks enforced by GitHub

If an instruction in this file conflicts with an infrastructure constraint, the infrastructure wins. That is P2.

## Further Reading

- `spec/SPEC.md` — Full architecture specification v1.1.0 (start here for any architectural question)
- `spec/SPEC.md SS0` — Design principles (P1-P6)
- `spec/SPEC.md SS3` — Task graph schema, state machine, routing
- `spec/SPEC.md SS4` — Agent runtime loop, context management, data quality tiers
- `spec/SPEC.md SS5` — Guardrail enforcement architecture
- `spec/SPEC.md SS7` — Communication Gateway
- `spec/SPEC.md SS9` — Kill switch and HALT protocol
- `spec/SPEC.md SS14` — Phased execution plan and success metrics
- `spec/agents/*.md` — Abstract tier-level agent definitions
- `autobot-inbox/agents/*.md` — Product-level agent behavioral contracts
- `autobot-inbox/config/agents.json` — Agent roster (source of truth)
