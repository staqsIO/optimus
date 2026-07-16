-- 158-capture-sources-access-resolved.sql
-- OPT-103 / ADR-016 (D1 — Drive ingestion convergence): add
-- content.capture_sources.access_resolved.
--
-- The access path the watcher ACTUALLY USED on its last successful poll —
-- distinct from the create-time `access` INTENT and from `owner_email` (the DWD
-- impersonation target). pollCaptureSource (ADR-016 D1) prefers SA-direct
-- membership over domain-wide-delegation impersonation: for an 'impersonated'
-- source it probes whether the service account can itself see the watched folder
-- and, if so, reads as the SA (no impersonation). This column records which path
-- won.
--
--   'sa_direct'     = read as the service account (no impersonation exercised).
--   'impersonated'  = SA could NOT see the folder; read via DWD impersonation.
--   NULL            = never polled yet (unprobed).
--
-- This is the P5 "measure before you trust" instrument for the eventual DWD
-- demotion (ADR-016 open question #1). The removal gate is a one-line query:
--   SELECT count(*) FROM content.capture_sources
--   WHERE enabled AND access_resolved = 'impersonated';   -- must be 0
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no DEFAULT. Raw parameterized
-- DDL, no ORM. Runs best-effort at startup and against PGlite.

ALTER TABLE content.capture_sources
  ADD COLUMN IF NOT EXISTS access_resolved TEXT;

COMMENT ON COLUMN content.capture_sources.access_resolved IS
  'ADR-016 (OPT-103 D1): access path used on the last successful poll — '
  'sa_direct | impersonated | NULL (unprobed). Set by pollCaptureSource, distinct '
  'from create-time access INTENT and from owner_email (DWD target). DWD-demotion '
  'gate: count(enabled AND access_resolved=impersonated) must be 0.';
