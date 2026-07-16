# ADR-008: Optimus as a Governed Agent-Native Operating Layer

**Date**: 2026-05-28
**Status**: Proposed
**Issue**: A Sept-2024 onboarding obligation ("set up Lester's accounts") surfaced in the `/today` Morning Brief as currently overdue — for a person hired 18 months ago and let go in February. Root cause exposed architectural drift from two founding principles.

---

## Context

### The trigger

The `/today` Morning Brief query (`api.js:1269`, `/api/today:1057`) reads `inbox.signals` raw, sorted overdue-first (`:1082`), with no recency floor. A Sept 15 2024 transcript was re-ingested on 2026-05-07; its onboarding obligations (due dates correctly `2024-09-15`) sit in `inbox.signals` with `resolved=false` permanently. They sort to the top of every brief. Haiku synthesizes "past due since Sunday." Production backlog: **2,629 unresolved obligations.**

The bug is not a query bug. It is an architecture bug.

### The two drifts

Optimus was founded on two non-negotiable design principles (SPEC §0):

- **P1. Deny by default.** Nothing is permitted unless explicitly granted.
- **P2. Infrastructure enforces; prompts advise.** The enforcement boundary is never the prompt.

It drifted into two anti-patterns that directly violate these:

**Drift 1 — Humans became the enforcement boundary.** Every agent action — draft replies, research, Linear issues, enrichment — waits for board approval before proceeding. All agents are effectively L0. The human queue is the only gate. This is P2 violated: the enforcement boundary is now a human, not infrastructure.

**Drift 2 — Collected data is never connected to action.** `inbox.signals` is a telemetry layer: extract, display, orphan. There is exactly one collect→act bridge anywhere in the codebase: `lib/contracts/spawn-work-items.js` (signed contract → work_item). 2,629 obligations have been extracted and are acted on by no one and nothing.

### The convergent external thesis

Three external reference points independently describe the same fix. They are cited as motivation, not authority.

**Polsia**: One orchestration layer runs every operational role with full dogfooding — the org is its own product. The governance and the work share the same substrate.

**builder.io agent-native** (agent-native.com/docs): The agentic system achieves parity between what a human can do in the UI and what an agent can do via API. Context-aware routing, skills-driven (playbooks, not re-reasoning), A2A federation, and self-modification through governance-gated "fork and customize." The key insight: if a human can resolve an obligation in the Today view and an agent cannot, the system is not agent-native.

**Microsoft/governance-economics essay on ungoverned agentic AI**: The central claim is that ungoverned agentic AI is a token-economics problem. The failure mode is LLM-verifying-LLM (a second model checking the first) and human-queue-as-gate ("invoices after, not authority before"). The proposed fix is a *pre-execution validator mesh* of deterministic graph operations — not probabilistic — plus a *persistent decision-context graph* that eliminates session re-reasoning, plus a *circuit-breaker* for drift detection. Estimated 40–70% token waste from the human-queue/LLM-verification pattern. [UNVERIFIED: the specific percentage range; verifiable by measuring tokens-per-closed-loop before and after the reversibility gate ships.]

**Parslee/Neo (Memgine)**: An operating layer that sits in front of the model providing identity, persistent memory, governance, and grounding. The "Neo" primitive: memory that learns from sessions and reduces the cost of re-reasoning the same context on every invocation.

### The bones already exist

Optimus already owns every primitive needed. None of this requires new infrastructure — only wiring:

| External pattern | Optimus primitive (exists) | Gap |
|---|---|---|
| Pre-execution validator mesh (deterministic, not LLM-on-LLM) | `lib/runtime/guard-check.js` G1-G11 + `checkDraftGates` | Only fires on agent claim transition; not the universal pre-execution authority for all action types |
| Persistent decision-context graph (no session re-reasoning) | Neo4j (ADR-019) + RAG (863 docs, 6,663 chunks) | Not read as a routing input; context enrichment exists but is not consulted at action-classification time |
| Circuit-breaker for drift | Dead-man switch (SPEC §9) + `autonomy-controller` | Not per-agent, not per-action-space bound; fires org-wide, not on individual action-class drift |
| Self-improvement / learns from sessions | `lib/runtime/retrospector.js` + `human_tasks.feedback_history` | Exists; not wired to routing thresholds or action-class promotion decisions |
| Agent+UI parity, context-aware, A2A | Board workstation + agent tier | UI actions (resolve, snooze, approve) are not callable by agents on the same DB rows |

