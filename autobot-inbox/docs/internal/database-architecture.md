---
title: "Database Architecture"
description: "Five schemas, key tables, state machine, hash chains, append-only triggers, budget reservation"
---

# Database Architecture

## Overview

One Supabase project (production) or PGlite instance (development). Five isolated schemas with no cross-schema foreign keys (design decision D5). SQL migrations in `sql/000-028` are the DDL source of truth.

Extensions required: `pgvector`, `pg_trgm`, `pgcrypto`.

## Schema: `agent_graph`

Core task graph, state machine, cost tracking, and governance infrastructure.

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `agent_configs` | Agent identity and configuration | `id` (PK, matches agent ID), `agent_type`, `model`, `system_prompt`, `tools_allowed`, `config_hash`, `is_active` |
| `agent_config_history` | Append-only config version history | `agent_id`, `config_version`, `config_json`, `config_hash`, `prompt_hash` |
| `work_items` | Nodes in the task DAG | `id`, `type` (directive/workstream/task/subtask), `status`, `assigned_to`, `created_by`, `parent_id`, `priority`, `data_classification`, `routing_class`, `output_quarantined`, `retry_count`, `metadata` |
| `edges` | Typed DAG relationships | `from_id`, `to_id`, `edge_type` (decomposes_into/blocks/depends_on) |
| `state_transitions` | Append-only audit log (partitioned monthly) | `work_item_id`, `from_state`, `to_state`, `agent_id`, `config_hash`, `reason`, `guardrail_checks_json`, `cost_usd`, `hash_chain_prev`, `hash_chain_current` |
| `valid_transitions` | State machine definition | `from_state`, `to_state`, `allowed_roles`, `required_guardrails` |
| `task_events` | Outbox for event-driven dispatch | `event_type`, `work_item_id`, `target_agent_id`, `priority`, `event_data`, `processed_at` |
| `llm_invocations` | Cost and performance tracking | `agent_id`, `task_id`, `model`, `input_tokens`, `output_tokens`, `cost_usd`, `prompt_hash`, `response_hash`, `latency_ms`, `idempotency_key` (UNIQUE) |
| `budgets` | Budget allocation and enforcement | `scope` (daily/monthly/directive/workstream), `allocated_usd`, `spent_usd`, `reserved_usd`, `period_start`, `period_end` |
| `halt_signals` | Persistent halt state (fail-closed kill switch) | `signal_type` (financial/auditor/human/system), `reason`, `is_active`, `resolved_at` |
| `strategic_decisions` | Strategist recommendations | `work_item_id`, `decision_type` (tactical/strategic/existential), `recommendation` (proceed/defer/reject/escalate), `perspective_scores`, `board_verdict` |
| `tool_registry` | Tool allow-list with integrity hashes | `tool_name` (UNIQUE), `tool_hash`, `allowed_agents` (TEXT[]), `is_active` |
| `tool_invocations` | Append-only tool execution audit trail | `agent_id`, `tool_name`, `params_hash`, `result_summary`, `duration_ms`, `success`, `error_message` |
| `threat_memory` | Append-only, hash-chained threat event log (graduated escalation) | `id`, `detected_at`, `source_type`, `scope_type`, `scope_id`, `threat_class`, `severity`, `detail_json`, `prev_hash`, `hash_chain_current`, `resolved`, `resolved_by`, `resolved_at` |
| `tolerance_config` | Board-managed escalation thresholds per threat class and scope | `id`, `threat_class`, `scope_type`, `scope_id`, `window_minutes`, `level_1_threshold` .. `level_4_threshold`, `severity_weights` (JSONB), `created_by`, `config_hash` |
| `action_proposals` | Unified cross-channel draft/proposal table (replaces per-channel draft tables) | `id`, `action_type` (email_draft/content_post), `work_item_id`, `body`, `tone_score`, `reviewer_verdict`, `gate_results`, `board_action`, `send_state`, `version`, `previous_proposal_id`; email-specific: `message_id`, `to_addresses`, `channel`, `provider`, `provider_draft_id`; content-specific: `topic_id`, `platform` |

### Graduated Escalation (spec section 8)

Fills the gap between single-output quarantine (Reviewer) and full HALT (section 9). Five escalation levels are computed from weighted threat event history:

