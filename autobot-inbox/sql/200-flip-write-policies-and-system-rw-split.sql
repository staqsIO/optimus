-- 200: system-scope read/write split (V-9 close) + operational read+write
--       coverage + org-scoped writes on the mig-190 SELECT-only tables.
--       (STAQPRO-263 / OPT-166 pool-flip remediation, P1.)
--
-- Architecture (the correctness contract this migration implements)
-- -------------------------------------------------------------------
-- System-scope = OPERATIONAL read+write, TENANT-CRM read-ONLY:
--   * Operational  (agent_graph.work_items, task_events, llm_invocations,
--     inbox.messages) — tenancy.is_system() grants READ **and** WRITE. These
--     are task-graph plumbing; the always-on runtime actor legitimately
--     drives them with no human/org context.
--   * Tenant-CRM   (content.counterparties, draft_versions, send_overrides,
--     gate_log, content.drafts, content.documents, signal.contacts,
--     signal.briefings, signal.organizations, inbox.signals,
--     inbox.human_tasks, agent_graph.signals, agent_graph.campaigns) —
--     is_system() grants READ ONLY. WRITES require an org-scoped principal
--     (Tiers 1-3 of tenancy.visible(): app.user / app.org_ids / federation),
--     NEVER the bare system actor. This closes the flip-readiness-smoke V-9
--     gap where a system-scoped cross-org INSERT into content.counterparties
--     wrongly succeeded.
--
-- Implementation: tenancy.visible(..., allow_system) WITHOUT a default
-- -------------------------------------------------------------------
-- The natural encoding is a boolean parameter on tenancy.visible() that
-- toggles the is_system() branch. The obvious spelling —
--   tenancy.visible(row_owner_user uuid, row_owner_org uuid,
--                    allow_system boolean DEFAULT true)
-- — is a Postgres footgun: PostgreSQL already has a distinct 2-arg
-- tenancy.visible(uuid,uuid) (sql/199). Adding a 3rd DEFAULTED parameter
-- creates two candidate functions for any 2-argument call (the true 2-arg
-- function, and the 3-arg function with its default filled in) and
-- PostgreSQL raises "function tenancy.visible(uuid, uuid) is not unique" —
-- breaking EVERY existing 2-arg call site (all of sql/190's 11 SELECT
-- policies, plus counterparties/draft_versions/send_overrides/gate_log SELECT
-- policies) the instant this migration lands. Verified against the Postgres
-- function-resolution rules (an exact-arity match and a defaulted-arity match
-- at the same effective arity are ambiguous, not preferentially resolved).
--
-- Fix: make allow_system REQUIRED on the 3-arg overload (no default), and
-- keep the 2-arg function as a thin wrapper that calls the 3-arg version
-- with true. Two arguments now match ONLY the 2-arg function (exact arity,
-- no ambiguity); three arguments match ONLY the 3-arg function. Existing
-- 2-arg call sites are UNTOUCHED in behavior (still is_system()-inclusive
-- read); new write policies call the 3-arg form explicitly with `false`.
-- CREATE OR REPLACE on the 2-arg signature is a true in-place replace (same
-- signature, same OID) — zero risk to the ~15 policies that already depend
-- on it; no DROP FUNCTION, no cascade.
--
-- Idioms followed (sql/198/199/190)
-- ----------------------------------
-- * Self-enable RLS immediately before (re)creating a policy on a table
--   this migration newly grants WRITE on, so a PGlite session that never
--   saw the owning migration's ENABLE cannot leave a dormant write policy
--   masquerading as enforced (mig198's false-green lesson). All 8 Part-4
--   tables and content.drafts already had RLS enabled by mig190/195/196
--   (which ran on both engines, no auth-schema dependency) — these ENABLE
--   statements are therefore idempotent no-ops on both engines, landed
--   defensively rather than because a gap is known to exist.
-- * COALESCE(...,false) keeps every predicate a total boolean (the
--   tenancy.is_system() idiom) — a NULL GUC never reads as "unrestricted".
-- * ALTER POLICY (not DROP+CREATE) for additive is_system()/allow_system
--   changes to EXISTING policies — it hard-fails if the named policy is
--   missing (no silent no-op), and preserves the policy's identity/name
--   across the change, matching "ADD to, don't replace" for the
--   current_agent_id() branches per the coordinator's brief.
--
-- Inert until the flip
-- ---------------------
-- The pool still connects as the RLS-bypassing superuser (STAQPRO-263 has
-- not flipped). Every statement below is dormant until AUTOBOT_AGENT_DB_PASSWORD
-- is set and the flip lands — this migration changes zero runtime behavior
-- today, same posture as sql/190/195-199.
--
-- Rollback
-- --------
-- Part 1: DROP FUNCTION tenancy.visible(uuid, uuid, boolean);
--         (2-arg tenancy.visible reverts to a direct body — see sql/199 —
--          rather than the thin wrapper; not required for correctness, the
--          wrapper is harmless to leave in place.)
-- Part 2: ALTER POLICY agent_update_work_items  ON agent_graph.work_items
--           USING (assigned_to = agent_graph.current_agent_id() OR current_setting('app.role', true) = 'board');
--         ALTER POLICY agent_read_events        ON agent_graph.task_events
--           USING (target_agent_id = agent_graph.current_agent_id() OR current_setting('app.role', true) = 'board');
--         ALTER POLICY agent_read_invocations   ON agent_graph.llm_invocations
--           USING (agent_id = agent_graph.current_agent_id() OR current_setting('app.role', true) = 'board');
--         DROP POLICY system_insert_invocations ON agent_graph.llm_invocations;
--         DROP POLICY system_insert_messages    ON inbox.messages;
-- Part 3: ALTER POLICY tenancy_visible_write_counterparties ON content.counterparties
--           USING (tenancy.visible(NULL::uuid, owner_org_id)) WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id));
--         ALTER POLICY tenancy_visible_insert_draft_versions ON content.draft_versions
--           WITH CHECK (EXISTS (SELECT 1 FROM content.drafts d WHERE d.id = draft_versions.draft_id AND tenancy.visible(NULL::uuid, d.owner_org_id)));
--         ALTER POLICY tenancy_visible_insert_send_overrides ON content.send_overrides
--           WITH CHECK (EXISTS (SELECT 1 FROM content.drafts d WHERE d.id = send_overrides.draft_id AND tenancy.visible(NULL::uuid, d.owner_org_id)));
--         ALTER POLICY tenancy_visible_update_send_overrides ON content.send_overrides
--           USING (EXISTS (SELECT 1 FROM content.drafts d WHERE d.id = send_overrides.draft_id AND tenancy.visible(NULL::uuid, d.owner_org_id)))
--           WITH CHECK (EXISTS (SELECT 1 FROM content.drafts d WHERE d.id = send_overrides.draft_id AND tenancy.visible(NULL::uuid, d.owner_org_id)));
--         ALTER POLICY tenancy_visible_delete_gate_log ON content.gate_log
--           USING (EXISTS (SELECT 1 FROM content.drafts d WHERE d.id = gate_log.draft_id AND tenancy.visible(NULL::uuid, d.owner_org_id)));
--         ALTER POLICY tenancy_visible_delete_drafts ON content.drafts
--           USING (tenancy.visible(NULL::uuid, owner_org_id));
--         ALTER POLICY tenancy_visible_update_drafts ON content.drafts
--           USING (tenancy.visible(NULL::uuid, owner_org_id)) WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id));
--         DROP POLICY tenancy_visible_insert_drafts ON content.drafts;
-- Part 4: DROP POLICY tenancy_visible_write_<table> ON <table>; for each of
--         signal.contacts, content.documents, inbox.signals,
--         inbox.human_tasks, signal.briefings, signal.organizations,
--         agent_graph.signals, agent_graph.campaigns.
--
-- Explicit exception (documented, not a bug)
-- -------------------------------------------
-- content.gate_log's agent_insert_gate_log (sql/195) is WITH CHECK (true) —
-- unconditionally permissive, not keyed on tenancy.visible() at all. It is
-- NOT narrowed here: sql/195 documents a live, audited agent-tier write
-- call site (agents/executor-writer/index.js:434) with no per-request
-- app.org_ids GUC plumbed; requiring an org-scoped principal would 0-row-deny
-- every gate-check write the instant autobot_agent goes live — a production
-- outage, not a fix. Tightening this predicate requires the write-call-site
-- audit sql/195 explicitly deferred; out of scope for this migration.

