-- 120: inbox.human_tasks Linear two-way sync + LLM guardrails substrate.
--
-- PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md §3.1, §3.2
-- Extends migration 119 (human_tasks) with:
--   1. Eleven new columns on inbox.human_tasks for Linear sync state +
--      enrichment/push worker bookkeeping.
--   2. Widened last_feedback CHECK to cover v0.2 system-emitted verbs
--      (transition, linear_pull, linear_push, llm_decision).
--   3. Six new partial indexes for the worker hot paths (pending push,
--      pending enrichment, by-linear-issue lookup, assignee kanban view,
--      quick-wins board, project view).
--   4. inbox.llm_guardrails — versioned prompt/mapping store for the
--      push and pull LLM passes. Partial unique index enforces "at most
--      one current row per kind" (P1 / P2 — invariant in the schema,
--      not in app code).
--   5. inbox.linear_team_cache — single-row-per-team cache of Linear
--      workflow_states/projects/members/labels (refreshed by the
--      enrichment worker; avoids per-task Linear API hits).
--   6. inbox.human_task_sync_log — append-only audit trail of every
--      push/pull/reconcile attempt. ON DELETE CASCADE from human_tasks
--      so deleting a task takes its sync history with it (P3).
--   7. inbox.linear_backfill_batches — operator-initiated bulk push
--      batches for §3.2 backfill UX.
--
-- §3.2 data move: set enrichment_status='pending' on existing rows so the
-- enrichment worker picks them up. push_status stays NULL — backfill is
-- operator-driven, not auto-push.

-- -----------------------------------------------------------------------
-- 1. inbox.human_tasks — new columns
-- -----------------------------------------------------------------------

ALTER TABLE inbox.human_tasks
  ADD COLUMN IF NOT EXISTS linear_state_id       TEXT,
  ADD COLUMN IF NOT EXISTS linear_state_name     TEXT,
  ADD COLUMN IF NOT EXISTS linear_assignee_id    TEXT,
  ADD COLUMN IF NOT EXISTS linear_project_id     TEXT,
  ADD COLUMN IF NOT EXISTS linear_last_event_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS push_status           TEXT,
  ADD COLUMN IF NOT EXISTS push_skip_reason      TEXT,
  ADD COLUMN IF NOT EXISTS push_last_error       TEXT,
  ADD COLUMN IF NOT EXISTS push_attempts         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_status     TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_at         TIMESTAMPTZ,
  -- pushed_at: when the push worker last stamped the row (claim or terminal
  -- transition). Symmetric with enrichment_at. Dedicated column — NOT
  -- updated_at — because the BEFORE UPDATE trigger from migration 119
  -- (inbox.touch_human_tasks_updated_at) unconditionally rewrites
  -- updated_at to now(), making it impossible for the worker to backdate
  -- or for stale-claim detection to rely on it. The trigger does NOT
  -- touch pushed_at, so the worker controls the value precisely.
  ADD COLUMN IF NOT EXISTS pushed_at             TIMESTAMPTZ;