| Level | Behavior |
|-------|----------|
| 0 | Normal operation |
| 1 | Monitoring (increased logging) |
| 2 | Force review (all outputs require Reviewer pass) |
| 3 | No new claims (agents cannot claim new work items) |
| 4 | Halt (equivalent to section 9 kill switch) |

**`threat_memory`** records threat events from six source types (`sanitization`, `post_check`, `tier1_audit`, `tier2_audit`, `tool_integrity`, `gateway_inbound`) across five scope types (`agent`, `task`, `workstream`, `tool`, `inbound_channel`). Eight threat classes are defined: `INJECTION_ATTEMPT`, `EXFILTRATION_PROBE`, `INTEGRITY_FAILURE`, `POLICY_VIOLATION`, `BUDGET_ABUSE`, `ESCALATION_BYPASS`, `TOOL_ABUSE`, `ANOMALOUS_BEHAVIOR`. Severity is one of `INFORMATIONAL`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.

**`tolerance_config`** defines per-threat-class, per-scope thresholds. Each row specifies a rolling `window_minutes` and four level thresholds. Severity weights (configurable per row) translate event counts into a weighted score. Default configs are seeded for org-level and agent-level scopes. The unique constraint on `(threat_class, scope_type, scope_id)` prevents duplicate config rows.

#### Escalation Functions

| Function | Purpose | Signature |
|----------|---------|-----------|
| `resolve_threat(p_threat_id, p_resolved_by)` | The only way to mark a threat resolved. HIGH/CRITICAL severity require `p_resolved_by = 'board'` -- agents and auto-decay cannot resolve them. Returns false if not found or already resolved. | `(TEXT, TEXT) -> BOOLEAN` |
| `current_escalation_level(p_scope_type, p_scope_id)` | Computes the current escalation level (0-4) by evaluating all matching `tolerance_config` rows, summing severity-weighted unresolved threats within each config's time window, and returning the highest level reached across all threat classes. | `(TEXT, TEXT) -> INTEGER` |
| `verify_threat_memory_chain()` | Tamper detection for the threat event log. Walks the hash chain (same pattern as `verify_ledger_chain` for state_transitions) and returns the first break point, if any. | `() -> TABLE(is_valid BOOLEAN, last_verified TIMESTAMPTZ, break_point TEXT)` |

Source: `sql/027-threat-memory-and-escalation.sql`

### Unified Action Proposals (ADR-013)

Replaces per-channel draft tables (`inbox.drafts`, `content.drafts`) with a single `action_proposals` table in `agent_graph`. The `action_type` discriminator (`email_draft`, `content_post`) determines which channel-specific columns are required via CHECK constraints. New channels add a CHECK value and an adapter, not a new table.

#### Unified Send State Machine

```
pending --> reviewed --> approved --> staged --> delivered
                                            --> cancelled
```

G5 (reversibility) is enforced by `action_proposals_g5_require_board_approval`: `send_state` cannot reach `delivered` unless `board_action IS NOT NULL`.

#### Type Discriminator Constraints

| Constraint | Rule |
|------------|------|
| `action_proposals_email_requires_fields` | `email_draft` rows must have `message_id` and `to_addresses` |
| `action_proposals_content_requires_fields` | `content_post` rows must have `topic_id` |

#### Key Indexes

- `idx_action_proposals_type` -- By action_type for filtered queries
- `idx_action_proposals_message` -- Partial on message_id (email lookups)
- `idx_action_proposals_topic` -- Partial on topic_id (content lookups)
- `idx_action_proposals_pending` -- Partial on unreviewed proposals awaiting board action
- `idx_action_proposals_send_state` -- Partial on active send states (excludes delivered/cancelled)
- `idx_action_proposals_work_item` -- Partial on work_item_id
- `idx_action_proposals_channel` -- Partial on channel for unreviewed proposals

#### Backwards Compatibility

`inbox.drafts` exists as a VIEW that filters `action_type = 'email_draft'` and maps unified state names back to legacy names (`approved` -> `board_approved`, `staged` -> `draft_created`, `delivered` -> `sent`). This allows un-migrated code and manual queries to work during transition.

Source: `sql/028-action-proposals.sql`

