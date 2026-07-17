# Ephor

**A governed agent organization — a technology company where every operational role is an AI agent, run under a human board and enforced by infrastructure, not prompts.**

In Sparta, the *ephors* (pronounced "EFF-orz") were the elected officials with the power to check the kings. Here, a constitutional layer checks the agents.

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License: Apache-2.0">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 20">
  <img src="https://img.shields.io/badge/database-PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs welcome">
  <img src="https://img.shields.io/github/stars/staqsIO/ephor?style=flat-square" alt="GitHub stars">
</p>

---

## What Is Ephor

Ephor is a fully agent-staffed technology organization. Every operational role — strategy, architecture, orchestration, execution, review, and exploration — is performed by an AI agent. A human board of directors sets strategy, defines ethical boundaries, controls budgets, and holds legal accountability. Everything else is agents, coordinated through a Postgres task graph with no framework, no message queue, and no ORM.

What makes it different from an "agent framework" is where the rules live. Capabilities are granted and constrained by **infrastructure** — database roles, row-level security, atomic state transitions, and hash-chained audit — not by system prompts an agent can be argued out of. A prompt advises; the database decides.

The long-term trajectory is the fully autonomous constitutional mode (called **AutoBot** in the spec): an agent organization where a constitutional layer replaces the human board for operational decisions. That mode cannot exist until Ephor has proven that agent governance works under human supervision. The transition is graduated and metric-gated — no capability is activated based on a calendar date.

Ephor builds and operates software products. The first running product is **autobot-inbox** — an AI-powered inbox manager that keeps a work inbox at zero, drafts replies in the owner's learned voice, and never sends anything a constitutional gate hasn't cleared. The distinction matters: Ephor is the organization; products are what it builds.

> [!NOTE]
> This is a **reference implementation and working lab** published as proof-of-work — a real, running governed-agent system, not a product pitch. It is self-hostable, but expect to bring your own credentials and your own operational judgment.

> [!NOTE]
> **Naming:** the project was renamed from **Optimus** to **Ephor** in July 2026. `SPEC.md`, `CONSTITUTION.md`, and historical design records predate the rename and retain the original names (Optimus, AutoBot); they refer to the same system.

## Architecture

```
+---------------------------------------------------------------+
|                      HUMAN BOARD                              |
|  Strategy, Ethics, Budget, Legal, Oversight                   |
|  Interfaces: Dashboard, CLI, Slack, Email (P6)                |
+----------------------------+----------------------------------+
                             |
+----------------------------v----------------------------------+
|                  ORCHESTRATION LAYER (lib/)                   |
|  Postgres task graph — single source of truth                 |
|                                                               |
|  guardCheck()          — constitutional gate enforcement       |
|  transition_state()    — atomic state + audit + event          |
|  claim_next_task()     — work dispatch (SKIP LOCKED)          |
|  Adapter registry      — channel-agnostic I/O                 |
|  Communication Gateway — inbound sanitize, outbound release   |
|  LLM provider layer    — per-tier model routing (BYO key)     |
|  RAG pipeline          — knowledge base (pgvector)            |
+---------------------------------------------------------------+
           |              |              |              |
           v              v              v              v
    +-----------+  +------------+  +----------+  +-----------+
    | Strategist|  |Orchestrator|  | Executor |  |  Reviewer |
    +-----------+  +-----+------+  +----------+  +-----------+
                         |
              +----------+----------+
              |          |          |
         +--------+ +--------+ +--------+
         |Workshop| |Campaign| |Explorer|
         +--------+ +--------+ +--------+

+---------------------------------------------------------------+
|                   PUBLIC TRANSPARENCY LAYER                   |
|  Every state transition -> structured event -> public archive |
|  Append-only, hash-chained audit log                          |
+---------------------------------------------------------------+
```

### Agent Tiers

20 agents across 7 tiers. Capabilities are enforced by infrastructure (P2), not prompts — each agent's tier, tool allow-list, and reachable peers are declared in `config/agents.json` and checked at the orchestration boundary.

