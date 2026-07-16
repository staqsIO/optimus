-- The signal.merge_contacts() function still references
-- signal.contact_account_interactions, which was renamed to
-- signal.contact_accounts at some point but the function never updated.
-- Calling it from the contacts page silently fails inside `try { ... } catch`
-- on the API side and the UI just stops showing the duplicate row without
-- the merge having actually happened.
--
-- This migration rewrites the body to use signal.contact_accounts (the
-- current table). The schema is the same idea — (contact_id, account_id,
-- interaction_count, last_interaction) — so the dedupe is now: sum
-- interaction_count, take max(last_interaction) when both contacts have
-- a row for the same account.

CREATE OR REPLACE FUNCTION signal.merge_contacts(
  p_primary_id   text,
  p_secondary_id text,
  p_reason       text DEFAULT 'manual merge',
  p_performed_by text DEFAULT 'board'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  moved_identities TEXT[];
  secondary_name TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_primary_id) THEN
    RAISE EXCEPTION 'Primary contact % not found', p_primary_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_secondary_id) THEN
    RAISE EXCEPTION 'Secondary contact % not found', p_secondary_id;
  END IF;

  SELECT name INTO secondary_name FROM signal.contacts WHERE id = p_secondary_id;

  -- Move identities (channel:identifier rows like email:foo@bar.com).
  SELECT array_agg(identifier) INTO moved_identities
    FROM signal.contact_identities WHERE contact_id = p_secondary_id;

  UPDATE signal.contact_identities
     SET contact_id = p_primary_id
   WHERE contact_id = p_secondary_id;

  -- Aggregate interaction counters on the primary row.
  UPDATE signal.contacts
     SET emails_received  = emails_received + COALESCE((SELECT emails_received FROM signal.contacts WHERE id = p_secondary_id), 0),
         emails_sent      = emails_sent     + COALESCE((SELECT emails_sent     FROM signal.contacts WHERE id = p_secondary_id), 0),
         last_received_at = GREATEST(last_received_at, (SELECT last_received_at FROM signal.contacts WHERE id = p_secondary_id)),
         last_sent_at     = GREATEST(last_sent_at,     (SELECT last_sent_at     FROM signal.contacts WHERE id = p_secondary_id)),
         notes = CASE
           WHEN notes IS NULL THEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
           WHEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id) IS NULL THEN notes
           ELSE notes || E'\n---\nMerged from ' || COALESCE(secondary_name, p_secondary_id) || ': ' || (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
         END,
         updated_at = now()
   WHERE id = p_primary_id;

  -- Repoint per-account interaction rows. Where both primary and secondary
  -- already had a row for the same account, sum the counters into the
  -- primary and drop the secondary row (PK is (contact_id, account_id)).
  UPDATE signal.contact_accounts ca_primary
     SET interaction_count = ca_primary.interaction_count + ca_secondary.interaction_count,
         last_interaction  = GREATEST(ca_primary.last_interaction, ca_secondary.last_interaction),
         first_seen        = LEAST(ca_primary.first_seen, ca_secondary.first_seen)
    FROM signal.contact_accounts ca_secondary
   WHERE ca_primary.contact_id   = p_primary_id
     AND ca_secondary.contact_id = p_secondary_id
     AND ca_primary.account_id   = ca_secondary.account_id;

  DELETE FROM signal.contact_accounts
   WHERE contact_id = p_secondary_id
     AND account_id IN (SELECT account_id FROM signal.contact_accounts WHERE contact_id = p_primary_id);

  UPDATE signal.contact_accounts
     SET contact_id = p_primary_id
   WHERE contact_id = p_secondary_id;

  -- Append-only audit (P3).
  INSERT INTO signal.contact_merge_log (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
  VALUES ('merge', p_primary_id, p_secondary_id, p_reason, p_performed_by, COALESCE(moved_identities, '{}'));

  DELETE FROM signal.contacts WHERE id = p_secondary_id;

  RETURN jsonb_build_object(
    'merged',           true,
    'primary_id',       p_primary_id,
    'secondary_id',     p_secondary_id,
    'identities_moved', COALESCE(moved_identities, '{}')
  );
END;
$$;
