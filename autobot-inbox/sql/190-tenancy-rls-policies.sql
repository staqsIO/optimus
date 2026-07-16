-- 190-tenancy-rls-policies.sql
-- ADR-012 §5.2 follow-through: add tenancy-keyed RLS policies on the 11
-- tables that migration 134 stamped with owner_org_id. This is the DB-level
-- backstop for the app-layer visibleClause() (lib/tenancy/scope.js); the
-- two predicates are byte-for-byte equivalent and the existing parity test
-- (test/tenancy-parity.test.js) guards the equivalence.
--
-- Why this is safe to ship NOW (without 191's FORCE flip)
-- -------------------------------------------------------
-- ENABLE ROW LEVEL SECURITY (not FORCE) is the state these tables sit in
-- after this migration. Two reasons that means zero behavior change in
-- prod today:
--
--   (a) The Postgres pool still connects as the Supabase `postgres.<project>`
--       superuser by default — superusers are ALWAYS exempt from RLS
--       regardless of policy. The pool only flips to autobot_agent when
--       AUTOBOT_AGENT_DB_PASSWORD is set (STAQPRO-303 PR-B-2, opt-in).
--   (b) Even after the pool flips, ENABLE alone does not enforce against
--       the table OWNER (the migration runner). Only FORCE does.
--
-- So this migration plants policies that are *correct* but *dormant* in
-- production. Once PR-B-2 ships AND a follow-up FORCE migration lands,
-- these policies start enforcing — but until both happen, naked query()
-- calls behave exactly as they do today.
--
-- The companion code change (lib/db.js: setAgentContext + withBoardScope)
-- plumbs app.user + app.org_ids GUCs into the per-request transaction so
-- tenancy.visible(row_owner_user, row_owner_org) can evaluate. The board
-- HTTP path passes its already-resolved tenancy principal explicitly via
-- `withBoardScope(req.auth, { principal })` — no auto-resolve, no cyclic
-- import lib/db → lib/tenancy/scope → lib/db.
--
-- Policy shape
-- ------------
-- Every target table is ORG-ONLY (migration 134 explicitly documented why:
-- "these tables have NO usable per-user owner column"). So tenancy.visible
-- gets NULL::uuid for the first arg — the Tier-1 (own) branch falls back
-- to FALSE via COALESCE, and only Tier-2 (org-shared) / Tier-3 (federation)
-- branches can grant visibility.
--
-- We add SELECT policies only. Writes are still scoped by the application
-- (owner-stamp.js stamps owner_org_id on insert/update via lib/tenancy);
-- a write policy would block the agent runtime which legitimately writes
-- across orgs in agent-keyed contexts (e.g. orchestrator promoting tasks).
-- 191 (deferred) can narrow this once every write call site is audited.
--
-- Audit trail
-- -----------
-- DROP POLICY IF EXISTS makes this migration idempotent. Each policy name
-- is prefixed `tenancy_visible_select_` so a future audit can grep all
-- tenancy-keyed policies in one shot without confusing them with the
-- agent-keyed `agent_*` policies from migration 126.
--
-- Rollback
-- --------
-- DROP POLICY tenancy_visible_select_<table> ON <table>;
-- (The owner_org_id column stays — owned by migration 134.)

BEGIN;

DO $$
DECLARE
  tbl TEXT;
  pol TEXT;
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
  FOREACH tbl IN ARRAY tables LOOP
    -- Build policy name from the unqualified table (last segment after '.').
    pol := 'tenancy_visible_select_' || split_part(tbl, '.', 2);

    -- ENABLE RLS — idempotent. Not FORCE (see header).
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);

    -- Drop any prior incarnation so re-runs don't leave stale predicates.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, tbl);

    -- The policy itself: SELECT permitted iff tenancy.visible() returns
    -- TRUE for the row's owner_org_id. row_owner_user is NULL (these tables
    -- carry no per-user owner column) — the predicate's COALESCE/Tier-1
    -- branch fail-closes that to FALSE, leaving Tier-2/3 as the only paths
    -- to visibility. tenancy.visible() is SECURITY DEFINER with a pinned
    -- search_path so a caller's search_path cannot shadow federation_grants.
    EXECUTE format(
      'CREATE POLICY %I ON %s FOR SELECT USING (tenancy.visible(NULL::uuid, owner_org_id))',
      pol, tbl
    );
  END LOOP;
END $$;

-- Verify: every target table now has its tenancy_visible_select_* policy.
-- A silent "no rows created" would defeat the whole point of this migration.
DO $$
DECLARE
  expected_count INT := 11;
  actual_count INT;
BEGIN
  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE policyname LIKE 'tenancy_visible_select_%';

  IF actual_count < expected_count THEN
    RAISE EXCEPTION
      'Expected at least % tenancy_visible_select_* policies, found %',
      expected_count, actual_count;
  END IF;
END $$;

COMMIT;