| Tier | Agents | Role |
|------|--------|------|
| Strategist | strategist | Priority scoring, strategy recommendations (suggest mode) |
| Architect | architect, claw-explorer | Daily analysis, autonomous codebase exploration |
| Orchestrator | orchestrator, claw-workshop, claw-campaigner | Pipeline coordination, issue-driven implementation, campaigns |
| Reviewer | reviewer | Gate checks: tone, commitments, precedent, scope |
| Executor | intake, triage, responder, ticket, coder, blueprint, redesign, research | Classification, drafting, ticketing, code generation, research |
| Utility | board-query | Board question answering |
| External | nemoclaw-* | Board-member agent instances (API-only interaction) |

### Model Routing (Bring Your Own Keys)

Ephor is model-agnostic and metered per agent. The LLM provider layer (`lib/llm/`) routes each tier to the cheapest model that can do its job reliably — reliability (tool-call and JSON adherence), not $/token alone, is the binding constraint, because failures compound down the task DAG. High-volume tiers default to open-weight models served over **OpenRouter**; the layer also speaks Anthropic, Google, and local **Ollama**.

| Tier | Default model | Provider |
|------|---------------|----------|
| Classification (intake, triage, responder, reviewer) | `qwen/qwen-2.5-72b-instruct` | OpenRouter |
| Orchestration (orchestrator, architect, utility, strategist) | `deepseek/deepseek-chat` | OpenRouter |
| Code generation (coder, blueprint, workshop) | `qwen/qwen3-coder` | OpenRouter |

> [!IMPORTANT]
> **You bring your own keys — the project does not subsidize token usage.** Every provider reads its own environment variable (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …), and production boot fails closed if a required key is missing. No credentials are bundled; a fresh clone runs entirely on your accounts and your spend, capped by the G1 daily ceiling and per-agent G10 caps.

A reasoning model (`<think>`-scratchpad) is never placed on a tool-calling path — a build-time test enforces this invariant. Reasoning-tag scratchpad is stripped from all model output before it reaches chat, RAG, or the voice corpus.

### Constitutional Gates

Gates run at the database/orchestration layer as part of the same atomic transaction that transitions a work item — an agent cannot route around them:

| Gate | What It Checks |
|------|----------------|
| G1 Financial | Daily LLM spend ceiling ($20 default) |
| G2 Legal | Commitment and contract language in drafts |
| G3 Reputational | Voice tone match ≥ 0.80 (pgvector cosine similarity) |
| G4 Autonomy | Approval requirements per autonomy level (L0/L1/L2) |
| G5 Reversibility | Draft-only constraint; flags reply-all |
| G6 Stakeholder | Per-recipient-per-day rate limit |
| G7 Precedent | Pricing, timeline, and policy commitment detection |
| G8 Injection | Prompt-injection screening on inbound content |
| G9 Classification | Auto-tags content sensitivity at context load |
| G10 Spend Cap | Per-agent daily spend cap |
| G11 Retrospective | Requires retrospective capture before task completion |

### Graduated Autonomy

| Level | Behavior | Exit Criteria |
|-------|----------|---------------|
| L0 | All drafts require human approval | Enough reviewed drafts at a low edit rate |
| L1 (partial) | Auto-archive noise, auto-label FYI; drafts still gated | Sustained low error rate |
| L2 | Handle all but G2-flagged | Ongoing monitoring |

## Design Principles

| # | Principle | Meaning |
|---|-----------|---------|
| P1 | Deny by default | No capability unless explicitly granted |
| P2 | Infrastructure enforces; prompts advise | DB constraints, not system prompts |
| P3 | Transparency by structure | Logging is automatic, not optional |
| P4 | Boring infrastructure | Postgres, SQL, JWT, hash chains |
| P5 | Measure before you trust | Data proves readiness, not calendar dates |
| P6 | Familiar interfaces for humans | System adapts to humans, not vice versa |

## Repository Structure

