-- Migration 175 — Per-field contact enrichment provenance (OPT-71)
--
-- Adds:
--   1. signal.contacts.title       — job title (filled by enrichment layer)
--   2. signal.contact_enrichment_provenance — per-(entity,field,source) audit table
--
-- Design:
--   - The provenance table is the GDPR/CCPA audit trail: every enriched field
--     records which provider set it and when.
--   - One row per (entity_id, field_name, source). ON CONFLICT DO UPDATE keeps
--     the latest fetched_at and value so re-enrichment is idempotent.
--   - basis_for_processing records the Art. 6 / CCPA legal basis so data-subject
--     requests can be resolved at the field level.
--   - entity_type distinguishes contacts from orgs for future expansion.
--   - No cross-schema FK on entity_id (per SPEC §12 no-cross-schema-FK rule).
--     The application layer enforces referential integrity at insert time.
--
-- Owner-stamping: provenance rows carry owner_org_id from the parent entity
-- so tenant-read-ratchet and visibleClause can scope reads correctly.

BEGIN;

-- ── 1. Add title column to signal.contacts ───────────────────────────────────
ALTER TABLE signal.contacts
  ADD COLUMN IF NOT EXISTS title TEXT;

COMMENT ON COLUMN signal.contacts.title IS
  'Job title / role extracted by the enrichment layer. '
  'See signal.contact_enrichment_provenance for provenance.';

-- ── 2. Per-field enrichment provenance table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS signal.contact_enrichment_provenance (
  id                    TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  entity_id             TEXT        NOT NULL,
  entity_type           TEXT        NOT NULL DEFAULT 'contact'
                          CHECK (entity_type IN ('contact', 'org')),
  field_name            TEXT        NOT NULL,
  field_value           TEXT,
  source                TEXT        NOT NULL,
  confidence            NUMERIC(4,3) NOT NULL
                          CHECK (confidence BETWEEN 0 AND 1),
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  basis_for_processing  TEXT        NOT NULL DEFAULT 'legitimate_interests',
  owner_org_id          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT contact_enrichment_provenance_pkey PRIMARY KEY (id),
  -- One row per (entity, field, source). Re-enrichment updates in place.
  CONSTRAINT contact_enrichment_provenance_entity_field_source_unique
    UNIQUE (entity_id, field_name, source)
);

COMMENT ON TABLE signal.contact_enrichment_provenance IS
  'Audit log of per-field enrichment decisions. Each row records which source '
  'set a field, with what confidence, and the legal basis for processing '
  '(GDPR Art. 6 / CCPA). One row per (entity_id, field_name, source); '
  'ON CONFLICT DO UPDATE keeps the latest value.';

COMMENT ON COLUMN signal.contact_enrichment_provenance.source IS
  'Provider name (e.g. email_signature_parser, pdl). Stable identifier.';

COMMENT ON COLUMN signal.contact_enrichment_provenance.basis_for_processing IS
  'Legal basis: legitimate_interests (Art. 6(1)(f)) for B2B contacts. '
  'Update per your DPA if activating external providers.';

COMMENT ON COLUMN signal.contact_enrichment_provenance.owner_org_id IS
  'Tenant scoping. Mirrors the owning signal.contacts.owner_org_id.';

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS contact_enrichment_provenance_entity_id_idx
  ON signal.contact_enrichment_provenance (entity_id);

CREATE INDEX IF NOT EXISTS contact_enrichment_provenance_owner_org_id_idx
  ON signal.contact_enrichment_provenance (owner_org_id)
  WHERE owner_org_id IS NOT NULL;

-- ── Audit notice ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[175] enrichment provenance: signal.contacts.title + signal.contact_enrichment_provenance (entity_id, field_name, source unique)';
END
$$;

COMMIT;
