---
title: "ADR-013: Unified Action Proposals"
description: "Unify inbox.drafts and content.drafts into agent_graph.action_proposals with type discriminator, eliminating per-channel draft tables"
---

# ADR-013: Unified Action Proposals

**Date**: 2026-03-01
**Status**: Accepted
**Issue**: At 2 channels (email, content), maintaining per-channel draft tables required 90 string replacements across the codebase. At 5 channels (email, LinkedIn, Slack, WhatsApp, webhook) this becomes O(channels) tables, O(channels) code paths, O(channels^2) cross-channel queries. Phase 1.5 content agents would have to duplicate the entire draft plumbing built for email. Issue #9.

## Context

The inbox pipeline stores email drafts in `inbox.drafts`. The Phase 1.5 content pipeline (023-content.sql) created `content.drafts` with a nearly identical schema -- same reviewer verdict, gate results, board action, and send state columns. The two tables had different send state values (inbox used `board_approved`/`draft_created`/`sent`; content used `draft`/`published`/`rejected`) and different channel-specific columns, but the core workflow was identical: agent produces proposal, reviewer checks gates, board approves, system delivers.

Cross-channel metrics (edit rate, draft accuracy, approval latency) required UNION ALL across both tables. Each new channel would add another table and another UNION ALL branch. Adapter-aware code (ADR-008) needed to know which schema to query based on channel -- a growing switch statement that contradicted the adapter pattern's goal of channel-agnostic agent logic.

## Decision

Unify both draft tables into a single `agent_graph.action_proposals` table with an `action_type` discriminator column (`email_draft`, `content_post`). New channels add a CHECK value and an adapter, not a new table.

Why `agent_graph` schema: action proposals are output artifacts of the task graph. The `agent_graph` schema is already the cross-cutting coordination layer (work items, state transitions, budgets, escalation). Placing proposals here follows the existing pattern -- cross-channel concerns belong in the cross-cutting schema.

The unified send state machine normalizes the divergent per-channel states:

```
pending --> reviewed --> approved --> staged --> delivered
                                            --> cancelled
```

State mapping from legacy schemas:
- `inbox.drafts`: `board_approved` -> `approved`, `draft_created` -> `staged`, `sent` -> `delivered`
- `content.drafts`: `draft` -> `pending`, `published` -> `delivered`, `rejected` -> `cancelled`

Channel-specific columns (e.g., `message_id`, `to_addresses` for email; `topic_id`, `platform` for content) are nullable with type-discriminator CHECK constraints enforcing that each type has its required fields. This is P2 (infrastructure enforces) -- an `email_draft` row that lacks `message_id` fails the constraint at INSERT, not at runtime.

Migration 028 handles data migration from `inbox.drafts`, drops both legacy tables, and creates a backwards-compatible `inbox.drafts` VIEW that maps unified state names back to legacy names so un-migrated code and manual queries continue to work during transition.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Keep per-channel tables with UNION ALL views | No migration; each channel owns its schema | O(channels) tables, O(channels^2) cross-channel queries; every new channel requires view updates and code paths; metrics queries grow linearly | Does not solve the scaling problem, only defers it |
| Generic proposals table in a new schema | Clean separation | Creates a sixth schema; still need cross-schema joins for work item context; adds complexity without clear benefit over using agent_graph | agent_graph already serves the cross-cutting role |
| Status quo (separate inbox.drafts and content.drafts) | No work required | Phase 1.5 content agents must duplicate all draft plumbing; 90 string replacements already needed; problem worsens per channel | Unsustainable at 3+ channels |

## Consequences

**Positive:**
- Phase 1.5 content agents build against the unified table with zero new draft plumbing
- Cross-channel metrics (edit rate, draft accuracy, autonomy readiness) are a single WHERE clause instead of UNION ALL
- New channels add a CHECK value + adapter, not new tables or code paths
- Unified send state machine makes the draft lifecycle consistent and predictable across channels
- G5 (reversibility) is enforced once, on one table, for all channels

**Negative:**
- Nullable channel-specific columns make the table wider than either original table
- CHECK constraints on `action_type` must be maintained as new types are added
- Backwards-compatible VIEW adds a translation layer that must eventually be removed

**Neutral:**
- `content.topics` and `content.reference_posts` remain in the content schema -- only drafts were unified
- The inbox schema retains `emails`, `signals`, and `sync_state` -- only drafts moved out
- `voice.edit_deltas.draft_id` now soft-references `action_proposals.id` instead of `inbox.drafts.id` (same D5 no-cross-schema-FK pattern)

## Affected Files

- `sql/028-action-proposals.sql` -- New migration: creates `action_proposals`, migrates data, drops legacy tables, creates compatibility VIEW, updates `reconcile_schemas()`, recreates dependent views
- `docs/internal/database-architecture.md` -- Updated: agent_graph gains action_proposals; inbox loses drafts (VIEW remains); content loses drafts; unified send state machine documented
- `CLAUDE.md` (autobot-inbox) -- Updated: migration range 000-028, schema descriptions
- `docs/internal/adrs/README.md` -- Updated: ADR index

## Cross-Project Impact

- **Root `CLAUDE.md`** -- Migration range updated from 000-027 to 000-028. Schema descriptions updated.
- **`autobot-spec`** -- No spec changes needed. The unified table implements the spec's draft lifecycle more cleanly than per-channel tables did.
