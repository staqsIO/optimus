# Contributor Onboarding

Welcome to Optimus. This document tells you honestly what works, what doesn't, and where things are.

## What Is Optimus

Optimus is a **governed agent organization** — a fully agent-staffed technology company where AI agents handle operational roles, governed by a human board (Eric and Dustin). Agents coordinate through a Postgres task graph. Every action is logged to a public event archive.

The first product is **autobot-inbox**: an AI-powered inbox management system. The company also builds software products via campaigns (multi-step agent pipelines).

Six design principles govern all decisions (cite by number):

| # | Principle | One-liner |
|---|-----------|-----------|
| P1 | Deny by default | Nothing permitted unless explicitly granted |
| P2 | Infrastructure enforces; prompts advise | Rules enforced by DB constraints, not prompt instructions |
| P3 | Transparency by structure | Every state transition logged automatically |
| P4 | Boring infrastructure | Postgres, SQL, hash chains, JWT — nothing exotic |
| P5 | Measure before you trust | Capability gates, not calendar gates |
| P6 | Familiar interfaces for humans | System adapts to humans, not vice versa |

Full spec: [`spec/SPEC.md`](spec/SPEC.md) (v1.1.0, canonical — there is no root `SPEC.md`; the spec lives in `spec/`). Constitution: [`CONSTITUTION.md`](CONSTITUTION.md) (repo root).

> **Repo note:** as of March 2026 this is a single consolidated monorepo (`staqsIO/optimus`). It was previously two repos (`autobot-inbox` + `autobot-spec`), unified via subtree merge — so older docs/issues referencing an `autobot-spec/` path now mean `spec/`.

## Honest Status

> The detailed "what works / what's stuck" table below is a **point-in-time snapshot from 2026-04-12** — treat individual agent statuses as historical. **Since that snapshot** (confident, higher-level): the Feature-010 obligation loop is live (extract → draft → autonomous-route → Today drawer), graph-connected chat memory shipped (Neo4j knowledge graph), the tenancy/authz spine + RLS hardening landed (per-user board JWT auth, deny-by-default), and customer-facing MCP tools (engagement → tailored-proposal verbs) are live. For the current picture prefer `spec/CHANGELOG.md`, recent ADRs under `autobot-inbox/docs/internal/adrs/`, and `autobot-inbox/config/agents.json` over this table.

### Snapshot — what ACTUALLY worked as of 2026-04-12

| What | How | Evidence |
|------|-----|----------|
| **Email pipeline** | Gmail → orchestrator → intake → responder → reviewer → draft | Drafts appear in Board "Drafts" page. Eric approves/edits daily. |
| **Code generation** | Linear issue → executor-coder → PR on GitHub | PRs appear on staqsIO repos |
| **Board Workstation** | Next.js 15 dashboard at board.staqs.io | Live SSE updates, 23 pages, agent monitoring |
| **RAG knowledge base** | 863 documents, 6,663 chunks, pgvector search | Board "Knowledge Base" + "Search" pages |
| **Constitutional gates** | G1-G11 enforced at DB layer | Budget caps, tone matching, commitment detection |

### What's built but NOT producing results yet

| What | Why it's stuck |
|------|---------------|
| **Content engine** (executor-writer) | Just built (2026-04-12). Campaign routing fix deployed but untested E2E. |
| **LinkedIn posting** | OAuth wired up, adapter built. Needs content engine to produce drafts first. |
| **Campaigns** | claw-campaigner runs but confuses users. Generic LLM loop, unclear what it produces. |
| **Research pipeline** | executor-research exists but no regular trigger. Dustin wants "research X → save to KB." |
| **Nemoclaws** (per-user agents) | Connection infrastructure works (JWT, heartbeats, MCP). No Board UI to spawn them. |

### What's planned

| What | When |
|------|------|
| Content page on Board | After content engine E2E works |
| Dustin's research flow | Soon — executor-research + RAG ingest |
| Phase 2 (Tactical Autonomy) | After Phase 1 exit criteria met |

## Team

| Person | Role | Focus |
|--------|------|-------|
| **Eric Gang** | Co-founder | Infrastructure, implementation, systems architecture, data governance |
| **Dustin Powers** | Co-founder | Governance, constitutional architecture, content strategy |
| **Ladd Angelius** | Lead engineer | Implementation |
| **Steve** | Engineer | Implementation (joining) |
| **Alex** | Engineer | Implementation (joining) |
| **Mike** | Biz dev / Finance | Business operations, capitalization (non-technical) |

## Repository Structure

