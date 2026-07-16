-- Migration 120 — async job status fields on engagements
--
-- auto-build and synth both run fire-and-forget on the server because
-- they routinely exceed Cloudflare's 100s request ceiling. To give the
-- UI something to show while the background work is running, we stamp
-- the engagement row with the current job state:
--
--   async_status      — null when idle; one of 'ingesting','synthesizing','generating'
--   async_started_at  — when the current async job started
--   async_progress    — {stage, current, total, label} — fine-grained progress
--                       for the UI to render a meaningful banner / bar
--
-- All three are nullable. Cleared when the background job completes or
-- errors out.

ALTER TABLE engagements.engagements
  ADD COLUMN IF NOT EXISTS async_status     TEXT,
  ADD COLUMN IF NOT EXISTS async_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS async_progress   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Partial index for "engagements currently working" — used by the
-- engagement list to surface a "running" badge cheaply.
CREATE INDEX IF NOT EXISTS idx_engagements_async_active
  ON engagements.engagements (async_started_at DESC)
  WHERE async_status IS NOT NULL;

DO $$ BEGIN
  RAISE NOTICE '[120] engagement async status columns added';
END $$;
