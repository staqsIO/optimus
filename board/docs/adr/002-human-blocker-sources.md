# ADR-002 — Human-blocker signal sources

**Status:** Accepted
**Date:** 2026-05-11

## Context

A Kanban that flows tasks through agent states must also surface items where a *human* is the bottleneck — otherwise the board cannot see what needs them. There is no `work_items.blocked_on` column today. Genuine human-blocker signals live in three tables outside `work_items`:

| Source | Marker for "needs human" |
|---|---|
| `agent_graph.action_proposals` | `board_action IS NULL` (proposal awaiting board verdict) |
| `agent_graph.needs_attention_log` | `acknowledged_at IS NULL` (retry≥3 / gate failure escalation) |
| `inbox.messages` | `triage_category = 'action_required'` |

`work_items.status = 'review'` is **not** a reliable human-blocker signal: the Reviewer *agent* performs most reviews. Conflating them would route agent reviews to the human queue.

## Decision

The v1 Kanban adds **one extra lane** — "Needs you" — to the left of the five `work_items.status` lanes. Its contents are the union of:

1. `agent_graph.action_proposals` where `board_action IS NULL`
2. `agent_graph.needs_attention_log` where `acknowledged_at IS NULL` AND `created_at >= now() - interval '30 days'`

`inbox.messages` with `triage_category = 'action_required'` is **excluded from v1**. Rationale: that surface is already covered by `/drafts` and the inbox flow is fundamentally a separate UX (read → reply). Folding it into a Kanban card list adds noise without affordances.

Each "Needs you" card carries a `kind` discriminator (`"proposal"` or `"attention"`) so the frontend can deep-link to the correct existing surface:

- `kind: "proposal"` → `/drafts` (selected to that proposal)
- `kind: "attention"` → `/activity` (scrolled to that incident)

## Consequences

- The board sees one queue: "what needs me" + "what's flowing through the system".
- We do **not** introduce a `work_items.blocked_on` enum in v1. That is the proper fix and is tracked as follow-up (post-v1 ADR).
- The "Needs you" lane is *side-channel data* — its rows are not `work_items`, so they do not move between lanes via state transitions. They appear when surfaced, disappear when acknowledged/acted-on.
- We accept the side-effect that signing off on a proposal happens in `/drafts`, not on the Kanban card itself. v1 ships routing, not a unified action surface.
- `inbox.messages.action_required` exclusion is reversible — adding a third union arm is mechanical when we revisit.
