# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Repository:** [`staqsIO/optimus`](https://github.com/staqsIO/optimus) — consolidated monorepo (March 2026). Previously two separate repos (`staqsIO/autobot-inbox` and `staqsIO/autobot-spec`), unified via subtree merge.

## What Is Optimus

Optimus is a **governed agent organization** — a fully agent-staffed technology company where every operational role is an AI agent, governed by a human board of directors (Dustin and Eric). Agents coordinate through a Postgres task graph. Every action is logged to a public event archive. The board sets strategy, defines ethical boundaries, controls budgets, and maintains legal accountability. Everything else is agents.

Optimus builds and operates software products. **autobot-inbox** is the first product — an AI-powered inbox management system. The distinction matters: Optimus is the company; autobot-inbox is a product the company builds.

**AutoBot** is the long-term goal: an autonomous constitutional agent organization where the human board is replaced by a constitutional layer. AutoBot cannot exist until Optimus proves agent governance works under human supervision.

### Governing Documents

**`SPEC.md`** (v1.0.0) is the canonical architecture specification. Design decisions and implementation patterns should align with this document. When the spec is silent on a topic, use pragmatic judgment — flag significant gaps for board review rather than blocking on spec coverage.

**`CONSTITUTION.md`** contains the prescriptive governance constraints extracted from SPEC.md — design principles (P1-P6), Lethal Trifecta assessment, Kill Switch architecture, AutoBot Constitution, legal compliance, and exclusions. This is the audit reference document used by the governance intake system's automated classifier. The full SPEC.md v1.0.0 is archived at `spec/archive/SPEC-v1.0.0.md`.

### Design Principles (§0) — Non-Negotiable

These govern every architectural decision. Cite by number when relevant.

- **P1. Deny by default.** Nothing is permitted unless explicitly granted.
- **P2. Infrastructure enforces; prompts advise.** The enforcement boundary is never the prompt.
- **P3. Transparency by structure, not by effort.** Logging is a side effect of operating, not a feature agents choose to provide.
- **P4. Boring infrastructure.** Postgres, SQL, JWT, hash chains. Novelty is for the organizational model, not the plumbing.
- **P5. Measure before you trust.** Capability gates pass on data, not calendar dates.
- **P6. Familiar interfaces for humans.** The system adapts to humans, not the reverse.

## Workspace Structure

```
optimus/
├── SPEC.md                    # Canonical architecture specification (v1.0.0, read-only source of truth)
├── CONSTITUTION.md            # Prescriptive governance constraints (audit reference)
├── CLAUDE.md                  # This file — repo-wide guidance for Claude Code
├── lib/                       # Org-level infrastructure (shared across all products)
│   ├── runtime/               # Agent loop, state machine, guard checks, event bus, context loader
│   ├── adapters/              # Channel-agnostic I/O (email, Slack, Telegram, webhook)
│   ├── graph/                 # Task graph + Neo4j knowledge graph operations
│   ├── comms/                 # Communication Gateway (outbound release tiers)
│   ├── rag/                   # RAG pipeline (chunker, embedder, retriever, normalizers)
│   ├── audit/                 # 3-tier audit system
│   ├── llm/                   # LLM provider abstraction
│   └── db.js                  # Database connection (Postgres/PGlite)
├── agents/                    # Org-level agents (channel-agnostic, reusable across products)
│   ├── executor-intake.js     # Message classification
│   ├── executor-coder.js      # Code generation → PRs
│   ├── executor-ticket.js     # Linear + GitHub issue creation
│   ├── executor-blueprint.js  # Architecture blueprints
│   ├── executor-redesign.js   # UI redesign pipeline
│   ├── executor-research.js   # Web research + synthesis
│   ├── reviewer.js            # Gate checks, quality assurance
│   ├── architect.js           # Daily analysis, briefings
│   ├── claw-workshop/         # Linear-issue-driven implementation
│   ├── claw-campaigner/       # Multi-step campaign execution
│   └── research/              # Deep research handler
├── autobot-inbox/             # First product: AI inbox management (JavaScript/Node.js)
│   ├── CLAUDE.md              # Product-specific implementation guidance
│   ├── src/agents/            # Inbox-specific agents (orchestrator, triage, responder, strategist)
│   ├── src/gmail/             # Gmail API integration (product-specific)
│   ├── src/voice/             # Voice learning system (product-specific)
│   ├── src/signal/            # Signal extraction + briefings
│   ├── config/                # Agent configs (agents.json), routing rules, gate definitions
│   ├── sql/                   # DDL migrations (001 baseline through 189)
│   ├── dashboard/             # Legacy inbox dashboard (port 3100)
│   └── docs/                  # Internal and external documentation
├── spec/                      # Architecture specification workspace (Markdown only)
│   ├── CLAUDE.md              # Spec workflow conventions
│   ├── archive/               # Versioned spec snapshots (SPEC-v1.0.0.md)
│   ├── conversation/          # Immutable historical conversation records
│   └── reviews/               # Agent review transcripts
├── board/                     # Board Workstation (PRIMARY): Next.js 15 (port 3200, board.staqs.io)
│   └── src/app/               # Today, Drafts, Signals, Pipeline, Workstation, Governance, etc.
└── [future products]/         # Additional products Optimus builds
```

