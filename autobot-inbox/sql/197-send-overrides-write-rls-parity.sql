-- 197: SELECT + INSERT + UPDATE RLS parity for content.send_overrides (#561).
--
-- Issue #561 (security) — the content.send_overrides half of #555
-- -----------------------------------------------------------------
-- POST /api/contracts/:id/send (src/api-routes/contracts.js) logs a
-- block-severity override, then backfills its request_id after the signing
-- request is created:
--     INSERT INTO content.send_overrides
--       (draft_id, overridden_by, override_reason, findings) VALUES (...)
--     ...
--     UPDATE content.send_overrides SET request_id = $1 WHERE id = $2
-- content.send_overrides has RLS ENABLED (sql/071) with a SELECT policy and,
-- as of sql/195, a DELETE policy — but NO INSERT and NO UPDATE policy. Both
-- of those existing policies are keyed on `auth.uid() IS NOT NULL`, which is
-- DEAD in this codebase: no path ever populates request.jwt.claim.sub, so the
-- local auth.uid() stub always returns NULL (see sql/195 residual-risk note,
-- L67-102). Today the app pool connects as the Supabase `postgres.<project>`
-- superuser, which always bypasses RLS, so both statements run unrestricted.
-- Once STAQPRO-303 PR-B flips the pool to the non-superuser `autobot_agent`
-- role (sql/001-baseline: LOGIN NOINHERIT, no BYPASSRLS):
--   * the INSERT — a command with no applicable INSERT/ALL policy — is denied
--     outright: `new row violates row-level security policy`, a hard error
--     that 500s the send;
--   * the UPDATE backfill — no applicable UPDATE/ALL policy — is denied by
--     default: 0 rows affected, NO error raised, the transaction still
--     commits. A silent false-positive-success no-op that leaves request_id
--     NULL forever while the API reports success (the handler even
--     `.catch()`es and swallows a thrown error there, so it degrades quietly
--     either way).
--
-- The SELECT policy is load-bearing too (the subtle one)
-- ------------------------------------------------------
-- It is NOT enough to add INSERT + UPDATE policies and leave the dead
-- auth.uid() SELECT policy in place. Postgres enforces a table's SELECT policy
-- IMPLICITLY, independent of whether application code ever issues a bare SELECT:
--   * `INSERT ... RETURNING <cols>` reads the just-inserted row back through the
--     SELECT policy. The send handler's audit INSERT is exactly
--     `INSERT INTO content.send_overrides (...) VALUES (...) RETURNING id`
--     (contracts.js) — so a dead SELECT policy makes even a WITH-CHECK-passing,
--     same-org INSERT fail (`new row violates row-level security policy`).
--   * `UPDATE ... WHERE id = $2` must first FIND the row; matching an existing
--     column's value applies the SELECT policy. A dead SELECT policy makes the
--     backfill match 0 rows even for the caller's own draft.
-- Net effect of an INSERT+UPDATE-only migration post-flip: EVERY block-severity
-- send 500s at the audit INSERT — a universal outage, strictly worse than the
-- cross-org-only leak this set out to fix. (Caught by the #561 real-Postgres
-- Verifier: T1 positive-INSERT and T3 positive-UPDATE both failed under a
-- MATCHING org until the SELECT policy was migrated; proven by an A/B where
-- setting the SELECT policy to USING(true) made both pass with the INSERT/UPDATE
-- predicates unchanged.) So this migration migrates the SELECT policy too, onto
-- the SAME parent-draft tenancy predicate.
--
-- Fix: parity via the parent draft, NOT the dead auth.uid() predicate
-- --------------------------------------------------------------------
-- The natural fix is NOT to add another auth.uid()-keyed policy (it would be
-- dead on arrival, same as the SELECT/DELETE ones). content.send_overrides
-- has no owner_org_id column of its own, but every row carries
-- draft_id -> content.drafts(id) (NOT NULL FK, sql/071:25), and content.drafts
-- already carries the tenancy predicate (SELECT sql/190, DELETE sql/195,
-- UPDATE sql/196): a row is visible/mutable iff its parent draft is
-- tenancy-visible. Derive the send_overrides policy through that same parent,
-- exactly as sql/195 already did for content.gate_log (its sibling
-- child-of-drafts table, L174-203):
--     EXISTS (SELECT 1 FROM content.drafts d
--             WHERE d.id = send_overrides.draft_id
--               AND tenancy.visible(NULL::uuid, d.owner_org_id))
-- Whatever draft a caller can already see, they can now log an override for
-- and backfill it; nothing new becomes visible or mutable. This reuses the
-- SAME app.org_ids GUC mechanism the DELETE handler (#562) and this send
-- handler (#561 handler change) plumb via withAgentScope — no auth.uid(), no
-- new column, no global GUC. tenancy.visible is spelled out explicitly (not
-- left implicit in content.drafts' own SELECT RLS on the subquery) so the
-- predicate holds even if that RLS were ever bypassed — belt and suspenders,
-- matching sql/195's gate_log policies verbatim.
--
-- SELECT takes USING (a row is visible iff its parent draft is visible) — this
-- is what makes INSERT ... RETURNING and UPDATE ... WHERE work (see above), and
-- it is the correct standalone tenancy rule for any future direct read.
-- INSERT takes only WITH CHECK (the new row's parent draft must be visible).
-- UPDATE takes USING (the pre-image's parent must be visible) AND WITH CHECK
-- (the post-image's parent must still be visible) — all three the SAME
-- predicate, the tightest parity choice (P1). draft_id is immutable anyway
-- (trg_send_overrides_immutable, sql/071:57 raises on any draft_id change), so
-- the post-image draft_id always equals the pre-image's; the WITH CHECK is a
-- second, independent guard, not a redundant one.
--
-- Complementary, not overlapping, with the immutability trigger
-- ------------------------------------------------------------
-- trg_send_overrides_immutable (sql/071) still enforces write-once semantics
-- on TOP of RLS: RLS answers "may this caller touch a row for this draft?"
-- (tenancy); the trigger answers "may ANY caller change more than request_id
-- NULL->non-NULL?" (immutability). The backfill UPDATE must pass BOTH — the
-- new UPDATE policy (tenancy) and the trigger (only request_id, only once).
-- Both are load-bearing; neither subsumes the other.
--
-- Scope: send_overrides SELECT + INSERT + UPDATE (NOT DELETE)
-- ----------------------------------------------------------
-- The dead auth.uid()-keyed SELECT policy (sql/071, "Authenticated users see
-- send_overrides") IS migrated here — it is replaced (DROP + CREATE) with the
-- parent-draft tenancy predicate. An earlier cut of this migration deliberately
-- left it in place, reasoning "no bare-SELECT call site exists, so the dead
-- policy is harmless" — that reasoning was WRONG (see "The SELECT policy is
-- load-bearing too" above): RETURNING and UPDATE ... WHERE invoke the SELECT
-- policy at the Postgres level even though the handler never issues a bare
-- SELECT, so leaving it dead would 500 every same-org send post-flip.
--
-- The DELETE policy is the one thing still NOT migrated:
--   * The DELETE path is entangled with trg_send_overrides_immutable, which
--     raises on EVERY delete (send_overrides is append-only audit by design,
--     D4). Whether a contract deletion may remove its override log is a
--     product/audit-design question owned by #545, not a tenancy-parity fix.
--     This migration does not touch it — the dead auth.uid() DELETE policy
--     (sql/195) stays as-is.
--   * Post-flip, a tenant's DELETE is still hard-blocked, but by RLS
--     default-deny, NOT by the trigger: with no applicable DELETE-command
--     policy, RLS makes the row invisible to the DELETE's implicit row-match
--     BEFORE the BEFORE-DELETE trigger can fire, so the attempt is a silent
--     `DELETE 0` no-op (the row survives; verified — no data loss, no
--     cross-tenant leak). The write-once invariant therefore holds either way;
--     it is only the failure MODE that differs (silent no-op now vs. the
--     trigger's loud raise once #545 adds an explicit DELETE policy). Flagged
--     here so the silence isn't mistaken for the trigger doing the blocking.
--
-- PGlite: pre-BEGIN skip guard REQUIRED (contrast sql/196)
-- --------------------------------------------------------
-- content.send_overrides only exists on real Postgres. sql/071 creates it with
-- an auth.uid()-based SELECT policy, so the migrate runner hard-fails 071 under
-- PGlite ('schema "auth" does not exist') and SKIPS it — the table is never
-- created there (lib/db.js:329-336,364; PGLITE_INCOMPAT_SIGNATURES lists the
-- auth-schema signature that cascades from 070/071/073). A CREATE POLICY ON
-- content.send_overrides here would therefore raise
-- 'relation "content.send_overrides" does not exist' under PGlite — a NEW error
-- string the runner does NOT tolerate, hard-failing the whole migrate lane.
-- So we re-raise the ALREADY-tolerated 'schema "auth" does not exist' signature
-- (literally true under PGlite, and the exact reason send_overrides is absent),
-- causing the runner to classify 197 as pglite-incompatible and SKIP it
-- wholesale — same technique sql/195 uses for the signatures schema. No-op on
-- real Postgres, where the auth schema always exists and the migration applies
-- in full.
--
-- CRITICAL: this guard MUST run BEFORE `BEGIN;`. Raising inside an already-open
-- explicit transaction leaves the shared PGlite session in an aborted-txn state
-- that is never rolled back (the runner catches the error and skips the file
-- without a ROLLBACK), poisoning every subsequent query. Running it in
-- autocommit (before BEGIN) means the failed statement rolls back cleanly on
-- its own. See sql/195 L130-136.
--
-- Rollback
-- --------
-- DROP POLICY tenancy_visible_select_send_overrides ON content.send_overrides;
-- DROP POLICY tenancy_visible_insert_send_overrides ON content.send_overrides;
-- DROP POLICY tenancy_visible_update_send_overrides ON content.send_overrides;
-- CREATE POLICY "Authenticated users see send_overrides"
--   ON content.send_overrides FOR SELECT USING (auth.uid() IS NOT NULL);
--   -- (restores the sql/071 dead policy; harmless — superuser bypasses RLS today)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    RAISE EXCEPTION 'schema "auth" does not exist';
  END IF;
END $$;

BEGIN;

-- ============================================================
-- content.send_overrides — derive SELECT/INSERT/UPDATE visibility through the
-- parent draft's tenancy predicate, mirroring sql/195's gate_log policies.
-- ============================================================

-- Replace the DEAD auth.uid() SELECT policy (sql/071) with the parent-draft
-- tenancy predicate. This is load-bearing for INSERT ... RETURNING and
-- UPDATE ... WHERE, not just for direct reads (see header). DROP IF EXISTS keeps
-- this idempotent even if sql/071's policy was renamed/removed upstream.
DROP POLICY IF EXISTS "Authenticated users see send_overrides" ON content.send_overrides;
DROP POLICY IF EXISTS tenancy_visible_select_send_overrides ON content.send_overrides;
CREATE POLICY tenancy_visible_select_send_overrides ON content.send_overrides
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = send_overrides.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

DROP POLICY IF EXISTS tenancy_visible_insert_send_overrides ON content.send_overrides;
CREATE POLICY tenancy_visible_insert_send_overrides ON content.send_overrides
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = send_overrides.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

DROP POLICY IF EXISTS tenancy_visible_update_send_overrides ON content.send_overrides;
CREATE POLICY tenancy_visible_update_send_overrides ON content.send_overrides
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = send_overrides.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = send_overrides.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id)
    )
  );

-- Verify all three policies landed. A silent partial apply would defeat the
-- point of this migration: a missing SELECT policy 500s every same-org send via
-- RETURNING, a missing INSERT policy hard-denies, a missing UPDATE policy keeps
-- 0-row-denying the backfill — all after the pool flip.
DO $$
DECLARE
  actual_count INT;
BEGIN
  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE (schemaname, tablename, policyname) IN (
    ('content', 'send_overrides', 'tenancy_visible_select_send_overrides'),
    ('content', 'send_overrides', 'tenancy_visible_insert_send_overrides'),
    ('content', 'send_overrides', 'tenancy_visible_update_send_overrides')
  );

  IF actual_count < 3 THEN
    RAISE EXCEPTION 'Expected 3 new policies from migration 197, found %', actual_count;
  END IF;
END $$;

COMMIT;
