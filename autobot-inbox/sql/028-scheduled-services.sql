-- Migration 028: Scheduled Services visibility
-- Tracks all periodic services (cron jobs) with runtime status.
-- Board operators can view status, pause non-critical services, and trigger runs.

CREATE TABLE IF NOT EXISTS agent_graph.scheduled_services (
  name            TEXT PRIMARY KEY,
  interval_ms     INTEGER NOT NULL,
  delay_ms        INTEGER NOT NULL DEFAULT 0,
  is_critical     BOOLEAN NOT NULL DEFAULT false,
  is_paused       BOOLEAN NOT NULL DEFAULT false,
  last_run_at     TIMESTAMPTZ,
  last_status     TEXT CHECK (last_status IN ('ok', 'failed', 'running', 'skipped')),
  last_error      TEXT,
  last_duration_ms INTEGER,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  total_runs      INTEGER NOT NULL DEFAULT 0,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_by       TEXT,
  paused_at       TIMESTAMPTZ
);
