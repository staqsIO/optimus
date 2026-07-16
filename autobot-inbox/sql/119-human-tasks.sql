-- 119: inbox.human_tasks — human-owned task cards from meeting signals.
--
-- PRD: docs/internal/prds/meeting-actions-to-kanban.md §5
-- Why a new table (not agent_graph.work_items):
--   - work_items.assigned_to FK's agent_configs(id); cannot hold a contact.
--   - work_items status set encodes agent-runtime concepts (timed_out,
--     output_quarantined, retry_count). Human kanban states are different.
--   - Per SPEC §12 schemas are isolated; cross-schema joins happen at the
--     API layer.

CREATE TABLE IF NOT EXISTS inbox.human_tasks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Provenance: audit trail back to the meeting signal it came from.
  signal_id       TEXT REFERENCES inbox.signals(id) ON DELETE SET NULL,
  message_id      TEXT,
  source_quote    TEXT,
  source_ts       TEXT,

  -- Content
  title           TEXT NOT NULL,
  description     TEXT,
  due_date        DATE,
  priority        TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  size            TEXT
    CHECK (size IS NULL OR size IN ('quick', 'small', 'medium', 'large')),

  -- Human assignment (not agent assignment).
  assignee_contact_id  TEXT,
  assignee_label       TEXT,
  assignee_confidence  NUMERIC(3,2)
    CHECK (assignee_confidence IS NULL OR (assignee_confidence >= 0 AND assignee_confidence <= 1)),

  -- Kanban lifecycle. See PRD §5 for the state machine.
  status          TEXT NOT NULL DEFAULT 'inbox'
    CHECK (status IN (
      'inbox',
      'proposed',
      'todo',
      'in_progress',
      'blocked',
      'later',
      'review',
      'done',
      'skipped',
      'not_for_us'
    )),
  snoozed_until   TIMESTAMPTZ,

  -- AI-autofilled enrichment.
  task_type       TEXT
    CHECK (task_type IS NULL OR task_type IN ('action', 'decision_followup', 'request', 'blocker')),
  project_id      TEXT,
  engagement_id   UUID,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  next_action_hint TEXT,
  related_contact_ids TEXT[] NOT NULL DEFAULT '{}',

  -- Confidence + relevance audit trail.
  relevance_score       NUMERIC(3,2)
    CHECK (relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1)),
  extraction_confidence NUMERIC(3,2)
    CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),

  -- Feedback log; powers the four-button UX and future retraining.
  last_feedback      TEXT
    CHECK (last_feedback IS NULL OR last_feedback IN ('done', 'skip', 'later', 'not_for_me', 'edited')),
  last_feedback_at   TIMESTAMPTZ,
  feedback_history   JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Linear two-way sync — designed now, unused in v0.1.
  linear_issue_id    TEXT,
  linear_issue_url   TEXT,
  linear_synced_at   TIMESTAMPTZ,

  created_by      TEXT NOT NULL DEFAULT 'meeting_pipeline',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE inbox.human_tasks IS
  'Human-owned task cards promoted from meeting signals. Distinct from agent_graph.work_items (PRD meeting-actions-to-kanban §5).';

COMMENT ON COLUMN inbox.human_tasks.signal_id IS
  'Source signal (inbox.signals). ON DELETE SET NULL — signals can be re-extracted; tasks survive.';

COMMENT ON COLUMN inbox.human_tasks.status IS
  'Kanban lifecycle. inbox/proposed are pre-confirmation; todo/in_progress/blocked/review are active; later is snoozed; done/skipped/not_for_us are terminal.';

CREATE INDEX IF NOT EXISTS human_tasks_by_status_priority
  ON inbox.human_tasks (status, priority, due_date NULLS LAST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS human_tasks_by_assignee
  ON inbox.human_tasks (assignee_contact_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS human_tasks_by_signal
  ON inbox.human_tasks (signal_id);

-- Touch updated_at on every UPDATE — matches the pattern used by
-- inbox.calendar_events / signal.contacts.
CREATE OR REPLACE FUNCTION inbox.touch_human_tasks_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS human_tasks_touch_updated_at ON inbox.human_tasks;
CREATE TRIGGER human_tasks_touch_updated_at
  BEFORE UPDATE ON inbox.human_tasks
  FOR EACH ROW EXECUTE FUNCTION inbox.touch_human_tasks_updated_at();
