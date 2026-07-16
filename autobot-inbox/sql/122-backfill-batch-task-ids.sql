-- 122: inbox.linear_backfill_batches.task_ids — record batch membership.
--
-- PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
--   FR-B5, FR-B6, FR-B7. The cancel + GET endpoints need to know which
--   human_tasks rows belong to each backfill batch. Storing the snapshot
--   of ids as JSONB on the batch row keeps the join cheap and avoids a
--   second relational table for what is operationally a small set
--   (<100 batches/month per the §1 notes).
--
-- Idempotent. Pre-existing batch rows backfill to '[]'::jsonb.

ALTER TABLE inbox.linear_backfill_batches
  ADD COLUMN IF NOT EXISTS task_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN inbox.linear_backfill_batches.task_ids IS
  'Snapshot of human_tasks.id values selected at batch creation. Used by cancel + GET /:id/progress queries (FR-B6, FR-B7).';
