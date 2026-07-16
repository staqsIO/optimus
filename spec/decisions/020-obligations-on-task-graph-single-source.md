# ADR-020: Obligations on the task graph as the single source of truth

- **Status:** Accepted (feature spec 010, Q3; board ratified 2026-06-14 — Eric + Dustin)
- **Date:** 2026-06-14
- **Deciders:** Eric, Dustin (board)
- **Related:** feature `spec/features/010-close-the-obligation-loop.md`, ADR-008 (signal→action bridge / reversibility), SPEC §3 (task graph)
- **Principles:** P1 (deny-by-default), P3 (transparency by structure — one lifecycle), P4 (boring infra — reuse the existing task graph, add no new store), P5 (measure before auto-close)

---

## Context — three stores, no owner

An obligation today can live in up to three places:

1. **`inbox.signals`** — the raw extraction layer. Every obligation starts here as telemetry (signal_type, direction, domain, confidence). ~1,900 unresolved in prod.
2. **`inbox.human_tasks`** — board cards. The Today surface ("Open Obligations") reads this table. Created by the bridge for *gated* obligations and by other callers.
3. **`agent_graph.work_items`** — the task graph. SPEC §3 already designates this "the single source of truth for all agent coordination." The bridge promotes *some* obligations here (autonomous + gated); these project to the issues board (Linear) via executor-ticket.

Resolution is equally split: the Gmail poller resolves `inbox.signals` on a same-thread reply; `signal-resolver` resolves the source signal when a *bridge-spawned* work_item reaches terminal; manual verbs hit `human_tasks`. The consequence (surfaced building feature 010): **the board shows `human_tasks`, but most auto-resolution writes `inbox.signals` — different tables, so a resolution can silently fail to reflect on the surface the board actually looks at.** No single object owns an obligation's lifecycle, so obligations rot until a staleness window drops them, and the "issues board" projection exists only for the subset that went through the bridge.

Feature 010 (close the obligation loop) needs one place to read, act on, resolve, and infer-satisfaction against. It cannot be built correctly on a three-way split.

## Decision

**Make the agent task graph (`agent_graph.work_items`) the single source of truth for obligations.** Concretely:

1. **Every extracted obligation is promoted to a work_item.** The existing bridge promotion path (ADR-008) generalizes from "some obligations" to "all eligible obligations" as the canonical lifecycle object. `inbox.signals` remains the raw *extraction/provenance* layer (immutable telemetry of what was detected) — it is the source signal, not the lifecycle owner.
2. **The board's Today surface reads work_items** (directly or via a view), not `inbox.human_tasks` as an independent store.
3. **`inbox.human_tasks` becomes a projection/card layer over work_items** (it is already partly this for gated items), not a parallel source of truth. It surfaces the human-facing card; the work_item owns state.
4. **All resolution — manual verbs and inferred satisfaction (010 US-3/US-4) — writes the work_item's terminal state**, which cascades provenance back to the originating `inbox.signals` row. One write path, one lifecycle.
5. **work_items continue to project to the issues board (Linear)** via the existing executor-ticket path, so "the issues board" and "the obligation list" are the same objects viewed two ways.

## Consequences

**Positive**
- One lifecycle object → P3: an obligation's state, provenance (source signal/message/meeting), and resolution are all on one row, transparently.
- Satisfaction inference (010) writes exactly one place; the board reflects it immediately — the split-table bug is structurally impossible.
- Reuses the task graph (P4) — no new store, no novel infra. Aligns with SPEC §3.
- The board's obligation view and the agent issues board converge.

**Costs / risks**
- **Migration:** ~1,900 live obligations spread across signals/human_tasks must be reconciled into work_items (backfill + dedup; the bridge's content-hash dedup helps). Sequencing matters — do not double-surface during transition.
- The Today query and per-viewer scoping must move to work_items without regressing the tenancy fixes already shipped (OPT-115/126/STAQPRO-588 semantics).
- `human_tasks` consumers (action API, board cards) must be re-pointed at work_items or kept working through the projection.

## Alternatives considered

- **Bridge the three stores (sync resolution across them) instead of unifying.** Rejected: faster but cements the debt; the split-table class of bug recurs; two writers of "resolved" never stay consistent.
- **Make `inbox.signals` the source of truth.** Rejected: signals are raw detection telemetry (one message can emit several; they are immutable provenance), not coordination objects. SPEC §3 already names the task graph the coordination SoT.
- **Keep `human_tasks` as the SoT (it's what the board reads today).** Rejected: human_tasks is a human-card view, has no agent-coordination semantics, and doesn't project to the issues board.

## Open questions

- [ ] **Migration sequencing:** big-bang backfill vs. forward-only (new obligations on work_items, old ones drained in place)? Forward-only avoids a risky bulk migration but prolongs the split.
- [ ] **Retire vs. retain `human_tasks`:** convert it to a view over work_items, or keep the table and treat it as a denormalized card cache?
- [ ] **Linear projection scope:** project *all* obligations to the issues board, or only actionable/assigned ones (avoid flooding Linear with low-value items)?
- [ ] **Per-viewer scoping parity:** confirm work_items carries (or gains) the owner/viewer fields needed to preserve the shipped tenancy guarantees.

## Sign-off

- [x] Author (Claude, on Eric's direction)
- [x] Eric (board) — 2026-06-14
- [x] Dustin (board) — 2026-06-14 ("it's good")
