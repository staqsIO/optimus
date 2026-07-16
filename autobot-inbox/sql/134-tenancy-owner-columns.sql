-- 134-tenancy-owner-columns.sql
-- ADR-012 M-B (STAQPRO-587): org-owner labeling + backfill on the tenant-scoped
-- tables that board members can read. Pairs with 133 (tenancy schema + memberships
-- + tenancy.visible predicate). M-C (STAQPRO-588) scopes reads against owner_org_id.
--
-- ORG-ONLY by design (verified against live schema 2026-05-31): these tables have
-- NO usable per-user owner column (signal.contacts / inbox.signals /
-- inbox.human_tasks / signal.briefings carry none). The Dustin->Eric leak is an
-- ORG-separation problem (Dustin=consulting-futures/umb, Eric=staqs); Tier-1
-- within-Staqs ownership is not needed to close it. So we add owner_org_id only.
--
-- THE BACKFILL IS THE BOUNDARY (Linus §11): N=1 operational org today — every
-- existing row's owner_org_id = Staqs (all live data predates any second org's
-- write access). Dustin (not a Staqs member) then reads ZERO of these rows.
--
-- DEFAULT owner_org_id = Staqs so NEW rows written by agents stay visible to
-- Staqs members WITHOUT requiring the M-C write-path stamping to ship first
-- (avoids a "new rows invisible" regression). When a second org begins writing,
-- the Phase-2 write-path stamp overrides the default. The default is set via a
-- DO block that reads the live staqs id (env-safe — no hardcoded UUID; fresh
-- DBs get their own staqs id from migration 133's seed).
--
-- Columns NULLABLE (fail-closed via tenancy.visible COALESCE). No CREATE INDEX
-- (non-CONCURRENT builds lock writes; tables are small; add later if needed).
-- inbox.signals / inbox.human_tasks are REAL TABLES (not views) — altered directly.
-- inbox.drafts is a VIEW over agent_graph.action_proposals; /api/drafts scopes by
-- recipient, not org, so the view is not recreated here.

DO $$
DECLARE
  staqs UUID;
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'signal.contacts',
    'inbox.signals',
    'inbox.human_tasks',
    'signal.briefings',
    'agent_graph.action_proposals',
    'agent_graph.signals',
    'agent_graph.campaigns',
    'agent_graph.work_items',
    'content.documents',
    'content.drafts',
    'signal.organizations'
  ];
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE EXCEPTION 'tenancy.orgs has no staqs row — run migration 133 first';
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    -- add column (idempotent)
    EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS owner_org_id UUID', tbl);
    -- backfill existing rows to Staqs
    EXECUTE format('UPDATE %s SET owner_org_id = %L WHERE owner_org_id IS NULL', tbl, staqs);
    -- default future rows to Staqs (overridden by write-path stamp once org 2 writes)
    EXECUTE format('ALTER TABLE %s ALTER COLUMN owner_org_id SET DEFAULT %L', tbl, staqs);
  END LOOP;
END $$;
