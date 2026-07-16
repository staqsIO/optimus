-- 152-flow-definitions-owner-org.sql
-- STAQPRO-615 (M2 SECURITY-HARDENING) — owner_org_id on the flow-definition write
-- surface. agent_graph.flow_definitions (sql/037) was created BEFORE the tenancy
-- model (migration 134) and never got an owner column, so POST /api/flows wrote
-- unscoped rows and GET /api/flows returned every org's flows. This adds the
-- column + backfill + DEFAULT, mirroring migration 134 exactly so the read scope
-- (visibleClause(owner_org_id)) and the write stamp (writerOrgId) have a column
-- to act on.
--
-- IDEMPOTENT + BEST-EFFORT (root CLAUDE.md / feedback_db_bootstrap_managed_pg):
-- ADD COLUMN IF NOT EXISTS; the staqs id is read live (no hardcoded UUID) so a
-- fresh PGlite/CI DB gets its own staqs id from migration 133's seed. Wrapped in
-- a DO block; a missing tenancy.orgs (pre-133 DB) raises a clear error rather
-- than silently mis-stamping.
--
-- THE BACKFILL IS THE BOUNDARY (same argument as 134, Linus §11): N=1 operational
-- org today — every existing flow predates any second org, so backfilling all
-- existing rows to Staqs is correct. The DEFAULT keeps NEW agent-runtime writes
-- (which don't carry an org context yet) visible to Staqs without requiring the
-- write-path stamp to ship first. The interim DEFAULT is dropped by the mig-145
-- line of work once every writer stamps explicitly.
--
-- Column NULLABLE (fail-closed via visibleClause). No CREATE INDEX (small table;
-- non-CONCURRENT build would lock writes — add later if needed).

DO $$
DECLARE
  staqs UUID;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE EXCEPTION 'tenancy.orgs has no staqs row — run migration 133 first';
  END IF;

  -- add column (idempotent)
  ALTER TABLE agent_graph.flow_definitions ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  -- backfill existing rows to Staqs (single-org boundary today)
  EXECUTE format('UPDATE agent_graph.flow_definitions SET owner_org_id = %L WHERE owner_org_id IS NULL', staqs);
  -- default future rows to Staqs (overridden by the write-path stamp once org 2 writes)
  EXECUTE format('ALTER TABLE agent_graph.flow_definitions ALTER COLUMN owner_org_id SET DEFAULT %L', staqs);
END $$;