BEGIN;

-- ============================================================
-- Part 1 — tenancy.visible(allow_system) split (V-9 predicate).
-- ============================================================

-- 3-arg overload: allow_system is REQUIRED (no default — see header for why
-- a default here is a Postgres ambiguity footgun). Body is sql/199's
-- tenancy.visible verbatim, with the is_system() branch gated by allow_system.
CREATE OR REPLACE FUNCTION tenancy.visible(
  row_owner_user UUID,
  row_owner_org  UUID,
  allow_system   BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog
AS $$
  SELECT COALESCE(
    (allow_system AND tenancy.is_system())
    OR row_owner_user = NULLIF(current_setting('app.user', true), '')::uuid
    OR row_owner_org = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
    OR EXISTS (
      SELECT 1 FROM tenancy.federation_grants g
      WHERE g.grantee_org_id = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
        AND g.grantor_org_id = row_owner_org
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
    )
  , false);
$$;

-- 2-arg function: TRUE IN-PLACE REPLACE (same signature/OID as sql/199) —
-- delegates to the 3-arg form with allow_system = true. Every existing
-- policy that calls tenancy.visible(x, y) keeps resolving to this same
-- function object; behavior is byte-identical to sql/199 (is_system()
-- always included). No DROP, no cascade, no dependent-policy risk.
CREATE OR REPLACE FUNCTION tenancy.visible(
  row_owner_user UUID,
  row_owner_org  UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog
AS $$
  SELECT tenancy.visible(row_owner_user, row_owner_org, true);
$$;

-- ============================================================
-- Part 2 — operational coverage: is_system() grants READ + WRITE.
-- Additive OR-branches on top of the existing current_agent_id()/board
-- branches — nothing already granted is narrowed.
-- ============================================================

ALTER TABLE agent_graph.work_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.task_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.llm_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox.messages              ENABLE ROW LEVEL SECURITY;

-- work_items UPDATE (sql/001-baseline: agent_update_work_items).
ALTER POLICY agent_update_work_items ON agent_graph.work_items
  USING (
    assigned_to = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
    OR tenancy.is_system()
  );

-- task_events SELECT (sql/001-baseline: agent_read_events).
ALTER POLICY agent_read_events ON agent_graph.task_events
  USING (
    target_agent_id = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
    OR tenancy.is_system()
  );

-- llm_invocations SELECT (sql/001-baseline: agent_read_invocations).
ALTER POLICY agent_read_invocations ON agent_graph.llm_invocations
  USING (
    agent_id = agent_graph.current_agent_id()
    OR current_setting('app.role', true) = 'board'
    OR tenancy.is_system()
  );

-- llm_invocations INSERT — NEW permissive-OR policy admitting is_system(),
-- left alongside sql/123's agent_insert_invocations (agent_id match / board)
-- rather than editing it, per the coordinator's "new INSERT policy" brief.
DROP POLICY IF EXISTS system_insert_invocations ON agent_graph.llm_invocations;
CREATE POLICY system_insert_invocations ON agent_graph.llm_invocations
  FOR INSERT WITH CHECK (tenancy.is_system());

-- inbox.messages INSERT — NO INSERT policy exists today (Landmine A: under
-- FORCE RLS, sql/126, an INSERT with no applicable policy hard-denies).
-- owner_org_id carries a DB DEFAULT (Staqs org, sql/138), so a system-scope
-- INSERT that omits it still lands a valid, non-NULL owner_org_id row —
-- this policy authorizes purely on role, not on the (already-defaulted)
-- owner_org_id value, matching the operational (role-gated, not org-gated)
-- posture for this table.
DROP POLICY IF EXISTS system_insert_messages ON inbox.messages;
CREATE POLICY system_insert_messages ON inbox.messages
  FOR INSERT WITH CHECK (tenancy.is_system());

-- ============================================================
-- Part 3 — tenant-CRM write-predicate repoint (V-9 close).
-- Every write policy below moves from the 2-arg (system-inclusive) call to
-- the 3-arg allow_system=false call. Their SELECT/read policies are left
-- untouched (still 2-arg, still system-inclusive read).
-- ============================================================

-- Self-enable RLS on the two conditionally-present contract tables (the mig198
-- false-green guard idiom): on real Postgres this is idempotent (sql/195 + sql/197
-- already enabled it); on PGlite, gate_log exists but its RLS-enable lived only in
-- the skipped sql/195, so without this the Part-5 rowsecurity assertion trips.
-- send_overrides is ABSENT on PGlite (sql/071/197 skipped) → table-existence guard
-- so we never ALTER a missing table; the Part-5 check excludes absent tables anyway.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'content' AND tablename = 'gate_log') THEN
    ALTER TABLE content.gate_log ENABLE ROW LEVEL SECURITY;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'content' AND tablename = 'send_overrides') THEN
    ALTER TABLE content.send_overrides ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- content.counterparties — sql/198's FOR ALL write policy.
