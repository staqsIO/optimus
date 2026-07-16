-- Add 'inactive' to signal.contacts.tier — for people who were once in the
-- inner circle / active but have gone cold and shouldn't ride priority any
-- more. Distinct from 'inbound_only' (they email me but I don't respond)
-- and 'unknown' (we don't have enough signal yet) — 'inactive' is an
-- intentional state.

ALTER TABLE signal.contacts
  DROP CONSTRAINT IF EXISTS contacts_tier_check;

ALTER TABLE signal.contacts
  ADD CONSTRAINT contacts_tier_check
    CHECK (tier IN (
      'inner_circle',
      'active',
      'inactive',
      'inbound_only',
      'newsletter',
      'automated',
      'unknown'
    ));
