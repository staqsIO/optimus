-- 148-owner-org-id-on-voice-calendar-tables.sql
-- STAQPRO-608: add owner_org_id to the 4 tenant tables that lack the column
-- entirely, so a follow-up can tenant-scope their routes. Today
-- /api/calendar/events and /api/voice-prints cannot be scoped at all because
-- voice.voice_prints, voice.unenrolled_speakers, inbox.calendar_events, and
-- inbox.calendar_watches have no org-owner column.
--
-- Pattern matches migrations 134 (tenancy-owner-columns) and 138
-- (owner-messages-accounts-projects): nullable owner_org_id UUID, no FK, no
-- index (tables are small; CONCURRENT-build deferred), backfill existing rows
-- via the real relationship to an org-bearing table.
--
-- NOTE on DEFAULT: migs 134/138 set a column DEFAULT = Staqs so agent writes
-- land visible before the write-path stamp ships. Those tables are written by
-- agents on the org-runtime path. The 4 tables here are written by HTTP routes
-- (voice-prints enroll/promote, calendar poller) — STAQPRO-608's sibling task
-- adds owner_org_id stamping on those write paths. To avoid a default that the
-- write-path stamp would immediately override AND to keep this migration purely
-- additive (no behavior change for the parallel route-scoping work), we add the
-- nullable column + backfill only. visibleClause COALESCEs legacy NULL -> Staqs
-- (mig 135), so any row left NULL stays visible to Staqs members — the correct
-- fail-safe single-org behavior. NOT NULL / DROP DEFAULT belong to the separate
-- 566 / PR-B track.
--
-- BACKFILL JOIN PATHS (investigated against live schema 2026-06-02):
--   inbox.calendar_events.account_email  -> inbox.accounts.identifier
--       (WHERE accounts.channel='email'); take accounts.owner_org_id (mig 138).
--   inbox.calendar_watches.account_email -> inbox.accounts.identifier
--       (WHERE accounts.channel='email'); take accounts.owner_org_id (mig 138).
--   voice.voice_prints.contact_id        -> signal.contacts.id
--       (the route already LEFT JOINs this); take contacts.owner_org_id (mig 134).
--   voice.unenrolled_speakers            -> NO clean org path. Pre-enrollment
--       audio embeddings with no contact/account/email identity (keyed only by
--       voice embedding + source_memo_ids). Column added, rows LEFT NULL.
--       Treated as legacy -> Staqs by visibleClause COALESCE (mig 135), which is
--       the safe single-org default until a memo->account org path is wired.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + WHERE owner_org_id IS NULL guards.
-- Parameterized via format(%L) on a live-read staqs id (no hardcoded UUID;
-- fresh DBs get their own staqs id from migration 133's seed). Matches the
-- DO-block style of migs 134/138/143/144.

DO $$
DECLARE
  staqs UUID;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE EXCEPTION 'tenancy.orgs has no staqs row — run migration 133 first';
  END IF;

  -- 1. inbox.calendar_events
  --    Backfill: account_email -> inbox.accounts.identifier (email accounts),
  --    take that account's owner_org_id.
  ALTER TABLE inbox.calendar_events ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE inbox.calendar_events ce
     SET owner_org_id = a.owner_org_id
    FROM inbox.accounts a
   WHERE a.channel = 'email'
     AND a.identifier = ce.account_email
     AND a.owner_org_id IS NOT NULL
     AND ce.owner_org_id IS NULL;
  -- Any rows whose account_email matches no email account (or an account with
  -- NULL owner_org_id) stay NULL -> legacy -> Staqs via visibleClause.

  -- 2. inbox.calendar_watches
  --    Same join path as calendar_events.
  ALTER TABLE inbox.calendar_watches ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE inbox.calendar_watches cw
     SET owner_org_id = a.owner_org_id
    FROM inbox.accounts a
   WHERE a.channel = 'email'
     AND a.identifier = cw.account_email
     AND a.owner_org_id IS NOT NULL
     AND cw.owner_org_id IS NULL;

  -- 3. voice.voice_prints
  --    Backfill: contact_id -> signal.contacts.id, take contact's owner_org_id.
  ALTER TABLE voice.voice_prints ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE voice.voice_prints vp
     SET owner_org_id = c.owner_org_id
    FROM signal.contacts c
   WHERE c.id = vp.contact_id
     AND c.owner_org_id IS NOT NULL
     AND vp.owner_org_id IS NULL;
  -- Prints whose contact has NULL owner_org_id stay NULL -> legacy -> Staqs.

  -- 4. voice.unenrolled_speakers
  --    NO derivable org path (no contact/account/email; only audio embedding +
  --    source_memo_ids). Column added; rows LEFT NULL on purpose. visibleClause
  --    COALESCEs NULL -> Staqs (mig 135), the safe single-org behavior. When a
  --    memo->account org path exists, a follow-up can backfill via source_memo_ids.
  ALTER TABLE voice.unenrolled_speakers ADD COLUMN IF NOT EXISTS owner_org_id UUID;
END $$;
