-- 195: DELETE-policy parity for the contract-deletion transaction.
--
-- Issue #545 (security)
-- ----------------------
-- DELETE /api/contracts/:id (src/api-routes/contracts.js) runs one
-- transaction across four tables: content.gate_log, content.send_overrides,
-- signatures.signature_requests, and content.drafts. Three of them carry
-- RLS with a SELECT-only policy; content.gate_log carries no RLS at all.
-- Today the app pool connects as the Supabase `postgres.<project>`
-- superuser, which always bypasses RLS, so every DELETE in that
-- transaction runs unrestricted. Once STAQPRO-303 PR-B flips the pool to
-- the non-superuser `autobot_agent` role (sql/001-baseline: LOGIN
-- NOINHERIT, no BYPASSRLS), any DELETE against an RLS-enabled table with
-- no applicable DELETE/ALL policy is denied by default: 0 rows affected,
-- NO error raised. The transaction still commits — a universal
-- false-positive-success no-op that leaves every row intact while the API
-- reports `{ ok: true, deleted: ... }`.
--
-- Fix: parity, not a new authorization model
-- -------------------------------------------
-- For each table that already has a SELECT policy, add a DELETE policy
-- using the IDENTICAL predicate — whatever a caller could already see,
-- they can now also delete; nothing new becomes visible or deletable.
-- Predicates are copied verbatim, not re-derived:
--   * content.drafts              — sql/190: tenancy.visible(NULL::uuid, owner_org_id)
--   * content.send_overrides      — sql/071: auth.uid() IS NOT NULL
--   * signatures.signature_requests — sql/054: created_by = auth.uid()::text
--
-- content.drafts is DELETE-only here, not FOR ALL: sql/190 deliberately
-- left INSERT/UPDATE unscoped on this table pending a full write-call-site
-- audit (agents write cross-org in agent-keyed contexts). Grepping the
-- codebase (2026-07-05) turns up exactly one `DELETE FROM content.drafts`
-- call site — this same contracts.js endpoint — so narrowing DELETE alone
-- carries no risk to those other write paths. Same reasoning applies to
-- send_overrides/signature_requests: only touch DELETE, since a FOR ALL
-- policy keyed on auth.uid() would also gate the request_id-backfill
-- UPDATE on send_overrides (contracts.js send handler), which — like the
-- DELETE endpoint — runs over a naked `query()`/`withTransaction()` with
-- no auth.uid()-populating GUC set, and would silently break the same way.
-- That is a pre-existing, separate gap (see "Residual risk" below); this
-- migration does not touch it.
--
-- content.gate_log — decision: ENABLE RLS (previously none at all)
-- -------------------------------------------------------------------
-- gate_log shipped in sql/048 with zero RLS — a real P1 (deny-by-default)
-- gap, not a deliberate carve-out. It has no owner_org_id of its own
-- (append-only rows keyed only by draft_id), so its predicate is derived
-- through its parent: a row is visible/deletable iff the content.drafts
-- row it references is tenancy-visible. This mirrors the join-through-
-- parent pattern sql/054 already uses for signers/signature_events, rather
-- than inventing a new shape or adding an owner_org_id column to gate_log.
--
-- INSERT is left permissive (WITH CHECK true), following sql/126's
-- established precedent for agent write call sites that legitimately
-- write without a resolved tenancy context. Audited call sites
-- (2026-07-05, `grep -rn "content\.gate_log" lib/ src/ agents/`):
--   * agents/executor-writer/index.js:434 — INSERT, agent-tier content
--     generation, no per-request app.org_ids GUC plumbed. Scoping INSERT
--     the same as SELECT/DELETE would 0-row-deny every gate-check write
--     the instant autobot_agent goes live.
--   * src/api-routes/content.js:79           — SELECT, board-facing read.
--   * src/api-routes/contracts.js:641         — DELETE, this endpoint.
-- No UPDATE call site exists anywhere in the codebase; no UPDATE policy is
-- added — default-deny is correct, since sql/048 documents gate_log as
-- append-only.
--
-- Residual risk (not fixed here — flagging for the record)
-- ------------------------------------------------------------
-- content.drafts, content.send_overrides, and signatures.signature_requests
-- are all read via plain `query()`/`withTransaction()` in contracts.js and
-- content.js — none of them route through withBoardScope()/withAgentScope()
-- to plumb app.user/app.org_ids (tenancy.visible) or request.jwt.claim.sub
-- (auth.uid()) into the session. Once autobot_agent is live, ALL of these
-- predicates evaluate to their fail-closed default (tenancy.visible via
-- COALESCE(...,false); auth.uid() via the local stub reading an
-- unset GUC) for every naked query — including the SELECT policies that
-- already exist today. That means the initial `SELECT ... FROM
-- content.drafts` precondition check in the DELETE handler (contracts.js:605)
-- would itself return 0 rows and 404 before ever reaching the DELETE
-- statements this migration protects. This migration restores SELECT/DELETE
-- *parity* on the RLS layer (the schema-level bug in scope for #545); wiring
-- these routes through withBoardScope so the predicates evaluate true for a
-- legitimate caller is a separate, larger change (STAQPRO-303 PR-B's remit)
-- and is out of scope here.
--
-- A second, sharper-edged residual risk sits directly downstream of that
-- GUC-plumbing fix: once withBoardScope/withAgentScope IS wired up (so
-- content.drafts' and content.gate_log's predicates evaluate true), the
-- DELETE on content.drafts still shares a transaction with
-- send_overrides_draft_id_fkey (RESTRICT, sql/071) and
-- gate_log_draft_id_fkey (RESTRICT, sql/048). auth.uid() is never set
-- anywhere in this codebase (no JWT-issuing path populates
-- request.jwt.claim.sub), so "Authenticated users delete send_overrides"
-- above never actually matches for any real caller — that DELETE always
-- 0-row-denies. If a draft has any surviving send_overrides row at that
-- point, `DELETE FROM content.drafts` hits the FK and the WHOLE
-- transaction aborts (rolling back the gate_log delete too), turning
-- today's silent no-op into a visible 500 instead of the 404 above.
-- Confirmed empirically (test/contracts-delete-rls.test.js, test 3). Fixing
-- send_overrides' dead auth.uid() predicate (or resolving the FK some other
-- way) is required before the GUC-plumbing fix can be applied safely;
-- tracked as follow-on to STAQPRO-263 PR-B, not fixed here.
--
-- Rollback
-- --------
-- DROP POLICY tenancy_visible_delete_drafts ON content.drafts;
-- DROP POLICY "Authenticated users delete send_overrides" ON content.send_overrides;
-- DROP POLICY "Board members delete their own requests" ON signatures.signature_requests;
-- DROP POLICY tenancy_visible_select_gate_log ON content.gate_log;
-- DROP POLICY tenancy_visible_delete_gate_log ON content.gate_log;
-- DROP POLICY agent_insert_gate_log ON content.gate_log;
-- ALTER TABLE content.gate_log DISABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- PGlite guard (STAQPRO-392 strict-gate compatibility)
-- ------------------------------------------------------------
-- This migration adds RLS DELETE parity across content.send_overrides and
-- signatures.signature_requests. Both cascade-skip on PGlite: the signatures
-- schema needs pgcrypto (054) and send_overrides needs the auth schema (071),
-- neither of which PGlite provides — see PGLITE_INCOMPAT_SIGNATURES in
-- lib/db.js (the migrate runner already skips 063/066/067/069/072 for the same
-- reason). RLS is not enforced on PGlite anyway (demo-only engine), so there is
-- nothing to apply there. Re-raise the already-tolerated
-- 'schema "signatures" does not exist' signature — literally true under PGlite —
-- so the runner classifies 195 as pglite-incompatible and SKIPS it wholesale,
-- rather than hard-failing on a downstream missing relation. This keeps the
-- strict-gate allowlist minimal (no lib/db.js change). No-op on real Postgres,
-- where the signatures schema always exists and the migration applies in full.
--
-- CRITICAL: this guard MUST run BEFORE `BEGIN;`. Raising inside an already-open
-- explicit transaction leaves the shared PGlite session in an aborted-txn state
-- that is never rolled back (the runner catches the error and skips the file
-- without a ROLLBACK), poisoning every subsequent query with
-- "current transaction is aborted" — which took down the whole tenancy-gucs
-- suite's before() hook under the PGlite unit lane. Running it in autocommit
-- (before BEGIN) means the failed statement rolls back cleanly on its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signatures') THEN
    RAISE EXCEPTION 'schema "signatures" does not exist';
  END IF;
END $$;

BEGIN;

-- ============================================================
-- 1. content.drafts — mirror sql/190's SELECT predicate for DELETE.
-- ============================================================

DROP POLICY IF EXISTS tenancy_visible_delete_drafts ON content.drafts;
CREATE POLICY tenancy_visible_delete_drafts ON content.drafts
  FOR DELETE USING (tenancy.visible(NULL::uuid, owner_org_id));

-- ============================================================
-- 2. content.send_overrides — mirror sql/071's SELECT predicate for DELETE.
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users delete send_overrides" ON content.send_overrides;
CREATE POLICY "Authenticated users delete send_overrides"
  ON content.send_overrides
  FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- ============================================================
-- 3. signatures.signature_requests — mirror sql/054's SELECT predicate.
-- ============================================================

DROP POLICY IF EXISTS "Board members delete their own requests" ON signatures.signature_requests;
CREATE POLICY "Board members delete their own requests"
  ON signatures.signature_requests
  FOR DELETE
  USING (created_by = auth.uid()::text);

-- ============================================================
-- 4. content.gate_log — enable RLS; SELECT + DELETE derived through the
--    parent draft's own tenancy predicate; INSERT stays permissive.
-- ============================================================

ALTER TABLE content.gate_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenancy_visible_select_gate_log ON content.gate_log;
CREATE POLICY tenancy_visible_select_gate_log ON content.gate_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = gate_log.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

DROP POLICY IF EXISTS tenancy_visible_delete_gate_log ON content.gate_log;
CREATE POLICY tenancy_visible_delete_gate_log ON content.gate_log
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = gate_log.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

DROP POLICY IF EXISTS agent_insert_gate_log ON content.gate_log;
CREATE POLICY agent_insert_gate_log ON content.gate_log
  FOR INSERT WITH CHECK (true);

-- Verify: RLS actually enabled on gate_log, and all 6 target policies
-- (3 mirrored DELETE + gate_log's SELECT/DELETE/INSERT triad) landed. A
-- silent partial apply would defeat the point of this migration.
DO $$
DECLARE
  actual_count INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'content' AND tablename = 'gate_log' AND rowsecurity = true
  ) THEN
    RAISE EXCEPTION 'content.gate_log ENABLE ROW LEVEL SECURITY did not apply';
  END IF;

  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE (schemaname, tablename, policyname) IN (
    ('content', 'drafts', 'tenancy_visible_delete_drafts'),
    ('content', 'send_overrides', 'Authenticated users delete send_overrides'),
    ('signatures', 'signature_requests', 'Board members delete their own requests'),
    ('content', 'gate_log', 'tenancy_visible_select_gate_log'),
    ('content', 'gate_log', 'tenancy_visible_delete_gate_log'),
    ('content', 'gate_log', 'agent_insert_gate_log')
  );

  IF actual_count < 6 THEN
    RAISE EXCEPTION 'Expected 6 new policies from migration 195, found %', actual_count;
  END IF;
END $$;

COMMIT;
