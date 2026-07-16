---
title: "ADR-019: Neo4j Knowledge Graph for Agent Learning"
status: Accepted
date: 2026-03-12
decision_date: 2026-03-13
---

# ADR-019: Neo4j Knowledge Graph for Agent Learning

## Context

Optimus agents are output-only. They write to the task graph (work items, state transitions, intents, action proposals) but never read back outcomes, peer capabilities, or feedback patterns. The data for learning exists in Postgres — intent match rates, edit deltas, event logs, reviewer feedback, gate failure patterns — but no agent consumes it.

This is a structural gap, not a missing feature. The task graph was designed for coordination (claim-execute-transition), not reflection. Additionally, relationship-heavy queries that would enable learning — agent capability graphs, task similarity scoring, multi-hop pattern traversal, decision-outcome linkage — are structurally awkward in relational SQL. They can be approximated with materialized views and recursive CTEs, but the query patterns fight the data model.

Separately, Google's Agent-to-Agent (A2A) protocol was evaluated for agent coordination and capability discovery. It was rejected for internal use due to P1/P2 violations (self-declared capabilities, HTTP-based discovery with no infrastructure enforcement). A2A remains a candidate for future external gateway interoperability.

## Decision

Add Neo4j as a complementary knowledge and learning layer alongside Postgres. Postgres remains the single operational truth for task coordination, state transitions, and guardrail enforcement. Neo4j stores agent capabilities, task outcomes, learned patterns, and decision history — enabling agents to discover peers, learn from results, and improve over time.

### Key design choices:

1. **Postgres is authoritative, Neo4j is derived** — all source-of-truth data originates in Postgres. Neo4j is populated via event-driven sync (`pg_notify` -> sync listener). If Neo4j and Postgres disagree, Postgres wins.
2. **Async writes, no blocking** — no graph write blocks agent execution. The sync listener processes events asynchronously. Agent latency is unaffected.
3. **Graceful degradation** — if Neo4j is unavailable, agents continue operating normally. They lose access to learned patterns and capability intelligence, but the task graph functions without interruption. Learning is valuable but not load-bearing.
4. **Reflection is tier-gated** — only higher-tier agents (strategist, architect, orchestrator) get a `reflect()` capability that queries Neo4j. Executors (Haiku) stay fast and focused with no graph queries in their hot path.
5. **P2 preserved** — Neo4j is a read layer for agents. All guardrails remain enforced at the Postgres transaction boundary. No enforcement logic moves to Neo4j.
6. **Neo4j Community Edition** — no enterprise license required. Hosted on Railway alongside existing infrastructure.

### Graph model (initial):

- **Nodes**: Agent, Task, Pattern, Decision, Capability, Outcome
- **Edges**: PERFORMED, PRODUCED_OUTCOME, SIMILAR_TO, LEARNED_FROM, ASSIGNED_BY, DELEGATES_TO, HAS_CAPABILITY

## Alternatives Considered

| Alternative | Rejected Because |
|-------------|-----------------|
| Postgres-only with materialized views | Possible for simple aggregations but structurally awkward for relationship traversal, pattern similarity, and multi-hop queries. Recursive CTEs become unmaintainable at 3+ hops. The query patterns fight the relational model. |
| A2A Protocol for capability discovery | P1 violation (self-declared capabilities invert deny-by-default). P2 violation (HTTP discovery with no infrastructure enforcement). Appropriate for external gateway, not internal coordination. |
| In-memory agent state | Volatile — no persistence across restarts, no cross-agent visibility, no historical pattern accumulation. Fundamentally incompatible with P3 (transparency by structure). |
| Embedding similarity in Postgres (pgvector) | Already used for voice profile similarity. Insufficient for relationship traversal and multi-entity pattern queries. Good for "find similar content," poor for "trace the decision chain that led to this outcome." |

## Consequences

### Positive

- **Agents can learn** — strategist reads outcome data to improve priority scoring, orchestrator reads capability data to improve assignment, architect reads pattern data to optimize the pipeline
- **Capability discovery** — agents can find peers best suited for specific task types based on historical performance, not static configuration
- **Pattern emergence** — graph queries surface patterns invisible in tabular data (recurring failure modes, successful delegation chains, task type clusters)
- **P3 alignment** — learning graph makes agent improvement observable and auditable (transparency by structure)
- **P5 alignment** — capability gates can incorporate historical performance data from the graph (measure before you trust)

### Negative