-- push_status / enrichment_status CHECKs (allow NULL for pre-existing
-- rows and for the worker's "not yet enqueued" state).
ALTER TABLE inbox.human_tasks
  DROP CONSTRAINT IF EXISTS human_tasks_push_status_check;
ALTER TABLE inbox.human_tasks
  ADD CONSTRAINT human_tasks_push_status_check
  CHECK (push_status IS NULL OR push_status IN
    ('pending', 'running', 'succeeded', 'skipped', 'failed'));

ALTER TABLE inbox.human_tasks
  DROP CONSTRAINT IF EXISTS human_tasks_enrichment_status_check;
ALTER TABLE inbox.human_tasks
  ADD CONSTRAINT human_tasks_enrichment_status_check
  CHECK (enrichment_status IS NULL OR enrichment_status IN
    ('pending', 'running', 'completed', 'failed', 'skipped'));

-- -----------------------------------------------------------------------
-- 2. Widen last_feedback CHECK with the v0.2 system-emitted verbs
-- -----------------------------------------------------------------------

ALTER TABLE inbox.human_tasks
  DROP CONSTRAINT IF EXISTS human_tasks_last_feedback_check;
ALTER TABLE inbox.human_tasks
  ADD CONSTRAINT human_tasks_last_feedback_check
  CHECK (last_feedback IS NULL OR last_feedback IN
    ('done', 'skip', 'later', 'not_for_me', 'edited',
     'transition', 'linear_pull', 'linear_push', 'llm_decision'));

-- Drop NOT NULL on feedback_history. Pre-v0.2 rows and external pipelines
-- may leave it NULL; every write path defensively uses
-- COALESCE(feedback_history, '[]'::jsonb) || jsonb_build_array(...). The
-- DEFAULT '[]'::jsonb on inserts is unchanged. NULL is a legitimate
-- "no audit trail yet" sentinel that lifecycle/PATCH/action handlers
-- recover from.
ALTER TABLE inbox.human_tasks
  ALTER COLUMN feedback_history DROP NOT NULL;

-- -----------------------------------------------------------------------
-- 3. Six new partial indexes on inbox.human_tasks
-- -----------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS human_tasks_pending_enrichment
  ON inbox.human_tasks (created_at)
  WHERE deleted_at IS NULL AND enrichment_status = 'pending';

CREATE INDEX IF NOT EXISTS human_tasks_pending_push
  ON inbox.human_tasks (created_at)
  WHERE deleted_at IS NULL AND push_status = 'pending';

CREATE INDEX IF NOT EXISTS human_tasks_by_linear_issue
  ON inbox.human_tasks (linear_issue_id)
  WHERE deleted_at IS NULL AND linear_issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS human_tasks_by_assignee_status_due
  ON inbox.human_tasks (assignee_contact_id, status, due_date NULLS LAST)
  WHERE deleted_at IS NULL AND status NOT IN ('done', 'skipped', 'not_for_us');

CREATE INDEX IF NOT EXISTS human_tasks_quickwins
  ON inbox.human_tasks (size, relevance_score, created_at)
  WHERE deleted_at IS NULL
    AND size IN ('quick', 'small')
    AND status NOT IN ('done', 'skipped', 'not_for_us');

CREATE INDEX IF NOT EXISTS human_tasks_by_project_status
  ON inbox.human_tasks (project_id, status)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;

-- -----------------------------------------------------------------------
-- 4. inbox.llm_guardrails — versioned prompt + mapping store
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbox.llm_guardrails (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind         TEXT NOT NULL CHECK (kind IN ('push', 'pull')),
  prompt_text  TEXT NOT NULL,
  mapping      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current   BOOLEAN NOT NULL DEFAULT false,
  revision     INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT
);

COMMENT ON TABLE inbox.llm_guardrails IS
  'Versioned LLM prompt + mapping store for the push/pull sync passes. At most one current row per kind, enforced by partial unique index.';

CREATE UNIQUE INDEX IF NOT EXISTS llm_guardrails_current_per_kind
  ON inbox.llm_guardrails (kind)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS llm_guardrails_by_kind_revision
  ON inbox.llm_guardrails (kind, revision DESC);

-- -----------------------------------------------------------------------
-- 5. inbox.linear_team_cache — workflow/projects/members/labels cache
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbox.linear_team_cache (
  team_id          TEXT PRIMARY KEY,
  workflow_states  JSONB NOT NULL DEFAULT '[]'::jsonb,
  projects         JSONB NOT NULL DEFAULT '[]'::jsonb,
  members          JSONB NOT NULL DEFAULT '[]'::jsonb,
  labels           JSONB NOT NULL DEFAULT '[]'::jsonb,
  refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inbox.linear_team_cache IS
  'Per-team cache of Linear workflow_states/projects/members/labels. Refreshed by the enrichment worker; lets per-task syncs avoid Linear API hits.';

-- -----------------------------------------------------------------------
-- 6. inbox.human_task_sync_log — append-only sync audit trail
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbox.human_task_sync_log (
  id                BIGSERIAL PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES inbox.human_tasks(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('push', 'pull', 'reconcile')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('success', 'skipped', 'failed', 'no_change', 'conflict_resolved')),
  before_snapshot   JSONB,
  after_snapshot    JSONB,
  guardrail_id      TEXT,
  backfill_batch_id TEXT,
  error_text        TEXT,
  duration_ms       INTEGER,
  at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inbox.human_task_sync_log IS
  'Append-only audit trail of every push/pull/reconcile attempt against Linear. Cascade-deletes with parent human_tasks row (P3 transparency).';

CREATE INDEX IF NOT EXISTS human_task_sync_log_by_task
  ON inbox.human_task_sync_log (task_id, at DESC);

CREATE INDEX IF NOT EXISTS human_task_sync_log_by_batch
  ON inbox.human_task_sync_log (backfill_batch_id, at DESC)
  WHERE backfill_batch_id IS NOT NULL;

-- -----------------------------------------------------------------------
-- 7. inbox.linear_backfill_batches — operator-initiated bulk push batches
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbox.linear_backfill_batches (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  filter_json   JSONB NOT NULL,
  task_count    INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_progress', 'completed', 'cancelled')),
  completed_at  TIMESTAMPTZ
);

COMMENT ON TABLE inbox.linear_backfill_batches IS
  'Operator-initiated bulk-push batches (§3.2). filter_json captures the selection criteria; task_count is the snapshot at creation time.';

-- -----------------------------------------------------------------------
-- 8. §3.2 data backfill — flip pre-existing rows to enrichment pending.
-- push_status stays NULL: backfill is operator-driven, not auto-push.
-- -----------------------------------------------------------------------

UPDATE inbox.human_tasks
   SET enrichment_status = 'pending'
 WHERE enrichment_status IS NULL
   AND deleted_at IS NULL;
