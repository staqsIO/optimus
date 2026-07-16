-- Migration 139: backfill true orphaned (non-signal-only) unlinked messages (STAQPRO-548)
--
-- Symptom (production logs, 2026-05-30):
--   [runtime/infrastructure] Found 61 issue(s):
--     [unlinked_message] inbox.messages <id>: no work_item_id   (x 61)
--
-- Root cause: the unlinked_message detector in 001-baseline.sql
-- (check_referential_integrity / detect_infrastructure_issues) flagged EVERY
-- inbox.message with work_item_id IS NULL in the last 24h. Most of those are
-- by-design Tier-3 'signal-only' rows (webhook:linear / webhook:github /
-- webhook:tldv awareness path) that intentionally never get a work_item and
-- cost zero LLM. They were polluting the alert.
--
-- The going-forward fix (this PR) adds `AND NOT ('signal-only' = ANY(m.labels))`
-- to BOTH unlinked_message detection queries so signal-only rows stop firing.
--
-- This migration backfills the ~56 *true* orphans (work_item_id IS NULL AND
-- NOT signal-only) by stamping triage_category='orphaned', mirroring the
-- sentinel used in migration 099 for orchestrator-skipped messages. This makes
-- them explicitly classified rather than silently unlinked.
--
-- Idempotent:
--   * The CHECK-constraint widening uses IF the value is absent, then swaps the
--     constraint in a single DO block guarded by pg_constraint lookup.
--   * The UPDATE is guarded by `WHERE triage_category IS DISTINCT FROM 'orphaned'`
--     (pattern from migration 099) so re-running touches zero rows.
-- Safe to run twice.

-- ------------------------------------------------------------------
-- 1. Permit 'orphaned' in the triage_category CHECK constraint.
--
-- The baseline constraint (messages_triage_category_check) enumerates
-- ('action_required','needs_response','fyi','noise','pending') and does NOT
-- include 'orphaned'. Migration 099's COALESCE(..., 'orphaned') was effectively
-- dead because triage_category DEFAULTs to 'pending' (never NULL), so the
-- 'orphaned' branch never fired and the constraint was never exercised. This
-- migration writes 'orphaned' directly, so the constraint must allow it first.
-- ------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_triage_category_check'
      AND conrelid = 'inbox.messages'::regclass
  ) THEN
    ALTER TABLE inbox.messages DROP CONSTRAINT messages_triage_category_check;
  END IF;

  ALTER TABLE inbox.messages
    ADD CONSTRAINT messages_triage_category_check
    CHECK (triage_category IN (
      'action_required', 'needs_response', 'fyi', 'noise', 'pending', 'orphaned'
    ));
END $$;

-- ------------------------------------------------------------------
-- 2. Backfill the true orphans.
--
-- A "true orphan" is a message with no work_item that is NOT a by-design
-- signal-only awareness row. We mark it 'orphaned' so it is explicitly
-- classified. Guarded so re-runs are no-ops.
-- ------------------------------------------------------------------
UPDATE inbox.messages m
SET triage_category = 'orphaned'
WHERE m.work_item_id IS NULL
  AND NOT ('signal-only'::TEXT = ANY(m.labels))
  AND m.triage_category IS DISTINCT FROM 'orphaned';

DO $$
DECLARE
  v_orphaned   BIGINT;
  v_signalonly BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_orphaned
  FROM inbox.messages
  WHERE work_item_id IS NULL
    AND triage_category = 'orphaned';

  SELECT COUNT(*) INTO v_signalonly
  FROM inbox.messages
  WHERE work_item_id IS NULL
    AND 'signal-only'::TEXT = ANY(labels);

  RAISE NOTICE '[139] true orphans marked orphaned (expected ~56): %', v_orphaned;
  RAISE NOTICE '[139] signal-only unlinked rows (excluded from alert, untouched): %', v_signalonly;
END $$;
