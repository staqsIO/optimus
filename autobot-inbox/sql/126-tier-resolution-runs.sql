-- STAQPRO-522 — audit table for the nightly tier-resolution job.
--
-- One row per execution of lib/runtime/tier-resolution.js. The job runs
-- every 24h (scheduler.register('tier-resolution', ...) in
-- autobot-inbox/src/index.js) plus once on boot after a 60s warmup.
--
-- We capture per-rule row counts so the operator can spot:
--   - A query regression (any count suddenly jumps to triple digits)
--   - The decay rule firing more than the promotion rules (steady-state
--     attrition signal — time to revisit cohort assumptions)
--   - A boot-time backlog being cleared in one big run after the job is
--     first deployed.
--
-- Append-only; no PII; no foreign keys (this is operational telemetry).

CREATE TABLE IF NOT EXISTS signal.tier_resolution_runs (
  id                          BIGSERIAL PRIMARY KEY,
  ran_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_inner_circle       INTEGER NOT NULL DEFAULT 0,
  promoted_active_calendar    INTEGER NOT NULL DEFAULT 0,
  promoted_active_email       INTEGER NOT NULL DEFAULT 0,
  demoted_active_unknown      INTEGER NOT NULL DEFAULT 0,
  duration_ms                 INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tier_resolution_runs_ran_at
  ON signal.tier_resolution_runs (ran_at DESC);
