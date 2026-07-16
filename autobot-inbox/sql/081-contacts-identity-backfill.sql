-- Phase 1 cont'd: every contact gets at least one identity row, and the
-- table stays in sync going forward.
--
-- Today most contacts have nothing in signal.contact_identities — the table
-- was added in migration 009 but only some code paths populate it. The
-- person-centric model needs identities to BE the way you find a contact
-- across channels (email/slack/github), so we (a) backfill from the legacy
-- contacts.email_address column and (b) add a trigger to keep them
-- synchronized when contacts are inserted or their primary email changes.

-- Trigger function: ensures any contact with an email_address has a
-- matching email-channel identity row. Idempotent on the unique
-- (channel, identifier) index.
CREATE OR REPLACE FUNCTION signal.sync_contact_email_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email_address IS NULL OR NEW.email_address = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO signal.contact_identities (
    contact_id, channel, identifier, label, source, verified_at
  ) VALUES (
    NEW.id,
    'email',
    lower(NEW.email_address),
    NEW.name,
    COALESCE(TG_ARGV[0], 'auto_sync'),
    now()
  )
  ON CONFLICT (channel, identifier) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_sync_email_identity ON signal.contacts;
CREATE TRIGGER contacts_sync_email_identity
  AFTER INSERT OR UPDATE OF email_address ON signal.contacts
  FOR EACH ROW EXECUTE FUNCTION signal.sync_contact_email_identity('auto_sync');

-- One-shot backfill for existing rows. Inserts an email identity for every
-- contact that doesn't already have one. Idempotent on the unique
-- (channel, identifier) index — if two contacts have the same email under
-- different cases, the second loses; this is acceptable because it just
-- means dedupe will surface them as a candidate pair next time.
INSERT INTO signal.contact_identities (
  contact_id, channel, identifier, label, source, verified_at
)
SELECT
  c.id,
  'email',
  lower(c.email_address),
  c.name,
  'migration_backfill_081',
  c.created_at
FROM signal.contacts c
WHERE c.email_address IS NOT NULL
  AND c.email_address <> ''
  AND NOT EXISTS (
    SELECT 1 FROM signal.contact_identities i
    WHERE i.contact_id = c.id
      AND i.channel = 'email'
      AND i.identifier = lower(c.email_address)
  )
ON CONFLICT (channel, identifier) DO NOTHING;