```
optimus/
├── CONSTITUTION.md              # Governance constraints (canonical spec is spec/SPEC.md)
├── CLAUDE.md                    # AI agent instructions (good architecture overview)
├── ONBOARDING.md                # You are here
│
├── lib/                         # Org-level infrastructure (shared)
│   ├── runtime/                 # Agent loop, state machine, guards, event bus
│   ├── adapters/                # Channel I/O (email, slack, telegram, linkedin)
│   ├── graph/                   # Task graph + Neo4j knowledge graph
│   ├── comms/                   # Communication Gateway (outbound tiers)
│   ├── rag/                     # RAG pipeline (chunker, embedder, retriever)
│   ├── audit/                   # 3-tier audit system
│   ├── llm/                     # LLM provider abstraction
│   └── db.js                    # Database connection
│
├── agents/                      # Agent handlers (channel-agnostic)
│   ├── executor-writer/         # Blog + content generation (5-phase pipeline)
│   ├── executor-coder/          # Code generation → PRs
│   ├── claw-campaigner/         # Multi-step campaign orchestration
│   ├── claw-workshop/           # Linear issue → implementation
│   ├── content-atomizer.js      # Blog → LinkedIn post derivation
│   └── ...                      # research, blueprint, redesign, ticket
│
├── autobot-inbox/               # First product: inbox management
│   ├── src/agents/              # Inbox-specific agents
│   ├── src/gmail/               # Gmail API integration
│   ├── src/voice/               # Voice learning system
│   ├── config/                  # agents.json, gates, routing
│   ├── sql/                     # Sequential DDL migrations (run `npm run migrate`)
│   └── docs/                    # Internal + external docs
│
├── board/                       # Board Workstation (Next.js 15, port 3200)
│   └── src/app/                 # Today, Drafts, Campaigns, Pipeline, Agents, etc.
│
└── spec/                        # Architecture specification workspace
    ├── SPEC.md                  # Canonical spec (v1.1.0)
    ├── conversation/            # Immutable decision records
    └── archive/                 # Versioned spec snapshots
```

## Running Locally

### Prerequisites

- Node.js 20+
- Docker (for local Postgres) or Supabase connection
- API keys: `ANTHROPIC_API_KEY` (required), `OPENROUTER_API_KEY`, `GEMINI_API_KEY`

### Quick Start

```bash
# Clone and setup
git clone https://github.com/staqsIO/optimus.git
cd optimus/autobot-inbox
cp .env.example .env    # Fill in API keys + DATABASE_URL

# Database
npm run migrate         # Apply SQL migrations (sequential in autobot-inbox/sql/)

# Run the full stack (Railway topology — all agents + API + ingestion)
npm start

# Or run just the M1 runner (executor agents only)
npm run runner          # Default: executor-coder + claw-campaigner

# Board Workstation
cd ../board && npm install && npm run dev   # port 3200

# CLI
npm run cli             # Interactive CLI (inbox, review, stats)
```

### Docker Compose (recommended for full stack)

```bash
cp .env.example .env
docker compose up -d    # Postgres, Redis, all services
```

## Deployment Topology

Two environments run simultaneously:

### Railway (cloud — always running)

| Service | What it does | URL |
|---------|-------------|-----|
| autobot-inbox | Full agent runtime + API | inbox.staqs.io |
| autobot-inbox-api | Preview/dev deploy | preview.staqs.io |
| board-workstation | Board dashboard | board.staqs.io |
| neo4j-graph | Knowledge graph | (internal) |

Railway runs **all API-based agents**: orchestrator, intake, responder, reviewer, architect, strategist, ticket, research, executor-writer, content-atomizer. These use LLM APIs (Anthropic, OpenRouter, Gemini) and are billed per-token.

### M1 MacBook (local — runs when needed)

The M1 runs agents that need the Claude CLI (`spawnCLI()`), which benefits from the flat-rate CLI subscription (~$100/mo unlimited):

```bash
cd autobot-inbox && node src/runner.js
# Default agents: executor-coder, claw-campaigner
# Override: node src/runner.js --agents=executor-coder,claw-workshop,executor-redesign
```

**Why M1?** executor-coder and executor-redesign shell out to the `claude` CLI tool. Railway containers can't do this. The M1's flat-rate subscription avoids per-API-call costs for expensive code generation tasks.

**Rule of thumb:** If the agent uses `spawnCLI()` → M1. If it uses `agent.callLLM()` → Railway.

## Agent Inventory (21 agents / 20 enabled — statuses are a 2026-04-12 snapshot)

> The per-agent **Status** column below is point-in-time (2026-04-12) and has drifted. The live agent set is `autobot-inbox/config/agents.json` (21 configured, 20 enabled); the table here is kept for orientation, not as current status.