---

## Decision

Four decisions, stated plainly.

### 1. Reframe Optimus as a governed agent-native operating layer

This is a return to P2 done correctly. The enforcement boundary is deterministic infrastructure — `guard-check.js` G1-G11 and `checkDraftGates` — running before every action of consequence. Humans gate only genuine irreversibility (external counterparty sends, money out the door, legal commitments). Everything else runs to completion.

The framing change is also a product claim: Optimus is the substrate in front of the models, not a collection of models with a dashboard on top.

### 2. Replace the human-gated L0/L1/L2 autonomy dial with a deterministic reversibility gate

The existing tier dial produced all-L0 in practice. Replace it with a two-state classification computed deterministically from four attributes of each signal at bridge time:

```
(signal_type, has_external_recipient, touches_money, touches_legal) → {autonomous | gated}
```

**`autonomous`** (reversible): internal work_item, Linear issue, draft reply (not sent), research task, contact/deal enrichment, RAG query, scheduling. The bridge spawns a `status='created'` work_item; the executor runs to completion immediately. No board card is created.

**`gated`** (irreversible): external send to a counterparty, money movement, legal commitment. The bridge spawns the work_item and the executor runs up to — but not through — the irreversible step. At that step the *existing* `guardCheck`/`checkDraftGates` gate fires. The board approves the **send**, not the work leading up to it.

This is not less safe. The enforcement boundary is identical — the same deterministic gates that exist today (G1, G2, G3, G6, G10) — but it no longer fires for reversible actions where it adds zero safety value and maximum latency. The minimum always-gated set (confirmed by the Linus review): external counterparty sends, client-visible artifacts, budget spend.

### 3. Connect collected data to action and close the loop

The signal→action bridge (`autobot-inbox/sql/127-signal-action-bridge.sql` + `lib/runtime/signal-action-bridge.js`, `lib/runtime/signal-resolver.js`, and the `autobot-inbox/src/runtime/signal-action-reconciler.js` driver) is the first concrete implementation. It replaces the `resolved=false` orphan pattern:

- **Context decides what is still live** (`isStillLive`): the bridge consults contact/engagement/deal context — via Neo4j and RAG — not date arithmetic. An obligation from a terminated relationship is not live regardless of its due date.
- **Reversibility is computed at bridge time**, not at claim time.
- **Every closed loop feeds `retrospector.js`** and `human_tasks.feedback_history`. Routing thresholds are data, not config.
- **Agent+UI parity**: every resolve/snooze/approve action available to a human in the Today view is callable by an agent on the same DB rows.

The 2,629-obligation backlog is handled through a **Phase 0 dry-run**: the bridge runs in audit-only mode first, logging `would_route_to` without creating work_items, giving the board a preview of what would be promoted and under what classification.

### 4. Token economics is a first-class engineering metric

`tokens_per_closed_loop` is added to the Phase 1 metrics dashboard. The target direction is down. Deterministic gating, skills-driven routing (codified playbooks rather than per-run re-reasoning), and context read from the persistent graph rather than reconstructed from scratch each session are the levers. LLM-on-LLM verification is an anti-pattern; every instance of it is a regression against this metric.

