# AutoBot Inbox

AI inbox management -- the first Optimus organization running the full autobot-spec architecture.

## What It Does

AutoBot Inbox monitors a work email account, classifies every incoming message, drafts replies in the account owner's voice, and surfaces only the items that need human attention. The goal is inbox zero with minimal board effort: the AI handles triage, drafting, and signal extraction while the board retains full control over what actually gets sent.

Every inbound email passes through a six-agent pipeline coordinated through a Postgres task graph. The Orchestrator polls Gmail every 60 seconds and creates a work item for each new message. That work item flows through Strategist (priority scoring), Triage (classification), Responder (draft generation using a voice profile learned from sent mail), and Reviewer (constitutional gate enforcement) before reaching the board for approval. A sixth agent, Architect, runs daily pipeline analysis and suggests optimizations.

An email that arrives at 10:00 AM is typically triaged within 1-2 minutes and has a draft ready for review within 3-5 minutes. The average cost per email processed is approximately $0.004 for noise/FYI messages and $0.06-$0.13 for emails requiring a drafted response, well within the $20/day budget ceiling.

## Architecture

### Agent Pipeline

Six Claude-powered agents run in sequence on each inbound email. No orchestration framework or message queue -- coordination happens through a Postgres task DAG.

| Agent | Model | Role | Gates |
|-------|-------|------|-------|
| Orchestrator | claude-sonnet-4-6 | Polls Gmail, creates work items, routes tasks | G1 |
| Strategist | claude-opus-4-6 | Priority scoring, strategy recommendations (suggest mode only) | G1, G7 |
| Executor-Triage | claude-haiku-4-5 | Classifies: action_required, needs_response, fyi, noise | G1 |
| Executor-Responder | claude-haiku-4-5 | Drafts replies using voice profile + few-shot examples | G1, G2, G3, G5 |
| Reviewer | claude-sonnet-4-6 | Constitutional gate checks on all drafts | G1, G2, G3, G5, G6, G7 |
| Architect | claude-sonnet-4-6 | Daily pipeline analysis, optimization suggestions, briefings | G1 |
| Executor-Research | claude-sonnet-4-6 | Analyzes URLs/articles against the spec, finds gaps | G1 |

The Strategist is selectively invoked -- it is skipped for emails classified as fyi or noise, saving the most expensive per-call cost on the majority of inbound email.

### Task Graph

All agent coordination runs through a Postgres task DAG (`agent_graph` schema). Key properties:

- **Atomic state transitions** -- Every state change (pending, claimed, in_progress, completed, failed) is a single-transaction operation with an append-only audit trail in `state_transitions`.
- **pg_notify event bus** -- Agents are notified of claimable work via Postgres LISTEN/NOTIFY. No external message queue.
- **Hash-chained audit** -- Each state transition record includes a SHA-256 hash of the previous record, creating a tamper-evident log.
- **Budget reservation** -- Before claiming a task, agents atomically reserve their estimated LLM cost. Concurrent agents cannot overspend.
- **Reaper** -- A background process runs every 60 seconds to reclaim orphaned reservations from crashed agents.

### Constitutional Gates

Seven gates are enforced at the database layer via constraints and check functions -- not in prompts. The AI cannot bypass a gate by generating clever output.

| Gate | Name | Check | On Violation |
|------|------|-------|-------------|
| G1 | Financial | Daily LLM spend under $20 ceiling | Halt all non-critical processing |
| G2 | Legal | Scan for commitment, contract, or agreement language | Flag for board review |
| G3 | Reputational | Voice tone match >= 0.80 vs speaker profile | Reject draft |
| G4 | Autonomy | Board approval level respected for current autonomy level | Require board approval |
| G5 | Reversibility | Prefer drafts over sends; flag reply-all | Flag for board review |
| G6 | Stakeholder | No spam, no misleading content; 3 messages/recipient/day limit | Reject draft |
| G7 | Precedent | Pricing, timeline, or policy commitment detection | Flag for board review |

