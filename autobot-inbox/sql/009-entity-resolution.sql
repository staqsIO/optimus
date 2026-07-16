-- 009: Entity Resolution — Multi-Identity Contact Graph (GitHub #56)
-- Adds contact_identities table so one contact can have multiple identifiers
-- (email, LinkedIn, phone, Slack, Ashby, etc.). Signals aggregate across all.

-- Multi-identity table: each row is one identifier for a contact
CREATE TABLE IF NOT EXISTS signal.contact_identities (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id      TEXT NOT NULL REFERENCES signal.contacts(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN (
    'email', 'linkedin', 'phone', 'slack', 'github', 'linear', 'ashby', 'telegram', 'other'
  )),
  identifier      TEXT NOT NULL,
  label           TEXT,                 -- display-friendly name for this identity
  verified_at     TIMESTAMPTZ,          -- NULL = unverified/auto-detected
  stale_after     INTERVAL,             -- per-channel freshness (e.g., '90 days' for recruiting)
  source          TEXT,                 -- how this identity was discovered (google_contacts, gmail_header, manual, etc.)
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, identifier)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON signal.contact_identities(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_identities_lookup ON signal.contact_identities(channel, identifier);

-- GIN trigram index for duplicate detection (prevents O(n^2) cross-product)
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON signal.contacts USING gin (name gin_trgm_ops);

COMMENT ON TABLE signal.contact_identities IS
  'Multi-identity layer for entity resolution. One contact_id → many identifiers across channels. Signals link to contact_id, not directly to an identifier.';

-- Backfill: create email identities from existing contacts
INSERT INTO signal.contact_identities (contact_id, channel, identifier, verified_at, source)
SELECT id, 'email', email_address, created_at, 'migration_backfill'
FROM signal.contacts
WHERE email_address IS NOT NULL
ON CONFLICT (channel, identifier) DO NOTHING;

-- Backfill: create phone identities from existing contacts that have phone numbers
INSERT INTO signal.contact_identities (contact_id, channel, identifier, verified_at, source)
SELECT id, 'phone', phone, created_at, 'migration_backfill'
FROM signal.contacts
WHERE phone IS NOT NULL
ON CONFLICT (channel, identifier) DO NOTHING;

-- Contact merge log: append-only record of merge/split operations (P3)
CREATE TABLE IF NOT EXISTS signal.contact_merge_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  operation       TEXT NOT NULL CHECK (operation IN ('merge', 'split')),
  primary_id      TEXT NOT NULL,    -- the surviving contact
  secondary_id    TEXT NOT NULL,    -- the contact being merged into primary (or split from)
  reason          TEXT,             -- why the merge/split happened
  performed_by    TEXT,             -- board member or 'system'
  identities_moved TEXT[],          -- which identities were transferred
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable trigger for merge log (P3 append-only)
CREATE OR REPLACE FUNCTION signal.prevent_merge_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'contact_merge_log is append-only (P3)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER merge_log_immutable
BEFORE UPDATE OR DELETE ON signal.contact_merge_log
FOR EACH ROW EXECUTE FUNCTION signal.prevent_merge_log_mutation();

-- View: contact with all identities aggregated
CREATE OR REPLACE VIEW signal.v_contact_identities AS
SELECT
  c.id,
  c.name,
  c.organization,
  c.contact_type,
  c.tier,
  c.email_address,
  c.emails_received,
  c.emails_sent,
  c.is_vip,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'channel', ci.channel,
        'identifier', ci.identifier,
        'verified', ci.verified_at IS NOT NULL,
        'stale', ci.stale_after IS NOT NULL AND ci.verified_at + ci.stale_after < NOW()
      )
    ) FILTER (WHERE ci.id IS NOT NULL),
    '[]'::jsonb
  ) AS identities,
  COUNT(ci.id) AS identity_count
FROM signal.contacts c
LEFT JOIN signal.contact_identities ci ON ci.contact_id = c.id
GROUP BY c.id;

-- Function: merge two contacts (moves identities, updates signals, logs operation)
CREATE OR REPLACE FUNCTION signal.merge_contacts(
  p_primary_id TEXT,
  p_secondary_id TEXT,
  p_reason TEXT DEFAULT 'manual merge',
  p_performed_by TEXT DEFAULT 'board'
) RETURNS JSONB AS $$
DECLARE
  moved_identities TEXT[];
  secondary_name TEXT;
BEGIN
  -- Validate both contacts exist
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_primary_id) THEN
    RAISE EXCEPTION 'Primary contact % not found', p_primary_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_secondary_id) THEN
    RAISE EXCEPTION 'Secondary contact % not found', p_secondary_id;
  END IF;

  SELECT name INTO secondary_name FROM signal.contacts WHERE id = p_secondary_id;

  -- Move identities from secondary to primary
  SELECT array_agg(identifier) INTO moved_identities
  FROM signal.contact_identities WHERE contact_id = p_secondary_id;

  UPDATE signal.contact_identities
  SET contact_id = p_primary_id
  WHERE contact_id = p_secondary_id;

  -- Aggregate interaction counts
  UPDATE signal.contacts
  SET
    emails_received = emails_received + COALESCE((SELECT emails_received FROM signal.contacts WHERE id = p_secondary_id), 0),
    emails_sent = emails_sent + COALESCE((SELECT emails_sent FROM signal.contacts WHERE id = p_secondary_id), 0),
    last_received_at = GREATEST(last_received_at, (SELECT last_received_at FROM signal.contacts WHERE id = p_secondary_id)),
    last_sent_at = GREATEST(last_sent_at, (SELECT last_sent_at FROM signal.contacts WHERE id = p_secondary_id)),
    notes = CASE
      WHEN notes IS NULL THEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
      WHEN (SELECT notes FROM signal.contacts WHERE id = p_secondary_id) IS NULL THEN notes
      ELSE notes || E'\n---\nMerged from ' || COALESCE(secondary_name, p_secondary_id) || ': ' || (SELECT notes FROM signal.contacts WHERE id = p_secondary_id)
    END,
    updated_at = now()
  WHERE id = p_primary_id;

  -- Re-point related records BEFORE deleting secondary (prevents CASCADE data loss)
  UPDATE signal.contact_account_interactions
    SET contact_id = p_primary_id
    WHERE contact_id = p_secondary_id
    AND NOT EXISTS (
      SELECT 1 FROM signal.contact_account_interactions
      WHERE contact_id = p_primary_id AND account_id = signal.contact_account_interactions.account_id
    );
  -- Delete duplicate interactions that would violate uniqueness
  DELETE FROM signal.contact_account_interactions WHERE contact_id = p_secondary_id;

  -- Log the merge (P3 append-only)
  INSERT INTO signal.contact_merge_log (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
  VALUES ('merge', p_primary_id, p_secondary_id, p_reason, p_performed_by, COALESCE(moved_identities, '{}'));

  -- Delete the secondary contact (all references already moved)
  DELETE FROM signal.contacts WHERE id = p_secondary_id;

  RETURN jsonb_build_object(
    'merged', true,
    'primary_id', p_primary_id,
    'secondary_id', p_secondary_id,
    'identities_moved', COALESCE(moved_identities, '{}')
  );
END;
$$ LANGUAGE plpgsql;
