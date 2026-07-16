# Signal→action bridge — downstream (orchestrator/executor) bugs

**Date:** 2026-05-29
**Found by:** Phase 1 small-batch LIVE test (`signal-action-reconciler.js --live --limit=3`) against prod.
**Owner:** A-prime work stream (`agents/orchestrator/index.js`, `lib/runtime/agent-loop.js`). These are NOT bridge bugs — `lib/runtime/signal-action-bridge.js` worked correctly.

## Context

The 3-signal live run created work cleanly at the **bridge** layer: 3 `work_items`, 2 `task_routing` events, 1 gated `human_tasks` card, 3 signals stamped, 0 orphans. The bridge fixes (migration 130 `created_by` identity; reversibility-class out of `routing_class`, #257/#258) are confirmed working in prod.

The **downstream** consumption of those work_items is buggy. Batch outcome: `cancelled:1, created:1, in_progress:1`.

| WI | Class | Outcome |
|---|---|---|
| `01fa435b` | autonomous (action_item) | orchestrator assigned → `executor-ticket` → `in_progress` (then stuck; no Linear issue, no LLM activity) |
| `3975ea0c` | gated (legal_domain) | correct: unassigned + board card (`f7e3c5dd`) |
| `7f194b65` | autonomous (action_item) | **cancelled** after two distinct errors (below) |

## Bug 1 — `Unknown event type: task_routing`

`7f194b65` state_transitions:
```
created → in_progress (orchestrator)  "Task claimed, starting execution"
in_progress → failed (orchestrator)   "Execution error (retry 1/3): Unknown event type: task_routing"
failed → assigned (orchestrator)      "Auto-retry 1/3"
assigned → in_progress (orchestrator) "Task claimed, starting execution"
in_progress → cancelled (orchestrator) "Orphaned: no email in context (STAQPRO-281)"
```

The agent-loop / orchestrator execution dispatch has **no handler case for the `task_routing` event type**. Migration 129 added the event type to the DB CHECK and the bridge emits it, but the *consume* side is incomplete: for `01fa435b` the assignment path worked, for `7f194b65` the loop tried to **execute** the event as a task and threw `Unknown event type: task_routing`. Looks racy / dual-path.

**Fix direction:** in the agent-loop event dispatch (`lib/runtime/agent-loop.js`) and/or the orchestrator handler (`agents/orchestrator/index.js`), `task_routing` must be handled as an **assignment trigger** (orchestrator reads it, assigns the referenced work_item to `metadata.target_executor`), never executed as a work task. Ensure the same path runs for every `task_routing` event (no race where it falls through to the generic "execute task" branch).

## Bug 2 — STAQPRO-281 orphan-guard cancels transcript work_items

After the retry, the orchestrator cancelled `7f194b65` with `Orphaned: no email in context (STAQPRO-281)`. The STAQPRO-281 guard (silent-skip/cancel on null email) is built for **email** work_items. Bridge work_items are sourced from **meeting transcripts / signals** and legitimately have **no email/message in context** — so the guard wrongly cancels them.

**Fix direction:** exempt bridge-spawned work_items (`metadata.source = 'signal-action-bridge'`, or `metadata.source_signal_id` present) from the no-email orphan cancel. They should be executed against signal/transcript context, not email context.

## Note on test coverage

The bridge integration test (`autobot-inbox/test/signal-action-bridge-live.test.js`, #258) asserts the `task_routing` event is *emitted*, but does not drive the orchestrator *consuming* it nor an executor running. A follow-up test should exercise orchestrator-assignment-on-`task_routing` and executor execution on a transcript-sourced (no-email) work_item — that would catch both bugs above without a prod run.

## Rollout status

Scale-up PAUSED. `SIGNAL_BRIDGE_ENABLED=false`, `dryRun=true`, `staleCleanupOnly=true` all remain default-off. The bridge is ready; do not flip live for real routing until Bugs 1 & 2 are fixed and a downstream test passes.

## Live-test prod artifacts (cleanup)

- `7f194b65` — already `cancelled` by the orphan guard (no action).
- `01fa435b` — progressed `in_progress → failed` (downstream bug). Manual `failed → cancelled` is **not an allowed state-machine transition**, so it was left to self-terminate the same way `7f194b65` did (retry → orphan-cancel). A raw UPDATE was deliberately NOT used — it would break the append-only hash chain (P3). Burns no LLM (no-email path fails fast; 0 invocations).
- `3975ea0c` — gated legal obligation ("contracts with Steve & Ladd"); left for the board (real obligation, real card `f7e3c5dd`).