### Valid State Transitions

| From | To | Allowed Roles |
|------|----|---------------|
| created | assigned | orchestrator, * |
| created | in_progress | executor-triage, executor-responder, reviewer, strategist, architect, orchestrator, * |
| assigned | in_progress | executor-triage, executor-responder, reviewer, strategist, architect, * |
| in_progress | completed | executor-triage, executor-responder, orchestrator, reviewer, architect, * |
| in_progress | failed | orchestrator, reviewer, * |
| in_progress | blocked | orchestrator, * |
| in_progress | review | executor-triage, executor-responder, orchestrator, strategist, architect, * |
| in_progress | timed_out | orchestrator, * |
| in_progress | cancelled | orchestrator, * |
| blocked | in_progress | orchestrator, * |
| blocked | cancelled | orchestrator, * |
| review | completed | reviewer, orchestrator, * |
| review | in_progress | reviewer, orchestrator, * |
| review | cancelled | orchestrator, * |
| failed | assigned | orchestrator, * |
| timed_out | assigned | orchestrator, * |
| created | cancelled | orchestrator, * |
| assigned | cancelled | orchestrator, * |

### Hash Chain (Append-Only Audit)

Every state transition produces a hash-chained record. The chain is computed as:

```
SHA256(prev_hash | transition_id | work_item_id | from_state | to_state | agent_id | config_hash)
```

Where `prev_hash` is `'genesis'` for the first transition of a work item, or the hex-encoded `hash_chain_current` from the most recent transition.

Hash chain integrity can be verified per work item or globally:

```sql
SELECT * FROM agent_graph.verify_ledger_chain('work-item-id');
SELECT * FROM agent_graph.verify_all_ledger_chains();
```

The hash is computed in JavaScript (`state-machine.js`) because PGlite does not include `pgcrypto`. The SQL function accepts a pre-computed hash via `p_hash_chain_current`, or computes one itself using `sha256()` for real Postgres deployments.

### Append-Only Enforcement

The following tables are append-only, enforced by database triggers that raise exceptions on UPDATE or DELETE:

| Table | Trigger |
|-------|---------|
| `agent_graph.state_transitions` | `trg_state_transitions_no_update`, `trg_state_transitions_no_delete` |
| `voice.edit_deltas` | `trg_edit_deltas_no_update`, `trg_edit_deltas_no_delete` |
| `agent_graph.agent_config_history` | `trg_config_history_no_update`, `trg_config_history_no_delete` |
| `agent_graph.halt_signals` | `trg_halt_signals_no_delete` (delete only; `is_active` can be set to false) |
| `agent_graph.tool_invocations` | `trg_tool_invocations_no_update`, `trg_tool_invocations_no_delete` |
| `agent_graph.threat_memory` | `trg_threat_memory_immutable` (custom: blocks DELETE and all UPDATE except resolved fields; resolved can only go false->true, never back) |

### Cycle Detection

Edges in the task DAG are protected by a BFS-based cycle detection trigger (`trg_edges_no_cycle`). The `would_create_cycle()` function uses iterative BFS with a depth limit of 100 (not recursive CTE) to prevent stack overflow on deep graphs.

### Agent Assignment Rules

Agent routing is enforced via a generalized mechanism: the `enforce_assignment_rules()` trigger on `work_items` checks the `agent_assignment_rules` table. Each row in `agent_assignment_rules` defines a `(agent_id, can_assign)` pair — an agent can only create work items assigned to agents listed in its `can_assign` set, or leave them unassigned. This is P2 (infrastructure enforces) applied to issue #37 — originally implemented as a hardcoded architect-only trigger, then generalized to support all agents (e.g., orchestrator → executor-redesign, orchestrator → executor-blueprint).

Source: `sql/024-tool-sandboxing.sql` (trigger), `sql/001-baseline.sql` (seed data in `agent_assignment_rules`)

### Partitioning

`state_transitions` is partitioned by month (`PARTITION BY RANGE (created_at)`) with partitions for each month of 2026 plus a default partition. This keeps queries on recent transitions fast while preserving the complete audit trail.

## Schema: `inbox`

