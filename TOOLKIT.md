# TOOLKIT.md — Shared Agent Set

**Version:** 1.0.0 · **Last updated:** 2026-05-30 · **Owner:** Board (Eric/Dustin)

The canonical, versioned set of agents and skills used to build and operate
Optimus. This is the onboarding reference: a new contributor should be able to
read this file and know **which agent to reach for, and when**, with zero verbal
explanation. The full routing/disambiguation table lives in
`~/.claude/rules/agent-routing.md`; this file is the at-a-glance index.

> These are *development-time* agents (the ones that write and review Optimus's
> code). They are distinct from the *runtime* agents that operate the
> autobot-inbox product (orchestrator, intake, triage, responder, reviewer,
> architect — see `autobot-inbox/config/agents.json` and SPEC §2).

## How to read this

- **Role** — the one thing this agent is for.
- **When to use** — the trigger that should make you reach for it.
- Pick by *risk surface*, not by habit. The cheapest review is the one that runs
  before code exists. See the Pre-Push Review Checklist in `agent-routing.md`.

## Orchestration

| Agent | Role | When to use |
|-------|------|-------------|
| **Foreman** (`/gsd`, `/ship-issue`) | Sequential state-machine that drives a Linear-issue queue through plan→implement→test→review→commit→PR. | A backlog of issues, or issues with ordering dependencies. One issue at a time, full pipeline, retries on failure. |
| **Ultrawork** (`/ultrawork`) | Spawns up to 3 parallel git worktrees, each running Foreman, then an aggregate verification gate. | A hand-curated list of **independent, pre-decomposed** tasks with no shared mutable state. Refuses vague directives. |

## Architecture & Design

| Agent | Role | When to use |
|-------|------|-------------|
| **Liotta** | System-level architecture. Contrarian-scaling decisions, framework selection, database-schema and cross-service integration. | New service creation, schema changes, cross-service integration, framework choice. Run **first**, before implementation — it can invalidate whole approaches. |
| **Neo Architect** (`/neo-architect`) | Design-level guidance *within* an existing architecture: module boundaries, interface design. | "How should I structure this feature?" — narrower than Liotta. |

## Implementation

| Agent | Role | When to use |
|-------|------|-------------|
| **CompliantImplementer** | Policy-compliant implementation. Writes code while honouring CLAUDE.md / SPEC constraints (P1–P6, constitutional gates). | Touching compliance-critical paths (auth, gates, audit, SQL), or when policy adherence is explicitly required. The default executor in Foreman's pipeline. |
| **Delphi** | UI/UX design and implementation (non-Shopify frontends). | Frontend/UI work is the primary task (e.g. the Board Workstation). |
| **Storefront** | Shopify theme work. | Shopify themes only. |

## Data

| Agent | Role | When to use |
|-------|------|-------------|
| **PostgresDBA** | PostgreSQL / Prisma / Supabase: schema design, migration planning, query optimization, RLS policies. | Any schema change, new SQL migration, or query-perf question. Optimus is Postgres-only — this is the DB agent. |
| **Metrc** | Metrc API integration work. | Metrc-specific tasks (not used inside Optimus today). |

## Testing & Debugging

| Agent | Role | When to use |
|-------|------|-------------|
| **TestEngineer** | Writes and runs tests; fixes CI failures. | After implementation, always. Use `npm run test:ci` from `autobot-inbox/` — **never** bare `npm test` (it hangs on PGlite open handles). |
| **Debugger** | DEDUCE-methodology diagnosis of production incidents, stack traces, deploy-correlated failures. | "It's broken / it worked yesterday." Runtime failures with context. |
| **Neo Debug** (`/neo-debug`) | Semantic reasoning about code behaviour without runtime context. | "Why does this function return X?" — logic errors, no stack trace. |

## Review

| Agent | Role | When to use |
|-------|------|-------------|
| **Linus** | Kernel-quality code review, bug hunting, security audit. | PRs, and any change touching auth / payments / data deletion / secrets. **Prefer pre-implementation review on the design** over post-implementation review on the diff. |
| **Neo Review** (`/neo-review`) | Semantic analysis, code-smell and structural-refactor suggestions. | 50–200 LOC or new public API surface, or pre-PR self-review. Never run Neo before Linus on the same diff. |

## Quality (skills, not agents)

| Skill | Role | When to use |
|-------|------|-------------|
| **`/simplify`** | Post-implementation cleanup: reuse, dead code, unused imports. | After implementation touching 3+ files. Skip for single-line or config-only changes. |
| **`/batch`** | Apply the same transformation across 3+ files. | Renames, migrations, repeated refactors. Not for changes needing sequential reasoning. |
| **Neo Optimize** (`/neo-optimize`) | Algorithmic / performance optimization. | "Can this be faster?" on a hot path. |

## Documentation

| Agent | Role | When to use |
|-------|------|-------------|
| **Scribe** | Internal/engineering docs — ADRs, CLAUDE.md, system/database/agent-pipeline docs. | Engineers need the technical context. See Scribe triggers in `CLAUDE.md`. |
| **Herald** | External/board-facing docs — changelogs, product overview, CLI/dashboard guides. | Stakeholders need a readable update. [Keep a Changelog](https://keepachangelog.com/) format. |

> **Scribe vs Herald:** engineers → Scribe; stakeholders → Herald. **Never both
> for the same event.**

## Subagent budget (phase-scoped, per task)

Budgets are per *phase* per *task*, not per session. A Foreman run or a
3-worktree Ultrawork invocation exceeds any session cap by design.

| Phase | Cap per task | What counts |
|-------|-------------|-------------|
| Planning | 3 | Liotta, Neo Architect, Linus pre-impl, Researcher |
| Implementation | 5 | CompliantImplementer, TestEngineer, Debugger, PostgresDBA, Delphi, Scribe |
| Verification | 2 | Linus, Neo Review on the final diff (hard cap) |

Orchestrators (Foreman, Ultrawork) are **transparent** — they don't count
toward the parent's budget; each issue/worktree they manage gets its own
per-phase budgets. When a cap fires, **stop and ask** — it's an "are you sure?"
gate, not a wall.

## See also

- `~/.claude/rules/agent-routing.md` — full routing + disambiguation table.
- `SEAMS.md` — the capture→link edge map (how data flows between subsystems).
- `CLAUDE.md` / `SPEC.md` — what Optimus is and the rules that govern it.
