---
title: Meeting Actions → Linear (v0.2) — Tech Spec
status: Draft
owner: Isaias
date: 2026-05-20
related: meeting-actions-to-kanban-v0.2.md (PRD)
---

# Tech Spec: Meeting Actions → Linear (v0.2)

Implementation plan covering: the four product-decisions from the PRD (two-tier push, auto-detect state mapping, parallel /board+Linear surfaces, DB-stored guardrails), the v0.1 gap fixes carried forward, and the new Linear integration end-to-end.

---

## 0. v0.1 Gap Audit (carried forward)

These are unchanged from the earlier audit and remain blocking for v0.2.

### Critical — Promotion-time

| # | Gap | Where |
|---|-----|-------|
| G0.1 | `enrichTask` is never called. Every promoted task has `description=null`, `project_id=null`, `assignee_contact_id=null`, `size=null`. | `lib/runtime/signal-task-promoter.js` returns after `INSERT`; no caller for `enrichTask`. |
| G0.2 | Engagement allow-list missing from enrichment prompt. | `human-task-enrichment.js:buildEnrichmentPrompt` |

### High — Board surface

| # | Gap |
|---|-----|
| G0.4 | No lifecycle transitions (`start`, `block`, `unblock`, `to_review`, `return_to_*`). |
| G0.5 | `needs_human` payload computed but never rendered. |
| G0.6–G0.8 | Project / engagement / tags not rendered on cards. |
| G0.9 | No card-details panel. |
| G0.10 | No project filter, no size filter. |

### High — Today surface

| # | Gap |
|---|-----|
| G0.11 | `/today` does not fetch or render human_tasks. |

### Medium — Meeting surface

| # | Gap |
|---|-----|
| G0.12 | `/meetings` doesn't show how many tasks were promoted from each meeting. |
| G0.13 | No jump-to-meeting link on cards. |

### New for Linear pivot — Integration gaps

| # | Gap |
|---|-----|
| G0.19 | Existing `lib/linear/client.js` covers GraphQL plumbing but no `createIssue` helper that maps `human_tasks` → Linear payload. |
| G0.20 | Linear webhook exists for engineering tickets (`src/linear/ingest.js`) but does not match issues by `linear_issue_id` against `inbox.human_tasks`. |
| G0.21 | No team-workflow state cache. Mapping `human_tasks.status ↔ Linear stateId` requires live state lookup unless cached. |
| G0.22 | No reconciliation loop — if a webhook is missed, divergence is silent. |

---

## 1. Functional Requirements

### Enrichment pipeline (closes G0.1, G0.2)

- **FR-1.** When a human task is created, the enrichment LLM call MUST run asynchronously within 60s and patch the row with: `description`, `project_id`, `engagement_id` (when resolvable), `assignee_contact_id`, `assignee_confidence`, `task_type`, `priority`, `size`, `tags`, `next_action_hint`, `related_contact_ids`, `extraction_confidence`.
- **FR-2.** Enrichment MUST validate `project_id` and `engagement_id` against their respective tables (active only); invalid values drop to null.
- **FR-3.** Enrichment MUST be re-runnable, and MUST NOT overwrite any field the operator has manually edited (tracked via `feedback_history` `verb='edited'`). Sticky-override logic.
- **FR-4.** Enrichment failure MUST NOT block promotion. Row stays in initial lane; failure logged.

### Push to Linear (the LLM picks everything)

- **FR-5.** After enrichment completes, a **push LLM call** runs. It receives: the task row, the active Linear projects, the team members, the workflow states, the labels, and the current **push guardrail** prompt. It returns a structured Linear issue payload `{title, description (markdown), projectId|null, assigneeId|null, stateId, priority, labelIds[], dueDate|null, skip_reason?}`.
- **FR-6.** **Two-tier push trigger** (per product decision):
  - `relevance_score ≥ 0.8` → push immediately.
  - `0.6 ≤ relevance_score < 0.8` → wait on `/board` proposed-band for operator tap "Push to Linear".
  - `relevance_score < 0.6` → never pushed; stays as `proposed` or terminates `not_for_us`.
- **FR-7.** The push LLM payload MUST be validated against the cached Linear team metadata (project/assignee/state/label ids must exist) before submission. Invalid ids drop to defaults from the guardrail mapping.
- **FR-8.** After successful issue creation, the row's `linear_issue_id`, `linear_issue_url`, `linear_synced_at` are written. The card's "Linear chip" becomes visible.
- **FR-9.** If the push LLM returns `skip_reason`, the row stays on `/board` in the **Not-pushed bin** with the reason visible. Operator can force-push from the panel.
- **FR-10.** Push MUST retry on transient errors (network, 5xx, rate-limit) with exponential backoff up to 3 attempts. Retries are **in-process under a single LLM decision** — the row stays in `running` across attempts; the next-poll path is not used for retry. Rationale: NFR-8 caps LLM cost at one call per push, and re-LLMing on each Linear retry would produce a non-deterministic payload (different decision per attempt). After 3 attempts the row goes to `failed` with the last error in `push_last_error`.
- **FR-11.** Description footer MUST include the guardrail revision number used at push time (e.g. `Pushed under guardrail v7`).

### Pull from Linear (the agent organisation hears the human)

- **FR-12.** Linear webhook subscription MUST be added for `Issue` and `Comment` events on the team.
- **FR-13.** For any webhook event referencing an issue whose id matches `inbox.human_tasks.linear_issue_id`, the matching row's mirrored fields (status, title, description, assignee, priority, labels, project) update to reflect Linear. `feedback_history` appends a `linear_pull` entry.
- **FR-14.** When a pulled state is mapped to terminal (`done`, `not_for_us`), Optimus emits `pg_notify('human_task.completed', task_id)`. Downstream agents subscribe.
- **FR-15.** "**Ready for Optimus**" signal — two equivalent triggers:
  - Issue moves to the workflow state mapped to `awaiting_optimus` in the operator's mapping (default name: `Ready for Optimus`, auto-created on first run if missing).
  - Issue receives a comment containing `@optimus` (configurable mention handle).
  Either fires `pg_notify('human_task.ready_for_optimus', { task_id, comment_text?, actor })` for the orchestrator to handle.
- **FR-16.** A **reconciliation job** MUST run every 10 minutes: compares `inbox.human_tasks WHERE linear_issue_id IS NOT NULL` against Linear's GraphQL state for those issues; fills any divergent rows. Counts divergence events in metrics.

### Conflict resolution (both surfaces in parallel)