### Graduated Autonomy

Autonomy increases are metric-based, not calendar-based. The system must prove readiness before earning more independence.

| Level | Behavior | Exit Criteria |
|-------|----------|---------------|
| L0 | All drafts require board approval | 50+ drafts reviewed, <10% edit rate, 14 days of operation |
| L1 | Auto-archive noise, auto-label FYI, auto-send routine replies | 90 days, <5% error rate |
| L2 | Handle all emails except G2-flagged (legal/commitment) | Ongoing |

## What Is Implemented

### Phase 1 -- Core Pipeline

- [x] Orchestrator agent (Gmail polling, task creation, routing)
- [x] Strategist agent (priority scoring, conditional invocation)
- [x] Executor-Triage agent (four-category classification)
- [x] Executor-Responder agent (voice-matched draft generation)
- [x] Reviewer agent (constitutional gate enforcement)
- [x] Architect agent (daily pipeline analysis)
- [x] Task graph with atomic state transitions and hash-chained audit
- [x] Budget reservation system with G1 ceiling enforcement
- [x] Voice profiles from sent mail analysis (pgvector embeddings)
- [x] CLI board interface (approve, reject, halt, stats, briefing)
- [x] Next.js 15 web dashboard
- [x] Electron desktop app
- [x] Slack integration

### Phase 2 -- Constitutional Layer

- [x] Constitutional engine (shadow mode)
- [x] Financial script (autobot_finance schema, append-only ledger)
- [x] Three-tier audit system (tier 1 automated, tier 2 AI auditor, tier 3 board)
- [x] Communication gateway (risk-tiered message routing)
- [x] Sanitization rulesets (adversarial input protection)
- [x] Capability gates (fine-grained permission system)
- [x] Agent replacement protocol
- [x] Strategy evaluation framework

### Phase 3 -- Activation

- [x] Phase manager (activation triggers and rollback)
- [x] Dead-man switch (automated safety watchdog)
- [x] Distribution mechanism (autobot_distrib schema)
- [x] Value measurement system
- [x] Exploration monitor

### Phase 4 -- Autonomy

- [x] Merkle publisher (tamper-evident state publication)
- [x] Autonomy controller (graduated independence management)

## Quick Start

### Demo Mode (no credentials required)

```bash
npm install
npm run migrate
npm run seed
npm run demo
```

This starts the runtime with synthetic emails injected into the pipeline. Useful for exploring the system without connecting a real Gmail account.

### Full Setup

```bash
npm install
cp .env.example .env        # Fill in credentials (see Configuration below)
npm run setup-gmail          # OAuth flow for Gmail access
npm run migrate              # Create database tables
npm run seed                 # Seed agent configs and budget
npm run bootstrap-voice      # Build voice profiles from sent mail (optional)
npm start                    # Start the agent runtime
```

### Runner Mode (Remote Machine)

