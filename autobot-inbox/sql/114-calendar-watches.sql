-- STAQPRO-327 follow-up — multi-account calendar watches.
--
-- The Phase 3 first cut keyed off CALENDAR_ACCOUNT_EMAIL env var, hard-
-- coding a single calendar. Eric flagged needing more than one calendar
-- managed from the UI, so the source of truth moves to a DB-backed
-- configuration mirroring inbox.drive_watches (sql/001-baseline).
--
-- One row per (account_email, calendar_id). 'primary' is the default
-- calendar for an account; a workspace user can also subscribe to
-- secondary calendars (e.g., team calendars) which would be additional
-- rows under the same account_email with non-'primary' calendar_id.
-- The poller iterates active watches each tick.

CREATE TABLE IF NOT EXISTS inbox.calendar_watches (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Workspace email whose calendar to read. Not FK'd because inbox.accounts
  -- is currently Gmail-oriented (channel='email' provider='gmail') and
  -- coupling Calendar to that table adds unnecessary cascade complexity.
  account_email   TEXT NOT NULL,

  -- Google calendar id. 'primary' = the account's default; secondary
  -- calendars use the email-ish id Google assigns.
  calendar_id     TEXT NOT NULL DEFAULT 'primary',

  label           TEXT NOT NULL DEFAULT 'Calendar',

  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_poll_at    TIMESTAMPTZ,
  last_error      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_email, calendar_id)
);

COMMENT ON TABLE inbox.calendar_watches IS
  'Google Calendar watch configs. One row per (account_email, calendar_id). Replaces CALENDAR_ACCOUNT_EMAIL env var with DB-backed multi-account config.';

CREATE INDEX IF NOT EXISTS idx_calendar_watches_active
  ON inbox.calendar_watches (account_email)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION inbox.touch_calendar_watches_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_watches_touch_updated_at ON inbox.calendar_watches;
CREATE TRIGGER calendar_watches_touch_updated_at
  BEFORE UPDATE ON inbox.calendar_watches
  FOR EACH ROW EXECUTE FUNCTION inbox.touch_calendar_watches_updated_at();