ALTER POLICY tenancy_visible_write_counterparties ON content.counterparties
  USING (tenancy.visible(NULL::uuid, owner_org_id, false))
  WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id, false));

-- content.draft_versions — sql/198's INSERT-only write policy (append-only).
ALTER POLICY tenancy_visible_insert_draft_versions ON content.draft_versions
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM content.drafts d
      WHERE d.id = draft_versions.draft_id
        AND tenancy.visible(NULL::uuid, d.owner_org_id, false)
    )
  );

-- content.send_overrides — sql/197's INSERT + UPDATE (SELECT stays system-inclusive).
-- PGlite portability: send_overrides + these policies are created by sql/071 +
-- sql/197, both of which depend on the Supabase `auth` schema and are therefore
-- PGlite-skipped — the table AND its policies are ABSENT on PGlite. Guard each
-- ALTER behind a policy-existence check (pg_policies) so mig 200's PGlite-compatible
-- policies (drafts, counterparties, mig-190 tables, operational) still apply, while
-- these no-op on PGlite. On real Postgres the policies exist → the IF is TRUE → both
-- ALTERs run exactly as before (behavior byte-identical to the unguarded form the
-- sensor + Verifier proved). Policy-existence (not table-existence) is the precise
-- guard: gate_log below shows the table can exist while its policy does not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'content' AND tablename = 'send_overrides' AND policyname = 'tenancy_visible_insert_send_overrides') THEN
    ALTER POLICY tenancy_visible_insert_send_overrides ON content.send_overrides
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM content.drafts d
          WHERE d.id = send_overrides.draft_id
            AND tenancy.visible(NULL::uuid, d.owner_org_id, false)
        )
      );
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'content' AND tablename = 'send_overrides' AND policyname = 'tenancy_visible_update_send_overrides') THEN
    ALTER POLICY tenancy_visible_update_send_overrides ON content.send_overrides
      USING (
        EXISTS (
          SELECT 1 FROM content.drafts d
          WHERE d.id = send_overrides.draft_id
            AND tenancy.visible(NULL::uuid, d.owner_org_id, false)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM content.drafts d
          WHERE d.id = send_overrides.draft_id
            AND tenancy.visible(NULL::uuid, d.owner_org_id, false)
        )
      );
  END IF;
