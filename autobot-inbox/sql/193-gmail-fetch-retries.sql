-- 193 — inbox.gmail_fetch_retries: loss-free retry set for the Gmail poller.
--
-- The incremental sync loop advances the stored history_id unconditionally after
-- fetching each new message's metadata. A transient fetch error (5xx / 429 /
-- timeout) on a single message therefore dropped that message *permanently* —
-- the next poll started past it and never revisited it, so the email never
-- entered the inbox pipeline (no triage, no signals, no reply). Silent data loss
-- on the core ingestion path.
--
-- Fix (Plan 017, strategy B — persistent retry set): a per-message failure is
-- recorded here instead of being swallowed. The cursor advances as before (Gmail
-- history IDs are opaque, so we cannot advance to "just before" a failed message
-- — strategy A would have to stall the cursor, the one MED risk we must avoid).
-- Each poll drains this table with bounded attempts; on success the message is
-- re-fetched into the pipeline and the row cleared, on attempt-cap exhaustion the
-- drop is logged (account_id + provider_msg_id) — turning silent loss into an
-- observable, bounded drop that can never stall ingestion.
--
-- Composite PK (account_id, provider_msg_id) is the natural dedup key; no FK
-- (account_id carries the poller's syncKey, which may be the 'default' sentinel).

CREATE TABLE IF NOT EXISTS inbox.gmail_fetch_retries (
  account_id      TEXT NOT NULL,
  provider_msg_id TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider_msg_id)
);

COMMENT ON TABLE inbox.gmail_fetch_retries IS
  'Bounded retry set for Gmail messages whose metadata fetch failed transiently '
  'during incremental sync; drained each poll so a transient error never causes '
  'permanent, silent inbound loss (Plan 017).';