**Three-layer architecture (intent):**
- `lib/` — Org-level infrastructure (task graph, runtime, adapters, guardrails, RAG)
- `agents/` — Org-level agents (channel-agnostic, reusable across products)
- `autobot-inbox/` — Product code (inbox-specific agents, Gmail/voice/signal, config)

Re-export shims in `autobot-inbox/src/` maintain backward-compatible import paths for all moved code.

**Current state (2026-06) — what `lib/` actually is today:**

Pure product-neutrality is in progress. The config-loader and channel-registry abstractions have landed, and `lib/` no longer imports channel senders from `autobot-inbox/src/{gmail,outlook,slack,telegram}/` directly. The CG-1 cross-layer-imports ratchet (`.github/cg1-baseline` is currently `2`; `.github/workflows/ci.yml`) prevents *new* coupling; remaining product-coupled code in `lib/contracts/*` and `lib/wiki/*` is grandfathered and tracked for relocation.

**Cleanup roadmap:**
1. ✅ CG-1 converted from static threshold to monotonic ratchet
2. ✅ `lib/config/loader.js` — products inject config via `getConfig()` (OPT-141 landed)
3. ✅ `lib/adapters/registry.js` — products register channel implementations at startup; `lib/comms/sender.js`, `lib/runtime/agents/context-loader.js`, and `lib/runtime/emit-meeting-received.js` consume the registry (OPT-144 landed)
4. ⏳ Relocate remaining product-coupled files back to `autobot-inbox/`: `lib/contracts/*` (9 files), `lib/wiki/*` (4 files). **Blocked on a refactor, not just a `git mv`.** `lib/engagements/docx-export.js` statically imports `lib/contracts/brand-profile.js` and `lib/signatures/signer.js` dynamically imports `lib/contracts/{pdf-render,spawn-work-items}.js`. Naively moving `contracts/` to `autobot-inbox/src/contracts/` rewrites those imports to reach across the layer boundary (`from '../../autobot-inbox/src/contracts/...'`), adding a new CG-1 violation rather than removing one. The proper fix is to invert the dependency: `lib/engagements` + `lib/signatures` accept a renderer/spawn callback as a parameter (or via the same kind of registry that lib/adapters uses) so they no longer name the contract module directly. After that refactor lands the `git mv` is mechanical. (✅ `lib/runtime/phase1-metrics.js` and `lib/runtime/campaign-promoter.js` already relocated to `autobot-inbox/src/runtime/` because they had no lib/-side dependents.)

When a second product arrives, the registry/loader pattern lets it register its own channels and config without forking `lib/`.

## Optimus Architecture (SPEC §2–§5)

### Agent Tiers

Optimus agents are organized in a strict hierarchy. Each tier has explicit capabilities and constraints enforced by infrastructure (P2), not prompts. Every agent in `config/agents.json` has `tier` and `subTier` fields mapping to this hierarchy.