The runner is a lightweight task worker that connects to the shared Postgres database and processes work items without running Gmail, Slack, or the API server. Multiple runners can operate simultaneously — task claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`.

```bash
cp .env.runner.example .env   # Fill in DATABASE_URL + ANTHROPIC_API_KEY
npm install
npm run runner                # Default: executor-coder only
```

To include the research agent:

```bash
npm run runner -- --agents=executor-coder,executor-research
```

Or research only:

```bash
npm run runner -- --agents=executor-research
```

**Required env vars for runner:**
- `DATABASE_URL` — shared Postgres connection string (mandatory, no PGlite)
- `ANTHROPIC_API_KEY` — needed for `executor-research` (uses `callLLM()` via the SDK)
- GitHub auth (for `executor-coder`) — GitHub App, `gh` CLI, or `GITHUB_TOKEN`

**Optional:**
- `RUNNER_ID` — human-friendly name for logs/audit (auto-generated if omitted)

See `.env.runner.example` for the full template.

### Dashboard

In a separate terminal:

```bash
cd dashboard && npm install && npm run dev
```

Opens at [http://localhost:3100](http://localhost:3100). See `docs/external/dashboard-guide.md` for a page-by-page walkthrough.

### Electron Desktop App

```bash
cd electron && npm install
npm run electron
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the agent runtime (poll loop + API server) |
| `npm run dev` | Start with auto-restart on file changes |
| `npm run cli` | Interactive CLI for draft review, stats, directives |
| `npm run migrate` | Run SQL migrations against the database |
| `npm run seed` | Seed initial configuration (agents, budget, gates) |
| `npm run setup-gmail` | OAuth initialization for Gmail API access |
| `npm run bootstrap-voice` | Build voice profiles from sent mail history |
| `npm run demo` | Start with synthetic emails (no Gmail required) |
| `npm run electron` | Launch Electron desktop app |
| `npm run electron:demo` | Launch Electron in demo mode |
| `npm run electron:build` | Build Electron app for distribution |
| `npm run runner` | Start runner mode (executor-coder by default) |
| `npm run runner -- --agents=X,Y` | Start runner with specific agents |
| `npm test` | Run unit tests (Node.js --test runner) |
| `npm run test:integration` | Run integration tests |

## Configuration

All configuration is via environment variables in `.env`. Copy `.env.example` to get started.

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude models | -- |
| `GMAIL_CLIENT_ID` | Yes | OAuth client ID from Google Cloud Console | -- |
| `GMAIL_CLIENT_SECRET` | Yes | OAuth client secret | -- |
| `GMAIL_REFRESH_TOKEN` | Yes | Obtained during `setup-gmail` or dashboard OAuth flow | -- |
| `GMAIL_USER_EMAIL` | Yes | The inbox email address to manage | -- |
| `DATABASE_URL` | No | Postgres connection string (uses PGlite if unset) | PGlite (in-process) |
| `DAILY_BUDGET_USD` | No | Daily LLM spend ceiling | 20 |
| `AUTONOMY_LEVEL` | No | 0, 1, or 2 | 0 |
| `GMAIL_POLL_INTERVAL` | No | Polling interval in milliseconds | 60000 |
| `CREDENTIALS_ENCRYPTION_KEY` | No | Encryption key for stored credentials | -- |
| `SLACK_BOT_TOKEN` | No | Slack bot token for notifications | -- |
| `SLACK_SIGNING_SECRET` | No | Slack app signing secret | -- |
| `SLACK_APP_TOKEN` | No | Slack app-level token for socket mode | -- |
| `API_PORT` | No | Port for the REST API server | 3001 |
| `DASHBOARD_PORT` | No | Port for the Next.js dashboard | 3100 |

## Project Structure

```
sql/              22 migrations (DDL source of truth, 000-022)
config/           Agent configs, routing rules, gate definitions, email rules
src/runtime/      Core infrastructure: agent-loop, event-bus, guard-check,
                  state-machine, reaper, constitutional-engine, phase-manager,
                  capability-gates, sanitizer, dead-man switch
src/agents/       7 agents: orchestrator, strategist, executor-triage,
                  executor-responder, executor-research, reviewer, architect
src/gmail/        Gmail API integration: poller, client, sender
src/voice/        Voice learning: profile-builder, pgvector embeddings
src/signal/       Signal extraction, contact graphs, daily briefings
src/cli/          Board interface (readline REPL)
src/finance/      Financial script, budget enforcement (Phase 2)
src/audit/        Three-tier audit system (Phase 2)
src/comms/        Communication gateway (Phase 2)
src/distrib/      Distribution mechanism (Phase 3)
src/value/        Value measurement system (Phase 3)
tools/            MCP-compatible tool definitions, stress test
dashboard/        Next.js 15 web dashboard (separate package)
electron/         Electron desktop app wrapper
test/             Unit and integration tests (7 test files, 86 passing)
docs/external/    User-facing documentation
docs/internal/    Engineering documentation, ADRs, runbooks
```

