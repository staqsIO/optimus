-- 194: GRANT USAGE ON SCHEMA audit TO autobot_agent (+ table/view/sequence
--      grants) — closes the grant gap left by sql/188.
--
-- Why this exists
-- ---------------
-- sql/188-shared-doc-retrieval-audit.sql created `CREATE SCHEMA audit` plus
-- `audit.shared_doc_retrievals` (table) and `audit.shared_doc_retrievals_daily`
-- (view), but — unlike every other schema introduced since sql/147's
-- grant-completeness pass — never granted the non-superuser `autobot_agent`
-- role USAGE on the new schema. Two live call sites hit this gap under the
-- autobot_agent pool:
--   * lib/rag/share-retrieval-audit.js recordSharedDocHit() — fire-and-forget
--     INSERT into audit.shared_doc_retrievals on every RAG retrieval that
--     surfaced a cross-org shared chunk.
--   * src/api-routes/sharing.js GET /api/sharing/metrics — SELECTs from
--     audit.shared_doc_retrievals_daily for the usage/top-grants panels.
-- Both currently raise `permission denied for schema audit` once the pool
-- flips off the Supabase superuser (STAQPRO-263 PR-B). sharing.js's read path
-- only swallows "relation does not exist" errors (see its try/catch), not
-- "permission denied", so this is a live 500 risk on that flip, not just a
-- test-time schema-contract failure (STAQPRO-243 / issue #533 finding #4).
--
-- Design mirrors sql/147 exactly: guarded on autobot_agent existing (no-op
-- under PGlite/test where the role is absent), guarded per-schema/table
-- existence, EXCEPTION handler so a grant edge case never crash-loops a
-- deploy.
--
-- Append-only carve-out
-- ----------------------
-- audit.shared_doc_retrievals is, by its own header comment in sql/188,
-- "Append-only. Rows are insert-only — never updated, never deleted." We
-- grant SELECT + INSERT only — no UPDATE, no DELETE — matching the same
-- append-only posture sql/147 already enforces for agent_graph/inbox audit
-- tables. The view is read-only by construction (SELECT only).
--
-- Rollback
-- --------
-- REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM autobot_agent;
-- REVOKE ALL ON SCHEMA audit FROM autobot_agent;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE SELECT, INSERT ON TABLES FROM autobot_agent;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE USAGE, SELECT ON SEQUENCES FROM autobot_agent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    RAISE NOTICE 'autobot_agent role absent (PGlite/test env) — skipping 194 grants';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'audit') THEN
    RAISE NOTICE 'audit schema absent — skipping 194 grants';
    RETURN;
  END IF;

  -- 1. Schema USAGE — sql/188's original omission.
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO autobot_agent';

  -- 2. Table/view SELECT + INSERT (append-only; no UPDATE/DELETE). "ALL
  --    TABLES IN SCHEMA" covers both the base table and the view.
  EXECUTE 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO autobot_agent';

  -- 3. Sequence usage for the BIGSERIAL id column on shared_doc_retrievals.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO autobot_agent';

  -- 4. ALTER DEFAULT PRIVILEGES — durable fix so future audit.* tables
  --    auto-grant to autobot_agent without needing another one-shot GRANT
  --    ALL TABLES migration (see sql/147 header for why this matters).
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';

EXCEPTION WHEN OTHERS THEN
  -- Match sql/147's defensive posture: never let a grant edge-case
  -- crash-loop a deploy. A swallowed grant here surfaces as a loud
  -- permission-denied in staging smoke, not a silent prod outage.
  RAISE NOTICE '194 audit-schema grants: %, skipping remainder', SQLERRM;
END $$;