- **FR-17.** Source-of-truth contract: `inbox.human_tasks` is canonical. Linear is a synchronised view.
- **FR-18.** On every edit, both surfaces stamp `updated_at` (DB) and we record `linear_synced_at` (last successful sync). A push attempt where `linear_updated_at` (last seen webhook timestamp) is newer than `linear_synced_at` triggers a read-before-write: Optimus fetches Linear's current state, merges, and only writes fields the human did not change since last sync. Conflicts are logged.
- **FR-19.** If two surfaces edit the same field within the same sync window, last-write-wins with a `feedback_history` entry recording the dropped change. Operator can view the conflict in the card-details panel.

### Guardrails (DB-stored, versioned)

- **FR-20.** A new `inbox.llm_guardrails` table stores guardrail revisions: `(id, kind ENUM('push','pull'), prompt_text, mapping JSONB, created_by, created_at, is_current BOOLEAN)`. `is_current = true` for exactly one row per `kind` at any time.
- **FR-21.** The push LLM call MUST fetch the current `push` guardrail and prepend its `prompt_text` to the system prompt. The pull LLM (for `@optimus` comment interpretation) does the same with `kind='pull'`.
- **FR-22.** A new **Settings → LLM Guardrails** page MUST:
  - Render the current push and pull prompts in editable text areas (Markdown, 2000-char hard cap).
  - Render the state mapping editor (one row per Linear workflow state → `human_tasks.status` dropdown).
  - Allow saving a new revision. Saving creates a new row, sets `is_current=true`, flips the previous current row to `is_current=false`.
  - Show diff between current and previous revision.
  - Show "Last 10 LLM decisions under this prompt" — table of recent pushes with a "this was wrong" button that captures a correction example.
- **FR-23.** Every push and pull LLM call MUST record the guardrail revision id used, in `feedback_history` (`verb='llm_decision'`, `guardrail_id`).

### Backfill of pre-existing tasks (PRD §8b)

- **FR-B1.** On migration run, existing `inbox.human_tasks` rows MUST have `push_status = NULL` (not `pending`). They do not enter the auto-push queue.
- **FR-B2.** A new **Backfill panel** under `Settings → Backfill to Linear` MUST:
  - Show counts of pushable rows grouped by `status`, `relevance_score` band, and age bucket (`< 7d`, `7–30d`, `> 30d`).
  - Provide filter controls (status include/exclude, min relevance, max age).
  - Render a preview table of the first 50 matching rows with title + relevance + status.
  - Have a **Push selected** button that flips `push_status='pending'` on the filtered set.
- **FR-B3.** Backfill MUST exclude terminal rows (`done`, `skipped`, `not_for_us`) from any selection, regardless of filter input — these are hard-excluded server-side.
- **FR-B4.** Backfill MUST respect the same rate limiter as steady-state push (NFR-8). A single large backfill is queued; throughput is capped at 50 tasks/min.
- **FR-B5.** Each row pushed via backfill MUST record `feedback_history` entry `verb='linear_push'` with payload `{ backfill: true, backfill_batch_id }`. The batch id is generated per "Push selected" click so the operator can group/cancel a wave.
- **FR-B6.** A backfill batch MUST be **cancellable** while still pending. Cancellation flips `push_status` back to `NULL` for rows in that batch that haven't been picked up yet.
- **FR-B7.** Backfill runs MUST be observable in `human_task_sync_log` with `direction='push'` and a non-null `backfill_batch_id` column.

### Linear team metadata cache (closes G0.21)

- **FR-24.** A new `inbox.linear_team_cache` table (or row in an existing config table) MUST cache: workflow states (id, name, type), projects (id, name, is_active), team members (id, name, email), labels (id, name). Refreshed on a 1-hour interval and on demand from Settings.
- **FR-25.** On first run, Optimus MUST auto-populate the state mapping by introspecting the team's Linear workflow `state.type` enum (which Linear normalises to `backlog | unstarted | started | completed | canceled`) and assigning these defaults:
  - `backlog` → `inbox`
  - `unstarted` → `todo`
  - `started` → `in_progress`
  - `completed` → `done`
  - `canceled` → `not_for_us`
  - Other / unmapped types → `inbox` with a warning surfaced in Settings.

  `review` is intentionally not in the defaults because Linear has no `review` enum type — teams that use a custom "In Review" state will see it normalised to `started` and mapped to `in_progress`. Operators who want `review` mirrored separately must edit the mapping in Settings to overlay it on the specific state name (handled via the editable mapping override per AD-8).
- **FR-26.** If the operator's team lacks a "Ready for Optimus" state, the Settings page MUST offer a one-click "Create this state in Linear" action that calls `workflowStateCreate`. After creation, the state-mapping table is refreshed.

### Lifecycle transitions on /board (closes G0.4)