- **P4 tension** — Neo4j is not "boring infrastructure." It's a new dependency justified by the organizational model (agents that learn), not by operational necessity. This tension is acknowledged, not resolved.
- **New infrastructure dependency** — Neo4j Community on Railway adds hosting cost, operational surface area, and a new failure mode
- **Sync complexity** — event-driven sync between Postgres and Neo4j introduces eventual consistency. Learning data may lag operational data by seconds to minutes.
- **Learning curve** — Cypher (Neo4j query language) is a new skill for contributors. Mitigated by limiting graph queries to a small number of well-defined patterns in a dedicated module.

### Neutral

- **No schema migration** — Neo4j is schema-optional. Graph model evolves without DDL migrations.
- **No Postgres changes required** — `pg_notify` events already exist for state transitions. The sync listener is a new consumer of existing events.
- **Executor agents unaffected** — no changes to Haiku executor hot paths. Only strategist, architect, and orchestrator gain `reflect()`.

## Affected Files

| File | Change |
|------|--------|
| `src/graph/` (new) | Neo4j client, sync listener, graph query module |
| `src/agents/strategist.js` | Add optional `reflect()` — query outcome patterns before priority scoring |
| `src/agents/architect.js` | Add optional `reflect()` — query pipeline patterns before analysis |
| `src/agents/orchestrator.js` | Add optional `reflect()` — query capability data before task assignment |
| `config/agents.json` | Add `graph_enabled` flag for tier-gated reflection |
| `docker-compose.yml` or Railway config | Neo4j Community service |

## Spec References

- P1 Deny by default — A2A rejected for P1 violation. Neo4j read access is explicitly granted per agent tier.
- P2 Infrastructure enforces — all guardrails remain in Postgres. Neo4j is advisory/learning only.
- P3 Transparency by structure — learning graph makes agent improvement observable
- P4 Boring infrastructure — **tension acknowledged**. Neo4j justified by organizational model requirement (agent learning), not technical preference.
- P5 Measure before you trust — graph data enables richer capability gate assessments
- §2 Agent Tiers — reflection gated by tier (strategist/architect/orchestrator only)
- §3 Task Graph — Postgres task graph unchanged, Neo4j is additive
- §5 Guardrail Enforcement — no enforcement moves to Neo4j

---

## Board Decision

**Date:** 2026-03-13
**Status:** Accepted with conditions

The board approved Neo4j integration on 2026-03-13. Production deployment is gated on Linus security fixes being resolved (see Review Findings below). Neo4j may run in development and staging environments in the interim.

**Board rationale:** Dual purpose justified the P4 exception — (1) agent learning layer enabling capability-based routing and outcome-pattern reflection, (2) client demonstration of graph intelligence capabilities as a differentiator for the Optimus organizational model. Liotta's Postgres-only alternative was considered but rejected as insufficient for the multi-hop relationship traversal the client demo and agent reflection use cases require.

### Review Findings

**Linus (Security Review — 2026-03-13):** Architecture is sound. P2 boundary holds — Neo4j is read-only for agents and has no enforcement role. Required fixes before production deployment:

1. `NEO4J_USER` is hardcoded in `src/graph/client.js` — must move to `NEO4J_USER` env var alongside the existing `NEO4J_PASSWORD` handling.
2. Intent titles are written to graph nodes verbatim — PII leakage risk. Titles must be scrubbed (type + ID reference only) before sync writes.
3. `pg_notify`-based sync has no durability guarantee — if the sync listener is down, events are dropped. Outbox table required (see §5.3 of SPEC.md knowledge graph section).
4. `permission_grants` seeding in the migration includes Neo4j connection — remove from seed; grants must be authorized through the standard permission workflow (P1).

**Liotta (Architecture Review — 2026-03-13):** Initially recommended Postgres-only learning schema (materialized views + pgvector for similarity). Updated position after board decision: proceed with Neo4j for the dual-purpose justification, with the following conditions incorporated into implementation:

1. Current reflect() queries are one-hop only — multi-hop Cypher queries must be implemented before the graph DB overhead is justified over a view-based approach. Target: at least one 2-hop capability-chain query in strategist.reflect() before Phase 1 exit.
2. Postgres learning schema (materialized views over task outcomes) is recommended as a complement — not a replacement — for simpler aggregations that don't need graph traversal.
3. `pg_notify` durability gap is the most significant architectural risk. The outbox pattern (write to Postgres outbox table first, sync listener reads from outbox, marks delivered) is required before production. This aligns with the existing `task_events` outbox pattern in §3.
