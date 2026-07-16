---
title: "Internal Engineering Documentation"
description: "Index of all internal technical documentation for autobot-inbox"
---

# Internal Engineering Documentation

Technical documentation for the autobot-inbox AI inbox management system. This is the first Optimus organization running the full autobot-spec v0.7.0 architecture.

## Quick Reference

### Agents

| Agent | Model | Role | Guardrails |
|-------|-------|------|------------|
| orchestrator | claude-sonnet-4-6 | Gmail poll, task creation, pipeline routing | G1 |
| strategist | claude-opus-4-6 | Priority scoring, strategy recommendations (suggest mode) | G1, G7 |
| executor-triage | claude-haiku-4-5-20251001 | Classify emails, extract signals | G1 |
| executor-responder | claude-haiku-4-5-20251001 | Draft replies using voice profile + few-shot examples | G1, G2, G3, G5 |
| reviewer | claude-sonnet-4-6 | Gate checks on drafts before board review | G1, G2, G3, G5, G6, G7 |
| architect | claude-sonnet-4-6 | Daily pipeline analysis, briefing generation | G1 |

### Database Schemas

| Schema | Purpose |
|--------|---------|
| `agent_graph` | Task DAG, state transitions (hash-chained), budgets, LLM invocations, halt signals |
| `inbox` | Email metadata (no body stored), triage results, drafts, Gmail sync state |
| `voice` | Sent email corpus with pgvector embeddings, voice profiles, edit deltas (append-only) |
| `signal` | Contacts (relationship graph), topics, briefings |
| `content` | Topic queue, content drafts, reference posts (Phase 1.5 LinkedIn automation) |

### Ports and Services

| Service | Port | Command |
|---------|------|---------|
| Agent runtime (poll loop) | N/A (no HTTP) | `npm start` |
| Next.js dashboard | 3100 | `cd dashboard && npm run dev` |
| Electron desktop app | N/A | `npm run electron` |
| CLI (REPL) | N/A | `npm run cli` |

## Documentation Index

| Document | Description |
|----------|-------------|
| [System Architecture](./system-architecture.md) | Overall system topology, service components, how they connect |
| [Agent Pipeline](./agent-pipeline.md) | Detailed agent pipeline: models, routing, event-driven task graph pattern |
| [Database Architecture](./database-architecture.md) | Five schemas, key tables, state machine, hash chains, append-only triggers |
| [Constitutional Gates](./constitutional-gates.md) | G1--G7 gates: what each checks, enforcement mechanism, failure behavior |
| [Graduated Autonomy](./graduated-autonomy.md) | L0, L1, L2 levels: behaviors, exit criteria, metric tracking |
| [Voice System](./voice-system.md) | Voice profile architecture: sent mail corpus, embeddings, few-shot selection, tone matching |
| [Cost Model](./cost-model.md) | LLM cost breakdown by agent and model tier, budget reservation pattern, daily ceiling |

## Related Resources

- [ADRs](./adrs/) -- Architecture Decision Records
- [Runbooks](./runbooks/) -- Operational runbooks
- `CLAUDE.md` (project root) -- Claude Code guidance for this sub-project
- `autobot-spec/SPEC.md` -- Upstream specification (v0.7.0)
