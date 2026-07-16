# ADR-005: Elixir/BEAM as Optimus Runtime — Evaluated and Rejected

**Status:** Rejected
**Date:** 2026-03-17
**Decided by:** Eric (architecture evaluation)

## Context

The question: would Elixir/BEAM be a better runtime for Optimus? The system runs 12 AI agents as async loops in a single Node.js process, coordinated through a Postgres task graph. BEAM's actor model maps naturally to "many supervised agents," so the idea deserves a rigorous answer grounded in what the code actually does.

## Decision

Stay on Node.js. Elixir is a great fit for the *category* of system (concurrent agents, supervision, state machines), but Optimus has already built Postgres-native equivalents of every BEAM feature it would use. The actual bottleneck is LLM API latency (10-60s per call), not runtime concurrency.

## Why BEAM Looks Appealing (and Why It Doesn't Apply)

### 1. "True concurrency" — Not the bottleneck

Agents are I/O-bound, not CPU-bound. Each agent `await`s its Anthropic API call, yielding the event loop. At most 2-3 agents are simultaneously in-flight, all waiting on HTTP responses. `spawn-cli.js` has `MAX_CLAUDE_CONCURRENCY=4` — proving the bottleneck is API rate limits, not the event loop. Elixir processes would be waiting on the same API.

### 2. "OTP supervisors" — Already built in Postgres

- **Reaper** (60s sweep) finds stuck tasks, transitions to `timed_out`, retries up to 3x, then escalates. This IS supervision — stateless and database-driven.
- **AgentLoop** catch block handles per-task failures without killing the agent loop.
- **`FOR UPDATE SKIP LOCKED`** enables multiple consumers with zero coordination.
- OTP restarts in microseconds vs Reaper's 60s detection — but tasks take 10-60s anyway. No work is lost, just delayed.

### 3. "Per-agent fault isolation" — Already works

If an agent handler throws, `AgentLoop.tick()` catches it, logs, sleeps 5s, continues. Other agents are unaffected. If the entire Node process dies, Railway restarts in seconds. All agents re-claim from Postgres. The `runner.js` pattern already supports multiple satellite workers.

### 4. "Pattern matching for state machines" — DB enforces, not app code

State transitions are Postgres stored procedures (`claim_next_task`, `transition_state`). Elixir pattern matching would duplicate what the DB already does. Per SPEC P2: "Infrastructure enforces; prompts advise."

## What We'd Lose in a Migration

| Item | Impact |
|------|--------|
| **~37K LOC rewrite** (full `src/` tree) | Months of velocity for 1-person team |
| `@anthropic-ai/sdk` | Need custom HTTP wrapper for streaming, tool use, token counting |
| `googleapis` (Gmail, Drive, OAuth) | No mature Elixir equivalent |
| `@slack/bolt` (Socket Mode) | Would need custom integration |
| `neo4j-driver` | Limited Elixir options |
| `spawn-cli.js` subprocess management | Deeply Node-specific semaphore concurrency |
| SQL migration pipeline + raw `pg` patterns | Ecto translation layer or raw Postgrex |
| pg_notify event bus | Postgrex supports it, but full rewrite of event-bus, cache-invalidation, graph-sync |

## What To Do Instead (Cheap Wins)

The architecture already supports horizontal scaling without changing languages:

- **Already built**: `PROCESS_ROLE` splitting, `runner.js` satellite workers, `AGENTS_ENABLED` per-process filtering, `FOR UPDATE SKIP LOCKED` multi-consumer
- **If needed**: Node `worker_threads` for CPU-bound work, multiple Railway instances with different agent sets, decrease Reaper interval (60s to 15s), add health-check endpoint with per-agent last-activity timestamps

## Revisit Criteria

Revisit if any of these become true:

- 50+ agents needing per-agent memory isolation (currently 12)
- CPU-bound work dominates (currently 100% I/O-bound on LLM APIs)
- Multi-node distributed clustering required (currently single Railway + optional M1 satellite)
- Eric learns Elixir and wants to build the next product in it (team preference is valid)
- Sub-second crash recovery matters (60s Reaper is fine for email processing)

None of these are true today or in the Phase 1-2 roadmap.

## Key Files (Proving Current Architecture Handles It)

- `src/runtime/agent-loop.js` — while(running) + tick() + error recovery = per-agent fault tolerance
- `src/runtime/reaper.js` — stuck-task detection + retry + escalation = OTP supervisor equivalent
- `src/runner.js` — horizontal scaling: satellite workers with SKIP LOCKED claiming
- `src/runtime/spawn-cli.js` — semaphore concurrency proving API rate limits are the bottleneck
- `src/index.js` — PROCESS_ROLE splitting enables multi-process deployment today

## Alternatives Considered

1. **Full Elixir rewrite** — rejected due to migration cost vs. zero practical benefit at current scale
2. **Elixir sidecar for orchestration only** — rejected; orchestration is already in Postgres (P4: boring infrastructure)
3. **Elixir for next product** — deferred; valid if team learns Elixir and the product has different characteristics (CPU-bound, real-time, distributed)
