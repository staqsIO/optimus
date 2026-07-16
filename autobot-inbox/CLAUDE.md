# CLAUDE.md — autobot-inbox

## Overview

AI inbox management system — the first Optimus organization running the full autobot-spec architecture. Keeps Eric's work inbox at zero, drafts replies in his voice, extracts signals, and generates daily briefings.

**Spec lineage:** autobot-spec v1.0.0 (Dustin + Eric unified architecture)

## Architecture

20 enabled (21 total) agents across 7 SPEC tiers coordinated through a Postgres task graph (no framework). Org-level infrastructure lives in `lib/` at the repo root — agent handlers in `src/agents/` consume it via re-export shims. Channel I/O is abstracted via adapters (`lib/adapters/`), wired through a singleton adapter registry. Body fetching and prompt context assembly are centralized in `lib/runtime/context-loader.js` — agents never import provider-specific modules for content retrieval. Agent selection is config-driven (`config/agents.json`):

| Agent | Tier/Sub-Tier | Model | Role |
|-------|---------------|-------|------|
| orchestrator | Orchestrator/core | DeepSeek | Channel poll → task creation, pipeline coordination |
| strategist | Strategist/core | Gemini 2.5 Pro | Priority scoring, strategy recommendations (suggest mode) |
| executor-intake | Executor/intake | Haiku | Channel-agnostic message classification |
| executor-triage | Executor/triage | DeepSeek | Legacy classifier (being replaced by intake) |
| executor-responder | Executor/responder | Haiku | Draft replies using voice profile + few-shot examples |
| reviewer | Reviewer/core | Sonnet | Gate checks: tone (G3), commitments (G2), precedent (G7) |
| architect | Architect/core | Gemini 2.5 Pro | Daily pipeline analysis, optimization suggestions |
| executor-ticket | Executor/ticketing | DeepSeek | Structure feedback → Linear + GitHub issues |
| executor-coder | Executor/engineering | Sonnet | Code generation → PR via Git Trees API |
| executor-blueprint | Executor/engineering | Sonnet | Architecture/design blueprints |
| executor-redesign | Executor/engineering | Sonnet | UI redesign pipeline |
| executor-research | Executor/research | Gemini 2.5 Pro | Web search + synthesis |
| claw-explorer | Architect/exploration | Sonnet | Autonomous codebase exploration |
| claw-workshop | Orchestrator/workshop | Sonnet | Linear issue → implementation |
| claw-campaigner | Orchestrator/campaign | Sonnet | Multi-step campaign execution |
| board-query | Utility/query | DeepSeek | Board question answering |
| nemoclaw-ecgang | External/nemoclaw | Gemini 2.5 Pro | Eric's external agent |
| nemoclaw-ConsultingFuture4200 | External/nemoclaw | Gemini 2.5 Pro | Dustin's external agent |

## Database

**Dev environment:** Docker container `autobot-postgres` (`pgvector/pgvector:pg17`) on port 5432. Database `autobot`, user `autobot`. Set `DATABASE_URL` in `.env` to use it (already configured). When `DATABASE_URL` is set, `db.js` uses a real `pg.Pool`; when unset, it falls back to PGlite (in-process, `data/pglite/` directory). **Always use Docker Postgres for testing** — PGlite is demo-only.

**Production:** Supabase ("Optimus" project, Staqs Pro org, us-west-2). Railway `DATABASE_URL` points to Supabase pooler.

Five isolated schemas. No cross-schema FKs.

- `agent_graph` — Core task graph (work_items, edges, state_transitions, etc.), unified action_proposals (cross-channel drafts, ADR-013)
- `inbox` — Email metadata only (never stores body), triage results, signals; `inbox.drafts` is a compatibility VIEW over `agent_graph.action_proposals`
- `voice` — Sent email corpus with pgvector embeddings, profiles, edit deltas (append-only)
- `signal` — Contacts, topics, briefings
- `content` — Topic queue, reference posts (Phase 1.5 LinkedIn automation); content drafts unified into `agent_graph.action_proposals`

## Key Design Decisions

- **D1**: Metadata-only email storage. Never store body in DB. Fetch on-demand via adapter (Gmail, Outlook, or inline for Slack).
- **D2**: Gmail drafts, not sends, in L0. G5 reversibility.
- **D3**: Voice profiles derived from sent mail analysis, not hand-authored.
- **D4**: Edit deltas are append-only (immutable triggers). Most valuable data.
- **D5**: One Supabase project, five isolated schemas.
- **D6**: CLI for quick ops (approve, halt), Next.js dashboard for signal surface.
- **D7**: Poll Gmail (60s). Push notifications deferred.

## Constitutional Gates

| Gate | Check |
|------|-------|
| G1 Financial | $20/day LLM ceiling |
| G2 Legal | Scan for commitment/contract language |
| G3 Reputational | Tone match ≥ 0.80 vs voice profile |
| G4 Autonomy | L1 partial: noise/FYI auto-archived. Drafts still L0. |
| G5 Reversibility | Prefer drafts over sends. Flag reply-all |
| G6 Stakeholder | No spam, no misleading content |
| G7 Precedent | Flag pricing/timeline/policy commitments |
| G8 Prompt Injection | Model Armor screening on email body; block mode quarantines work items on HIGH-confidence matches (`MODEL_ARMOR_MODE`) |
| G9 Classification | Auto-classifier tags content sensitivity level at context load (`auto-classifier.js`) |
| G10 Spend Cap | Per-agent daily spend cap; advisory for cli drivers, enforced for metered (managed/api) |
| G11 Retrospective | Require retrospective capture before task completion (per-agent, default off) |