```
ephor/
  SPEC.md            Canonical architecture specification (source of truth)
  CONSTITUTION.md    Prescriptive governance constraints (audit reference)
  lib/               Org-level infrastructure (shared across products)
    runtime/         Agent loop, state machine, guard checks, event bus
    adapters/        Channel-agnostic I/O (email, Slack, Telegram, webhook)
    graph/           Task graph + knowledge graph operations
    comms/           Communication Gateway (outbound release tiers)
    rag/             RAG pipeline (chunker, embedder, retriever)
    audit/           3-tier audit system (deterministic, AI, cross-model)
    llm/             LLM provider abstraction (per-tier routing, BYO key)
    db.js            Database connection (Postgres/PGlite)
  agents/            Org-level agents (channel-agnostic, reusable)
  autobot-inbox/     Product: AI inbox management
    src/agents/      Inbox-specific agents (orchestrator, triage, responder, …)
    src/gmail/       Gmail API integration
    src/voice/       Voice learning system (pgvector embeddings)
    src/signal/      Signal extraction + briefings
    config/          Agent configs, routing rules, gate definitions
    sql/             DDL migrations (source of truth)
  spec/              Architecture specification workspace
    conversation/    Immutable design decision records
    decisions/       Architecture Decision Records
  board/             Board Workstation (Next.js 15)
```

## Quick Start

The minimum to boot the organization is a **Postgres database and one LLM key** — no Google, Slack, or GitHub credentials required. Optional integrations detect missing credentials and disable themselves cleanly.

```bash
git clone https://github.com/staqsIO/ephor.git
cd ephor

# Guided setup — walks you through every service account (with signup
# links), writes autobot-inbox/.env, and generates internal secrets:
npm install && npm run setup

# …or configure by hand — set a database URL and at least one provider key
cp autobot-inbox/.env.example autobot-inbox/.env
#   DATABASE_URL=...           (Postgres with pgvector)
#   ANTHROPIC_API_KEY=...      and/or OPENROUTER_API_KEY=...

# Run the full stack with Docker (Postgres, Redis, services)
docker compose up -d
docker compose logs -f
```

**Demo mode** — synthetic mail, no Gmail or external credentials needed:

```bash
npm install                # root install — also installs lib/ and agents/ deps
cd autobot-inbox && npm install && npm run demo
```

**Requirements:** Node >= 20.0.0, npm. ES modules throughout (`"type": "module"`).

**Self-hosting a fork?** See [`SELF_HOSTING.md`](SELF_HOSTING.md) for a tiered
guide — from a zero-config demo boot (just `ANTHROPIC_API_KEY` +
`DEMO_MODE=1`, no other credentials) up to the full multi-channel production
configuration, including **satellite runners** (`npm run runner`) for
spreading heavy executor agents across machines that share only the
Postgres database.

| Port | Service |
|------|---------|
| 5432 | Postgres (pgvector) |
| 6379 | Redis |
| 3001 | autobot-inbox API |
| 3100 | Inbox dashboard (legacy) |
| 3200 | Board Workstation (primary) |

## Specification

The full architecture lives in `spec/SPEC.md`. It covers agent tiers and their constraints, the Postgres task graph as the single coordination source, the runtime loop with pre/post guardrail checks, constitutional gate enforcement, the risk-tiered Communication Gateway, the phased path from the governed organization (called *Optimus* in the spec) to the autonomous one (called *AutoBot*), and the legal-compliance architecture. Changes to the spec require board review.

## Status

Phase 1 — pipeline running live. 20 agents across 7 tiers, constitutional gates G1–G11 enforced at the database layer, a pgvector RAG knowledge base, and a Next.js Board Workstation. Channels and integrations (Gmail, Slack, Telegram, Drive, Calendar, GitHub, Linear, transcripts, webhooks) each enable only when their credentials are present.

## Contributing

Issues and pull requests are welcome. Fork, branch, and open a PR against `main`; CI runs unit tests, migration checks, config-isolation, and secret scanning, and skips credential-dependent jobs automatically on forks. See `CONTRIBUTING.md` and `SECURITY.md` (report vulnerabilities privately to eric@staqs.io).

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
