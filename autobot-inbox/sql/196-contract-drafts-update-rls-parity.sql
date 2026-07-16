-- 196: UPDATE-policy parity for content.drafts (STAQPRO-303 PR-B, #555).
--
-- Issue #555 (security) — the content.drafts half
-- ------------------------------------------------
-- DELETE /api/contracts/:id (src/api-routes/contracts.js) runs a
-- transaction that, among other statements, executes:
--     UPDATE content.drafts SET source_draft_id = NULL WHERE source_draft_id = $1
-- to detach any child drafts before the parent is removed. content.drafts
-- carries RLS with a SELECT policy (sql/190) and, as of sql/195, a DELETE
-- policy — but no UPDATE policy. Today the app pool connects as the Supabase
-- `postgres.<project>` superuser, which always bypasses RLS, so this UPDATE
-- runs unrestricted. Once STAQPRO-303 PR-B flips the pool to the
-- non-superuser `autobot_agent` role (sql/001-baseline: LOGIN NOINHERIT, no
-- BYPASSRLS), an UPDATE against an RLS-enabled table with no applicable
-- UPDATE/ALL policy is denied by default: 0 rows affected, NO error raised.
-- The transaction still commits — a silent false-positive-success no-op that
-- leaves the child drafts pointing at a now-deleted parent while the API
-- reports `{ ok: true }`.
--
-- Fix: parity, not a new authorization model
-- -------------------------------------------
-- content.drafts already has a SELECT policy (sql/190) and a DELETE policy
-- (sql/195), both USING the same predicate. Add the UPDATE policy with the
-- IDENTICAL predicate, copied verbatim (sql/190:96, sql/195:152):
--     tenancy.visible(NULL::uuid, owner_org_id)
-- Whatever a caller could already see and delete, they can now also update;
-- nothing new becomes visible or mutable. Unlike a SELECT/DELETE policy, an
-- UPDATE policy takes both USING (the pre-image must be visible) and
-- WITH CHECK (the post-image must remain in scope). We set WITH CHECK to the
-- SAME predicate as USING: a caller may not UPDATE a row into an org it
-- cannot see (e.g. re-homing owner_org_id to another tenant). This is the
-- tightest parity choice and matches the deny-by-default principle (P1).
--
-- Scope: content.drafts only, UPDATE only. The #555 transaction also touches
-- a write-once request_id backfill on content.send_overrides (contracts.js
-- send handler). That statement's RLS twin is keyed on auth.uid(), which is
-- never populated in this codebase (no path sets request.jwt.claim.sub), so a
-- parity UPDATE policy there would be dead weight — the backfill still
-- silently no-ops after the flip. Fixing it requires plumbing
-- request.jwt.claim.sub through setAgentContext AND flipping the CI auth.uid()
-- stub, a cross-tier change tracked separately as #561. This migration does
-- not touch send_overrides. See sql/195 residual-risk note (L86-102).
--
-- PGlite: no skip guard needed (contrast sql/195)
-- -----------------------------------------------
-- sql/195 guards itself out on PGlite because its DELETE parity spans the
-- signatures schema (needs pgcrypto, sql/054) and content.send_overrides
-- (needs the auth schema, sql/071) — neither of which PGlite provides
-- (PGLITE_INCOMPAT_SIGNATURES, lib/db.js). THIS migration references only
-- content.drafts (present under PGlite) and tenancy.visible (created in
-- sql/133, present under PGlite — the tenancy-gucs suite calls it directly on
-- the PGlite lane). It is fully PGlite-compatible: the policy DDL applies in
-- both environments, exactly like sql/190's SELECT policy on the same table.
-- RLS is not *enforced* under PGlite (demo-only engine, superuser-equivalent),
-- but the policy row lands in pg_policies either way. Adding a false skip
-- guard here would wrongly suppress the policy on PGlite and lie about which
-- schemas the migration touches — so there is deliberately no guard.
--
-- Rollback
-- --------
-- DROP POLICY tenancy_visible_update_drafts ON content.drafts;

BEGIN;

-- ============================================================
-- content.drafts — mirror sql/190's SELECT / sql/195's DELETE predicate
-- for UPDATE, on both the pre-image (USING) and post-image (WITH CHECK).
-- ============================================================

DROP POLICY IF EXISTS tenancy_visible_update_drafts ON content.drafts;
CREATE POLICY tenancy_visible_update_drafts ON content.drafts
  FOR UPDATE
  USING (tenancy.visible(NULL::uuid, owner_org_id))
  WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id));

-- Verify the policy landed. A silent partial apply would defeat the point of
-- this migration (the UPDATE would keep 0-row-denying after the pool flip).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'content'
      AND tablename  = 'drafts'
      AND policyname = 'tenancy_visible_update_drafts'
  ) THEN
    RAISE EXCEPTION 'migration 196: tenancy_visible_update_drafts did not apply';
  END IF;
END $$;

COMMIT;
