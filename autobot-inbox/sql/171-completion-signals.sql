-- Migration 171: completion_signals table (OPT-44)
--
-- Stores inbound completion events that the completion-detector uses to
-- auto-advance work_item status through the state machine. Rows are
-- append-only (write-once on ingest, stamped on processing).
--
-- Signal types:
--   pr_merged        — a GitHub PR linked to this work_item was merged
--   slack_approval   — a Slack message contains approval language
--   slack_done       — a Slack message contains done/completed language
--   email_closed     — an email reply contains closing language
--   manual_override  — board-set explicit next_status (must be legal next hop)
--
-- COMPLETION_DETECTION_ENABLED=true env gate controls whether the detector
-- actually advances state; this table is populated regardless so signals are
-- captured even when the gate is off.

CREATE TABLE IF NOT EXISTS agent_graph.completion_signals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id    TEXT NOT NULL REFERENCES agent_graph.work_items(id) ON DELETE CASCADE,
  signal_type     TEXT NOT NULL CHECK (signal_type IN (
                    'pr_merged', 'slack_approval', 'slack_done', 'email_closed', 'manual_override'
                  )),
  channel         TEXT CHECK (channel IN ('slack', 'email', 'github', NULL)),
  content         TEXT,
  pr_merged       BOOLEAN,
  next_status     TEXT,
  -- Processing audit
  outcome         TEXT CHECK (outcome IN ('advanced', 'noop', 'illegal', 'dry_run', NULL)),
  outcome_reason  TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_completion_signals_work_item
  ON agent_graph.completion_signals(work_item_id);

CREATE INDEX IF NOT EXISTS idx_completion_signals_unprocessed
  ON agent_graph.completion_signals(created_at)
  WHERE processed_at IS NULL;

COMMENT ON TABLE agent_graph.completion_signals IS
  'OPT-44: completion events that drive work_item auto-advancement via completion-detector.js. '
  'Gated by COMPLETION_DETECTION_ENABLED=true env flag.';
