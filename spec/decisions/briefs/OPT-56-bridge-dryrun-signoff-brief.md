# Board Decision Brief: OPT-56 — Signal-Action Bridge Dry-Run Sign-Off

**Brief date**: 2026-06-13
**Source ADR**: ADR-008 (`spec/decisions/008-agent-native-governed-operating-layer.md`), Phase 4 of the Proper Path plan
**Implementation file**: `autobot-inbox/src/runtime/signal-action-reconciler.js`
**Config**: `autobot-inbox/config/signal-routing.json` (dryRun field)
**Decision required from**: Board (Dustin + Eric) — explicit sign-off required before `dryRun=false`

---

## One-sentence question

After reviewing the dry-run report (bySkipReason + byClass buckets against the ~1,430–2,629 obligation backlog), does the board approve setting `dryRun=false` and enabling autonomous obligation closure?

---

## What is happening

### The bridge (current state)

The signal-action reconciler (`signal-action-reconciler.js:61`) processes unresolved signals from the obligation backlog and routes each one to either:
- **Autonomous closure**: create a `work_item` / `human_task` and close the obligation without human review.
- **Gated action**: route to the board governance queue for human review.
- **Skip**: obligation does not meet liveness criteria (no matching work type, `touches_money`/`touches_legal` flag, etc.).

**Two independent safety gates** (documented in `autobot-inbox/src/index.js:715-729`):
1. `SIGNAL_BRIDGE_ENABLED=true` (Railway env var) — master on/off switch. When unset, the reconciler is never registered.
2. `signal-routing.json "dryRun": false` (config) — lets the bridge actually create work items. While `dryRun=true` (the **shipped default**), the reconciler computes routing and stamps metadata but creates nothing.

Flip order to go live: (1) set `SIGNAL_BRIDGE_ENABLED=true` to observe dry-run summaries in logs; (2) review this brief with the dry-run report; (3) board approves; (4) set `dryRun=false` in config.

### The dry-run report format

The reconciler returns (`signal-action-reconciler.js:103-110`):
```js
{
  bySkipReason: Record<string, number>,  // why obligations were skipped
  byClass:      Record<string, number>,  // autonomous vs gated split for routed obligations
  dryRun:       boolean,
  ...counts
}
```

`bySkipReason` is the key signal: it shows whether obligations are being skipped for structural reasons (no matching work type, signal too old) vs. safety reasons (`touches_money`, `touches_legal`). The board must understand the distribution before authorizing live routing.

---

## What the board must review before `dryRun=false`

### 1. `bySkipReason` + `byClass` buckets

Run the reconciler in dry-run against the full backlog. Export the summary. The board must see:
- What fraction of obligations are autonomously routable vs. gated vs. skipped.
- The top `bySkipReason` categories — if the majority are skipped for unexpected reasons, the classifier needs tuning before going live.
- The `byClass` split — the ratio of autonomous vs. gated is the key governance metric.

### 2. `autonomous_closure_rate` floor

Before `dryRun=false`, the board must set an explicit **`autonomous_closure_rate` floor** — the minimum fraction of closures that must be autonomous (vs. routed to board review) for the bridge to be considered healthy. If the live rate falls below this floor, the bridge auto-pauses and fires a board alert.

The plan (Phase 4) does not specify a number; that is a board decision. Suggested starting point: 60% autonomous / 40% gated. If the dry-run shows a very different split, adjust before committing.

### 3. The `touches_money` / `touches_legal` invariant

Per Phase 4: `touches_money` and `touches_legal` flags **must be deterministic heuristics, not LLM inference** — this is a named invariant documented in `guard-check.js` (pending, per the plan). The board must confirm this invariant is implemented before `dryRun=false`. LLM-scored reversibility is a prompt-injection surface; deterministic heuristics are not.

### 4. Gating migration: UNIQUE INDEX on `human_tasks(signal_id)`

Per the Proper Path plan Phase 2.2: `UNIQUE INDEX human_tasks(signal_id) WHERE deleted_at IS NULL` must be landed as a migration **before** `dryRun=false`. This prevents double-surfacing of obligations (two simultaneous bridge runs racing to create the same work item). Without this index, the guarantee is app-level logic on a race; with it, it is a DB-level invariant. This migration is a hard blocker on `dryRun=false`.

### 5. G10 spend-cap fail-closed (STAQPRO-557)

The spend cap gate (G10) must fail closed — if the cap check cannot be evaluated (DB error, config missing), the action must be denied, not passed. This must be verified in the guard-check implementation before autonomous closure goes live.

---

## Recommendation

**Do not set `dryRun=false` until:**
1. The UNIQUE INDEX migration is merged and deployed.
2. G10 fail-closed is verified.
3. `touches_money` / `touches_legal` deterministic heuristics are implemented and tested.
4. The board has reviewed the dry-run report (`bySkipReason` + `byClass`) and set the `autonomous_closure_rate` floor.

**Once those conditions are met**, the bridge is ready for live operation. The recommendation is to proceed — the bridge is the mechanism that turns the 2,629-obligation backlog into structured work items that Optimus can actually execute. Leaving it in dry-run indefinitely means the inbound spine is built but inert.

**Sequencing dependency**: Phase 2 (PR-B, RLS live) must come first. The bridge creates `work_items` and `human_tasks` — if those writes happen as the superuser role (pre-PR-B), they bypass the RLS policies that enforce org tenancy. The bridge must not go live on a superuser connection.

---

## What the board is signing off on

A one-time approval to:
1. Accept the `autonomous_closure_rate` floor at a specific number (board sets this).
2. Acknowledge that obligations categorized as `touches_money` or `touches_legal` will never be autonomously closed — they will always route to the board governance queue.
3. Authorize the config change `"dryRun": false` in `signal-routing.json` after the gating conditions above are met.

This is not a permanent commitment. The bridge can be returned to `dryRun=true` at any time via a config edit without a code deploy.
