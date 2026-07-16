-- Phase 1 of the CRM upgrade: organizations as a first-class entity.
--
-- Until now, signal.contacts.organization was free text — "UMB Advisors",
-- "umb", "umbadvisors.com" and "" all referred to the same org without any
-- way to roll up. This migration promotes it to a real table, adds an alias
-- layer for fuzzy variant matching, and a nullable FK on contacts.
--
-- Per SPEC §12 there are no cross-schema FKs; everything stays inside the
-- signal schema.

CREATE TABLE IF NOT EXISTS signal.organizations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  -- Lowercased, whitespace-collapsed form of name. Used for dedupe at insert
  -- time. Not surfaced in the UI — display name is `name`.
  slug            TEXT NOT NULL UNIQUE,
  primary_domain  TEXT,
  org_type        TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (org_type IN ('startup', 'agency', 'vendor', 'customer',
                                        'partner', 'service', 'investor', 'unknown')),
  parent_org_id   TEXT REFERENCES signal.organizations(id) ON DELETE SET NULL,
  notes           TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organizations_primary_domain_idx
  ON signal.organizations (primary_domain) WHERE primary_domain IS NOT NULL;

-- Alias layer: maps display variants ("UMB", "umbadvisors.com", former names)
-- to a canonical organization. The backfill seeds (alias='<name>',
-- alias_type='name') for every org so subsequent name matches dedupe to the
-- same id.
CREATE TABLE IF NOT EXISTS signal.organization_aliases (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL REFERENCES signal.organizations(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,           -- already lowercased
  alias_type      TEXT NOT NULL CHECK (alias_type IN ('name', 'domain', 'former_name', 'short')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_aliases_unique UNIQUE (alias, alias_type)
);

CREATE INDEX IF NOT EXISTS organization_aliases_org_idx
  ON signal.organization_aliases (organization_id);

-- Review queue for ambiguous backfill matches (multiple candidate orgs for one
-- text). Append-only; the contacts page surfaces pending entries for manual
-- resolution.
CREATE TABLE IF NOT EXISTS signal.organization_review_log (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id          TEXT,
  organization_text   TEXT,
  candidate_org_ids   TEXT[] NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'merged', 'separated', 'ignored')),
  resolved_by         TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organization_review_log_status_idx
  ON signal.organization_review_log (status) WHERE status = 'pending';

-- The actual link: contacts now point at an organization row instead of (or
-- alongside) the legacy free-text field. The text column stays for
-- backward-compat and as the human-readable label until everything reads
-- through the FK.
ALTER TABLE signal.contacts
  ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES signal.organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contacts_organization_id_idx
  ON signal.contacts (organization_id) WHERE organization_id IS NOT NULL;

-- Touch-trigger to keep updated_at fresh on org edits.
CREATE OR REPLACE FUNCTION signal.touch_organization_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_touch_updated_at ON signal.organizations;
CREATE TRIGGER organizations_touch_updated_at
  BEFORE UPDATE ON signal.organizations
  FOR EACH ROW EXECUTE FUNCTION signal.touch_organization_updated_at();
