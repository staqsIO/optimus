-- Migration 131 — add `headers jsonb` to inbox.messages (STAQPRO-562)
--
-- Why: the deterministic header-sniff rules in
-- lib/runtime/signals/triage-header-sniff.js (List-Unsubscribe / List-ID /
-- Precedence / Auto-Submitted) were coded forward-compatibly but no-op'd on
-- live rows because the Gmail poller never captured those headers and
-- inbox.messages had nowhere to store them. STAQPRO-562 widens the poller
-- (src/gmail/client.js fetchEmailMetadata) to request those headers and
-- persists them here so the rules light up on real mail.
--
-- The column is a plain jsonb blob of { lowercased-header-name: value }.
-- It is NOT used as a security boundary or join key — it is read-only input
-- to a deterministic, structured-field classifier (P2/P4: boring plumbing,
-- enforcement stays in the runtime + DB constraints, not the prompt).
--
-- Backfill: existing rows keep headers = NULL. The sniffer treats a missing
-- headers map exactly like an empty one (it already did for forward-compat),
-- so old rows simply fall through to the label / from_address rules. No data
-- migration required; reclassify-vendor-noise.js handles the historical pass.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.

ALTER TABLE inbox.messages
  ADD COLUMN IF NOT EXISTS headers jsonb;

DO $$ BEGIN
  RAISE NOTICE '[131] inbox.messages.headers jsonb added (header-sniff rules now persist on live rows)';
END $$;