| Agent | Tier | Model | Runs on | What it does | Status |
|-------|------|-------|---------|-------------|--------|
| orchestrator | Orchestrator | DeepSeek | Railway | Gmail/Slack/Drive polling → work items | Working |
| strategist | Strategist | Gemini 2.5 Pro | Railway | Priority scoring, strategy (suggest mode) | Working (output underused) |
| executor-intake | Executor | Haiku | Railway | Message classification | Working |
| executor-responder | Executor | Haiku | Railway | Draft email replies | Working |
| reviewer | Reviewer | Sonnet | Railway | Gate checks (G2/G3/G7) | Working |
| architect | Architect | Gemini 2.5 Pro | Railway | Daily analysis, briefings | Working |
| executor-ticket | Executor | DeepSeek | Railway | Linear + GitHub issue creation | Rarely triggered |
| executor-coder | Executor | Sonnet (CLI) | M1 | Code generation → PRs | Working |
| executor-research | Executor | Gemini 2.5 Pro | Railway | Web research + synthesis | Built, rarely invoked |
| executor-redesign | Executor | Sonnet (CLI) | M1 | UI redesign pipeline | Working (niche) |
| executor-blueprint | Executor | Sonnet | Railway | Architecture blueprints | Rarely used |
| executor-writer | Executor | Sonnet | Railway | 5-phase blog content pipeline | Just built, testing |
| content-atomizer | Executor | Haiku | Railway | Blog → LinkedIn derivation | Just built, needs writer first |
| claw-campaigner | Orchestrator | Sonnet (CLI) | M1 | Multi-step campaign orchestration | Working, needs routing fix |
| claw-workshop | Orchestrator | Sonnet (CLI) | M1 | Linear issue → implementation | Working |
| issue-triage | Orchestrator | Sonnet | M1 | Auto-assigns Linear/GitHub issues | Working |
| nemoclaw-ecgang | External | Gemini 2.5 Pro | External | Eric's external agent (MCP) | Infrastructure ready |
| nemoclaw-ConsultingFuture4200 | External | Gemini 2.5 Pro | External | Dustin's external agent (MCP) | Infrastructure ready |

## Database

**Production:** Supabase ("Optimus" project, us-west-2). Five isolated schemas, no cross-schema FKs:

- `agent_graph` — Task graph, work items, campaigns, state transitions
- `inbox` — Email metadata (never stores body), triage results
- `voice` — Sent email corpus with pgvector embeddings, profiles
- `signal` — Contacts, topics, briefings
- `content` — Topic queue, drafts, reference posts, wiki pages

**Migrations:** sequential in `autobot-inbox/sql/`. Run with `npm run migrate`.

**Local dev:** PGlite (in-process) when `DATABASE_URL` not set. Use Docker Postgres for testing.

## Key Architectural Concepts

### Task Graph (Postgres)
All agent coordination happens through structured work items in `agent_graph`. No email, no message queue — typed DAG edges, atomic state transitions, immutable audit logging.

### Constitutional Gates (G1-G11)
Infrastructure-enforced guardrails (P2). Budget caps (G1), commitment detection (G2), tone matching (G3), autonomy-level checks (G4), rate limiting (G5), content policy (G7), prompt-injection screening / Model Armor (G8), auto-classification (G9), spend caps (G10), retrospective feedback (G11).

### AgentLoop Pattern
Every agent exports an `AgentLoop` instance. The loop: claim work item → execute handler → transition state. Generic claim-execute-transition cycle handles concurrency, retries, and audit logging.

### Adapter Pattern
Channel I/O abstracted via `InputAdapter`/`OutputAdapter` interfaces. Adding a channel = implementing the interface + registering in `lib/adapters/registry.js`.

## Files to Read First

| File | Why |
|------|-----|
| `CLAUDE.md` | Best architecture overview — written for AI agents but readable by humans |
| `spec/SPEC.md` | Canonical specification (v1.1.0) |
| `lib/runtime/agent-loop.js` | Core claim-execute-transition loop |
| `lib/runtime/guard-check.js` | Constitutional gates enforcement |
| `autobot-inbox/config/agents.json` | Agent configuration (models, roles, routing) |
| `autobot-inbox/sql/001-baseline.sql` | Database schema (all 5 schemas) |

## Git Workflow

- Branch from `main`, PR back into `main`
- Atomic commits — one logical change per commit
- No force-push to `main`
- All work tracked on [Optimus Roadmap](https://github.com/orgs/staqsIO/projects/2) project board

## What Needs Help

1. **Content engine E2E** — executor-writer pipeline needs testing and debugging
2. **Campaign UX** — campaigns confuse users; needs a dedicated Content page on Board
3. **Research flow** — Dustin wants "research X and save to KB" but no trigger exists
4. **Email pipeline polish** — drafts need quality improvement, approval flow needs UX work
5. **Nemoclaw UI** — per-user agents need Board spawn mechanism
