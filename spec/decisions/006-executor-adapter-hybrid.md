# ADR-006: Executor Adapter — Hybrid Runtime with Driver Pattern

**Status:** Accepted
**Date:** 2026-04-08
**Decided by:** Eric (architecture), Board review pending for managed driver activation

## Context

Anthropic launched Claude Managed Agents (public beta, Apr 8 2026) — a cloud-hosted agent harness with sandboxing, checkpointing, long-running sessions, and scoped permissions.

Optimus currently runs all agent executors via local `claude` CLI subprocess (`lib/runtime/spawn-cli.js`) on an M1 MacBook with flat-rate subscription. Known pain points:

- `MAX_CLAUDE_CONCURRENCY=4` bottleneck
- Subscription rate-limiting under heavy campaign loads
- `.git` directory nuked by `bypassPermissions` CLI flag (see commit `18415f4`)
- Campaign iteration state lost on process crashes — no checkpointing

Managed Agents addresses several of these, but introduces serious concerns:

- **~67x cost increase** over flat-rate subscription (per-token billing)
- **P2 violation** — governance enforcement moves outside our infrastructure boundary
- **Credential sovereignty** — API keys and secrets enter Anthropic's sandbox
- **Audit chain breaks** — agent actions outside Postgres lose hash-chained traceability
- **Public beta churn** — API surface likely to change before GA

## Decision

Build an **executor adapter** (`lib/runtime/executor-adapter.js`) with swappable drivers following a strategy pattern:

| Driver | Status | Routes to |
|--------|--------|-----------|
| `cli` | Implemented | Existing `spawnCLI()` in `spawn-cli.js` |
| `managed` | Stub | Anthropic Managed Agents API (future) |
| `api` | Stub | Raw Anthropic Messages API (future) |

Per-agent routing via an `executor_driver` field in `config/agents.json`. All agents default to `cli` — zero behavior change on day one.

Independently adopt **managed agent patterns** locally, regardless of runtime:

- **Checkpointing** — persist campaign iteration state to Postgres, survive crashes
- **G10 budget gate** — per-agent token budget enforcement at the guard-check layer
- **Trace export** — structured execution traces for observability (complements existing audit)

## Consequences

- **Decouples execution from orchestration** — any runtime is swappable without touching the task graph, guard-check, or audit chain
- **Governance stays local** — G1-G9 gates, task graph, audit chain, and `guard-check.js` remain 100% in Postgres (P2)
- **Zero risk deployment** — all agents stay on `cli` until a driver is explicitly activated
- **Future optionality** — `managed` driver can be wired up if the cost/governance math changes
- **Local pattern adoption** — checkpointing and G10 deliver immediate value without any Anthropic API dependency

### Never-migrate list

These stay on `cli` (or future local driver) permanently due to governance constraints:

- Code-writing agents (`executor-coder`, `claw-workshop`, `claw-campaigner`)
- Orchestrators (`orchestrator`)
- Governance code (`guard-check.js`, `reviewer.js`)
- Any agent with credential access

## Alternatives Considered

1. **Full migration to Managed Agents** — rejected. P2 violation (governance enforcement outside our boundary), ~67x cost increase, public beta instability, credential sovereignty unresolved.
2. **Do nothing** — rejected. Misses the adapter pattern benefit and leaves checkpointing/G10 unbuilt.
3. **Raw Anthropic API driver only** — deferred. Similar per-token cost concerns, less managed infrastructure, but viable as a future `api` driver slot.

## Decision Criteria to Revisit

All four must be true before activating the `managed` driver:

- Managed Agents reaches GA + 6 months stability
- Credential isolation guarantees documented by Anthropic
- Canary benchmark completed: 100 runs `cli` vs `managed`, comparing p99 latency, cost, and success rate
- Board approval (budget + governance implications)

## Key Files

- `lib/runtime/spawn-cli.js` — current CLI subprocess executor
- `lib/runtime/executor-adapter.js` — new adapter (to be built)
- `lib/runtime/guard-check.js` — guardrail enforcement (unaffected)
- `config/agents.json` — agent configuration (new `executor_driver` field)
