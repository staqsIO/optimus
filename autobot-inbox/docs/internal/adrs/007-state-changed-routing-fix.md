---
title: "ADR-007: State-Changed Event Routing Fix"
description: "Fixed transition_state() to route state_changed events to specific agents instead of broadcasting"
---

# ADR-007: State-Changed Event Routing Fix

**Date**: 2026-02-28
**Status**: Accepted
**Spec Reference**: SPEC.md -- Agent Pipeline (Orchestrator routes, Executors execute)

## Context

The original `transition_state()` SQL function (in `sql/005-functions.sql`) emitted `state_changed` events with `target_agent_id = '*'` (broadcast to all agents). This caused a cascade failure:

1. **Every agent claimed every state_changed event**: When executor-triage completed a task, the state_changed event was broadcast. The orchestrator, strategist, executor-responder, and reviewer all attempted to claim it.
2. **Guard check failures**: `guard-check.js` enforces `can_assign_to` validation -- an agent can only claim tasks assigned to it. Agents that claimed broadcast events for tasks assigned to other agents would fail the guard check with `can_assign_to_violation`.
3. **Pipeline blockage**: Failed guard checks transitioned work items to `blocked` state. Legitimate state_changed events (e.g., triage completion that the orchestrator needs for routing) were consumed by the wrong agent first, blocking the pipeline.

The root cause was two-fold: broadcast event targeting, and guard-check not exempting state_changed events from assignment validation.

## Decision

Two coordinated fixes were applied:

### Fix 1: Targeted event routing in transition_state()

The patched `transition_state()` function (in `sql/patches/fix-transition-state-routing.sql`) routes state_changed events to specific agents based on the new state:

- **`completed` or `failed`** -> `target_agent_id = 'orchestrator'` -- The orchestrator is responsible for routing decisions after task completion. This implements the spec principle "orchestrator routes, executors execute."
- **All other states** (`in_progress`, `blocked`, `review`, etc.) -> `target_agent_id = COALESCE(assigned_to, 'orchestrator')` -- The assigned agent is notified of state changes on its own tasks. Falls back to orchestrator if no agent is assigned.

The patched function also includes `work_item_id` in the `event_data` JSON payload for easier downstream consumption.

### Fix 2: Guard check exemption for state_changed events

In `guard-check.js`, the `can_assign_to` validation now skips the check when `action === 'state_changed'`:

```javascript
if (assignedTo && assignedTo !== agentId && assignedTo !== '*' && action !== 'state_changed') {
  failedChecks.push('can_assign_to_violation');
}
```

This is necessary because the orchestrator must read completed tasks that are assigned to other agents (e.g., a triage task assigned to executor-triage) to make routing decisions. The state_changed event is a notification, not a claim of ownership.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|-------------|
| Keep broadcast, fix guard-check only | Simpler change (one file) | All agents still process every event; wasted cycles; agents must filter irrelevant events | Does not fix the root cause; agents should not receive events they cannot act on |
| Application-level filtering (agent-loop.js) | No SQL change needed | Filtering happens after claim; event is consumed and lost to the correct agent | SKIP LOCKED means the wrong agent permanently consumes the event |
| Separate event tables per agent | Perfect isolation; no targeting needed | Schema explosion; harder to query globally; migration complexity | Over-engineering for 5 agents |
| Topic-based routing (add topic column) | Flexible; agents subscribe to topics | Additional complexity; still need to define who subscribes to what | Equivalent to targeted routing with more indirection |

## Consequences

### Positive
- Pipeline no longer blocks on misrouted state_changed events
- Each agent only receives state_changed events it can act on
- Guard check correctly allows orchestrator to read completed tasks from other agents
- No wasted SKIP LOCKED claims by agents that cannot process the event

### Negative
- Routing logic is now split between SQL (`transition_state()` determines target) and JavaScript (orchestrator's `handleStateChanged()` determines action) -- a change to the pipeline topology requires updating both
- `task_assigned` events created by `createWorkItem()` use the explicit `assignedTo` value as `target_agent_id`, so they were never affected by this bug

### Neutral
- The original `transition_state()` in `005-functions.sql` still contains the broadcast version; the patch in `sql/patches/fix-transition-state-routing.sql` is a `CREATE OR REPLACE` that overrides it at migration time

## Affected Files

- `sql/patches/fix-transition-state-routing.sql` -- Patched `transition_state()` with targeted routing logic
- `sql/005-functions.sql` -- Original function (overridden by patch; retained for reference)
- `src/runtime/guard-check.js` -- Added `action !== 'state_changed'` exemption to `can_assign_to` check
- `src/agents/orchestrator.js` -- `handleStateChanged()` consumes targeted state_changed events for routing decisions
