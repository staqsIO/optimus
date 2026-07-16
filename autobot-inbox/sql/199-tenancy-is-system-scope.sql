-- 199: system-scope escape — tenancy.is_system() + tenancy.visible() Tier-0
--      branch + append-only audit.system_scope_opens ledger.
--      (STAQPRO-263 Bucket 2 — the always-on runtime read-path bypass mechanism.)
--
-- Why this exists (the flip black-holes the runtime without it)
-- -------------------------------------------------------------
-- Today the app pool connects as the Supabase superuser (BYPASSRLS), so every
-- RLS policy is installed-but-dark. The moment STAQPRO-263 flips the pool to the
-- non-superuser `autobot_agent` role (sql/001-baseline: NOBYPASSRLS), RLS starts
-- enforcing. Every ALWAYS-ON runtime read path — the poll loop, the task graph,
-- context-loader, the gmail/calendar/tldv/research pollers, the audit writers,
-- and ~40 HTTP routes — issues bare `query()` calls with NO tenancy GUCs
-- (`app.user` / `app.org_ids` unset). `tenancy.visible()` (sql/133) then
-- COALESCEs to FALSE for every row → SELECT returns 0 rows, INSERT...RETURNING
-- 500s, UPDATE...WHERE matches 0 rows (the #561 implicit-SELECT-policy lesson).
-- That is a full runtime outage, not a leak.
--
-- These bare paths are NOT tenant users: the poll loop legitimately processes
-- work for ALL orgs. They need a *system* identity that is explicitly allowed
-- cross-org reads AND explicitly audited as such — not a fabricated per-org
-- membership. This migration lays that mechanism; the paths ADOPT it in Bucket 3.
--
-- What Bucket 2 lands (this migration + the lib/db.js withSystemScope helper)
-- --------------------------------------------------------------------------
--   1. tenancy.is_system() — one source of truth for "the connection is a
--      system/runtime actor", i.e. app.role = 'system'.
--   2. tenancy.visible() gains a Tier-0 `is_system()` branch as the FIRST clause
--      inside its existing COALESCE. This covers the 13 visible()-based tables in
--      ONE change (ADR-012 §5.1). The rest of the body is reproduced VERBATIM
--      from sql/133:75-94 — Tier-1 own / Tier-2 org / Tier-3 federation are
--      byte-for-byte unchanged; only the Tier-0 line is added.
--   3. audit.system_scope_opens — an append-only ledger. withSystemScope() writes
--      one row per scope open, SYNCHRONOUSLY and IN-TRANSACTION (fail-closed): no
--      cross-org system read can occur without a durable audit record of who
--      opened the scope (P3: transparency by structure).
--
-- Deliberately OUT of scope here (Bucket 2b, sequenced after Bucket 3):
--   * The OLDER policy shape (`current_agent_id() OR app.role='board'`) on
--     agent_graph.{task_events, llm_invocations, work_item_scenarios,
--     federation_grants} and the work_items WRITE policies. visible() never
--     touches those, so `OR tenancy.is_system()` must be added per-table — but
--     only once Bucket 3 decides which scope each write path runs under. This
--     migration touches ONLY application site 1 (visible()).
--
-- Security invariant (the load-bearing one)
-- ------------------------------------------
-- app.role='system' is a FULL cross-org read bypass. It is safe ONLY because no
-- request/token-influenced path can set it. Enforced OUTSIDE this migration by:
--   * lib/db.js setAgentContext() — throws on role='system' unless the caller
--     passes a module-private guard token that ONLY withSystemScope holds (P2:
--     infra enforces, not a lint).
--   * a caller-import ratchet (scripts/audit-system-scope-importers.mjs +
--     test/system-scope-importer-ratchet.test.js) — fails CI if any new file
--     imports withSystemScope beyond the baseline (0 in Bucket 2).
-- This migration only defines the DB-side predicate; the actuator + its guards
-- live in lib/db.js and are covered by the ratchet.
--
-- Inert until the flip
-- --------------------
-- The pool is still the RLS-bypassing superuser, so is_system() is never
-- consulted in anger today, withSystemScope has ZERO callers (Bucket 3 adds
-- them), and the audit table stays empty. Safe to land incrementally, exactly
-- like sql/197 / sql/198.
--
-- PGlite
-- ------
-- is_system() and visible() are plain SQL (no auth/pgcrypto dependency) and run
-- on both engines. The `audit` schema already exists on PGlite (sql/188 runs
-- there). The autobot_agent role does NOT exist on PGlite, so the grant at the
-- bottom is guarded by a pg_roles existence check (sql/147 pattern). We ENABLE
-- RLS on the new table self-containedly and the verify block asserts
-- pg_tables.rowsecurity=true (the sql/198 dormant-policy lesson) so a policy is
-- never created against an RLS-disabled table.
--
-- Rollback
-- --------
-- DROP FUNCTION tenancy.is_system();
-- -- restore sql/133's tenancy.visible() body (drop the Tier-0 line);
-- DROP TABLE audit.system_scope_opens;   -- (append-only; ledger is empty pre-flip)

BEGIN;

-- ============================================================
-- 1. tenancy.is_system() — single source of truth for the system-actor test.
-- ============================================================
-- STABLE SECURITY DEFINER SET search_path — mirrors tenancy.visible() exactly so
-- the two functions share identical volatility/search_path posture. current_setting
-- reflects the session/txn GUC regardless of SECURITY DEFINER, so this reads the
-- app.role that withSystemScope stamps via set_config('app.role','system',true).
CREATE OR REPLACE FUNCTION tenancy.is_system()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog AS $$
  -- COALESCE to a TOTAL boolean: with app.role unset/empty, NULLIF(...)='system'
  -- is NULL, and a NULL Tier-0 predicate is a footgun (NULL IS NOT FALSE, and a
  -- NULL in an RLS USING/WITH CHECK reads as deny but obscures intent). Force
  -- FALSE so is_system() is strictly true/false in every context.
  SELECT COALESCE(NULLIF(current_setting('app.role', true), '') = 'system', false);
$$;

COMMENT ON FUNCTION tenancy.is_system() IS
  'STAQPRO-263 Bucket 2: TRUE when app.role=''system'' (a withSystemScope() connection). Tier-0 cross-org read bypass for always-on runtime actors. Reachable only via lib/db.js withSystemScope (guard-token protected); see sql/199 header.';

-- ============================================================
-- 2. tenancy.visible() — add Tier-0 is_system() branch.
--    Body reproduced VERBATIM from sql/133:75-94; ONLY the Tier-0 line is new.
-- ============================================================
CREATE OR REPLACE FUNCTION tenancy.visible(row_owner_user UUID, row_owner_org UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog AS $$
  -- COALESCE(..., false): unset GUCs / NULL owner columns resolve to an explicit
  -- FALSE, not NULL — fail-closed in ANY boolean context, not only in WHERE.
  SELECT COALESCE(
    -- Tier 0: system/runtime actor (STAQPRO-263 Bucket 2). Full cross-org read
    -- bypass for always-on paths; set ONLY by lib/db.js withSystemScope.
    tenancy.is_system()
    -- Tier 1: own
    OR row_owner_user = NULLIF(current_setting('app.user', true), '')::uuid
    -- Tier 2: org-shared, only for orgs where caller holds read:'org'
    OR row_owner_org = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
    -- Tier 3: federation (dormant until a grant exists)
    OR EXISTS (
      SELECT 1 FROM tenancy.federation_grants g
      WHERE g.grantee_org_id = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
        AND g.grantor_org_id = row_owner_org
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
    )
  , false);
$$;

-- ============================================================
-- 3. audit.system_scope_opens — append-only system-scope ledger.
-- ============================================================
CREATE SCHEMA IF NOT EXISTS audit;   -- present since sql/188; self-contained here.

CREATE TABLE IF NOT EXISTS audit.system_scope_opens (
  id             BIGSERIAL PRIMARY KEY,
  system_actor   TEXT        NOT NULL,                       -- the SYSTEM_ACTORS entry that opened the scope
  reason         TEXT,                                       -- optional caller-supplied context
  backend_pid    INT         NOT NULL DEFAULT pg_backend_pid(),
  txid           BIGINT      NOT NULL DEFAULT txid_current(),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_scope_opens_actor_ts_idx
  ON audit.system_scope_opens(system_actor, opened_at DESC);

COMMENT ON TABLE audit.system_scope_opens IS
  'Append-only ledger of every lib/db.js withSystemScope() open (STAQPRO-263 Bucket 2). Written synchronously in-transaction and fail-closed — a cross-org system read cannot occur without a durable open record. Empty until Bucket 3 wires callers.';

-- Append-only immutability (P3). RLS default-deny already blocks tenant
-- UPDATE/DELETE post-flip, but the trigger also protects the pre-flip superuser
-- window, matching the repo convention for audit ledgers (state_transitions etc.).
CREATE OR REPLACE FUNCTION audit.fn_system_scope_opens_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.system_scope_opens is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_system_scope_opens_immutable ON audit.system_scope_opens;
CREATE TRIGGER trg_system_scope_opens_immutable
  BEFORE UPDATE OR DELETE ON audit.system_scope_opens
  FOR EACH ROW EXECUTE FUNCTION audit.fn_system_scope_opens_immutable();

-- Self-contained RLS enablement (sql/198 dormant-policy lesson): enable BEFORE
-- creating policies so they are enforceable rather than dormant on any engine.
ALTER TABLE audit.system_scope_opens ENABLE ROW LEVEL SECURITY;

-- INSERT: admitted iff the connection is itself system-scoped. This is the same
-- txn in which withSystemScope has already stamped app.role='system', so the
-- audit write is admitted precisely because is_system() is true — no bootstrap
-- circularity (is_system() is defined above, in this migration).
DROP POLICY IF EXISTS system_scope_opens_insert ON audit.system_scope_opens;
CREATE POLICY system_scope_opens_insert ON audit.system_scope_opens
  FOR INSERT
  WITH CHECK (tenancy.is_system());

-- SELECT: board members read the ledger (governance surface); a system-scoped
-- connection may also read its own ledger. No UPDATE/DELETE policy → append-only
-- under RLS default-deny post-flip (belt-and-suspenders with the trigger above).
DROP POLICY IF EXISTS system_scope_opens_select ON audit.system_scope_opens;
CREATE POLICY system_scope_opens_select ON audit.system_scope_opens
  FOR SELECT
  USING (
    NULLIF(current_setting('app.role', true), '') = 'board'
    OR tenancy.is_system()
  );

-- Explicit grant to autobot_agent (belt-and-suspenders vs sql/194's ALTER
-- DEFAULT PRIVILEGES, per the sql/198 self-containment lesson). Guarded on the
-- role existing so PGlite/test (no autobot_agent role) does not error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA audit TO autobot_agent';
    EXECUTE 'GRANT SELECT, INSERT ON audit.system_scope_opens TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE audit.system_scope_opens_id_seq TO autobot_agent';
  END IF;
END $$;

-- ============================================================
-- 4. Verify: functions exist, Tier-0 wired, RLS enabled, policies present.
-- ============================================================
DO $$
DECLARE
  n_policies INT;
  rls_on     BOOLEAN;
BEGIN
  -- is_system() must exist and return TRUE under a simulated system GUC and
  -- FALSE otherwise (this is the whole Tier-0 hinge).
  PERFORM set_config('app.role', 'system', true);
  IF tenancy.is_system() IS NOT TRUE THEN
    RAISE EXCEPTION 'tenancy.is_system() did not return TRUE under app.role=system';
  END IF;
  -- visible() Tier-0 must now short-circuit TRUE for any row while system-scoped,
  -- even with NULL owners and no app.user/app.org_ids set.
  IF tenancy.visible(NULL::uuid, NULL::uuid) IS NOT TRUE THEN
    RAISE EXCEPTION 'tenancy.visible() Tier-0 branch did not admit a system-scoped connection';
  END IF;
  PERFORM set_config('app.role', '', true);
  IF tenancy.is_system() IS NOT FALSE THEN
    RAISE EXCEPTION 'tenancy.is_system() did not return FALSE with app.role unset';
  END IF;
  -- With app.role cleared and no tenancy GUCs, visible() must fail closed again
  -- (proves the Tier-0 line did not accidentally widen the default posture).
  IF tenancy.visible(NULL::uuid, NULL::uuid) IS NOT FALSE THEN
    RAISE EXCEPTION 'tenancy.visible() no longer fails closed for a non-system, unscoped connection';
  END IF;

  SELECT rowsecurity INTO rls_on FROM pg_tables
    WHERE schemaname = 'audit' AND tablename = 'system_scope_opens';
  IF rls_on IS NOT TRUE THEN
    RAISE EXCEPTION 'RLS not enabled on audit.system_scope_opens';
  END IF;

  SELECT count(*) INTO n_policies FROM pg_policies
    WHERE schemaname = 'audit' AND tablename = 'system_scope_opens'
      AND policyname IN ('system_scope_opens_insert', 'system_scope_opens_select');
  IF n_policies < 2 THEN
    RAISE EXCEPTION 'Expected 2 policies on audit.system_scope_opens, found %', n_policies;
  END IF;
END $$;

COMMIT;
