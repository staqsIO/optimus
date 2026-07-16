-- 066: Track when each signer was last reminded.
--
-- Background
-- ----------
-- Nothing sweeps signature_requests today. Expired requests stay in
-- status 'pending'/'in_progress' until a board member notices, and signers
-- never get nudged as the deadline approaches. The sweeper in
-- lib/signatures/sweeper.js needs a per-signer "last reminded" anchor so
-- we don't re-email on every cron tick.
--
-- Change
-- ------
-- signatures.signers gains last_reminded_at TIMESTAMPTZ. Sweeper only
-- sends a reminder when last_reminded_at is NULL or older than a
-- configurable interval (24h for now, chosen so an hourly cron doesn't
-- spam the signer but a real 48h expiry still gets two nudges).

ALTER TABLE signatures.signers
  ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

COMMENT ON COLUMN signatures.signers.last_reminded_at IS
  'Wall-clock timestamp of the last reminder email sent to this signer. '
  'NULL = never reminded. Updated by lib/signatures/sweeper.js after a '
  'successful Resend API call. Used to rate-limit reminders (24h cooldown).';

-- Partial index for the sweeper's hot query — signers that are still
-- pending or viewed on active requests whose deadline is near.
CREATE INDEX IF NOT EXISTS idx_signers_reminder_candidates
  ON signatures.signers (request_id, last_reminded_at)
  WHERE status IN ('pending', 'viewed');
