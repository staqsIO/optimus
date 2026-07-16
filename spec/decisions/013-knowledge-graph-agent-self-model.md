# ADR-013: Knowledge Graph as Agent-Consumable Self-Model

**Date**: 2026-05-31
**Status**: Proposed
**Issue**: The `/understand` knowledge graph (3,657 nodes / 5,597 edges — files, functions, layers, dependency edges, a guided tour of the optimus codebase) is being surfaced to the human board as a Board Workstation view (feature spec `001-architecture-graph-in-board`, PR #288). The board asked whether Optimus itself — the agent organization — can consume this graph for self-understanding and self-improvement. That is a different question with autonomy- and security-boundary implications, so it gets its own decision record.

---

## Context

### What the graph is

A structurally-extracted, queryable map of the codebase: file/function/config/table nodes; `imports` / `calls` / `contains` / `migrates` / `tested_by` edges; a 9-layer architectural decomposition; and a 15-step guided tour. It answers structural questions deterministically — "what depends on `lib/runtime/guard-check.js`?", "what does migration 123 touch?", "which layer owns this file?" — without re-grepping the repo or re-reasoning from scratch each session.

It is a **map, not comprehension**. It carries summaries, but it is structural/relational; it sharpens reasoning about the system, it does not replace reading code.

### The bones already exist

Consuming a self-model is not new infrastructure — Optimus already owns the primitives (consistent with the "wiring, not building" framing of ADR-008):

| Need | Optimus primitive (exists) | Gap |
|---|---|---|
| A queryable graph store agents already use | Neo4j subsystem `lib/graph/*` (`client.js`, `sync.js`, `queries.js`, `pattern-extractor.js`, `schema.js`) | The `/understand` structural graph is not ingested into it; agents have no structural self-model to query |
| Retrieval over knowledge | RAG pipeline `lib/rag/*` (863 docs) | Node summaries / edges are not an indexed retrieval source |
| Autonomous codebase exploration | Architect tier + `claw-explorer` | Re-explores from raw files each time; no persistent structural map |
| Pre-execution enforcement | `lib/runtime/guard-check.js` (G1-G11) | N/A — this is the gate the self-model must never bypass |
| Learns from sessions | `lib/runtime/retrospector.js`, `human_tasks.feedback_history` | Not wired to graph-derived proposal quality |
| Drift containment | Dead-man switch (SPEC §9), `lib/runtime/autonomy-controller.js` | Not bound to a self-model-acting action class |

### The distinction that governs everything

- **Self-understanding** = agents *read* a model of the system to reason better (impact analysis, scoped proposals, briefings, onboarding). Adds no authority.
- **Self-improvement** = agents *act* to change the system. This already exists as a **governed loop** (architect analyzes → orchestrator coordinates → executor-coder opens a PR → reviewer + guard-check + CI ratchets + board gate). The graph can only improve the *analyze/scope* steps of that loop. It must never become a path that moves the enforcement boundary.

### Why this needs an ADR, not just wiring

Per repo `CLAUDE.md`, anything touching **autonomy** or **security boundaries** is a board decision. A self-model that agents read to reason about — potentially including reasoning about their own guardrails — sits squarely there. It also adds to the "read internal/private state" leg of the **Lethal Trifecta** (CONSTITUTION) for any tier that also has write or external-comms capability.

---

## Decision

Five decisions, stated plainly. All are gated by board acceptance of this ADR; until then the graph remains a human-viewing artifact only (spec 001).

### 1. The graph MAY serve as an agent-consumable structural self-model — read-only, scoped by tier

Permitted consumers and uses:
- **Architect / `claw-explorer`** — impact analysis and topology-aware analysis instead of re-exploring raw files; input to the daily briefing.
- **Research / Reviewer** — retrieval context and blast-radius checks ("what does this change touch?") before/around executor work.
- **Onboarding** — the same layer map + tour given to a new agent or task that a human board member gets.

The canonical home is the existing **Neo4j self-model** (`lib/graph/*`): ingest the `/understand` graph as a structural layer via `sync.js`/`pattern-extractor.js`, queried through `queries.js`. Optionally index node summaries into RAG. This reuses boring, owned infrastructure (P4) rather than adding a parallel store.

### 2. The self-model improves proposals; it NEVER gates self-modification

No agent may merge or enact a change because the graph "said so." All system changes remain gated by reviewer + `guard-check.js` (G1-G11) + CI ratchets (CG-1..CG-5) + board approval. The graph raises proposal quality and shrinks blast radius; it does not confer authority. (P1 deny-by-default, P2 infrastructure-enforces.)

### 3. Guardrail-region nodes are flagged; proposals touching them are board-escalated

Nodes for the enforcement layer itself — `lib/runtime/guard-check.js`, the gate configs, JWT identity (`agent-jwt`/`board-jwt`), `autonomy-controller.js`, the audit ledger, RLS migrations — are tagged as **self-modification-sensitive**. Any agent proposal whose impact set (per the graph's own edges) intersects this region is automatically routed to the board and never presented as final. An agent reasoning about and proposing changes to its own guardrails is the exact case the governance model exists to keep human-gated.

### 4. Consumption requires a freshness + provenance guarantee (deny-by-default for stale maps)

A human glancing at a slightly-stale map is harmless; an agent *acting on* one is a correctness bug. Therefore:
- The self-model carries provenance: `gitCommitHash` + `analyzedAt` (already in `meta.json`).
- Agents may only consume a graph within a defined freshness window relative to `HEAD`; beyond it, the self-model is treated as **unavailable** (deny-by-default), not "best effort." Stale-but-used is worse than absent.
- This makes the refresh pipeline (flagged as load-bearing in spec 001) a hard dependency for agent consumption, not a nicety.

### 5. Any autonomous action on graph-derived conclusions is capability-gated (measure before trust)

Default is **suggest-mode** (consistent with the Strategist's Phase-1 posture). Promotion of any tier to act with reduced human review on graph-derived conclusions is gated on measured data (P5) — e.g. proposal-acceptance rate, false-impact rate — surfaced through the capability-metrics view (`v_phase1_metrics`), bound per action-class to the `autonomy-controller` / dead-man switch. No capability activates on a calendar date.

---

## Consequences

**Positive**
- Higher-quality, properly-scoped agent proposals; fewer "didn't realize that touched X" mistakes.
- Reuses existing Neo4j + RAG + retrospector primitives — wiring, not new infrastructure (P4).
- A plausible, governed building block toward AutoBot's self-model, without granting new autonomy now.

**Negative / risk**
- The self-model strengthens the "read internals" leg of the Lethal Trifecta; any tier holding it plus write/comms needs the decision-3 escalation and tighter scoping.
- Staleness becomes a first-class correctness risk → hard dependency on the refresh pipeline.
- Ingestion + freshness plumbing is real work in `lib/graph/*`; structural-only model can mislead an agent into over-trusting a map that lacks behavioral nuance.

**Neutral**
- The human-facing viewer (spec 001) ships independently and is unaffected by whether this ADR is accepted.

---

## Alternatives Considered

- **Do nothing (human-viewing only).** Ship spec 001; agents keep re-exploring raw files. Lowest risk, forgoes the proposal-quality gains. Valid if the board wants to defer agent consumption.
- **Standalone graph store / API for agents.** Rejected: parallels the existing Neo4j self-model; violates "boring infrastructure" (P4).
- **Unrestricted agent read of the graph (no tier scoping / no freshness gate).** Rejected: violates deny-by-default and ignores the staleness correctness risk.
- **Let graph-derived conclusions auto-act with reduced review.** Rejected for Phase 1: violates P2 and the measure-before-trust gate; this is exactly the human-queue-as-gate failure ADR-008 is correcting, but the fix is a deterministic pre-execution mesh, not autonomy granted by a structural map.

---

## Relationship to Other Artifacts

- **Feature spec `001-architecture-graph-in-board` (PR #288)** — the human-viewing counterpart. Viewer for the board; this ADR for the agents. They share the graph artifact and the refresh pipeline.
- **ADR-008 (agent-native governed operating layer)** — same "primitives exist, wire them" thesis; the self-model is a candidate input to the pre-execution validator mesh / decision-context graph described there.
- **ADR-019 / `lib/graph` (Neo4j)** — the intended store for the ingested self-model.
- **CONSTITUTION (Lethal Trifecta), SPEC §0 (P1-P6), SPEC §5 (guardrails), SPEC §9 (kill switch)** — the constraints decisions 2–5 enforce.
- On acceptance, reflect the self-model and its autonomy posture in `SPEC.md` (and bump `CHANGELOG.md`) per `spec/CLAUDE.md`.

---

## Open Questions

1. **Ingestion shape:** full UA graph into Neo4j, a board-relevant subset, or RAG-indexed summaries only? Start narrow (impact-analysis edges) and expand?
2. **Freshness window:** what staleness threshold makes the self-model "unavailable" to agents — same commit only, N commits, or content-fingerprint delta?
3. **Tier scoping:** confirm the exact allowlist (Architect, Research, Reviewer) and whether the Orchestrator may read it for routing.
4. **Self-modification-sensitive region:** finalize the node set tagged as guardrail/identity/audit and the auto-escalation rule.
5. **Metric gate:** which measured signals (proposal-acceptance rate, false-impact rate) and what thresholds before any reduced-review promotion?

---

## Status / Next Step

**Proposed.** Requires board decision (Eric + Dustin) per `spec/CLAUDE.md` and the autonomy/security-boundary rule in `CLAUDE.md`. Not to be implemented until accepted. On acceptance, decompose into execution issues (Neo4j ingestion via `lib/graph`, freshness/provenance gate, tier-scoped query path, guardrail-region tagging + escalation, metric instrumentation) and update `SPEC.md`.
