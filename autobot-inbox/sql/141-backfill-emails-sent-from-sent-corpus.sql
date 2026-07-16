-- 141-backfill-emails-sent-from-sent-corpus.sql
-- STAQPRO-584: tier-resolution promotes 0 contacts because genuine
-- correspondents are stuck at tier='unknown'. The promotion predicate
-- (Rule 3: correspondence volume) reads signal.contacts.emails_sent, but
-- historically the sent-mail bootstrap (src/gmail/sent-analyzer.js) inserted
-- into voice.sent_emails WITHOUT bumping signal.contacts.emails_sent. So the
-- counter under-reported (often 0) for contacts whose only interaction was
-- inbound-only resolution, and Rule 3 never fired.
--
-- The code fix (this same PR) now calls resolveAndUpsert(role='recipient') on
-- every newly imported sent email, which increments emails_sent going forward.
-- This migration backfills the historical gap: it recomputes emails_sent from
-- the voice.sent_emails ground truth (count of sent emails whose recipient
-- address matches the contact's email_address, case-insensitively).
--
-- This mirrors the same ground-truth recompute already used in migration 106
-- (signal.split_contact) and the merge functions (079/082), so the value
-- converges on the canonical definition.
--
-- IDEMPOTENT: this is a recompute, not an increment. It SETs emails_sent to a
-- deterministic count(*); running it twice produces the identical result. The
-- WHERE clause skips contacts whose value already matches ground truth, so a
-- second run touches zero rows.

BEGIN;

UPDATE signal.contacts c
SET emails_sent = sub.cnt,
    updated_at  = now()
FROM (
  SELECT lower(se.to_address) AS addr, count(*)::int AS cnt
  FROM voice.sent_emails se
  WHERE se.to_address IS NOT NULL
  GROUP BY lower(se.to_address)
) sub
WHERE lower(c.email_address) = sub.addr
  AND c.emails_sent IS DISTINCT FROM sub.cnt;

COMMIT;
