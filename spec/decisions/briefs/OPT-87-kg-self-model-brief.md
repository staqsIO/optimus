# Board Decision Brief: OPT-87 — Knowledge Graph as Agent-Consumable Self-Model

**Brief date**: 2026-06-13
**Source ADR**: `spec/decisions/013-knowledge-graph-agent-self-model.md` (Status: Proposed, 2026-05-31)
**Plan reference**: Phase 6 of the Proper Path plan ("Entity-brain connective fabric")
**Decision required from**: Board (Dustin + Eric)

---

## One-sentence question

May Optimus agents read the `/understand` knowledge graph — a structural map of the codebase (3,657 nodes, 5,597 edges) — as a self-model to improve their proposals, with explicit boundaries preventing it from becoming a self-modification path?

---

## What is being proposed

ADR-013 proposes that the **Architect tier** and **Reviewer** agents may query the existing Neo4j graph (`lib/graph/`) to answer structural questions (impact analysis, blast-radius checks, layer attribution) rather than re-grepping raw files each session. The graph would be populated by ingesting the `/understand` structural export into the existing `lib/graph/sync.js` / `pattern-extractor.js` subsystem.

**What this is NOT:**
- Agents cannot modify the graph.
- Agents cannot act on graph-derived conclusions without going through the existing governed loop (`reviewer → guard-check → CI ratchets → board`).
- The graph does not confer authority; it improves the quality of proposals before they enter the governed loop.

**The self-understanding / self-improvement distinction** (ADR-013 §Context):
- Self-understanding = agents read a structural map to reason better. Zero new authority.
- Self-improvement = agents act to change the system. This already exists as the governed loop. The graph only improves the *analyze/scope* steps of that loop.

---

## What the board is being asked to approve

1. **Permission** for Architect-tier and Reviewer agents to query the Neo4j graph via `lib/graph/queries.js` for structural self-model reads.
2. **Policy**: guardrail-region nodes (`lib/runtime/guard-check.js`, gate configs, JWT identity, RLS migrations, `autonomy-controller.js`) are flagged as `self-modification-sensitive`; any proposal whose impact set touches these nodes is automatically board-escalated and never presented as final.
3. **Freshness rule**: graph reads require a provenance guarantee; stale maps (configurable threshold) are denied by default (P1). Agents must record which graph snapshot they used in their reasoning.
4. **Capability gate**: any autonomous action derived from graph conclusions is capability-gated (P5, measure before trust). Initial deployment is architect-reads-only, no autonomous action.

---

## Risks per Lethal Trifecta / P2

| Risk | Assessment | Mitigation in ADR-013 |
|---|---|---|
| Agent reads guardrail implementation and proposes weakening it | Medium likelihood, high impact | Guardrail-region nodes flagged; proposals auto-escalated to board; never auto-merged |
| Stale graph leads to wrong impact analysis | Medium likelihood, low-medium impact | Freshness gate (deny-by-default if graph is stale); graph is read-only (no write path from agents) |
| Graph becomes an authority oracle ("graph said so") | Low likelihood if boundary is explicit | ADR-013 §Decision.2 explicitly: "No agent may merge or enact a change because the graph 'said so.'" |
| New attack surface for prompt injection via graph nodes | Low with current architecture | Graph nodes are structurally extracted (not free-text from external sources); injection risk is lower than RAG |

**P2 (infrastructure enforces):** the self-model does NOT move the enforcement boundary. `guard-check.js` G1-G11 and CI ratchets remain the enforcement layer; the graph is upstream of them in the proposal-quality chain, not a bypass.

---

## Recommendation

**Approve ADR-013 as proposed.** The risk profile is acceptable: the graph is read-only, the governed loop is unchanged, guardrail-region nodes are explicitly flagged for board escalation, and the freshness gate denies stale reads by default.

**Sequencing note**: Phase 6 (this) is downstream of Phase 2 (PR-B, RLS live) and Phase 4 (bridge dry-run). Approving this ADR now unblocks implementation planning without committing to a delivery date.

**Open questions for the board** (from ADR-013 §Open Questions):
1. What is the acceptable staleness threshold for graph freshness? (Proposed: 24h for architect reads, 1h for reviewer blast-radius checks.)
2. Should the guardrail-region node list be board-curated (explicit allowlist) or auto-derived from file-path patterns? (Proposed: auto-derived with explicit overrides, audited quarterly.)
3. Does Dustin want to review the first agent session that uses graph-derived reasoning before it becomes standard practice?
