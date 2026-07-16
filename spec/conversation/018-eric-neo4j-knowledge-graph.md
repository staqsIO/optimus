# 018: Neo4j Knowledge Graph for Agent Learning

**Author:** Eric
**Date:** 2026-03-12
**Status:** Proposal — board review requested
**Spec sections affected:** §3 Agent Configuration, §5 Guardrail Enforcement (new: learning layer)

## The Problem: Agents Don't Learn

The agent-loop is output-only. Agents write work items, intents, and decisions to Postgres, but they never read back outcomes, feedback, or peer capabilities. The data for learning already exists — intent match rates, edit deltas, event logs, reviewer feedback, gate failure patterns — but no agent consumes it.

This isn't a missing feature. It's a structural gap. The task graph was designed for coordination (claim-execute-transition), not reflection. An executor that gets 40% of its triage classifications corrected by the board has no mechanism to incorporate that signal. An orchestrator assigning work has no visibility into which executor handles which task types best. The strategist recommending priorities cannot see whether its previous recommendations led to good outcomes.

The data is there. The consumption path is not.

## A2A Protocol Evaluation and Rejection

Linus and Liotta reviewed Google's Agent-to-Agent (A2A) protocol as a potential solution for agent coordination and capability discovery. The protocol defines HTTP-based agent cards with self-declared capabilities, discovery endpoints, and negotiation flows.

**Rejected for internal use.** The protocol violates two non-negotiable design principles:

- **P1 (Deny by default):** A2A uses self-declared capability cards. Agents advertise what they can do. In Optimus, agents have no capabilities unless infrastructure explicitly grants them. Self-declaration inverts the trust model.
- **P2 (Infrastructure enforces; prompts advise):** A2A discovery is HTTP-based and trust-on-first-use. There is no infrastructure enforcement layer — an agent's declared capabilities are taken at face value. Optimus requires that the enforcement boundary is never the agent itself.

A2A may be appropriate as a **future external gateway** — if Optimus agents need to interact with third-party agent systems, A2A provides a reasonable interoperability protocol. But internally, agent coordination flows through the Postgres task graph with infrastructure-enforced constraints.

## Neo4j as Complementary Knowledge Layer

The proposal is to add Neo4j as a **learning and relationship graph** alongside Postgres. This is not a replacement — Postgres remains the operational truth for task coordination, state transitions, and guardrail enforcement. Neo4j adds a layer that Postgres is structurally awkward at: relationship intelligence, pattern emergence, and agent memory.

### The Hybrid Model

**Postgres handles the task graph:**
- Work items, state transitions, guardrails (G1-G7)
- Permission grants, audit logging, hash chains
- All enforcement boundaries (P2)

**Neo4j handles the learning graph:**
- Agent capability profiles (what each agent has done well, poorly, and how recently)
- Task outcome patterns (which task types succeed/fail, common failure modes)
- Decision history with outcome linkage (strategist recommended X, outcome was Y)
- Cross-agent relationship mapping (who delegates to whom, success rates by pairing)
- Pattern similarity for few-shot retrieval (find tasks structurally similar to the current one)

### Sync Architecture

- Event-driven via `pg_notify` — Postgres state transitions emit events, a sync listener writes to Neo4j
- Writes are **async** — no graph write blocks agent execution
- **Graceful degradation** — if Neo4j goes down, agents still operate. They lose access to learned patterns and capability intelligence, but the task graph continues functioning. Learning is valuable but not load-bearing.

### Reflection is Tier-Gated

Not every agent gets a `reflect()` capability. Executors (Haiku) stay fast and focused — they don't need to introspect on their performance history. Reflection is reserved for higher-tier agents:

- **Strategist**: Reads outcome data to improve priority scoring
- **Architect**: Reads pattern data to improve pipeline optimization
- **Orchestrator**: Reads capability data to improve task assignment

This preserves the tier hierarchy (SPEC §2) and keeps executor latency low.

## P4 Tension: This Is Not "Boring Infrastructure"

Neo4j is a graph database. It is not Postgres, SQL, JWT, or hash chains. Adding it introduces a new infrastructure dependency that the spec's design principles explicitly caution against (P4: "Novelty is for the organizational model, not the plumbing").

The counterargument: the organizational model (agents that learn from outcomes, discover peer capabilities, and self-improve) **requires** graph-native capabilities. Multi-hop relationship traversal, pattern similarity scoring, and capability graph queries are structurally awkward in relational SQL. Materialized views can approximate some of this, but the query patterns are fighting the data model.

The P4 tension is real and should not be hand-waved. Neo4j is justified only because the capability it enables (agent learning) is core to the Optimus thesis — not because it's technically elegant. If this were a nice-to-have feature, Postgres materialized views would be the right call. It's not nice-to-have. Agents that don't learn are expensive prompt-runners, not an organization.

## Board Discussion Points

1. **P4 override justification**: Is agent learning sufficiently core to the Optimus thesis to justify a non-boring infrastructure addition? The argument is yes — Optimus without learning is just a pipeline, not an organization.

2. **Failure modes**: Neo4j down means no learning, but agents still operate. Is this acceptable, or should there be a Postgres fallback for critical learning data?

3. **Data classification**: Which data lives in Neo4j vs. Postgres? The proposed boundary is operational (Postgres) vs. analytical/learning (Neo4j). Should any learning data also be materialized in Postgres for resilience?

4. **Cost**: Neo4j Community Edition on Railway. What's the hosting cost, and does it fit within Phase 1 budget constraints?

5. **Phase sequencing**: Should this be Phase 2 work (after Phase 1 exit validation), or is it foundational enough to begin now?
