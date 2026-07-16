-- STAQPRO-327 — Google Calendar events ingestion (read-only, Phase 3).
--
-- One row per Google Calendar event. Populated by:
--   - src/calendar/poller.js (every 5 min, incremental via syncToken)
--   - scripts/backfill-calendar.js (one-shot historic pass)
--
-- Dedup is keyed on (account_email, gcal_event_id). Per-event attendee
-- resolution into signal.contacts happens in the poller, not here.
--
-- The downstream UNIONs in src/api-routes/calendar.js consume this table
-- to emit a `gcal_event` kind on the day-grid view.

CREATE TABLE IF NOT EXISTS inbox.calendar_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Google Workspace user whose calendar this event was fetched from.
  -- Not FK'd to inbox.accounts (whose IDs are TEXT and oriented around
  -- channel='email' provider='gmail'); the email is enough to scope.
  account_email     TEXT NOT NULL,

  -- Google's per-event id (immutable for a given event on a given
  -- calendar). The dedup key paired with account_email.
  gcal_event_id     TEXT NOT NULL,

  -- Cross-calendar event id (RFC 5545). Same physical meeting can have
  -- different gcal_event_id values when invited to multiple calendars,
  -- but ical_uid is shared. Useful for Phase 4 :Meeting node merging
  -- (where a TLDv transcript + a calendar invite for the same meeting
  -- should converge on one :Meeting node).
  ical_uid          TEXT,

  title             TEXT,
  description       TEXT,
  location          TEXT,
  hangout_link      TEXT,

  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ,
  all_day           BOOLEAN NOT NULL DEFAULT false,

  organizer_email   TEXT,

  -- Array of { email, displayName, responseStatus, optional, organizer,
  -- self, resource, contact_id? }. contact_id is filled by the
  -- participants resolver at ingest time when a match exists.
  attendees         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Lifecycle. 'confirmed' is the normal case; 'cancelled' / 'tentative'
  -- come from the Google status field. We keep cancelled rows so we can
  -- see "this meeting was on the calendar then dropped" for context.
  status            TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'tentative', 'cancelled')),

  -- Provenance for the Phase 4 :Meeting node merge step:
  --   'gcal'    : sourced directly from Google Calendar (this table).
  source            TEXT NOT NULL DEFAULT 'gcal'
    CHECK (source = 'gcal'),

  -- Full event payload as Google returned it, for fields we don't have
  -- a dedicated column for and for future-proofing.
  raw_event         JSONB,

  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_email, gcal_event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at
  ON inbox.calendar_events (start_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_account_start
  ON inbox.calendar_events (account_email, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_ical_uid
  ON inbox.calendar_events (ical_uid) WHERE ical_uid IS NOT NULL;

-- Touch updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION inbox.touch_calendar_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_events_touch_updated_at ON inbox.calendar_events;
CREATE TRIGGER calendar_events_touch_updated_at
  BEFORE UPDATE ON inbox.calendar_events
  FOR EACH ROW EXECUTE FUNCTION inbox.touch_calendar_events_updated_at();

COMMENT ON TABLE inbox.calendar_events IS
  'Google Calendar events ingested via src/calendar/poller.js + backfill-calendar.js. Read-only; agents propose events via different release-tier paths (out of scope for STAQPRO-327).';
