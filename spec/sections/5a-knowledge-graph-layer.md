---
title: "Knowledge Graph Layer"
section: 5a
tier: operations
description: "Neo4j knowledge graph for agent learning, pattern emergence, and relationship intelligence"
---
## 5a. Knowledge Graph Layer

**Status:** Board-approved 2026-03-13 (implementation ADR-019). Production deployment gated on Linus security fixes.

### Purpose and Separation of Concerns

Postgres is the single operational truth for task coordination, state transitions, guardrail enforcement, and audit. It does not change. Neo4j is an advisory learning layer alongside Postgres — it stores agent capabilities, task outcomes, learned patterns, and decision history, enabling agents to discover peers, improve assignment decisions, and surface patterns invisible in tabular data.

**Division of authority:**

| Layer | Role | Authoritative For |
|-------|------|-------------------|
| Postgres | Operational truth + enforcement | Task state, guardrails, budgets, audit trail |
| Neo4j | Relationship intelligence + agent learning | Capability graphs, outcome patterns, decision history |

No enforcement logic moves to Neo4j. All constitutional gates remain enforced at the Postgres transaction boundary (P2 unchanged). If Neo4j and Postgres disagree on any fact, Postgres wins.

### Graph Model

**Nodes:** Agent, TaskOutcome, Pattern, Decision, Capability

**Edges:**

| Edge | From → To | Meaning |
|------|-----------|---------|
| `COMPLETED_TASK` | Agent → TaskOutcome | Agent produced this outcome |
| `PROPOSED_DECISION` | Agent → Decision | Agent was the decision author |
| `HAS_CAPABILITY` | Agent → Capability | Agent has demonstrated this capability |
| `CAN_DELEGATE_TO` | Agent → Agent | Delegation relationship (derived from assignment history) |
| `SIMILAR_TO` | TaskOutcome → TaskOutcome | Outcome similarity (Cypher relationship, not pgvector) |
| `LEARNED_FROM` | Agent → Pattern | Agent has incorporated this pattern |

**Security constraint:** No PII in graph nodes. Nodes reference type + ID only (e.g., `{type: "email", id: "msg-0042"}` — never subject lines, intent titles, or contact names). Graph data is advisory — never used as input for enforcement decisions.

### Sync Mechanism

Graph data is populated asynchronously from Postgres events. The sync path uses an outbox table for durability (the same pattern as `task_events` in §3):

1. Postgres writes to `agent_graph.graph_sync_outbox` as part of the state transition transaction
2. Sync listener reads outbox entries via `FOR UPDATE SKIP LOCKED`, writes to Neo4j, marks delivered
3. If Neo4j is unavailable, entries accumulate in the outbox — no data loss, no agent impact
4. If the sync listener restarts, it replays undelivered outbox entries

**Events that trigger graph sync:** `task_completed`, `intent_decided`, `draft_reviewed`

`pg_notify` is used for low-latency notification that outbox entries are waiting. It is not the durability mechanism — the outbox table is. A `pg_notify` drop (e.g., listener restart) causes a sync delay, not data loss.

### Tier-Gated Reflection

Only higher-tier agents have access to `reflect()` — the capability to query Neo4j before making decisions. Executor agents (Haiku) have no graph access in their hot path.

| Tier | `reflect()` Access | Typical Use |
|------|--------------------|-------------|
| Strategist | Yes | Query outcome patterns before priority scoring |
| Architect | Yes | Query pipeline patterns before analysis |
| Orchestrator | Yes | Query capability data before task assignment |
| Reviewer | No | — |
| Executor | No | — |

Access is enforced by the orchestration layer (P1): `reflect()` is not in the executor tool allow-list. Agents do not self-police this.

### Graceful Degradation

Neo4j is valuable but not load-bearing. If Neo4j is unavailable:

- Agents continue operating normally via the Postgres task graph
- `reflect()` calls return empty results (no error, no blocking)
- Sync listener queues events in the outbox and retries on reconnect
- The only loss is learning data recency — operational integrity is unaffected

This is a hard design constraint: any code path that calls Neo4j must handle connection failure without propagating the error to the agent execution path.

### P4 Exception

Neo4j is not "boring infrastructure" (P4). This tension is acknowledged, not resolved. The exception is justified by two factors: (1) multi-hop relationship traversal and pattern emergence — the query patterns that make learning useful fight the relational model at 3+ hops; (2) client demonstration of graph intelligence as a capability of the Optimus organizational model. All enforcement remains in Postgres. P4's intent — minimize novel infrastructure dependencies — is satisfied for the enforcement layer. The learning layer accepts the tradeoff.

**Simpler aggregations** (e.g., agent success rates, task type distributions) remain in Postgres as materialized views. Neo4j is used only where graph traversal is structurally necessary.

### Cross-References

- ADR-019: `autobot-inbox/docs/internal/adrs/019-neo4j-knowledge-graph.md` — implementation decision record
- P1: Neo4j read access is explicitly granted per agent tier; A2A (self-declared capabilities) was rejected for P1 violation
- P2: All guardrails remain in Postgres; Neo4j is advisory
- P3: Learning graph makes agent improvement observable and auditable
- P4: Exception acknowledged; see above
- P5: Graph data enables richer capability gate assessments (measure before you trust)
- §2 Agent Tiers: Reflection gated by tier
- §3 Task Graph: Postgres task graph unchanged; Neo4j is additive
- §5 Guardrail Enforcement: No enforcement moves to Neo4j

---
