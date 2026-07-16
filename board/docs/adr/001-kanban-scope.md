# ADR-001 — Kanban board scope and filter heuristic

**Status:** Accepted
**Date:** 2026-05-11

## Context

The Pipeline page (`/pipeline`) renders every row of `agent_graph.work_items`, which includes thousands of operational rows (per-email triage decisions, daemon ticks, intake classifications). A Kanban-style flow view inherits the same firehose problem if we do not filter.

The board needs a Kanban that shows *meaningful* task flow: work items the board would recognise as "a thing being built" rather than internal plumbing. The semantics for "meaningful" must be derivable from columns we have today — there is no `category` or `kind` field on `work_items`.

## Decision

The v1 Kanban filters `agent_graph.work_items` to:

```sql
WHERE type IN ('directive', 'workstream')
```

Rationale:

- `work_items.type` is constrained to `('directive', 'workstream', 'task', 'subtask')` (`sql/001-baseline.sql`).
- `directive` and `workstream` are the top-of-tree intents — they represent the *thing the board cares about*. Their children (`task`, `subtask`) are agent-decomposed steps and would multiply card count 10–100×.
- The Pipeline view remains available for the unfiltered firehose.

Rejected alternatives:

- **Filter by `assigned_to` membership in a dev-executor set** (`executor-coder`, `executor-ticket`, `executor-blueprint`, `executor-redesign`, `claw-workshop`, …). Brittle: the set is a hard-coded string list that drifts as agents are added/renamed.
- **Add a `task_category` column.** Right answer long-term; out of scope for v1 (requires migration, backfill, runtime writes).
- **No filter.** Card count makes the board unreadable.

## Consequences

- Cards are "what's getting built", not "every agent breath".
- A `directive` with 12 child `task`s shows as 1 card. Drill-down lives on the existing `/pipeline?task=<id>` deep link.
- If we ever need a "team standup" view (one card per child), we add it as a second page rather than relaxing this filter.
- Migration to a real `category` column (post-v1) keeps this ADR as the historical reason for the filter — supersede with ADR-NNN at that time.