## Database

Four core schemas, isolated by domain. No cross-schema foreign keys.

| Schema | Purpose |
|--------|---------|
| `agent_graph` | Task DAG, state transitions, budgets, LLM invocations, halt signals |
| `inbox` | Email metadata only (body never stored -- fetched on-demand from Gmail) |
| `voice` | Sent mail corpus with pgvector embeddings, speaker profiles, edit deltas (append-only) |
| `signal` | Contacts, topics, relationship graphs, daily briefings |

Additional schemas introduced in later phases:

| Schema | Purpose |
|--------|---------|
| `autobot_finance` | Append-only financial ledger with SHA-256 hash chain |
| `autobot_distrib` | Distribution mechanism ledger |

All tables use `TEXT` primary keys with `gen_random_uuid()::text`. All monetary values use `NUMERIC(15,6)` with banker's rounding. Migrations are the DDL source of truth -- run `npm run migrate` to apply.

## Documentation

### User-Facing (docs/external/)

| Document | Description |
|----------|-------------|
| [Product Overview](docs/external/product-overview.md) | What the system does, pipeline flow, board responsibilities |
| [Getting Started](docs/external/getting-started.md) | Setup guide from clone to running system |
| [CLI Guide](docs/external/cli-guide.md) | Commands available in the interactive CLI |
| [Dashboard Guide](docs/external/dashboard-guide.md) | Page-by-page walkthrough of the web dashboard |
| [FAQ](docs/external/faq.md) | Common questions and answers |
| [Changelog](docs/external/changelog.md) | Version history and release notes |

### Engineering (docs/internal/)

| Document | Description |
|----------|-------------|
| [System Architecture](docs/internal/system-architecture.md) | Full system design and component interactions |
| [Agent Pipeline](docs/internal/agent-pipeline.md) | Agent roles, routing logic, error handling |
| [Database Architecture](docs/internal/database-architecture.md) | Schema design, migration strategy, isolation model |
| [Constitutional Gates](docs/internal/constitutional-gates.md) | Gate implementation details and enforcement mechanisms |
| [Graduated Autonomy](docs/internal/graduated-autonomy.md) | Level transitions, exit criteria, metric tracking |
| [Voice System](docs/internal/voice-system.md) | Profile building, embedding strategy, tone matching |
| [Cost Model](docs/internal/cost-model.md) | Per-agent costs, budget reservation, daily projections |
| [ADRs](docs/internal/adrs/) | 7 architecture decision records |
| [Runbooks](docs/internal/runbooks/) | Deployment and incident response procedures |

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js >= 20 (ES modules) | Agent event loop, API server |
| AI | Claude API via @anthropic-ai/sdk | All six agents (Opus, Sonnet, Haiku tiers) |
| Database | PostgreSQL / PGlite | Task graph, schemas, budget enforcement |
| Embeddings | pgvector | Voice profile similarity matching |
| Dashboard | Next.js 15 | Web interface for board operations |
| Desktop | Electron | Native app wrapping the dashboard |
| Email | Gmail API via googleapis | Polling, reading, draft creation |
| Notifications | Slack Bolt | Optional alert delivery |
| Package manager | npm | Dependency management |

No ORM. No web framework in the runtime. No external message queue. Parameterized SQL queries throughout. These constraints are intentional -- see design principle P4 (boring infrastructure).

## Spec Lineage

This implementation follows the [autobot-spec](../autobot-spec/) architecture specification. The spec defines the governance model, constitutional framework, graduated autonomy levels, and multi-phase rollout plan that this codebase implements.

Current alignment: spec v0.7.0. All four phases (core pipeline, constitutional layer, activation, autonomy) are implemented. The spec is co-authored by Eric and Dustin and lives in the sibling `autobot-spec/` directory.

## License

Private. Unlicensed.
