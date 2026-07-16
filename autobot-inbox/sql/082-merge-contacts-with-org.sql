-- Extend signal.merge_contacts() to reconcile organization_id when merging.
--
-- Today (migration 079) merge handles identities, per-account interactions,
-- engagement counters, and notes — but doesn't know about organization_id
-- (introduced in 080). When two contacts merge:
--   - if neither has an org_id, no change.
--   - if exactly one has an org_id, the primary inherits it.
--   - if both have org_ids and they're equal, no change.
--   - if both have org_ids and they DIFFER, log a review entry and keep the
--     primary's value (don't silently overwrite).

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
  secondary_name   TEXT;
  primary_org      TEXT;
  secondary_org    TEXT;
  org_conflict     BOOLEAN := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_primary_id) THEN
    RAISE EXCEPTION 'Primary contact % not found', p_primary_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_secondary_id) THEN
    RAISE EXCEPTION 'Secondary contact % not found', p_secondary_id;
  END IF;

  SELECT name, organization_id INTO secondary_name, secondary_org
    FROM signal.contacts WHERE id = p_secondary_id;
  SELECT organization_id INTO primary_org
    FROM signal.contacts WHERE id = p_primary_id;

  -- Move identities (channel:identifier rows like email:foo@bar.com).
  SELECT array_agg(identifier) INTO moved_identities
    FROM signal.contact_identities WHERE contact_id = p_secondary_id;

  UPDATE signal.contact_identities
     SET contact_id = p_primary_id
   WHERE contact_id = p_secondary_id;

  -- Aggregate interaction counters on the primary row. Inherit org_id from
  -- the secondary only if the primary has none — never silently overwrite a
  -- non-null primary value (logged below as a conflict).
  UPDATE signal.contacts
     SET emails_received  = emails_received + COALESCE((SELECT emails_received FROM signal.contacts WHERE id = p_secondary_id), 0),
         emails_sent      = emails_sent     + COALESCE((SELECT emails_sent     FROM signal.contacts WHERE id = p_secondary_id), 0),
         last_received_at = GREATEST(last_received_at, (SELECT last_received_at FROM signal.contacts WHERE id = p_secondary_id)),
         last_sent_at     = GREATEST(last_sent_at,     (SELECT last_sent_at     FROM signal.contacts WHERE id = p_secondary_id)),
         organization_id  = COALESCE(organization_id, secondary_org),
         notes = CASE
           WHEN notes IS NULL THEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
           WHEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id) IS NULL THEN notes
           ELSE notes || E'\n---\nMerged from ' || COALESCE(secondary_name, p_secondary_id) || ': ' || (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
         END,
         updated_at = now()
   WHERE id = p_primary_id;

  -- If both sides had a non-null org_id and they differed, record it for
  -- review rather than losing the secondary's value silently.
  IF primary_org IS NOT NULL AND secondary_org IS NOT NULL AND primary_org <> secondary_org THEN
    org_conflict := true;
    INSERT INTO signal.organization_review_log
      (contact_id, organization_text, candidate_org_ids, status)
    VALUES (
      p_primary_id,
      'merge conflict: primary org ' || primary_org || ' kept; secondary org ' || secondary_org || ' from ' || COALESCE(secondary_name, p_secondary_id),
      ARRAY[primary_org, secondary_org],
      'pending'
    );
  END IF;

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
    'identities_moved', COALESCE(moved_identities, '{}'),
    'org_conflict',     org_conflict
  );
END;
$$;