Email metadata and signal extraction. Body is never stored (design decision D1). Drafts have been unified into `agent_graph.action_proposals` (ADR-013); a backwards-compatible `inbox.drafts` VIEW exists for transition.

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `emails` | Email metadata (no body) | `gmail_id` (UNIQUE), `thread_id`, `from_address`, `to_addresses`, `subject`, `snippet`, `received_at`, `triage_category`, `triage_confidence`, `priority_score`, `work_item_id`, `processed_at`, `archived_at` |
| `signals` | Extracted commitments, deadlines, action items | `email_id` (FK), `signal_type`, `content`, `confidence`, `due_date`, `resolved` |
| `sync_state` | Gmail incremental polling state | `history_id`, `last_poll_at`, `emails_synced` |
| `calendar_events` | Google Calendar event mirror (STAQPRO-327 / ADR-027). One row per `(account_email, gcal_event_id)`. Cancellations stay (status='cancelled'). Mutable fields content-hashed into `raw_event.__hash` to skip no-op updates. | `account_email`, `gcal_event_id`, `ical_uid`, `title`, `start_at`, `end_at`, `all_day`, `organizer_email`, `attendees` (JSONB with resolved `contact_id`), `status` (`confirmed`/`tentative`/`cancelled`), `raw_event` (JSONB) |
| `calendar_watches` | Multi-account calendar config managed via Settings UI. Mirrors `inbox.drive_watches`. | `account_email`, `calendar_id` (default `'primary'`), `label`, `is_active`, `last_poll_at`, `last_error` |

### Views

| View | Purpose |
|------|---------|
| `drafts` | Backwards-compatible view over `agent_graph.action_proposals` filtered to `action_type = 'email_draft'`. Maps unified send states back to legacy names (`approved` -> `board_approved`, `staged` -> `draft_created`, `delivered` -> `sent`). Read-only. |

### Key Indexes

- `idx_emails_unprocessed` -- Partial index on unprocessed emails for fast polling
- `idx_emails_triage` -- Partial index on pending triage for the orchestrator

## Schema: `voice`

Voice learning system. Sent email corpus with pgvector embeddings for few-shot selection.

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `sent_emails` | Sent email corpus with embeddings | `gmail_id` (UNIQUE), `to_address`, `subject`, `body`, `word_count`, `embedding` (vector(1536)), `recipient_cluster`, `topic_cluster` |
| `profiles` | Aggregate voice profiles | `scope` (global/recipient/topic), `scope_key`, `greetings`, `closings`, `vocabulary` (JSONB), `tone_markers` (JSONB), `avg_length`, `formality_score`, `sample_count` |
| `edit_deltas` | Board edit training data (APPEND-ONLY) | `draft_id`, `original_body`, `edited_body`, `diff`, `recipient`, `edit_type` (tone/content/structure/minor/major), `edit_magnitude` |

### pgvector Index

```sql
CREATE INDEX idx_sent_emails_embedding ON voice.sent_emails
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
```

The IVFFlat index with 50 lists provides approximate nearest neighbor search for the few-shot selector. Cosine distance is used because it normalizes for text length.

See [Voice System](./voice-system.md) for the complete voice architecture.

## Schema: `signal`

Relationship intelligence and daily briefings.

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `contacts` | Relationship graph | `email_address` (UNIQUE), `name`, `organization`, `contact_type` (team/investor/customer/partner/vendor/recruiter/unknown), `emails_received`, `emails_sent`, `is_vip` |
| `topics` | Recurring topics with trending | `name` (UNIQUE), `mention_count`, `trend_direction` (rising/stable/declining), `trend_score`, `keywords` |
| `briefings` | Daily briefing records | `briefing_date` (UNIQUE), `summary`, `action_items`, `signals`, `trending_topics`, `vip_activity`, daily stats |

## Schema: `content`

Content generation for LinkedIn automation (Phase 1.5). Content drafts have been unified into `agent_graph.action_proposals` as `action_type = 'content_post'` (ADR-013). This schema retains the topic queue and reference posts.

Source: `sql/023-content.sql`, `sql/028-action-proposals.sql`

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `topics` | Schedule-driven or directive-driven content queue | `id`, `platform` (linkedin), `topic`, `topic_area`, `source` (schedule/directive/signal), `status` (queued/in_progress/drafted/published/skipped), `scheduled_for` |
| `reference_posts` | Annotated examples with pgvector embeddings for few-shot selection | `id`, `body`, `topic_area`, `annotation`, `embedding` (vector(1024)) |

