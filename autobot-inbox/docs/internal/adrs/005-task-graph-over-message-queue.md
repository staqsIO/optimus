---
title: "ADR-005: Task Graph Over Message Queue"
description: "Postgres task graph with SKIP LOCKED for agent coordination instead of Redis, RabbitMQ, or Kafka"
---

# ADR-005: Task Graph Over Message Queue

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- P4 (Boring Infrastructure), P3 (Transparency by Structure)

## Context

The five-agent pipeline needs a coordination mechanism: agents must claim work, execute in sequence, handle failures, and produce an audit trail. The standard approach is a message queue (Redis Streams, RabbitMQ, Kafka) where agents consume from topic-partitioned queues.

However, the autobot-spec imposes three requirements that message queues handle poorly:

1. **Ordered DAG execution**: Work items have parent-child and dependency relationships (`edges` table with `depends_on`, `blocks`, `decomposes_into`). A triage subtask must complete before routing. Message queues are FIFO or priority-ordered, not DAG-ordered.
2. **Atomic state + audit**: Every state transition must atomically update the work item status, append to the immutable audit log (`state_transitions`), and emit a notification event -- all in one transaction. Message queues cannot participate in Postgres transactions.
3. **Queryable state**: The CLI and dashboard need to query "all in-progress work items," "all blocked tasks," "cost spent today." This requires SQL queries against the task state, not consuming messages from a queue.

Postgres already provides queue semantics via `SELECT ... FOR UPDATE SKIP LOCKED`, which gives exactly-once delivery with transactional guarantees.

## Decision

Agent coordination uses three Postgres tables in the `agent_graph` schema:

- **`work_items`** -- Nodes in the task DAG. Status column tracks state machine position (`created`, `assigned`, `in_progress`, `review`, `completed`, `failed`, `blocked`, `timed_out`, `cancelled`).
- **`task_events`** -- Outbox table for event-driven dispatch. Agents poll this table with `claim_next_task()` which uses `FOR UPDATE SKIP LOCKED` to atomically claim and mark events as processed.
- **`state_transitions`** -- Append-only audit log. Every state change is recorded with agent ID, config hash, guardrail results, cost, and hash chain entry.

The `transition_state()` SQL function performs the state update, audit log append, and event emission in a single transaction. The `claim_next_task()` function uses `SKIP LOCKED` to prevent contention between concurrent agents.

The `edges` table maintains DAG relationships with cycle detection via `would_create_cycle()` (iterative BFS with depth limit, enforced by trigger on INSERT).

Valid state transitions are defined in `valid_transitions` table and enforced by `transition_state()` -- agents cannot skip states or make invalid transitions.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Redis Streams | Fast; built-in consumer groups; proven at scale | Cannot participate in Postgres transactions; no DAG ordering; separate audit log needed; adds a service | Loses atomic state+audit; adds operational dependency (P4) |
| RabbitMQ | Mature; routing exchanges; dead letter queues | Same transaction isolation problem; complex topology for 5 agents; overkill for ~700 msgs/day volume | Complexity disproportionate to scale; P4 violation |
| Kafka | Durable log; replay capability; partitioned | Massive operational overhead for a single-user inbox; no transactional integration with Postgres | Grossly over-engineered for this use case |
| Temporal / Durable Execution | Handles retries, timeouts, sagas natively | Heavy runtime; opinionated workflow model; learning curve; another service | P4: boring infrastructure means fewer moving parts, not more |

## Consequences

### Positive
- Single database for state, events, and audit -- no distributed consistency problems
- `SKIP LOCKED` provides exactly-once delivery within Postgres transactions
- Full SQL queryability of pipeline state for CLI and dashboard
- Atomic `transition_state()` guarantees state + audit + event in one transaction
- Cycle detection prevents DAG corruption via database trigger

### Negative
- Postgres polling (agents check `task_events` table periodically) has higher latency than push-based queues
- `SKIP LOCKED` throughput tops out at ~1000 claims/second -- adequate for email volume but would not scale to high-throughput workloads
- No built-in dead letter queue; failed tasks go to `failed` state and require manual intervention or retry logic

### Neutral
- `pg_notify` is available for push-based notification but not yet wired into the agent loop (agents currently poll on interval)
- The `task_events.processed_at` column serves as the acknowledgment mechanism -- unprocessed events are the "queue"

## Affected Files

- `sql/001-agent-graph.sql` -- `work_items`, `edges`, `task_events`, `state_transitions`, `valid_transitions` table definitions
- `sql/005-functions.sql` -- `transition_state()`, `claim_next_task()`, `would_create_cycle()` functions
- `src/runtime/state-machine.js` -- `claimNextTask()`, `claimAndStart()`, `transitionState()`, `createWorkItem()` wrappers
- `src/runtime/agent-loop.js` -- Poll loop that calls `claimAndStart()` on interval
