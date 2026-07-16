-- Migration 118 — engagements extras (audit-driven follow-ups)
--
-- 1. client_domain_memory: remember which email domains turned out to belong
--    to which client name on past auto-builds, so the LLM expansion step
--    doesn't have to re-guess every time. Keyed by lowercased client name.
--
-- 2. organization_id on engagements: optional FK-style link (text, not a real
--    FK because inbox.organizations lives in a different schema and we don't
--    do cross-schema FKs — SPEC §12). Lets us aggregate engagements per org.

CREATE TABLE IF NOT EXISTS engagements.client_domain_memory (
  client_name_lc  TEXT NOT NULL,
  domain          TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'auto-build'
    CHECK (source IN ('auto-build', 'manual')),
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_name_lc, domain)
);

CREATE INDEX IF NOT EXISTS idx_client_domain_memory_client
  ON engagements.client_domain_memory (client_name_lc);

ALTER TABLE engagements.engagements
  ADD COLUMN IF NOT EXISTS organization_id TEXT;

CREATE INDEX IF NOT EXISTS idx_engagements_organization
  ON engagements.engagements (organization_id)
  WHERE organization_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE '[118] client_domain_memory created; engagements.organization_id added';
END $$;
