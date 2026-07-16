-- 142-contacts-identity-backfill-rerun.sql
-- STAQPRO-555 (P0.5 — Stabilize & Connect): contact enrichment / snapshot fix.
--
-- Symptom (2026-05-30 walkthrough, contact David Berkowitz): the contact detail
-- page showed "No identities linked" — signal.contact_identities had no row for
-- the contact even though signal.contacts.email_address was populated. Contacts
-- are the connective fabric (they tie meetings + projects + threads together),
-- and the relationship inferrer / snapshot retrieval key off identities, so a
-- contact with no email identity is effectively invisible to enrichment.
--
-- Root cause: migration 081 added a one-shot backfill + an AFTER INSERT/UPDATE
-- trigger (signal.sync_contact_email_identity) to keep identities in sync. Any
-- contact that was inserted before 081 ran in a given environment, or whose
-- email_address path bypassed the trigger, can still be missing its email
-- identity row. This migration is a re-run of the 081 backfill to catch those
-- stragglers. The 081 trigger remains the forward-going guarantee.
--
-- IDEMPOTENT: WHERE NOT EXISTS skips contacts that already have a matching
-- email identity, and ON CONFLICT (channel, identifier) DO NOTHING absorbs the
-- (channel, identifier) unique-index collision when two contacts share an
-- email under different casing. Safe to run twice.
--
-- TENANCY NOTE: signal.contact_identities has no owner_org_id column today
-- (that lives on signal.contacts and is the subject of STAQPRO-591 follow-up).
-- This migration only inserts identity rows for contacts that already exist and
-- does NOT touch owner_org_id scoping, the retriever scope surface, or
-- content.match_chunks. It is purely additive on the entity-resolution table.

INSERT INTO signal.contact_identities (
  contact_id, channel, identifier, label, source, verified_at
)
SELECT
  c.id,
  'email',
  lower(c.email_address),
  c.name,
  'migration_backfill_142',
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