---

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|---|---|---|---|
| Fix only the recency floor on the brief query | Surgical, low risk | Does not address the 2,629 backlog, does not close the collect→act gap, does not address P2 drift | Treats the symptom, not the cause |
| Keep L0 default, add explicit L1/L2 opt-in per signal type | Incremental, low blast radius | Still human-queue-as-gate; enforcement boundary remains human; token economics unchanged | Does not satisfy P2; does not achieve autonomous operation for any reversible action |
| LLM-as-validator (second model reviews first model's planned action) | No new infrastructure | Is the exact anti-pattern named in the governance-economics essay; probabilistic, not deterministic; adds tokens, not removes them | Violates P2 (prompts advise, infrastructure enforces); adds cost |
| External governance platform (OPA, Cedar, etc.) | Purpose-built for policy | Adds a new service dependency; Optimus already has `guard-check.js`; P4 (boring infrastructure) | Over-engineering; the deterministic gate already exists and just needs universal application |

---

## Consequences

**Positive:**
- The org acts. Reversible obligations close without a human round-trip.
- Cheaper operation: fewer human round-trips, no LLM-on-LLM verification, no session re-reasoning from scratch.
- Self-improving: routing thresholds update from closed-loop feedback via `retrospector.js`.
- Lester disappears as a structural side effect — the bridge correctly classifies a terminated-relationship obligation as not live.
- P2 is restored: enforcement is deterministic infrastructure, not human queues.

**Negative / Risks:**
- `autonomous` classification widens the action surface. Mitigation: it routes through the identical deterministic gates as today; the only change is that reversible actions no longer require a board card before the gate. The gate itself is unchanged.
- Self-modifying code (the "fork and customize" agent-native aspiration) is the most dangerous capability in this class. It is explicitly out of scope for the first implementation slice and requires the strongest governance layer before it can be proposed.
- The 2,629-obligation backlog requires the Phase 0 dry-run before any live promotion. Skipping the dry-run is not permitted. The dry-run report (`signal-action-reconciler.js` summary) buckets would-drop decisions by reason (`bySkipReason`) and would-route decisions by class (`byClass`) so the board can validate the staleness window and the autonomous/gated split before the flip.
- **Dual-promoter duplication risk** (see "Relationship to Existing Decisions"): the bridge and the live `promoteSignal` path both surface the same signals and do not coordinate claim state. Mitigation: bridge ships `dryRun=true` (creates nothing). Flipping `dryRun=false` is blocked on deciding the promoter handoff/dedup; doing so without that decision double-surfaces gated obligations and creates board cards for autonomous ones.
- `isStillLive` context computation adds latency at bridge time. Mitigation: context reads from the persistent graph (Neo4j), which does not require a new LLM call.

**Neutral:**
- The autonomy-controller and dead-man switch (SPEC §9) are unchanged. They continue to function as org-wide circuit-breakers.
- ADR-018 (JWT agent identity, STAQPRO-263) and ADR-019 (Neo4j knowledge graph) are prerequisites, not blockers — both are in flight or shipped.

---

## Relationship to Existing Decisions

- **Supersedes the signal-surfacing model of ADR-014**: ADR-014 addressed how OWE/WAITING signals are surfaced in the Today view with raw signal reads. The signal→action bridge replaces that pattern with a lifecycle-aware collect→route approach.
- **Coexists with — does not yet replace — the live `promoteSignal` path**: the existing signal→`inbox.human_tasks` promoter (`lib/runtime/signal-task-promoter.js` / `promoteSignalsLive` in `lib/runtime/promote-live.js`, called from `executor-triage` at signal-insert time) remains live and is in fact *broadened* on this branch (meeting-only → all channels). Both promoters read the same `inbox.signals` rows; they share one canonical `isStillLive()` (the bridge's, imported by `promote-live.js`) but do **not** share claim state — `promoteSignal` never sets `bridged_at`/`work_item_id`, so a promoted signal stays bridge-eligible. **Open decision (must resolve before `dryRun=false`):** which promoter owns which signal, or how they dedup. Until resolved, flipping the bridge live would double-surface gated obligations (two `human_tasks`) and violate the "autonomous → no board card" rule above (the live promoter already created a card).
- **Builds on ADR-018** (JWT-scoped agent identity, STAQPRO-263): the bridge spawns work_items using agent-scoped JWT identity; RLS enforcement (PR-B in ADR-018) is a dependency for full isolation.
- **Builds on ADR-019** (Neo4j knowledge graph): `isStillLive` context reads from the Neo4j graph; this is the first use of Neo4j as a routing input, not just an enrichment surface.
- **Does not affect ADR-007** (federation thesis): federation-specific constraints (JWT `iss`/`org` claims, `origin_org` graph properties) are orthogonal to this decision.

---

## Implementation

The "why" is this document. The "what and how" is the approved plan at `~/.claude/plans/fix-it-the-long-vivid-lighthouse.md`.

**Vertical slice #1** (the first implementation): signal-lifecycle fix + signal→action bridge, structured as three parallel streams:

- **Stream A** — Converge the Today surface: stop the Morning Brief from reading raw, never-expiring, overdue-first `inbox.signals` (the direct cause of the Lester confabulation). As built, the brief sources obligations from the *filtered* `inbox.human_tasks` surface via a shared `HT_LIVE_PREDICATE` (`deleted_at IS NULL` AND `status NOT IN ('done','skipped','not_for_us')` AND not snoozed AND `due_date IS NULL OR due_date >= now() - interval '7 days'`) — the promoted, liveness-filtered kanban surface — rather than a literal `occurred_at >= now() - 90 days` floor on raw signals. The Haiku synthesis prompt is additionally hardened to treat anything >7 days past its due date as stale and not lead with it. Validate against the live 2,629-obligation set.
- **Stream B** — Signal→agent-work bridge: `autobot-inbox/sql/127-signal-action-bridge.sql` (ALTERs `inbox.signals` in place — adds `occurred_at`, `work_item_id`, `contact_id`, `bridged_at`, `content_hash` plus a partial UNIQUE index `signals_bridge_dedup` for at-most-once bridging and a partial eligibility index `signals_bridge_eligible`; no separate bridge table) + `lib/runtime/signal-action-bridge.js` (pure JS `routeObligation()` reversibility classifier + `isStillLive()` context check + the atomic-claim/spawn path) and `lib/runtime/signal-resolver.js` (closes the loop: terminal work-item state → signal resolution / visible human_task). Tunables — confidence threshold, review band, staleness windows, eligible signal types, dry-run flag — live in `autobot-inbox/config/signal-routing.json`, not in code, so retrospector-driven learning can rewrite them as data. The bridge is driven by `autobot-inbox/src/runtime/signal-action-reconciler.js`, a CLI tool that defaults to the dry-run config and is **not** auto-wired into the runtime poll loop. `routeObligation()` spawns `status='created'` work_items for `autonomous` actions and additionally creates a visible `inbox.human_tasks` card for `gated` actions.
- **Stream C** — This ADR (done).

**SPEC references**: P1-P6 (§0), task graph and work_item state machine (§3), guardrail enforcement and G1-G11 (§5), dead-man switch (§9).

### Phase 1 rollout — wiring the reconciler behind two independent gates

Stream B ships the reconciler (`signal-action-reconciler.js`) as a manual CLI driver, deliberately **not** wired into the runtime. Phase 1 wires it onto a periodic cadence in the agent runtime (`autobot-inbox/src/index.js`, via the `ServiceScheduler` — same pattern as the Gmail/TLDv/calendar safety-net polls; torn down by `scheduler.stopAll()` on shutdown), but keeps it **safe-by-default** behind **two independent switches**. Going live in production requires **both**, and each is flipped via Railway env / config edit — **not a code deploy**:

1. **`SIGNAL_BRIDGE_ENABLED=true`** (env, default false) — the master on/off switch. When unset/false the interval is not scheduled at all (zero overhead, zero behavior change). This gate decides *whether the loop runs*.
2. **`signal-routing.json` `"dryRun": false`** (config, default `true`) — decides *whether a pass creates anything*. While `dryRun=true` the reconciler computes routing + liveness and stamps metadata but creates no work_items and no human_tasks. `runBridgeReconciler()` reads `dryRun` from config itself, so this gate is honored without any further code change.

**Flip order**: enable `SIGNAL_BRIDGE_ENABLED=true` first and observe the dry-run summaries in the logs (and the Phase 0 backlog report); only then, once the board has reviewed the report **and** the dual-promoter dedup decision above is resolved, flip `dryRun=false`. The cadence is configurable via `signal-routing.json` `"reconcileIntervalMs"` (default 300000 = 5 min). Each scheduled pass respects the existing `perRunCostCapUsd` cap and is wrapped in error handling so a failed pass can never crash the runtime.

### Promoter coordination — resolved 2026-05-29 (Liotta)

The earlier "Open decision" (which promoter owns which signal) is resolved. `human_task` vs `work_item` is a false dichotomy at the data layer, but the live promoter is **not** redundant: it is the **relevance** gate (`human-task-relevance.js` scores obligor / known-people / project fit); the bridge is the **reversibility** gate (`routeObligation`, which carries no relevance signal). The end-state runs both as *one* router; for Phase 1 they coexist with the bridge subordinate.

- **Phase 1 (now) — bridge defers to promoter.** `bridgeSignal` returns `deferred_to_promoter` and creates nothing when a non-deleted `inbox.human_tasks` row already exists for the signal (predicate symmetric with `promoteSignal`'s own idempotence check). The promoter owns the human surface; the bridge adds only the genuinely new capability — *autonomous execution* — and defers every gated case to the card the promoter already makes well (with relevance scoring the bridge lacks). Canary-safe; observable as a `deferred_to_promoter` bucket in the dry-run report. The live promoter (Path A, in prod) is untouched. **This deferral check is the hard prerequisite for `dryRun=false`:** with `human_tasks(signal_id)` non-unique, an unguarded live pass would double-card gated obligations and phantom-execute already-carded ones.
- **End-state (post-canary refactor)** — extract one `routeSignal()` = relevance → reversibility, emitting exactly one of {autonomous work_item, human card, drop}; add a partial `UNIQUE INDEX human_tasks(signal_id) WHERE deleted_at IS NULL` so at-most-one-card is a DB invariant (P2 — infrastructure enforces), retiring the app-level deferral; fold the promoter's and the bridge's card inserts into a single path differing only by `created_by` provenance. Promoter and bridge become two stages of one router.

---

## Affected Files

- `autobot-inbox/src/api.js` — brief/today query: add recency floor, merge query paths
- `lib/runtime/signal-action-bridge.js` — new: pure `routeObligation()` reversibility classifier, `isStillLive()` context check, and the atomic-claim/spawn path
- `lib/runtime/signal-resolver.js` — new: closes the loop (terminal work-item state → signal resolution / visible human_task)
- `autobot-inbox/src/runtime/signal-action-reconciler.js` — new: CLI driver for the bridge; defaults to dry-run config, not auto-wired into the runtime
- `autobot-inbox/config/signal-routing.json` — new: bridge tunables (confidence threshold, review band, staleness windows, eligible signal types, `dryRun` flag) as data, not code
- `autobot-inbox/sql/127-signal-action-bridge.sql` — new: ALTERs `inbox.signals` (adds `occurred_at`, `work_item_id`, `contact_id`, `bridged_at`, `content_hash`) + partial UNIQUE dedup index + partial eligibility index. No separate bridge table; no SQL `routeObligation()` function — classification is JS
- `lib/runtime/guard-check.js` — no change to gate logic; invocation path expands to cover bridge-spawned actions
- `board/src/app/today/` — UI actions (resolve/snooze) must call the same DB path as the agent bridge (parity requirement)
- `lib/runtime/retrospector.js` — wire closed-loop signal completions into feedback_history

## Cross-Project Impact

This ADR is scoped to `~/Optimus`. No other sub-project is affected. The `autobot-inbox` product is the primary runtime target; the board workstation (`board/`) requires UI parity changes so that human Today actions and agent bridge actions call the same DB paths.
