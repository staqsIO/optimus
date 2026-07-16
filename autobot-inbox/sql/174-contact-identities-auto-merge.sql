-- 172: Multi-identity auto-merge — OPT-81 backend
--
-- Adds a REVERSIBLE soft-merge pointer to signal.contacts. A merged-away contact
-- is NOT deleted — it is marked merged_into=<canonical_id>. Un-merge = set NULL.
-- This is the reversibility guarantee (no hard deletes in this migration).
--
-- Also adds signal.auto_merge_contacts() for the scored auto-merge pass, and
-- signal.unmerge_contacts() for reversal.
--
-- NOTE: signal.contact_identities, signal.contact_merge_log, and the
-- signal.merge_contacts() human-merge function were added in migrations 009,
-- 079, and 082 respectively. This migration builds ON TOP of that foundation.

-- ── 1. Soft-merge pointer ─────────────────────────────────────────────────────

ALTER TABLE signal.contacts
  ADD COLUMN IF NOT EXISTS merged_into TEXT
    REFERENCES signal.contacts(id)
    DEFERRABLE INITIALLY DEFERRED;

COMMENT ON COLUMN signal.contacts.merged_into IS
  'OPT-81 reversible soft-merge. NULL = active canonical contact. Non-NULL = this
   row has been merged into the referenced canonical; treat as an alias. Un-merge
   by setting back to NULL. Never hard-deleted by auto-merge — only merged_into
   is written.';

CREATE INDEX IF NOT EXISTS idx_contacts_merged_into
  ON signal.contacts(merged_into)
  WHERE merged_into IS NOT NULL;

-- ── 2. Auto-merge audit extension in contact_merge_log ───────────────────────
-- The existing table already has: operation, primary_id, secondary_id, reason,
-- performed_by, identities_moved. We extend operation CHECK to allow
-- 'auto_merge' and 'auto_unmerge' alongside the existing 'merge'/'split'.

ALTER TABLE signal.contact_merge_log
  DROP CONSTRAINT IF EXISTS contact_merge_log_operation_check;

ALTER TABLE signal.contact_merge_log
  ADD CONSTRAINT contact_merge_log_operation_check
    CHECK (operation IN ('merge', 'split', 'auto_merge', 'auto_unmerge'));

-- ── 3. signal.auto_merge_contacts() — soft reversible merge ──────────────────
--
-- Unlike signal.merge_contacts() (which hard-DELETEs the secondary), this
-- function only sets merged_into on the loser. The canonical contact keeps all
-- its data unchanged; signal aggregation follows contact_identities.
--
-- REVERSIBLE: call signal.unmerge_contacts(secondary_id) to restore.
-- IDEMPOTENT: safe to call multiple times on the same pair.
-- NO HARD DELETES: the secondary row is never removed from signal.contacts.
--
-- Confidence threshold: 0.90 — intentionally conservative. "Name + shared
-- email domain" alone is 0.80, which requires additional evidence to cross the
-- threshold (overlapping correspondents OR same organization_id). This prevents
-- false merges between two people who share a company domain.