## Graduated Autonomy

| Level | Behavior | Exit Condition |
|-------|----------|----------------|
| L0 | Drafts require approval (action_required + needs_response) | 20+ drafts, <15% edit rate |
| L1 (partial) | Auto-archive noise/FYI, inner-circle guard | Enabled 2026-03-28 |
| L2 | Handle all but G2-flagged | Ongoing |

## PR Workflow

All changes flow through branches → PRs → `main`. Direct pushes to `main` require admin bypass.

1. **Feature work**: Create branch from `main` → implement → PR to `develop`
2. **Railway preview**: Deploys automatically from `develop` (preview.staqs.io)
3. **Board review**: Review preview on board.staqs.io
4. **Merge to main**: PR from `develop` → `main`, CI runs (test + migrate + smoke)
5. **Production deploy**: Railway deploys from `main`

**Campaign PRs** (from claw-campaigner/claw-workshop): Always target `develop`.

**CI checks** (required on PRs to `main`):
- `test` — unit + integration tests (PGlite)
- `migrate` — migration dry run
- `config-isolation` — prevents mixing board-tier and agent-tier files
- `secret-detection` — gitleaks scan
- `smoke` — post-deploy endpoint checks (develop only)

## Commands

```bash
npm start          # Start agent runtime (poll loop)
npm run cli        # Interactive CLI (inbox, review, briefing, stats)
npm run migrate    # Run SQL migrations against Supabase
npm run seed       # Seed initial config data
npm run test:ci    # Run unit tests (CI parity) — USE THIS. Wraps every file in
                   # --test-force-exit + 15s timeout, so a hanging test can't
                   # wedge the suite. `npm test` (raw runner) has neither and
                   # hangs forever on PGlite open handles — do not use it in
                   # automation/agents.
```

## Project Structure

```
# Org infrastructure (shared, lives at repo root)
../lib/runtime/   — Agent loop, state machine, guard checks, event bus, context loader
../lib/adapters/  — Channel-agnostic I/O (InputAdapter/OutputAdapter + registry)
../lib/graph/     — Task graph + Neo4j knowledge graph operations
../lib/comms/     — Communication Gateway (outbound release tiers)
../lib/rag/       — RAG pipeline (chunker, embedder, retriever, normalizers)
../lib/audit/     — 3-tier audit system
../lib/llm/       — LLM provider abstraction
../lib/db.js      — Database connection (Postgres/PGlite)

# Product code (this directory)
sql/           — DDL source of truth (001 baseline onward; e.g. 034 RAG match_chunks tenant + classification)
config/        — Agent configs (agents.json with tier/subTier), routing, email rules, gates
src/agents/    — 18 agent handlers (consume lib/ via re-export shims in src/runtime/, src/adapters/, etc.)
src/gmail/     — Gmail API integration
src/drive/     — Google Drive folder watcher
src/slack/     — Slack API integration
src/telegram/  — Telegram bot integration
src/outlook/   — Outlook/MS Graph integration
src/linear/    — Linear GraphQL API client
src/github/    — GitHub REST API (issues, PRs via Git Trees API)
src/voice/     — Voice learning system (pgvector embeddings)
src/signal/    — Signal extraction + briefings
src/cli/       — Board interface (readline REPL)
src/api.js     — HTTP API server
src/api-routes/— Route handlers
tools/         — MCP-compatible tool definitions
dashboard/     — Legacy inbox dashboard (port 3100)
docs/          — Internal (architecture, ADRs) and external (changelog, product overview)
test/          — Unit and integration tests
```

## Conventions

- **ES modules** (`"type": "module"`)
- **Parameterized queries only** — no string interpolation in SQL
- **No Express** — agent runtime is a pure event loop
- **Boring infrastructure** (P4) — pg, googleapis, @anthropic-ai/sdk. Nothing exotic.
- **Package manager**: npm

## Documentation Agents (Scribe & Herald)

Implementation-specific additions to the root CLAUDE.md guidance:

### Scribe

- Update the **Project Structure** block above when new directories appear under `src/` or at the project root.
- Keep the agent table in **Architecture** in sync with `config/agents.json` — if an agent is added, removed, or reconfigured, both must match.
- Implementation ADRs live in `docs/internal/adrs/` and are numbered independently from spec-level decisions in `spec/decisions/`. Continue the sequence from the ADR index (`docs/internal/adrs/README.md`).
- When adding a migration, update the migration range in this file's Project Structure block and in the root `CLAUDE.md`.
- When adding a schema, update the schema count in the Database section above and in `docs/internal/database-architecture.md`.

### Herald

- `docs/external/changelog.md` is written for the board — describe operational impact, not code changes.
- Version numbering continues the existing sequence (check the latest entry before incrementing).
- When the spec version bumps (`spec/SPEC.md`), note the spec alignment in the changelog entry.
