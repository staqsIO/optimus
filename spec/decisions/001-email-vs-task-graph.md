# ADR-001: Email vs. Postgres Task Graph for Agent Communication

**Status:** Accepted
**Date:** 2026-02-25
**Decided by:** Eric + Dustin (converged through conversation rounds 1-7)

## Context

Dustin's v0.1 proposed email (SMTP/IMAP) as the sole communication protocol between agents. The argument: email is boring, battle-tested, inherently auditable, human-readable, and provides a natural archive.

Eric raised concerns about latency (polling intervals of 30s-5min create multi-hour cascades for complex tasks), parsing overhead (agents must parse unstructured email bodies), and the mismatch between email's two states (read/unread) and the many states a task can be in (draft, ready, in_progress, blocked, in_review, done, failed, cancelled).

## Decision

Replace email with a Postgres-backed task graph for agent-to-agent communication. Preserve email (and Slack, dashboard, RSS) as the human interface for board oversight.

## Consequences

- Agent-to-agent dispatch is event-driven (pg_notify + outbox pattern), sub-second latency
- Tasks have rich state machines with validated transitions
- Dependency tracking (DAG edges) is native
- Audit trail is automatic (every state transition logged)
- Cost reduction: 3-5x vs email polling (no idle IMAP checks)
- Email remains available for human board interaction (P6: familiar interfaces for humans)

## Alternatives Considered

1. **Pure email** — rejected due to latency and state management limitations
2. **Linear + email hybrid** — rejected due to external dependency and API costs
3. **Custom message queue (Redis/RabbitMQ)** — rejected per P4 (boring infrastructure — Postgres already in the stack)