END $$;

-- content.gate_log — sql/195's DELETE (SELECT stays system-inclusive; the
-- permissive INSERT is the documented exception above, untouched).
-- PGlite portability: the gate_log TABLE exists on PGlite (created by an earlier
-- compatible migration), but its DELETE policy tenancy_visible_delete_gate_log is
-- created by sql/195 (`signatures` schema → PGlite-skipped), so the POLICY is
-- ABSENT on PGlite even though the table is present. Guard on policy-existence
-- (not table-existence): no-op on PGlite, runs unchanged on real Postgres.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'content' AND tablename = 'gate_log' AND policyname = 'tenancy_visible_delete_gate_log') THEN
    ALTER POLICY tenancy_visible_delete_gate_log ON content.gate_log
      USING (
        EXISTS (
          SELECT 1 FROM content.drafts d
          WHERE d.id = gate_log.draft_id
            AND tenancy.visible(NULL::uuid, d.owner_org_id, false)
        )
      );
  END IF;
END $$;

-- content.drafts — sql/195's DELETE + sql/196's UPDATE repointed; NEW INSERT
-- added (drafts had no INSERT policy at all pre-200). SELECT (sql/190) stays
-- system-inclusive. PGlite portability: the drafts TABLE + its UPDATE policy
-- (sql/196, PGlite-compatible) exist, but the DELETE policy
-- tenancy_visible_delete_drafts is created by sql/195 (`signatures` schema →
-- PGlite-skipped), so it is ABSENT on PGlite. Guard both repoints on
-- policy-existence (pg_policies): no-op on PGlite for any policy a skipped
-- migration never created, run unchanged on real Postgres where all exist.
ALTER TABLE content.drafts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'content' AND tablename = 'drafts' AND policyname = 'tenancy_visible_delete_drafts') THEN
    ALTER POLICY tenancy_visible_delete_drafts ON content.drafts
      USING (tenancy.visible(NULL::uuid, owner_org_id, false));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'content' AND tablename = 'drafts' AND policyname = 'tenancy_visible_update_drafts') THEN
    ALTER POLICY tenancy_visible_update_drafts ON content.drafts
      USING (tenancy.visible(NULL::uuid, owner_org_id, false))
      WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id, false));
  END IF;