CREATE OR REPLACE FUNCTION signal.auto_merge_contacts(
  p_canonical_id   text,   -- the surviving / richer contact
  p_secondary_id   text,   -- the contact to mark as merged-away
  p_confidence     numeric, -- the score that triggered this merge (for audit)
  p_reason         text,
  p_performed_by   text DEFAULT 'auto_merge_pass'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  moved_identities TEXT[];
BEGIN
  IF p_canonical_id = p_secondary_id THEN
    RAISE EXCEPTION 'auto_merge_contacts: cannot merge a contact with itself';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_canonical_id) THEN
    RAISE EXCEPTION 'auto_merge_contacts: canonical contact % not found', p_canonical_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_secondary_id) THEN
    RAISE EXCEPTION 'auto_merge_contacts: secondary contact % not found', p_secondary_id;
  END IF;

  -- Idempotent: skip if already merged.
  IF EXISTS (SELECT 1 FROM signal.contacts WHERE id = p_secondary_id AND merged_into IS NOT NULL) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_merged',
      'canonical_id', p_canonical_id, 'secondary_id', p_secondary_id);
  END IF;

  -- Re-point identities of the secondary to the canonical so signal aggregation
  -- immediately follows the right contact.
  SELECT array_agg(identifier) INTO moved_identities
    FROM signal.contact_identities WHERE contact_id = p_secondary_id;

  UPDATE signal.contact_identities
     SET contact_id = p_canonical_id
   WHERE contact_id = p_secondary_id;

  -- Soft-mark the secondary: set merged_into, do NOT delete.
  UPDATE signal.contacts
     SET merged_into = p_canonical_id,
         updated_at  = now()
   WHERE id = p_secondary_id;

  -- Append-only audit row (P3 — immutable trigger is on this table).
  INSERT INTO signal.contact_merge_log
    (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
  VALUES
    ('auto_merge', p_canonical_id, p_secondary_id,
     p_reason || ' [confidence=' || round(p_confidence, 3)::text || ']',
     p_performed_by,
     COALESCE(moved_identities, '{}'));

  RETURN jsonb_build_object(
    'merged',           true,
    'canonical_id',     p_canonical_id,
    'secondary_id',     p_secondary_id,
    'identities_moved', COALESCE(moved_identities, '{}'),
    'confidence',       p_confidence
  );
END;
$$;

-- ── 4. signal.unmerge_contacts() — reversal ───────────────────────────────────
--
-- Sets merged_into back to NULL on the secondary and re-points its identities.
-- SAFE: if identities have since been added to the canonical, those remain on
-- the canonical. Only identities whose source = p_secondary_id are moved back.

CREATE OR REPLACE FUNCTION signal.unmerge_contacts(
  p_secondary_id text,
  p_performed_by text DEFAULT 'board'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_canonical_id   TEXT;
  moved_back       TEXT[];
BEGIN
  SELECT merged_into INTO v_canonical_id
    FROM signal.contacts WHERE id = p_secondary_id;

  IF v_canonical_id IS NULL THEN
    RAISE EXCEPTION 'unmerge_contacts: contact % is not a merged-away alias', p_secondary_id;
  END IF;

  -- Restore identities whose source the auto_merge moved to the canonical.
  -- We find them via the audit log: identities_moved listed in the latest
  -- auto_merge for this pair. Move them back by identifier match.
  SELECT array_agg(identifier) INTO moved_back
    FROM signal.contact_identities
   WHERE contact_id = v_canonical_id
     AND identifier = ANY(
       SELECT unnest(identities_moved)
         FROM signal.contact_merge_log
        WHERE operation = 'auto_merge'
          AND secondary_id = p_secondary_id
        ORDER BY created_at DESC
        LIMIT 1
     );

  UPDATE signal.contact_identities
     SET contact_id = p_secondary_id
   WHERE contact_id = v_canonical_id
     AND identifier = ANY(COALESCE(moved_back, '{}'));

  -- Clear the soft-merge pointer.
  UPDATE signal.contacts
     SET merged_into = NULL,
         updated_at  = now()
   WHERE id = p_secondary_id;

  -- Audit.
  INSERT INTO signal.contact_merge_log
    (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
  VALUES
    ('auto_unmerge', v_canonical_id, p_secondary_id,
     'unmerge reversal',
     p_performed_by,
     COALESCE(moved_back, '{}'));

  RETURN jsonb_build_object(
    'unmerged',       true,
    'secondary_id',   p_secondary_id,
    'canonical_id',   v_canonical_id,
    'identities_back', COALESCE(moved_back, '{}')
  );
END;
$$;

-- ── 5. Grant EXECUTE to autobot_agent (matches existing pattern) ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION signal.auto_merge_contacts(text,text,numeric,text,text) TO autobot_agent';
    EXECUTE 'GRANT EXECUTE ON FUNCTION signal.unmerge_contacts(text,text) TO autobot_agent';
  END IF;
END;
$$;