**Lifecycle transition table** (canonical — the v0.2 PRD's earlier §4 table was lost in the Linear rewrite; this is the authoritative reference):

| Current status | Allowed verbs | Resulting status | UI label |
|----------------|---------------|------------------|----------|
| `inbox` | `start` | `todo` | Start |
| `inbox` | `to_in_progress` | `in_progress` | Send to in-progress |
| `proposed` | (none via this endpoint — must answer `is_this_ours` first) | — | — |
| `todo` | `start` | `in_progress` | Start |
| `todo` | `to_inbox` | `inbox` | Return to inbox |
| `later` | `start` | `in_progress` | Start |
| `later` | `to_inbox` | `inbox` | Return to inbox |
| `in_progress` | `block` | `blocked` | Block |
| `in_progress` | `to_review` | `review` | Send to review |
| `in_progress` | `to_todo` | `todo` | Return to todo |
| `blocked` | `unblock` | `in_progress` | Unblock |
| `blocked` | `to_todo` | `todo` | Return to todo |
| `review` | `to_in_progress` | `in_progress` | Return to in-progress |
| terminal (`done`/`skipped`/`not_for_us`) | (none) | reject 409 | — |

`proposed` rows cannot be lifecycle-transitioned directly — they must clear the relevance gate via the inline-answer `is_this_ours` field first, which promotes them to `inbox` (or terminates them). This preserves the gate's role as the relevance check.

- **FR-27.** Each non-terminal status MUST expose its valid transitions per the table above. Transitions update `status` locally and trigger a push to Linear to mirror the corresponding state.
- **FR-28.** Lifecycle menu MUST appear on both `/board` cards and `/today` rows from the same component.
- **FR-29.** Every transition appends `feedback_history` with `verb='transition'`, `from_status`, `to_status`, `actor`, `at`.

### Board UI extensions (closes G0.5–G0.10, G0.13)

- **FR-30.** Cards MUST display: project chip, engagement chip, tags, needs-human banner, **Linear chip** (when linear_issue_id is set, clicking opens the Linear issue).
- **FR-31.** Card-details panel MUST include a new **Linear** section showing: issue id, URL, state, last-synced timestamp, last 5 comments from Linear (read-only), and a "Force resync" button.
- **FR-32.** `/board` MUST add: project filter, size filter, signal-meeting filter — composable with existing view filter.
- **FR-33.** Card body click MUST open the card-details panel. Esc / click-outside / X closes.

### Today surface (closes G0.11)

- **FR-34.** `/today` MUST render "My Tasks" section from `inbox.human_tasks` for the logged-in user, ordered by overdue → due today → priority → in_progress → created_at.
- **FR-35.** `/today` MUST render a "Today in Linear" section from a live Linear query for issues assigned to the operator that have no matching `human_tasks` row (i.e. not Optimus-originated). Read-only.
- **FR-36.** `/today` MUST render a "Quick Wins" strip from `inbox.human_tasks` where `size ∈ {quick, small}` AND (assignee = me OR (unassigned AND relevance ≥ 0.6)).
- **FR-37.** All `/today` sections MUST respect the existing `?as=` and `?all=1` scope toggles.

### Meeting integration (closes G0.12)

- **FR-38.** Each meeting card on `/meetings` MUST show "N tasks → Linear" badge with a deep-link list of the created Linear issue URLs.

---

## 2. Non-Functional Requirements

- **NFR-1. Enrichment latency.** P95 within 30s of row insert; P99 within 60s.
- **NFR-2. Enrichment cost.** ≤ $0.01 per promoted task (Haiku, one call).
- **NFR-3. Push latency.** P95 enrichment-end → Linear-issue-created within 5s (one Linear GraphQL call after the LLM completes).
- **NFR-4. Pull latency.** P95 from Linear webhook receipt → DB updated within 2s (excluding webhook delivery time, which Linear owns).
- **NFR-5. Round-trip P95 ≤ 30s** end-to-end (edit on `/board` → reflected in Linear, or vice versa).
- **NFR-6. Reconciliation completeness.** After a 24h soak with one synthetic webhook drop, ≥ 99% of divergent rows are converged by the next reconciliation cycle.
- **NFR-7. Push success rate ≥ 95%** of LLM-generated payloads accepted by Linear without validation rework.
- **NFR-8. Linear API budget.** ≤ 1 GraphQL request per task push (create) + ≤ 1 per pull update + ≤ 1 per reconciliation pass per 50 tasks. Under Linear's 1500 req/hour limit for typical volumes.
- **NFR-9. Webhook security.** Signature verification on every Linear webhook (Linear signs with HMAC-SHA256; reuse existing `verifyLinearSignature` if present, otherwise add).
- **NFR-10. Guardrail change audit.** Every revision has actor + timestamp; previous revisions are immutable; rollback creates a new revision (no destructive edits).
- **NFR-11. Cache freshness.** `inbox.linear_team_cache` refreshes every 60 minutes, or on explicit user action from Settings. A stale cache MUST NOT block a push — the push uses the most recent cache and the post-write reconciliation corrects any drift.
- **NFR-12. Authorization.** All new endpoints use `requireBoard(req)`. Settings → Guardrails is gated by an additional `is_admin` check (only Eric and Isaias for now, list in `config/governance.json`).
- **NFR-13. Append-only audit.** Every push, pull, transition, edit, guardrail change appends to `feedback_history` or `inbox.llm_guardrails_history`. No destructive updates anywhere.
- **NFR-14. Schema isolation.** Logical FKs only across schemas (SPEC §12).
- **NFR-15. Backwards compat.** `/api/board`, `/api/human-tasks`, `/api/today` add fields additively; existing callers continue to work.

---

## 3. Database Changes

### 3.1 New migration `120-human-tasks-linear-and-guardrails.sql`

Combines the v0.2 indexes + the Linear-pivot tables.

1. **Extend `last_feedback` CHECK** to include new verbs.

   ```
   ALTER TABLE inbox.human_tasks
     DROP CONSTRAINT IF EXISTS human_tasks_last_feedback_check;
   ALTER TABLE inbox.human_tasks
     ADD CONSTRAINT human_tasks_last_feedback_check
       CHECK (last_feedback IS NULL OR last_feedback IN
         ('done','skip','later','not_for_me','edited',
          'transition','linear_pull','linear_push','llm_decision'));
   ```

2. **Add Linear sync metadata.**

   ```
   ALTER TABLE inbox.human_tasks
     ADD COLUMN linear_state_id          TEXT,
     ADD COLUMN linear_state_name        TEXT,
     ADD COLUMN linear_assignee_id       TEXT,
     ADD COLUMN linear_project_id        TEXT,
     ADD COLUMN linear_last_event_at     TIMESTAMPTZ,
     ADD COLUMN push_status              TEXT
       CHECK (push_status IS NULL OR push_status IN
         ('pending','running','succeeded','skipped','failed')),
     ADD COLUMN push_skip_reason         TEXT,
     ADD COLUMN push_last_error          TEXT,
     ADD COLUMN push_attempts            INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN pushed_at                TIMESTAMPTZ,
     ADD COLUMN enrichment_status        TEXT
       CHECK (enrichment_status IS NULL OR enrichment_status IN
         ('pending','running','completed','failed','skipped')),
     ADD COLUMN enrichment_at            TIMESTAMPTZ;
   ```

3. **Indexes** for the new query patterns.

   ```
   CREATE INDEX human_tasks_pending_enrichment
     ON inbox.human_tasks (created_at)
     WHERE deleted_at IS NULL AND enrichment_status = 'pending';

   CREATE INDEX human_tasks_pending_push
     ON inbox.human_tasks (created_at)
     WHERE deleted_at IS NULL AND push_status = 'pending';

   CREATE INDEX human_tasks_by_linear_issue
     ON inbox.human_tasks (linear_issue_id)
     WHERE deleted_at IS NULL AND linear_issue_id IS NOT NULL;

   CREATE INDEX human_tasks_by_assignee_status_due
     ON inbox.human_tasks (assignee_contact_id, status, due_date NULLS LAST)
     WHERE deleted_at IS NULL
       AND status NOT IN ('done','skipped','not_for_us');

   CREATE INDEX human_tasks_quickwins
     ON inbox.human_tasks (size, relevance_score, created_at)
     WHERE deleted_at IS NULL
       AND size IN ('quick','small')
       AND status NOT IN ('done','skipped','not_for_us');

   CREATE INDEX human_tasks_by_project_status
     ON inbox.human_tasks (project_id, status)
     WHERE deleted_at IS NULL AND project_id IS NOT NULL;
   ```

4. **New table `inbox.llm_guardrails`** (versioned, append-only).

   ```
   CREATE TABLE inbox.llm_guardrails (
     id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
     kind         TEXT NOT NULL CHECK (kind IN ('push','pull')),
     prompt_text  TEXT NOT NULL,
     mapping      JSONB NOT NULL DEFAULT '{}'::jsonb,
     is_current   BOOLEAN NOT NULL DEFAULT false,
     revision     INTEGER NOT NULL,
     created_by   TEXT NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     note         TEXT
   );

   CREATE UNIQUE INDEX llm_guardrails_current_per_kind
     ON inbox.llm_guardrails (kind) WHERE is_current = true;

   CREATE INDEX llm_guardrails_by_kind_revision
     ON inbox.llm_guardrails (kind, revision DESC);
   ```

5. **New table `inbox.linear_team_cache`** (single-row per cache kind, snapshot of Linear team metadata).

   ```
   CREATE TABLE inbox.linear_team_cache (
     team_id      TEXT PRIMARY KEY,
     workflow_states  JSONB NOT NULL DEFAULT '[]'::jsonb,
     projects         JSONB NOT NULL DEFAULT '[]'::jsonb,
     members          JSONB NOT NULL DEFAULT '[]'::jsonb,
     labels           JSONB NOT NULL DEFAULT '[]'::jsonb,
     refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```

6. **Append-only sync log** for debugging divergence and audit.

   ```
   CREATE TABLE inbox.human_task_sync_log (
     id                BIGSERIAL PRIMARY KEY,
     task_id           TEXT NOT NULL REFERENCES inbox.human_tasks(id) ON DELETE CASCADE,
     direction         TEXT NOT NULL CHECK (direction IN ('push','pull','reconcile')),
     outcome           TEXT NOT NULL CHECK (outcome IN
                         ('success','skipped','failed','no_change','conflict_resolved')),
     before_snapshot   JSONB,
     after_snapshot    JSONB,
     guardrail_id      TEXT,
     backfill_batch_id TEXT,
     error_text        TEXT,
     duration_ms       INTEGER,
     at                TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   CREATE INDEX human_task_sync_log_by_task
     ON inbox.human_task_sync_log (task_id, at DESC);
   CREATE INDEX human_task_sync_log_by_batch
     ON inbox.human_task_sync_log (backfill_batch_id, at DESC)
     WHERE backfill_batch_id IS NOT NULL;
   ```

7. **Backfill batches** — small table for grouping operator-initiated backfill waves.

   ```
   CREATE TABLE inbox.linear_backfill_batches (
     id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
     created_by    TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     filter_json   JSONB NOT NULL,
     task_count    INTEGER NOT NULL,
     state         TEXT NOT NULL DEFAULT 'pending'
       CHECK (state IN ('pending','in_progress','completed','cancelled')),
     completed_at  TIMESTAMPTZ
   );
   ```

### 3.2 Data backfill

- On migration run, seed an initial `llm_guardrails` row for each kind (`push`, `pull`) with an empty prompt and the auto-detected mapping (computed by a small script that queries Linear once and saves the result). `is_current=true`, `revision=1`, `created_by='system'`.
- Existing `human_tasks` rows get `enrichment_status='pending'` (so the enrichment worker fills in missing fields) but `push_status` stays **NULL** — they do NOT auto-push to Linear. Push happens only via the operator-driven Backfill panel (FR-B1–B7).

---

## 4. API Changes

All new endpoints follow the pattern in `autobot-inbox/src/api-routes/human-tasks.js`.

### 4.1 New endpoints

| Method + Path | Purpose | FR |
|---|---|---|
| `POST /api/human-tasks/:id/lifecycle` | Body `{verb, reason?}`. Updates status + appends transition. Triggers Linear push. | FR-27, FR-29 |
| `PATCH /api/human-tasks/:id/fields` | Body `{field, value}`. Inline edits with sticky-override logic. Triggers Linear push. | FR-3, FR-17–19 |
| `POST /api/human-tasks/:id/enrich` | Force re-enrichment. Idempotent; respects sticky overrides. | FR-3 |
| `POST /api/human-tasks/:id/push` | Force push to Linear (used for the confirm-push tier and for retries). | FR-6, FR-9, FR-10 |
| `POST /api/human-tasks/:id/resync` | Force pull from Linear (button in card-details Linear section). | FR-31 |
| `GET /api/human-tasks/:id` | Single-row fetch with `feedback_history` + sync log tail. Used by panel. | FR-31, FR-33 |
| `GET /api/projects` | Active projects from `agent_graph.projects`. | FR-30, FR-32 |
| `GET /api/engagements` | Active engagements. | FR-30 |
| `GET /api/today/tasks` | My Tasks + Quick Wins, server-sorted. | FR-34, FR-36 |
| `GET /api/today/linear` | Live Linear-only issues for the operator (not in human_tasks). | FR-35 |
| `POST /api/linear/webhook` | Linear webhook receiver (extends existing if present). | FR-12–FR-15 |
| `POST /api/linear/reconcile` | Manual trigger for reconciliation. Cron also calls this every 10min. | FR-16 |
| `GET /api/linear/team-cache` | Returns current cache contents. Used by Settings + push payload validation. | FR-24 |
| `GET /api/linear/backfill/preview` | Query params: status filter, min_relevance, max_age_days. Returns count + first 50 rows that would push. | FR-B2 |
| `POST /api/linear/backfill` | Body: same filters as preview + `dry_run`. Creates a `linear_backfill_batches` row, flips matching `push_status='pending'`. Returns batch_id. | FR-B2, FR-B5 |
| `POST /api/linear/backfill/:batch_id/cancel` | Cancels a backfill batch — flips back to `NULL` any row in this batch still in `pending`. | FR-B6 |
| `GET /api/linear/backfill/:batch_id` | Returns batch state + progress (pushed / pending / failed counts). | FR-B7 |
| `POST /api/linear/team-cache/refresh` | Forces a cache refresh from Linear. | FR-11 (NFR) |
| `POST /api/linear/workflow-states` | Creates a workflow state (used for one-click "Create Ready for Optimus" state). | FR-26 |
| `GET /api/guardrails` | Returns current `push` + `pull` guardrails + mapping. | FR-22 |
| `POST /api/guardrails` | Body `{kind, prompt_text, mapping, note}`. Creates new revision, flips `is_current`. | FR-20, FR-22 |
| `GET /api/guardrails/history` | Lists revisions with diff snippets. | FR-22 |
| `GET /api/guardrails/decisions` | Query params: guardrail_id, limit (default 10, max 50). Returns recent push decisions tied to that guardrail revision. Powers the "Last 10 decisions" panel (FR-22). | FR-22 |
| `POST /api/guardrails/correction` | Body `{task_id, what_was_wrong}`. Captures a correction example tied to the revision in effect at push time. | FR-22 |

### 4.2 Extended endpoints

- `GET /api/human-tasks` — add query params `project`, `size`, `signal_meeting_id`, `push_status`.
- `GET /api/board` — add `?project=`, `?size=` params applied at SQL layer.

### 4.3 inbox-proxy allow-list

Add to `board/src/app/api/inbox-proxy/route.ts` ALLOWED_PATHS: `/api/today/tasks`, `/api/today/linear`, `/api/projects`, `/api/engagements`, `/api/linear/team-cache`, `/api/linear/team-cache/refresh`, `/api/linear/reconcile`, `/api/guardrails`, `/api/guardrails/history`, `/api/guardrails/correction`. Sub-paths under `/api/human-tasks/` already covered.

---

## 5. UI Changes

### 5.1 New components

| Component | Path | Purpose |
|-----------|------|---------|
| `HumanTaskCardBody` | `board/src/app/board/human-task-card-body.tsx` | Extracted card body. Renders project chip, engagement chip, tags, needs-human banner, Linear chip. |
| `LinearChip` | `board/src/app/components/linear-chip.tsx` | `LIN-123` pill with click-through to Linear issue. |
| `LifecycleMenu` | `board/src/app/board/lifecycle-menu.tsx` | Kebab menu, computes valid transitions, calls `/lifecycle`. |
| `CardDetailsPanel` | `board/src/app/board/card-details-panel.tsx` | Right-side slide-in. Includes the new **Linear section**: issue link, state, last-synced, last 5 comments, Force resync button. |
| `ProjectPicker`, `EngagementPicker` | `board/src/app/components/` | Search-as-you-type dropdowns. |
| `BoardFilters` | `board/src/app/board/board-filters.tsx` | view + project + size + signal-meeting, URL-persisted. |
| `MyTasksSection` | `board/src/app/today/my-tasks.tsx` | /today section, reuses card body + lifecycle menu. |
| `TodayInLinearSection` | `board/src/app/today/today-in-linear.tsx` | Live Linear fetch, read-only. |
| `QuickWinsStrip` | `board/src/app/today/quick-wins.tsx` | Horizontal strip. |
| `GuardrailEditor` | `board/src/app/governance/guardrails/editor.tsx` | Push + Pull prompt textareas, mapping editor, "save as new revision", diff vs. previous, last-10-decisions panel, correction button. |
| `LinearStateMapper` | `board/src/app/governance/guardrails/state-mapper.tsx` | One row per Linear workflow state → human_tasks.status dropdown. "Create Ready for Optimus" button. |
| `BackfillPanel` | `board/src/app/governance/backfill/panel.tsx` | Filter controls (status / min relevance / max age), counts-by-bucket summary, preview table, "Push selected" button, list of in-flight + completed batches with cancel buttons. |

### 5.2 Edited components

| File | Change |
|------|--------|
| `board/src/app/board/page.tsx` | Mount `BoardFilters`, `CardDetailsPanel`. Refactor card body to use `HumanTaskCardBody`. Add Linear chip rendering. |
| `board/src/app/board/human-task-card.js` | Add `lifecycleTransitionsFor(card)` pure function. Wire `formatNeedsHuman`. |
| `board/src/app/today/page.tsx` | Add `<MyTasksSection/>`, `<TodayInLinearSection/>`, `<QuickWinsStrip/>`. |
| `board/src/app/meetings/page.tsx` | Add "N tasks → Linear" badge per meeting. |
| `board/src/app/governance/page.tsx` | Add link to Guardrails editor sub-route. |

### 5.3 Tests (per ADR-004, `node:test`)

- `linear-push-payload.test.js` — pure function `buildLinearIssuePayload(task, teamCache, guardrail)` covering all field decisions.
- `linear-pull-mapping.test.js` — pure function `mapLinearEventToTaskPatch(event, mapping)` covering state, assignee, project, label diffs.
- `linear-conflict-resolution.test.js` — `reconcileTaskWithLinear(localRow, remoteIssue, lastSyncedAt)` exhaustive cases.
- `lifecycle-menu.test.js` — transition-table coverage from PRD §4.
- `board-filters.test.js` — extend for project + size + signal-meeting composition.
- `guardrails-revision.test.js` — `is_current` invariant, append-only history.
- `human-task-sticky.test.js` — sticky-override logic.
- Integration: extend `human-tasks-api.test.js` for all new routes.
- Integration: `linear-webhook-roundtrip.test.js` simulates push → webhook → pull cycle against a mock Linear.

---

## 6. Architectural Decisions

### AD-1. Enrichment runs out-of-band; push runs after enrichment completes.

Promotion completes the synchronous insert and emits `pg_notify('human_task.enrichment_pending', task_id)`. A worker dequeues, calls `enrichTask`, patches the row, then (if `relevance_score ≥ 0.8`) enqueues a push by setting `push_status='pending'`. A second worker dequeues push-pending rows, calls the push LLM, then calls Linear.

Two workers, two queues (rows are the queues), one event channel per stage. Keeps the ingestion path's latency budget unchanged.

**Why not one worker for both stages?** Different rate limits (LLM vs Linear API), different retry semantics, different failure isolation. Splitting lets push retry independently when enrichment succeeded.

### AD-2. Source-of-truth: `inbox.human_tasks` is canonical; Linear is a synchronised view.

Even though Linear becomes the primary human surface, we keep DB as canonical because: (a) `/board` and `/today` need it for queries that Linear can't answer (relevance score, source quote, signal lineage); (b) audit + replay require local persistence; (c) downstream agents subscribe to `pg_notify` on DB changes — they don't talk to Linear directly.

Pull events update DB. DB updates push back to Linear. The reconciliation job is the safety net.

**Why not Linear-canonical?** Linear can't represent the relevance gate, the source-quote provenance, or the signal lineage. We'd lose half the data model.

### AD-3. Conflict resolution: read-before-write with field-level merge.

On every push attempt, the push worker fetches the current Linear issue first. It builds a "fields the human has changed since `linear_synced_at`" set and excludes those from the write. The push only writes fields the local row owns. Append a `human_task_sync_log` entry with both snapshots so divergence is debuggable.

**Why not last-write-wins?** Loses work silently — the human's edit on Linear gets overwritten by an Optimus push triggered by enrichment retry.

**Why not optimistic concurrency tokens?** Linear doesn't expose them in webhook payloads. We have `updatedAt` on the issue, which is enough.

### AD-4. Lifecycle and feedback share `feedback_history`.

Lifecycle transitions, Linear push events, Linear pulls, LLM decisions, manual edits — all append to one ordered `feedback_history` array per task. One audit query, one calibration source.

**Alternative considered:** separate `lifecycle_history`, `linear_history`, `llm_history` columns. Rejected — multiplies tables, complicates the calibration query.

### AD-5. Operator overrides are sticky.

Once an operator sets a field manually (recorded as `verb='edited'`), re-enrichment skips that field. The push LLM may still include it (since the operator's value is part of the row), but enrichment never overwrites it.

### AD-6. Guardrails are DB-stored, versioned, append-only.

Per the product decision. Editing creates a new revision; `is_current=true` flag flips atomically; previous revision is immutable. Every push records the `guardrail_id` it ran under, so the calibration loop can attribute behaviour changes to specific prompt edits.

**Why not config/*.json?** No hot-edit, requires deploy, can't attribute LLM behaviour to specific revision id, can't show "last 10 decisions" inline.

**Why a single-row-per-kind invariant with `is_current`?** Simpler query than `MAX(revision) WHERE kind=…`. Index supports it; one partial unique index enforces it.

### AD-7. Linear team metadata cache is single-row JSONB.

`inbox.linear_team_cache` is one row per team_id holding all metadata as JSONB. Refreshed hourly + on demand. Reads are O(1). No need for relational normalisation — we never JOIN against it.

**Why not separate tables for states / projects / members?** Doesn't earn its complexity. We need the snapshot whole.

### AD-8. Auto-detect mapping with editable defaults.

On first run, a one-shot bootstrap script queries Linear's workflow states and builds a default mapping using name heuristics (see FR-25). The result is saved as guardrail revision 1. The operator can edit and save a new revision at any time.

**Why heuristics over hardcoded names?** Linear teams customise workflow states; "Up Next" or "Doing" are common. Heuristics use `state.type` (Linear exposes `backlog | unstarted | started | completed | canceled`) which is normalised across teams.

### AD-9. Webhook handler reuses existing pattern.

`src/linear/ingest.js` already has the dedup cache + signature verification scaffolding for the engineering-ticket flow. v0.2 extends it: add a branch that matches `issue.id` against `human_tasks.linear_issue_id` and dispatches to the human-task pull handler. Engineering-ticket path unchanged.

**Why not a separate webhook endpoint?** Linear's webhook config supports one URL per team. Multiplexing in code is cheaper than fragmenting at the network layer.

### AD-10. Parallel /board + Linear surfaces are intentional, not transitional.

Both surfaces stay supported. The cost — extra UI maintenance — is justified because `/board` is also the **only** surface for: governance audit, proposed-band "Is this ours?" gate, and operators (auditors, Strategist, future external reviewers) who don't have Linear access.

### AD-11. Reconciliation loop is the safety net, not the primary sync.

Webhooks are the primary sync (low latency). Reconciliation is a 10-min cron that catches missed webhooks. The reconciliation worker only reads from Linear (no writes unless DB is out of sync); divergent rows fire a `pg_notify('human_task.divergence', task_id)` event for observability.

**Why not poll-only?** 10-min latency is too slow for the round-trip parity target (30s).

**Why not webhook-only?** Webhook delivery isn't guaranteed; one missed event creates silent drift.

---

## 7. Sequencing

Five weeks. Week 1 is gap-fix + plumbing prerequisite; weeks 2–5 are mostly parallelisable per track.

### Week 1 — Foundations (Gap fixes)

1. Migration `120-human-tasks-linear-and-guardrails.sql`.
2. Wire `enrichTask` post-promotion via `pg_notify` worker. Backfill `enrichment_status='pending'`.
3. Add engagement allow-list to enrichment prompt.
4. Add lifecycle verbs to API (`POST /lifecycle`).
5. Add sticky-override helper `lib/runtime/human-task-sticky.js`.

### Week 2 — Linear push side

6. `lib/linear/team-cache.js` — cache loader + 1h refresh cron + bootstrap script for default mapping.
7. `lib/linear/issue-payload.js` — pure function building Linear payload from task + cache + guardrail.
8. `lib/runtime/human-task-push-worker.js` — dequeues `push_status='pending'`, runs push LLM, calls Linear `issueCreate`, writes back ids.
9. `POST /api/human-tasks/:id/push` endpoint (force push for confirm-push tier).
10. Two-tier push trigger logic (auto vs confirm per FR-6).

### Week 3 — Linear pull side + reconciliation

11. Extend `src/linear/ingest.js` with human-task branch.
12. State / assignee / project / priority pull mapping (`lib/linear/pull-mapping.js`).
13. "Ready for Optimus" detection — state-name match + `@optimus` comment parse.
14. Reconciliation cron job (`scripts/reconcile-linear.js`, 10min schedule).
15. `feedback_history` linear_pull / linear_push entries + `human_task_sync_log` writes.

### Week 4 — Guardrails

16. `inbox.llm_guardrails` table + API endpoints.
17. Bootstrap script seeds revision 1 (auto-detected mapping + empty prompt).
18. `GuardrailEditor` + `LinearStateMapper` UI under `/governance/guardrails`.
19. Wire guardrail fetch into push + pull LLM calls.
20. "Last 10 decisions" panel + correction button.

### Week 5 — Board/Today UI + meetings

21. `HumanTaskCardBody`, `LinearChip`, `LifecycleMenu`, `CardDetailsPanel`.
22. `BoardFilters` (project + size + signal-meeting).
23. `MyTasksSection`, `TodayInLinearSection`, `QuickWinsStrip` on `/today`.
24. Task-count badge on `/meetings`.
25. All tests (per §5.3). Calibration: measure success criteria from PRD §11; tune.

---

## 8. Engineering Risks

| Risk | Mitigation |
|------|------------|
| Single-worker bottleneck on push (one row at a time blocks others). | `SELECT … FOR UPDATE SKIP LOCKED` so multiple worker instances race safely (same pattern as `agent_graph.work_items`). Concurrency cap = 4. |
| Linear rate limit during meeting backlog backfill. | Token-bucket rate limiter at 1500 req/hour. Backfill runs at 50 tasks/min max. |
| Webhook signature secret rotation breaks the integration silently. | Health-check endpoint that simulates a signed webhook every 5 min; pages on failure. |
| Guardrail edits cause LLM regressions. | Auto-snapshot last 50 pushes before each revision; diff "decisions before vs. after" is visible in the editor for the first 24h after a change. |
| Two-tier push (confirm) gets stale — operator doesn't notice. | Slack DM digest of unconfirmed pushes at end of day. |
| Sticky-override logic confuses operators ("why didn't enrichment update this?"). | Card-details panel shows "Manually set by Eric on 2026-05-14" next to any sticky field; "Clear override" button restores enrichable behaviour. |
| `human_task_sync_log` grows unbounded. | Monthly partition + 90-day retention. |
| Push LLM hallucinates a state/project/assignee id. | Payload validator (`lib/linear/issue-payload-validate.js`) checks every id against the cache before submission. Invalid → drop to guardrail default. |
| /board and Linear diverge despite reconciliation. | Divergence dashboard panel under `/governance/sync-health` showing rows with `human_task_sync_log.outcome='conflict_resolved'` in last 24h. |

---

## Implementation Notes

Things discovered during implementation that weren't pinned by the spec but matter for future readers.

### Task 11 — Linear webhook router (2026-05-21)

- **Router runs BEFORE the existing engineering-ticket dispatch.** P1 deny-by-default: an Optimus-owned issue (matched by `linear_issue_id`) MUST never reach `createWorkItem` and the executor-coder path. Match → dispatch to human-task path + return early.
- **`linear_last_event_at` stamp failure is swallowed** but `{matched:true}` is still returned. Worst case: stale timestamp; the engineering path is still correctly skipped.
- **Pre-existing test fixture issue surfaced.** `linear-ingest.test.js` had per-test mockQuery defaults that returned non-empty rows for ANY query — would spuriously match the new router's lookup. Mock narrowed to inspect `text.includes('human_tasks')` and return `{rows:[]}` for that branch. Legitimate extension; no assertions changed. Code reviewer verified the failure modes were real.
- **`handleHumanTaskWebhook` is a STUB for Task 11.** Body is filled by Tasks 12 (pull mapping), 13 (ready-for-Optimus), 15 (sync log).
- **Tests need `--experimental-test-module-mocks` flag** — pre-existing convention from `linear-ingest.test.js` header.

### Tasks 9, 10 — Force-push + two-tier trigger (2026-05-21)

- **Force-push appends `feedback_history` entry `verb='force_push'`** — operator-initiated retry is auditable per P3. No `field`/`value` since it's not an edit. Matches the audit pattern of lifecycle/inline-answer/patch handlers.
- **Two-tier auto-enqueue uses single conditional SQL** with `WHERE relevance_score >= 0.8 AND push_status IS NULL AND status NOT IN (terminal)`. RETURNING gates the `pg_notify`. No JS branching — pure DB-driven decision.
- **Confirm-tier rows (0.6–0.8) are recognised by `push_status IS NULL` post-enrichment**. The `/board` confirm-push UI will use this as its signal: "rows with completed enrichment, no push attempt, score in [0.6, 0.8)" are the "ready for operator confirm" set. This isn't a column — it's a query predicate. Task 21 surfaces it.
- **UPDATE + pg_notify in `maybeEnqueuePush` are not transactional.** If the process dies between them, `push_status='pending'` is set but no notify fires. Push worker's 5s poll fallback recovers within the next cycle. Acceptable.

### Task 8 — Push worker (2026-05-21)

- **In-process retry, not next-poll re-claim.** Spec FR-10 originally read "Push MUST retry … exponential backoff up to 3 attempts" without specifying the retry locus. Implementation chose in-process (worker holds the row in `running` across attempts; LLM called exactly once). Reason: NFR-8 caps LLM cost at 1 call/push; re-polling would re-LLM and produce a non-deterministic payload. FR-10 in the spec now explicitly pins this.
- **New column `pushed_at TIMESTAMPTZ`** added to migration 120. The existing `inbox.touch_human_tasks_updated_at` BEFORE UPDATE trigger (migration 119) clobbers `updated_at` on every UPDATE, so it can't be used for staleness detection. `pushed_at` is owned by the push worker and symmetric with `enrichment_at`. The 5-min freshness window applies to it.
- **`lib/runtime/push-prompt.js` is a STUB.** It returns a placeholder JSON-stringified summary of the task. Task 19 will wire the real prompt builder with guardrail prepending. Tests inject the llm and don't depend on the prompt body.
- **Three apply paths**: `applySuccess` (sets `last_feedback='linear_push'`, writes Linear ids), `applySkip` (skip_reason, no Linear call), `applyTerminalFailure` (after exhausted attempts). All three append to feedback_history + sync_log. Note: `last_feedback` updated only on success path — intentional, terminal failures shouldn't move the headline label off prior human edits.

### Task 7 — Linear issue-payload builder (2026-05-21)

- **`buildIssuePayload` has one side effect**: `log.warn` on optimus-label cache miss. Otherwise pure. The "no I/O" framing in the file header is technically inaccurate (acknowledged in code review as a cosmetic wart).
- **dueDate validation is shape-only.** Regex `/^\d{4}-\d{2}-\d{2}$/` accepts `2026-13-45`. Acceptable for v0.2 since the only producer is the push LLM under prompt control. Tighten in a future pass if needed.
- **Title truncation counts UTF-16 code units, not graphemes.** A title that ends in a surrogate pair could split a character at the 79-char boundary. PRD doesn't require grapheme-safety. Acceptable.
- **Footer guard strips ALL prior `Pushed under guardrail v<N>` lines** (any revision number, anywhere in description) before appending the canonical footer. Prevents LLM-injected spoof footers from surviving.

### Task 6 — Linear team-cache (2026-05-21)

- **FR-25 rewritten to use `state.type` enum, not state names.** Original spec listed `In Review → review` but Linear normalises that to `started`. `review` is intentionally absent from defaults — operators who want a separate `review` mapping must add it via Settings.
- **Two nits flagged for cleanup pass** (non-blocking): (a) the read-back-after-UPSERT could be replaced by `RETURNING` (one round-trip); (b) `parseJsonb` silently catches malformed JSON and returns `[]` — should let it throw or at least log, since corruption shouldn't be papered over.
- **`startCacheRefresher` fires an immediate initial tick** (not waiting one `intervalMs` window). Cache populates eagerly on startup. Tests depend on this behaviour.
- **Cache refresher has overlap guard** (`if (inFlight) return`) — no test exercises this directly. If the guard is ever removed, no test will catch it. Worth a follow-up test in a calibration pass.

### Task 5 — Lifecycle verbs + PATCH /fields + inline-answer fix (2026-05-21)

- **Lifecycle transition table moved to tech spec.** The v0.1 PRD's §4 lifecycle table didn't survive the Linear-pivot rewrite of the v0.2 PRD. Tech spec now owns the canonical transition table (near FR-27) — it's the single source of truth referenced by `TRANSITIONS` const in `api-routes/human-tasks.js`.
- **Migration 120 amended: `feedback_history` NOT NULL dropped.** Pre-v0.2 rows may carry NULL; every read path (`parseHistory`, `getStickyFields`, the worker, etc.) already defends with `Array.isArray` or `COALESCE`. The NOT NULL was cargo-cult belt-and-suspenders. DEFAULT '[]'::jsonb retained — fresh inserts still get an empty array. Migration is still additive and idempotent.
- **`inlineAnswerHumanTask` refactored via `editedEntry()` helper.** All four inline fields (assignee, size, is_this_ours, when) now carry `verb: 'edited'`. This was the upstream gap from Task 2 — sticky-override works end-to-end now.
- **PATCH /fields does NOT validate project_id / engagement_id / assignee_contact_id existence** — only type-checks. Existence validation against active rows is enrichment-time only (FR-2). The PATCH endpoint is operator-trust: if the operator typed an id, we believe them. Documented in tests.
- **`actHumanTask` (the legacy four-button endpoint) still writes terminal verbs (`done|skip|later|not_for_me`) without `verb='edited'`.** That's correct per spec — those are terminal/snooze actions, not edits. Sticky logic only applies to `edited`. No change required there.

### Task 4 — Engagement allow-list (2026-05-21)

- **`engagements.engagements` uses `status = 'active'` filter, not `is_active = true`.** Spec text used the latter; actual schema (migration 115) has a `status` enum (`draft|active|archived`). `loadEngagements` query updated accordingly.
- **Pre-existing asymmetry**: `loadProjects` does NOT filter to active projects but `loadEngagements` does. FR-2 says "active only" for both — leaving the project-side gap for a future cleanup pass since it's pre-existing v0.1 behaviour.
- **`ALLOWED_PATCH_FIELDS` regression caught in code review.** First implementation pass omitted `engagement_id` based on a false claim that the column didn't exist. Migration 119 line 55 (`engagement_id UUID`) shows it does. Worker would have silently dropped every engagement_id from enrichment patches — FR-2 half-broken. Fixed pre-merge.
- **Engagement-list size is unbounded in the prompt**, same shape as contacts/projects. Acceptable for v0.2 (board has <50 active engagements). If/when this grows beyond ~100, prompt-size pressure will force a "top N relevant" filter (e.g. engagements whose name appears in the transcript, with the rest dropped).

### Task 3 — Enrichment worker (2026-05-21)

- **pg_notify channel uses underscores, not dots.** Spec text shows `human_task.enrichment_pending`; the actual implementation uses `human_task_enrichment_pending`. Postgres/PGlite `LISTEN` rejects unquoted identifiers with dots, and the project doesn't double-quote channel names anywhere. Same constraint applies to future channels (`human_task_completed`, `human_task_ready_for_optimus`, `human_task_divergence`).
- **Promoter now sets `enrichment_status='pending'` on INSERT.** Required for the NOTIFY payload to be actionable — a row pointed at by the notify must be picked up by the worker's `WHERE enrichment_status='pending'` dequeue. Index `human_tasks_pending_enrichment` (migration 120) supports this.
- **Orphan-cleanup freshness contract = 5 minutes.** Worker startup resets `enrichment_status='running'` rows where `enrichment_at IS NULL OR enrichment_at < now() - interval '5 minutes'`. Fresh in-flight rows owned by another worker instance are left alone.
- **LISTEN reconnect: exponential 1s→30s.** Mirrors `lib/runtime/event-bus.js#schedulePgListenReconnect`. Initial connect failure also schedules reconnect (was a documented gap; fixed during code refactor).
- **Two new timeouts**: `stopTimeoutMs` default 30s (bounds `stop()` against hung enrichTask); `enrichmentTimeoutMs` default 60s (matches NFR-1 P99). On enrichment timeout: row → `failed` with `feedback_history` entry `kind='enrichment_failure'`, `error_text='enrichment timeout'`. (NFR-1 added the P95/P99 budget; the timeout makes it enforceable.)
- **Failed rows do not auto-retry.** Worker SQL only picks `pending`. A persistent LLM blip parks a row in `failed` until operator action. Acceptable for v0.2; revisit if `failed` count grows. Operator-facing "Retry enrichment" button is implicit in Task 21 card-details panel.
- **`markFailed` includes `AND enrichment_status='running'`** to avoid clobbering a terminal state set by a concurrent worker.
- **Failure detail lives in `feedback_history`, not a column.** `human_tasks` has no `error_text` column; that's on `human_task_sync_log` (push/pull, not enrichment). Append-only feedback_history entry `{ verb: 'llm_decision', kind: 'enrichment_failure', error_text }` preserves P3 transparency.
- **Test helper bug-fix during Task 3.** The pre-existing `seedTask` helper in `enrichment-worker.test.js` declared `priority/size/project_id` parameters but never bound them in its INSERT. Fixed during implementation — confirmed legitimate (no test assertion now passes for the wrong reason; both affected tests assert worker behaviour on operator-set seed values that must actually persist).

### Task 2 — Sticky-override helper (2026-05-21)

- **Existing inline-answer endpoint does NOT write `verb: 'edited'` into `feedback_history`.** `autobot-inbox/src/api-routes/human-tasks.js` currently writes entries shaped `{ field, value, by, at }` — no `verb` key. This means `getStickyFields()` (FR-3, AD-5) will return an empty Set today and re-enrichment will silently overwrite operator edits. **Fix required**: the inline-answer and field-PATCH endpoints (Task 5, FR-18, FR-12) MUST write `verb: 'edited'` along with the field. The sticky helper is correct per spec; the upstream writers are the gap. Wire this fix during Task 5.
- **Helper location is `lib/runtime/` not `autobot-inbox/lib/`.** Org-level helper per the three-layer architecture in CLAUDE.md. Tests import from `../../lib/runtime/human-task-sticky.js`.

### Task 1 — Migration 120 (2026-05-21)

- **Named CHECK constraints over inline.** The spec's §3.1 step 2 showed inline `CHECK` on `ADD COLUMN`, which is not idempotent under re-run. Implementation uses explicit names (`human_tasks_push_status_check`, `human_tasks_enrichment_status_check`) with `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`, matching the existing `human_tasks_last_feedback_check` pattern. Promote this as the project convention.
- **Inline CHECK on three new-table columns.** `human_task_sync_log.direction`, `human_task_sync_log.outcome`, and `linear_backfill_batches.state` use inline unnamed CHECK clauses. Acceptable (matches 119's `human_tasks.status`, `priority`, `size` pattern) but future widening will need to look up the auto-generated constraint name. Worth a one-line comment if anyone touches them.
- **`human_task_sync_log.guardrail_id` intentionally NOT an FK.** Guardrails are append-only and we want the sync log to survive any guardrail row deletion or schema change. It's a denormalised pointer, not a relational reference. Same treatment as `created_by`.
- **`linear_backfill_batches` has no secondary index.** Operator-initiated batches are expected at < 100/month. Seq scan over filter / sort is acceptable. Resist cargo-cult indexing.
- **§3.2 backfill is gated on `enrichment_status IS NULL AND deleted_at IS NULL`.** This makes the migration's data step idempotent — re-running 120 won't reset rows already moved to `running`/`completed`/`failed` by the enrichment worker.

## 9. Out of Scope (engineering)

- Drag-and-drop on `/board` (v0.3).
- Real-time SSE/websocket updates on `/board` (v0.3).
- Bulk operations (v0.3).
- Multi-team Linear support (v0.3).
- Cycle / milestone assignment (v0.3).
- Re-push of title/description changes from new signals into existing Linear issues (intentional — human owns the issue after creation).
- Optimus posting non-`@optimus`-prompted comments (intentional — only context comments at creation + "couldn't follow guardrail rule X" notes).
