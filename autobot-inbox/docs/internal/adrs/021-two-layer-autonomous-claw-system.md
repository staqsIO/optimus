---
title: "ADR-021: Two-Layer Autonomous Claw System"
status: Accepted
date: 2026-03-16
decision_makers: ["Eric", "Dustin"]
spec_refs: ["§5 Guardrails", "§3 Task Graph", "§9 Halt Signals"]
---

# ADR-021: Two-Layer Autonomous Claw System

## Context

Optimus has robust governance (5 tiers, G1-G7 gates, atomic guardrails, permission_grants) but every agent is purely reactive. Two gaps exist:

1. **No proactive intelligence** — nothing identifies problems or proposes improvements autonomously.
2. **No iterative autonomous execution** — no agent can take an approved goal and iterate toward it within a budget envelope.

Three external influences inform this design:
- **OpenClaw** — Gateway-as-control-plane, tool-policy security, cron/webhook proactive triggers.
- **Karpathy's autoresearch** — Fixed time budget per iteration, single objective metric, binary keep/discard via git state, human programs `program.md` not the code.
- **Optimus governance** — P1-P6 design principles, atomic guardrails, budget envelopes, hash-chained audit.

## Decision

Implement a two-layer autonomous system:

### Strategic Claw (Explorer)
Extends the existing `self-improve-scanner.js` with pluggable domain handlers, configurable scheduling, and two-track intent routing (tactical auto-route + strategic board approval). Runs as a service (not through the task graph) with a dedicated `explorer_ro` DB role for P2 enforcement. Domains: pipeline_health, test_health (initially enabled), plus 6 future domains.

### Operational Claw (Campaigner)
New Orchestrator-tier agent (`claw-campaigner`) that runs board-approved campaigns autonomously within a defined envelope. Follows the autoresearch iteration pattern: plan → execute → measure → keep/discard → repeat. Stateless campaigns first (Phase B), stateful git-worktree campaigns later (Phase C).

Key governance innovation: the board approves the envelope (goal + budget + constraints), not individual iterations. Campaign budget is separate from daily operational budget.

### Campaign Budget Isolation
Campaign envelopes are carved from a monthly campaign allocation (board-set, separate pool). `guardCheck()` detects campaign work_items via parent chain and routes to `reserve_campaign_budget()`. Daily operational budget is untouched by campaign activity.

### Iteration Work Items
Each campaign iteration creates a lightweight work_item (`type: 'subtask'`, `parent_id: campaign.work_item_id`). This provides hash-chained audit, guardCheck() per iteration, and budget tracking through the existing state machine.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| New agent tier for Explorer | Over-engineered; self-improve-scanner already does 60% of this (Liotta review) |
| Single monolithic claw agent | Violates separation of concerns; proactive intelligence and iterative execution are distinct capabilities |
| results.tsv file for iteration log | campaign_iterations table IS the single source of truth (P3); no file-based duplicate (Liotta review) |
| Self-assignment for Explorer | 026-assignment-enforcement.sql would deadlock; Explorer runs as service, not through task graph (Linus blocker) |
| Campaign budget counts against daily budget | One campaign would starve inbox agents; separate pools (Linus blocker) |
| deploy-to-production in Phase 1 | Too risky; staging only until pattern is proven (Liotta review) |

## Consequences

### Positive
- Optimus gains proactive intelligence (Explorer finds issues before they compound)
- Board can set autonomous goals with full transparency and budget safety
- Campaign pattern is reusable for any iterative optimization (prompts, sites, models)
- M1 Mac compute fully utilized (both Claws + existing executors)
- All existing governance (guardrails, halt signals, audit) applies to both Claws

### Negative
- Additional DB tables and functions increase schema complexity
- Campaign budget pool requires monthly allocation management
- Explorer domains need individual tuning to avoid noise

### Neutral
- Migration 008-claw-system.sql extends existing CHECK constraints (pre-production, no data risk)
- Campaigner uses same claim pattern (SKIP LOCKED) as other agents

## Affected Files

### New Files
- `sql/008-claw-system.sql` — Schema, tables, functions, seed data, indexes
- `src/agents/claw-campaigner/index.js` — Campaigner agent entry point
- `src/agents/claw-campaigner/campaign-loop.js` — Core iteration loop
- `src/agents/claw-campaigner/campaign-budget.js` — Budget envelope operations
- `src/agents/claw-campaigner/campaign-scorer.js` — Success criteria + content policy evaluation
- `src/agents/claw-campaigner/circuit-breaker.js` — Plateau detection + halt check
- `src/agents/claw-campaigner/strategy-planner.js` — LLM strategy selection
- `src/runtime/exploration/domain-selector.js` — Domain priority queue
- `src/runtime/exploration/domains/pipeline-health.js` — Pipeline health analysis
- `src/runtime/exploration/domains/test-health.js` — Test suite analysis
- `src/runtime/exploration/domains/dependency-audit.js` — npm audit + outdated checks
- `src/runtime/exploration/domains/code-quality.js` — Large files, TODO/FIXME density
- `src/runtime/exploration/domains/spec-alignment.js` — SPEC.md vs implementation drift
- `src/runtime/exploration/domains/config-drift.js` — agents.json vs reality mismatches
- `src/runtime/exploration/domains/security-scan.js` — Hardcoded secrets, permission scope
- `src/runtime/exploration/domains/performance.js` — Latency trends, queue depth, burn rate
- `src/agents/claw-campaigner/campaign-workspace.js` — Git worktree lifecycle
- `src/api-routes/campaigns.js` — Campaign + Explorer REST API routes
- `src/graph/claw-learning.js` — Neo4j learning integration for both Claws
- `dashboard/src/app/campaigns/page.tsx` — Campaign list + Explorer status UI
- `dashboard/src/app/campaigns/[id]/page.tsx` — Campaign detail + iteration history UI

### Modified Files
- `config/agents.json` — Added claw-explorer and claw-campaigner entries
- `src/runner.js` — Added campaignerLoop to RUNNER_AGENTS
- `src/runtime/guard-check.js` — Campaign budget routing in G1
- `src/runtime/state-machine.js` — Campaign budget release in claimAndStart
- `src/runtime/intent-executor.js` — Campaign creation from intents
- `src/runtime/self-improve-scanner.js` — Extended with exploration system

## Implementation Phases

- **Phase A** (complete): Schema + foundation
- **Phase B** (complete): Stateless campaigner proof-of-concept
- **Phase C** (complete): Stateful campaigns with git worktrees
- **Phase D** (complete): Explorer with pluggable domains
- **Phase E** (complete): Claw interaction + remaining exploration domains
- **Phase F** (complete): Dashboard + observability
- **Phase G** (complete): Neo4j learning integration
