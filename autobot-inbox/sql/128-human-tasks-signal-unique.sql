-- Migration 128 — at-most-one live human_task per signal (ADR-008 Phase 1, Linus item #3)
--
-- Why: the signal→action bridge defers to the live promoter via an APP-LEVEL
-- SELECT (signal-action-bridge.js (a.5)). That guard has a race window: the
-- promoter can insert a card between the bridge's deferral SELECT and its claim,
-- producing TWO human_tasks for one signal (double-carding) — `inbox.signals.signal_id`
-- on human_tasks is only a NON-unique index today (119-human-tasks.sql). This
-- migration closes the race at the infrastructure layer (P2 — infrastructure
-- enforces, not prompts/app code), which is the ADR-008 end-state invariant.
-- Must be applied BEFORE flipping `staleCleanupOnly=false` (the second live flip).
--
-- Reversible: drop the index. The dedupe step is a one-time soft-delete of older
-- duplicate cards and is not auto-undone, but it is conservative (keeps the most
-- recent card per signal) and idempotent (re-running is a no-op once unique).

-- 1. Dedupe existing duplicates so the unique index can be created. Soft-delete
--    (deleted_at) the OLDER cards per signal_id, keeping the most recent. At the
--    time of writing prod has ~20 human_tasks and the bridge has never run, so
--    this is expected to affect zero rows — but it makes the migration safe to
--    apply regardless of state.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY signal_id ORDER BY created_at DESC, id DESC) AS rn
    FROM inbox.human_tasks
   WHERE signal_id IS NOT NULL
     AND deleted_at IS NULL
)
UPDATE inbox.human_tasks ht
   SET deleted_at = now()
  FROM ranked r
 WHERE ht.id = r.id
   AND r.rn > 1;

-- 2. The invariant: at most one LIVE (non-deleted) card per signal. Partial so
--    soft-deleted history and NULL-signal_id ad-hoc tasks are unconstrained.
--    Built inline (not CONCURRENTLY) — works on PGlite and is sub-second on the
--    small human_tasks table; for a large prod table build CONCURRENTLY out of band.
CREATE UNIQUE INDEX IF NOT EXISTS human_tasks_signal_unique_live
  ON inbox.human_tasks (signal_id)
  WHERE signal_id IS NOT NULL AND deleted_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE '[128] inbox.human_tasks: deduped to one live card per signal + partial unique index created';
END $$;