| Tier | Sub-Tiers | Model(s) | Role | Key Constraints |
|------|-----------|----------|------|-----------------|
| Strategist | core | Gemini 2.5 Pro | Priority scoring, strategy recommendations | Suggest mode (Phase 1). Cannot deploy or modify infrastructure. |
| Architect | core, exploration | Gemini 2.5 Pro, Sonnet | Technical analysis, autonomous codebase exploration | Cannot assign tasks to executors directly. |
| Orchestrator | core, workshop, campaign | DeepSeek, Sonnet | Pipeline coordination, Linear-driven implementation, campaigns | Explicit `can_assign_to` list (no globs). Cannot create DIRECTIVEs. |
| Reviewer | core | Sonnet | Gate checks, quality assurance | Read-only on executor work. 1 round of feedback then escalate. |
| Executor | intake, triage, responder, ticketing, engineering, research | Haiku, Sonnet | Classification, drafting, code generation, research | Cannot initiate tasks, cannot read other executors' work. |
| Utility | query | DeepSeek | Board question answering | No agent communication except configured target. |
| External | nemoclaw | Gemini 2.5 Pro | Board member agent instances | API-only interaction. No task graph write access. |

### Task Graph (§3)

The Postgres task graph (`agent_graph` schema) is the single source of truth for all agent coordination. No email, no message queue — structured work items with typed DAG edges, atomic state transitions, and immutable audit logging.

Work item states: `created → assigned → in_progress → review → completed`. Terminal states: `completed`, `cancelled`. Failed tasks retry up to 3 times, then escalate.

### Guardrail Enforcement (§5)

The orchestration layer enforces all guardrails — agents do not self-police. `guardCheck()` and `transition_state()` execute as a single atomic Postgres transaction.

**Currently implemented:** Constitutional gates G1-G11 enforced via DB constraints and `lib/runtime/guard-check.js` — budget pre-authorization, commitment detection, voice tone matching, autonomy level checks, rate limiting, prompt injection screening (Model Armor), auto-classification (G9), spend cap (G10), retrospective gate (G11).

**Target architecture (per SPEC §5):** JWT-scoped agent identity, Postgres RLS for agent data isolation, tool allow-lists, content sanitization on all context loads, tool integrity verification (hash check before invocation).

### Current Phase

**Phase 1 (Optimus MVP) — in progress.** autobot-inbox is live: 20 agents across 7 tiers, 14 channels/integrations (Gmail, Slack, Telegram, Drive, Calendar, GitHub, Linear, tl;dv, research, front-door, webhooks live; Outlook/finance/transcripts beta — see `autobot-inbox/config/channels.json`), constitutional gates G1-G11, RAG knowledge base (863 docs), CLI + Next.js dashboard + Board Workstation. Note: `/observability` is now a redirect to `/activity` (SystemStatsPanel + AgentTimeline deferred); the scheduled-services control surface (`/api/services/*`) has no board consumer yet. See SPEC §14 for remaining deliverables and exit criteria.

## Running Locally

**Docker Compose is the recommended way to run the full stack** — it handles Postgres (pgvector), Redis, and all services with hot reload.

```bash
cp autobot-inbox/.env.example autobot-inbox/.env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d        # start everything
docker compose logs -f      # follow logs
```

| Port | Service | Railway Domain |
|------|---------|----------------|
| 5432 | Postgres (pgvector) | — |
| 6379 | Redis | — |
| 3001 | autobot-inbox API | preview.staqs.io |
| 3100 | autobot-inbox dashboard (legacy) | inbox.staqs.io |
| 3200 | Board Workstation (PRIMARY) | board.staqs.io |
| 3000 | Docs site | — |

## Product: autobot-inbox

See `autobot-inbox/CLAUDE.md` for product-specific implementation details including build commands, environment variables, database schemas, constitutional gates (G1–G11), and agent pipeline configuration.

### Quick Reference (without Docker)

```bash
cd autobot-inbox

# Runtime
npm start              # Start agent runtime (poll loop)
npm run dev            # Watch mode
npm run cli            # Interactive CLI

# Database
npm run migrate        # Run SQL migrations
npm run seed           # Seed initial config

# Testing
npm run test:ci        # Unit tests (CI parity) — USE THIS. Per-file --test-force-exit
                       # + 15s timeout; cannot hang. This is what CI runs.
npm test               # Raw runner — AVOID: no force-exit/timeout, hangs forever on
                       # PGlite open handles (the runner never exits).
npm run test:integration

# Dashboard
cd dashboard && npm run dev   # Next.js 15 on port 3100
```