### Key Constraints

- `reference_posts` uses IVFFlat index with 50 lists for cosine similarity search (same pattern as `voice.sent_emails`)

### Row-Level Security (contract-engine tables)

`content.drafts` (contract-engine drafts — distinct from the LinkedIn `topics`/`reference_posts` tables above, not yet documented in the Tables list) carries three RLS policies, all keyed on the identical predicate `tenancy.visible(NULL::uuid, owner_org_id)`:

| Policy | Command | Source |
|--------|---------|--------|
| `tenancy_visible_select_drafts` | SELECT | `sql/190-tenancy-rls-policies.sql` |
| `tenancy_visible_delete_drafts` | DELETE | `sql/195-contract-delete-rls-parity.sql` |
| `tenancy_visible_update_drafts` | UPDATE (`USING` + `WITH CHECK`) | `sql/196-contract-drafts-update-rls-parity.sql` |

RLS is currently a no-op in production: the app pool connects as the Supabase `postgres.<project>` superuser, which bypasses RLS unconditionally. These policies exist so the future STAQPRO-303 pool flip (to the non-superuser `autobot_agent` role, `sql/001-baseline.sql` — `LOGIN NOINHERIT`, no `BYPASSRLS`) doesn't silently deny writes: Postgres denies-by-default on DML against an RLS-enabled table with no matching policy (0 rows affected, no error, transaction still commits). Migration 196 closes this gap for the `source_draft_id`-detach UPDATE in `DELETE /api/contracts/:id`. `content.send_overrides` has a comparable UPDATE-RLS gap, deliberately left open and tracked separately as issue #561 — its policy predicate is keyed on `auth.uid()` / `request.jwt.claim.sub`, which no code path currently populates.

## Budget Reservation Pattern

The budget system uses a three-phase pattern to prevent TOCTOU races:

### Phase 1: Reserve (pre-execution)

```sql
-- reserve_budget() uses UPDATE...WHERE to atomically reserve cost
-- Two concurrent agents CANNOT both pass -- the WHERE clause prevents it
UPDATE agent_graph.budgets
  SET reserved_usd = reserved_usd + $estimated_cost
  WHERE scope = 'daily' AND period_start = CURRENT_DATE
    AND spent_usd + reserved_usd + $estimated_cost <= allocated_usd;
```

If the update matches zero rows, the budget is exhausted. If `spent_usd >= allocated_usd`, a financial halt signal is automatically inserted.

### Phase 2: Commit (post-execution)

```sql
-- commit_budget() converts reservation to actual spend
UPDATE agent_graph.budgets
  SET spent_usd = spent_usd + $actual_cost,
      reserved_usd = reserved_usd - $estimated_cost;
```

### Phase 3: Release (on failure)

```sql
-- release_budget() frees the reservation
UPDATE agent_graph.budgets
  SET reserved_usd = GREATEST(reserved_usd - $estimated_cost, 0);
```

The `budgets_no_overspend` CHECK constraint (`spent_usd + reserved_usd <= allocated_usd`) provides a final database-level safety net.

### Orphaned Reservation Recovery

The Reaper periodically recalculates `reserved_usd` based on the count of actually in-progress tasks, cleaning up reservations leaked by crashed agents.

## Cross-Schema Communication

Schemas communicate through work item metadata (JSONB), not foreign keys:

- `inbox.emails.work_item_id` links to `agent_graph.work_items.id` (no FK constraint)
- `agent_graph.action_proposals.message_id` soft-references `inbox.messages.id` (no FK constraint)
- `agent_graph.action_proposals.topic_id` soft-references `content.topics.id` (no FK constraint)
- `voice.edit_deltas.draft_id` soft-references `agent_graph.action_proposals.id` (no FK constraint)
- Agent handlers query across schemas using the `message_id` or `topic_id` stored in work item metadata

Orphaned cross-schema references are detected by `agent_graph.reconcile_schemas()`.

This design allows schemas to be independently migrated and avoids cascading issues.
