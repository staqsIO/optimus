# 019 — Elixir/BEAM Runtime Evaluation

**Author:** Eric
**Date:** 2026-03-17

## Prompt

Would Elixir/BEAM be a better runtime for Optimus/autobot-inbox? The actor model maps naturally to "many supervised agents" — is the current Node.js architecture leaving performance or reliability on the table?

## Analysis

Performed a rigorous evaluation grounded in actual code behavior, not theoretical framework comparison. Examined four areas where BEAM is commonly cited as superior:

1. **Concurrency** — Agents are I/O-bound (10-60s LLM API calls). `MAX_CLAUDE_CONCURRENCY=4` in spawn-cli.js proves API rate limits are the bottleneck, not the event loop. Elixir processes would wait on the same HTTP calls.

2. **Supervision** — Reaper (60s sweep) + AgentLoop error recovery + `FOR UPDATE SKIP LOCKED` multi-consumer already implement stateless, database-driven supervision. OTP's microsecond restarts don't matter when tasks take 10-60s.

3. **Fault isolation** — AgentLoop.tick() catches per-task failures. Process death → Railway restart → agents re-claim from Postgres. runner.js supports satellite workers. Already resilient.

4. **State machines** — Postgres stored procedures (`claim_next_task`, `transition_state`) enforce state transitions. Per P2, infrastructure enforces. Elixir pattern matching would duplicate DB logic.

## Migration Cost

A full rewrite would be ~37K LOC touching the entire `src/` tree. Critical dependencies without mature Elixir equivalents: `@anthropic-ai/sdk`, `googleapis`, `@slack/bolt`, `neo4j-driver`. Months of velocity loss for a 1-person team with zero practical benefit at current scale.

## Decision

**Stay on Node.js.** Captured as ADR-005. The architecture already supports horizontal scaling (PROCESS_ROLE splitting, runner.js satellites, AGENTS_ENABLED filtering, SKIP LOCKED). Cheap wins available without language change.

## Revisit Triggers

50+ agents, CPU-bound workloads, distributed clustering, team Elixir expertise, or sub-second crash recovery requirements. None present in Phase 1-2 roadmap.
