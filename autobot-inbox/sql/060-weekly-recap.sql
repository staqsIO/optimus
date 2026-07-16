-- 060: Weekly action-item recap emails.
--
-- Each Monday, per-board-member recap is sent listing action items from every
-- tl;dv meeting the member attended in the prior 7 days. Extraction is an LLM
-- pass over content.documents.raw_text, cached in meeting_action_items so the
-- same meeting isn't re-processed when multiple attendees trigger extraction.
-- weekly_recaps_sent guarantees idempotency inside the scheduler's hourly tick.

CREATE TABLE IF NOT EXISTS inbox.meeting_action_items (
  document_id   UUID PRIMARY KEY REFERENCES content.documents(id) ON DELETE CASCADE,
  items         JSONB NOT NULL,                  -- [{person, action, timestamp}]
  item_count    INT GENERATED ALWAYS AS (jsonb_array_length(items)) STORED,
  model         TEXT NOT NULL,
  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_action_items_extracted
  ON inbox.meeting_action_items(extracted_at DESC);

CREATE TABLE IF NOT EXISTS inbox.weekly_recaps_sent (
  id                SERIAL PRIMARY KEY,
  week_start        DATE NOT NULL,
  recipient_email   TEXT NOT NULL,
  recipient_member  UUID REFERENCES agent_graph.board_members(id),
  sender_account_id TEXT REFERENCES inbox.accounts(id),
  provider_sent_id  TEXT NOT NULL,
  meetings_count    INT NOT NULL DEFAULT 0,
  items_count       INT NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, recipient_email)
);

CREATE INDEX IF NOT EXISTS idx_weekly_recaps_week ON inbox.weekly_recaps_sent(week_start DESC);