Node >= 20.0.0. Package manager: npm. ES modules throughout (`"type": "module"`).

## Code Conventions (Repo-Wide)

These apply to all code in the monorepo, derived from the spec's design principles:

- **Parameterized queries only** — never interpolate strings into SQL (P1, P2)
- **No ORM** — raw SQL with parameterized queries (P4)
- **Boring dependencies** — pg, googleapis, @anthropic-ai/sdk. Nothing exotic. (P4)
- **Events via pg_notify** — no external message queue (P4)
- **Append-only audit** — state_transitions and all audit tables are immutable, hash-chained (P3)
- **Infrastructure enforcement** — security boundaries are database roles, JWT scoping, and schema constraints, never prompt instructions (P2)
- **No cross-schema foreign keys** — schemas are isolated by database roles (SPEC §12)

## Working in autobot-spec

The `spec/` sub-project is a design workspace, not code. `SPEC.md` is the single source of truth. Conversation entries in `conversation/` are immutable historical records — never modify after commit. Changes to the spec require both board members' review.

## Feature Specs (`spec/features/`)

For non-trivial features where an ADR is too heavy and a Linear issue is too light, write a **feature spec** first via the `/feature-spec` skill. Cherry-picked from `github/spec-kit` — captures user stories, acceptance criteria, scope, constraints, and open questions before planning. Output: `spec/features/NNN-<slug>.md`.

**Artifact hierarchy:**

| Layer | File | Question answered |
|---|---|---|
| Architecture | `SPEC.md`, `CONSTITUTION.md` | What is Optimus? What rules govern it? |
| Architectural decision | `spec/decisions/NNN-*.md` (or `autobot-inbox/docs/internal/adrs/`) | Why did we choose X over Y? |
| **Feature spec** | **`spec/features/NNN-*.md`** | **What does the feature do? What is "done"?** |
| Execution | Linear STAQPRO-* | Next concrete unit of work |

A feature spec produces 1–N Linear issues. Skip the feature spec for one-line fixes, bug reports, or features with already-clear acceptance criteria.

## Board Communication

When producing artifacts for board review:

- **Dustin** — Lead with what you're recommending, then why, then how. Frame trade-offs as board decisions. Flag costs, risks, and timeline implications proactively. Don't simplify — teach.
- **Eric** — Speak peer-to-peer technically. Reference specific spec sections. When you disagree with a decision, say so directly with reasoning.
- **Both** — Never present as final anything involving: budget, security boundaries, legal/compliance, external communication, or phased execution plan changes. Surface blockers immediately.

## Documentation Agents (Scribe & Herald)

Scribe (internal/engineering docs) and Herald (external/board-facing docs) are independent — run in parallel when both triggered.

### Scribe Triggers

| Change Type | Target File(s) |
|-------------|----------------|
| New SQL migration | `autobot-inbox/docs/internal/database-architecture.md` |
| New module or directory under `src/` | `autobot-inbox/docs/internal/system-architecture.md` |
| Architecture decision | New ADR in `autobot-inbox/docs/internal/adrs/NNN-*.md` |
| Agent added, removed, or reconfigured | `autobot-inbox/docs/internal/agent-pipeline.md` |
| Constitutional gate changed | `autobot-inbox/docs/internal/constitutional-gates.md` |
| Cost model change | `autobot-inbox/docs/internal/cost-model.md` |
| Spec-level architecture decision | New ADR in `spec/decisions/NNN-*.md`, update `SPEC.md` |

### Herald Triggers

| Change Type | Target File(s) |
|-------------|----------------|
| Feature shipped or milestone | `autobot-inbox/docs/external/changelog.md` |
| Product capability changed | `autobot-inbox/docs/external/product-overview.md` |
| CLI command changed | `autobot-inbox/docs/external/cli-guide.md` |
| Dashboard page changed | `autobot-inbox/docs/external/dashboard-guide.md` |

ADRs follow the template in `autobot-inbox/docs/internal/adrs/README.md`. Herald uses [Keep a Changelog](https://keepachangelog.com/) format — board audience, describe operational changes, not code changes.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