END $$;

DROP POLICY IF EXISTS tenancy_visible_insert_drafts ON content.drafts;
CREATE POLICY tenancy_visible_insert_drafts ON content.drafts
  FOR INSERT WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id, false));

-- ============================================================
-- Part 4 — org-scoped writes on the remaining mig-190 SELECT-only tables.
-- (content.drafts handled explicitly above since it already carried partial
-- write policies; these 8 had none.) FOR ALL, allow_system=false — a
-- legitimate org-scoped (board/agent-with-org) principal may write its own
-- org's rows; system may still READ them via the unchanged mig-190 SELECT
-- policy.
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  pol TEXT;
  tables TEXT[] := ARRAY[
    'signal.contacts',
    'inbox.signals',
    'inbox.human_tasks',
    'signal.briefings',
    'agent_graph.signals',
    'agent_graph.campaigns',
    'content.documents',
    'signal.organizations'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    pol := 'tenancy_visible_write_' || split_part(tbl, '.', 2);

    -- Idempotent no-op on both engines (mig190 already enabled RLS on all
    -- 8 of these; landed defensively per the self-enable idiom).
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %s FOR ALL '
      || 'USING (tenancy.visible(NULL::uuid, owner_org_id, false)) '
      || 'WITH CHECK (tenancy.visible(NULL::uuid, owner_org_id, false))',
      pol, tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Verification — hard-fail the migration on any silent partial apply.
-- ============================================================
DO $$
DECLARE
  actual_count INT;
  rls_off      TEXT;
  v_org        UUID := '11111111-1111-1111-1111-111111111111';
  v_other_org  UUID := '22222222-2222-2222-2222-222222222222';
BEGIN
  -- 1. Part 4's 8 new FOR ALL write policies landed.
  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE policyname LIKE 'tenancy_visible_write_%'
    AND (schemaname, tablename) IN (
      ('signal', 'contacts'), ('inbox', 'signals'), ('inbox', 'human_tasks'),
      ('signal', 'briefings'), ('agent_graph', 'signals'),
      ('agent_graph', 'campaigns'), ('content', 'documents'),
      ('signal', 'organizations'), ('content', 'counterparties')
    );
  IF actual_count < 9 THEN
    RAISE EXCEPTION 'migration 200: expected >= 9 tenancy_visible_write_* policies, found %', actual_count;
  END IF;

  -- 2. content.drafts' new INSERT policy landed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'content' AND tablename = 'drafts'
      AND policyname = 'tenancy_visible_insert_drafts'
  ) THEN
    RAISE EXCEPTION 'migration 200: tenancy_visible_insert_drafts did not apply';
  END IF;

  -- 3. Operational new policies landed.
  SELECT count(*) INTO actual_count
  FROM pg_policies
  WHERE (schemaname, tablename, policyname) IN (
    ('agent_graph', 'llm_invocations', 'system_insert_invocations'),
    ('inbox', 'messages', 'system_insert_messages')
  );
  IF actual_count < 2 THEN
    RAISE EXCEPTION 'migration 200: expected 2 new operational policies, found %', actual_count;
  END IF;

  -- 4. RLS actually enabled on every table this migration touches (the
  -- mig198 false-green guard).
  SELECT string_agg(schemaname || '.' || tablename, ', ') INTO rls_off
  FROM pg_tables
  WHERE (schemaname, tablename) IN (
    ('agent_graph', 'work_items'), ('agent_graph', 'task_events'),
    ('agent_graph', 'llm_invocations'), ('inbox', 'messages'),
    ('content', 'counterparties'), ('content', 'draft_versions'),
    ('content', 'send_overrides'), ('content', 'gate_log'),
    ('content', 'drafts'), ('signal', 'contacts'), ('inbox', 'signals'),
    ('inbox', 'human_tasks'), ('signal', 'briefings'),
    ('agent_graph', 'signals'), ('agent_graph', 'campaigns'),
    ('content', 'documents'), ('signal', 'organizations')
  )
  AND rowsecurity = false;
  IF rls_off IS NOT NULL THEN
    RAISE EXCEPTION 'migration 200: RLS not enabled on: %', rls_off;
  END IF;

  -- 5. Predicate sanity — simulate GUCs, no real rows required.
  --    5a. 2-arg call: is_system() alone (no org match) must still read TRUE
  --        (system-inclusive read is unchanged behavior).
  PERFORM set_config('app.role', 'system', true);
  PERFORM set_config('app.user', '', true);
  PERFORM set_config('app.org_ids', '', true);
  IF tenancy.visible(NULL::uuid, v_other_org) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'migration 200: 2-arg tenancy.visible() must stay system-inclusive';
  END IF;

  --    5b. 3-arg call with allow_system=false: is_system() alone, no org
  --        match, must now read FALSE (the V-9 close).
  IF tenancy.visible(NULL::uuid, v_other_org, false) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'migration 200: 3-arg tenancy.visible(...,false) must exclude bare is_system()';
  END IF;

  --    5c. 3-arg call with allow_system=false: an org-matched principal
  --        (not system) must still read TRUE — org-scoped writes still work.
  PERFORM set_config('app.role', 'agent', true);
  PERFORM set_config('app.org_ids', v_org::text, true);
  IF tenancy.visible(NULL::uuid, v_org, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'migration 200: 3-arg tenancy.visible(...,false) must still allow org-matched writes';
  END IF;

  --    5d. Cross-org: org-scoped principal against a DIFFERENT org must
  --        still read FALSE even with allow_system=false.
  IF tenancy.visible(NULL::uuid, v_other_org, false) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'migration 200: 3-arg tenancy.visible(...,false) must deny cross-org';
  END IF;

  -- Reset GUCs so this DO block leaves no residue in the migration's txn-local session.
  PERFORM set_config('app.role', '', true);
  PERFORM set_config('app.user', '', true);
  PERFORM set_config('app.org_ids', '', true);
END $$;

COMMIT;
