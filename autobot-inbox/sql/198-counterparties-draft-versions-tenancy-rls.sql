-- 198: real tenancy RLS for content.counterparties + content.draft_versions
--      (STAQPRO-263 Bucket 1a — dead-auth.uid() policy rewrites).
--
-- Issue (STAQPRO-263 pool-flip remediation, Bucket 1a)
-- ----------------------------------------------------
-- sql/070 shipped RLS on content.counterparties and content.draft_versions
-- keyed ENTIRELY on `auth.uid() IS NOT NULL`. That predicate is DEAD in this
-- codebase: nothing populates request.jwt.claim.sub, so the auth.uid() stub is
-- permanently NULL (same dead-predicate class fixed for send_overrides in
-- sql/197 / #561). Today the app pool connects as the Supabase superuser, which
-- BYPASSES RLS, so the dead policies never bite. The moment STAQPRO-263 flips
-- the pool to the non-superuser `autobot_agent` role (sql/001-baseline: LOGIN
-- NOINHERIT, no BYPASSRLS), RLS starts enforcing and every one of these dead
-- policies evaluates FALSE for every row:
--   * SELECT  -> 0 rows for everyone, including the owning tenant.
--   * INSERT  -> `new row violates row-level security policy` (hard 500), AND
--                (the subtle one, per sql/197 header) even a WITH-CHECK-passing
--                INSERT ... RETURNING is denied because Postgres enforces the
--                SELECT policy IMPLICITLY against the RETURNING read-back.
--   * UPDATE  -> `UPDATE ... WHERE` matches 0 rows (SELECT policy applied to the
--                row-match) — silent no-op, no error.
-- So these tables black-hole EVEN WITH a correctly-scoped connection; fixing the
-- policy predicate is required independent of the system-scope work.
--
-- Fix: the SAME tenancy predicate the rest of content.* already uses
-- --------------------------------------------------------------------
-- tenancy.visible(row_owner_user, row_owner_org) (sql/133, ADR-012 §5.1) reads
-- the app.user / app.org_ids GUCs (plumbed by withAgentScope/withBoardScope) and
-- returns true for own-row / same-org / federated reads, fail-closed otherwise.
--
--   * content.counterparties carries its own owner_org_id column (sql/149), so it
--     scopes DIRECTLY: tenancy.visible(NULL::uuid, owner_org_id) — exactly the
--     mig-190 shape used by content.documents / content.drafts.
--   * content.draft_versions has NO owner_org_id of its own but carries a NOT
--     NULL FK draft_id -> content.drafts(id) (sql/062:13), and content.drafts
--     already carries the tenancy predicate. So it scopes THROUGH the parent
--     draft, exactly as sql/195 (gate_log) and sql/197 (send_overrides) do for
--     their child-of-drafts tables:
--       EXISTS (SELECT 1 FROM content.drafts d
--               WHERE d.id = draft_versions.draft_id
--                 AND tenancy.visible(NULL::uuid, d.owner_org_id))
-- Nothing new becomes visible or mutable: whatever counterparty/draft a caller
-- can already see, they can now read/write its rows; everything else fail-closes.
--
-- Command coverage (preserves sql/070's original command surface, new predicate)
-- -----------------------------------------------------------------------------
--   counterparties: SELECT policy + a FOR ALL write policy (INSERT/UPDATE/DELETE)
--     — counterparties are mutable CRM entities; the owning tenant manages them.
--     (sql/070 had "see" = SELECT and "write" = FOR ALL; same split, live pred.)
--   draft_versions: SELECT policy + INSERT policy ONLY. draft_versions is
--     append-only (trg immutability, append_draft_version() SECURITY INVOKER);
--     sql/070 had no UPDATE/DELETE policy and this keeps it that way. Post-flip a
--     tenant UPDATE/DELETE is hard-blocked by RLS default-deny (no applicable
--     policy -> row invisible to the write's implicit match BEFORE any BEFORE-row
--     trigger fires -> silent no-op, row survives), which is the correct
--     append-only posture (same reasoning as sql/197's DELETE note).
--
-- owner_org_id must be stamped on counterparties INSERT (Bucket 3 note)
-- --------------------------------------------------------------------
-- A counterparty row with owner_org_id IS NULL is invisible to EVERYONE post-flip
-- (tenancy.visible(NULL,NULL) -> Tier-2 branch NULL -> COALESCE false), and an
-- INSERT that omits owner_org_id fails the WITH CHECK outright. mig 149 backfilled
-- existing rows to the Staqs org; the counterparties WRITE PATH must stamp
-- owner_org_id = caller's org on new rows before the flip (the voiceprints-NULL
-- lesson). Tracked under Bucket 3 (route/writer scoping); this migration only
-- lays the — inert until flip — policy.
--
-- Inert until the flip
-- --------------------
-- The pool is still the RLS-bypassing superuser, so these policies change no
-- behavior today. Safe to land incrementally, same as sql/197.
--
-- PGlite + self-contained RLS enablement
-- ---------------------------------------
-- Unlike content.send_overrides (sql/071, absent on PGlite), BOTH tables here are
-- created by migrations that DO run under PGlite (sql/062, sql/065 — no auth
-- dependency); only their sql/070 statements were skipped (auth-schema cascade).
-- That skip matters MORE than just the dead policies: sql/070 is ALSO where
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` lives for these two tables. So on
-- PGlite, RLS was never enabled on counterparties/draft_versions at all — a bare
-- CREATE POLICY there lands a DORMANT policy (Postgres allows policies on a table
-- with RLS disabled; they simply never evaluate). The anti-rot tripwire counts
-- pg_policies rows and would go green even though nothing is enforced — a false
-- positive. (Runtime exposure on PGlite is still nil because PGlite connects as a
-- superuser, which bypasses RLS regardless; but the schema state would be
-- inconsistent with real Postgres and the "applies to both engines" claim would
-- be a lie.)
--
-- Therefore this migration ENABLEs RLS itself, on both tables, before (re)creating
-- the policies — making it SELF-CONTAINED rather than depending on sql/070's
-- side effect. On real Postgres, sql/070 already ran the same ENABLE, so this is
-- an idempotent no-op there; on PGlite it flips rowsecurity on so the schema state
-- matches. We deliberately use ENABLE, NOT FORCE: the app pool connects as the
-- non-owner autobot_agent role, which plain ENABLE already subjects to RLS; FORCE
-- (which would also subject the table OWNER) is the deferred flip-time concern
-- handled by the STAQPRO-263 pool-flip program, not here. The verify block below
-- asserts pg_tables.rowsecurity = true on both tables so a silent enablement
-- regression trips the migration.
--
-- Net: this migration runs on BOTH engines (no sql/197 pre-BEGIN auth-schema skip
-- guard needed). The tenancy-gucs anti-rot tripwire (test/tenancy-gucs.test.js)
-- counts tenancy_visible_select_* policies on BOTH engines; this adds 2
-- (counterparties, draft_versions) to each.
--
-- Rollback
-- --------
-- DROP POLICY tenancy_visible_select_counterparties ON content.counterparties;
-- DROP POLICY tenancy_visible_write_counterparties  ON content.counterparties;
-- DROP POLICY tenancy_visible_select_draft_versions ON content.draft_versions;
-- DROP POLICY tenancy_visible_insert_draft_versions ON content.draft_versions;
--   -- optionally restore the sql/070 dead auth.uid() policies (harmless today).

BEGIN;

-- Enable RLS self-containedly (see "PGlite + self-contained RLS enablement"
-- above). Idempotent no-op on real Postgres, where sql/070 already enabled it;
-- on PGlite, where sql/070 was skipped, this is what actually turns RLS on so the
-- policies below are enforceable rather than dormant. ENABLE (not FORCE) — the
-- app pool is the non-owner autobot_agent role; FORCE is the deferred flip-time
-- concern, not this migration's.
ALTER TABLE content.counterparties ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.draft_versions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- content.counterparties — direct owner_org_id tenancy scope.
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users see counterparties"   ON content.counterparties;
DROP POLICY IF EXISTS tenancy_visible_select_counterparties      ON content.counterparties;
CREATE POLICY tenancy_visible_select_counterparties ON content.counterparties
  FOR SELECT
  USING (tenancy.visible(NULL::uuid, owner_org_id));

DROP POLICY IF EXISTS "Authenticated users write counterparties" ON content.counterparties;
DROP POLICY IF EXISTS tenancy_visible_write_counterparties        ON content.counterparties;
CREATE POLICY tenancy_visible_write_counterparties ON content.counterparties
  FOR ALL
  USING (tenancy.visible(NULL::uuid, owner_org_id))
  WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id));

-- ============================================================
-- content.draft_versions — tenancy scope THROUGH the parent draft (append-only).
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users see draft_versions"   ON content.draft_versions;
DROP POLICY IF EXISTS tenancy_visible_select_draft_versions      ON content.draft_versions;
CREATE POLICY tenancy_visible_select_draft_versions ON content.draft_versions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = draft_versions.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

DROP POLICY IF EXISTS "Authenticated users write draft_versions" ON content.draft_versions;
DROP POLICY IF EXISTS tenancy_visible_insert_draft_versions      ON content.draft_versions;
CREATE POLICY tenancy_visible_insert_draft_versions ON content.draft_versions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = draft_versions.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

-- Verify all four policies landed AND RLS is actually enabled on both tables
-- (a silent partial apply — or policies created while rowsecurity stayed off —
-- would re-open the black-hole this migration closes once the pool flips).
DO $$
DECLARE
  actual_count INT;
  rls_off      TEXT;
BEGIN
  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE (schemaname, tablename, policyname) IN (
    ('content', 'counterparties', 'tenancy_visible_select_counterparties'),
    ('content', 'counterparties', 'tenancy_visible_write_counterparties'),
    ('content', 'draft_versions', 'tenancy_visible_select_draft_versions'),
    ('content', 'draft_versions', 'tenancy_visible_insert_draft_versions')
  );

  IF actual_count < 4 THEN
    RAISE EXCEPTION 'Expected 4 new policies from migration 198, found %', actual_count;
  END IF;

  -- rowsecurity must be true on both tables, else the policies above are dormant
  -- (this is exactly the PGlite gap that motivated the ENABLE statements above).
  SELECT string_agg(tablename, ', ') INTO rls_off
  FROM pg_tables
  WHERE schemaname = 'content'
    AND tablename IN ('counterparties', 'draft_versions')
    AND rowsecurity = false;

  IF rls_off IS NOT NULL THEN
    RAISE EXCEPTION 'RLS not enabled after migration 198 on: %', rls_off;
  END IF;
END $$;

COMMIT;
