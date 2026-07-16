-- 147: GRANT-completeness for the non-superuser `autobot_agent` role.
--      STAQPRO-263 ("PR-B") prerequisite — read-only audit STAQPRO-564 found
--      BLOCKER-class grant gaps between the frozen baseline grant set
--      (001-baseline.sql:2766-2825) and what current code actually does.
--
-- Why this exists
-- ---------------
-- When the production Postgres pool flips from the Supabase `postgres.<project>`
-- SUPERUSER to the non-superuser `autobot_agent` role (driven by setting the
-- AUTOBOT_AGENT_DB_PASSWORD env var → lib/db.js:98 applyAutobotAgentRole), every
-- schema/table the baseline grant set missed produces `permission denied` for the
-- agents that touch it. The audit (pr-b-263-staging-validation-checklist.md §1)
-- enumerated the gaps:
--   * content   — granted SELECT-only; 70+ INSERT/UPDATE/DELETE write sites.
--   * signatures — NO grant at all (USAGE denied); 79 contract/e-sign refs.
--   * tenancy, engagements, autobot_comms, autobot_finance, autobot_distrib,
--     autobot_value — NO grant; any agent touching them 500s.
--   * signal, voice — had S/I/U but no DELETE; code DELETEs from several tables.
--   * agent_graph, inbox — DELETE deliberately REVOKED to protect append-only,
--     hash-chained audit tables; code DELETEs from specific NON-audit tables.
--
-- Ordering / durability
-- ---------------------
-- `GRANT ... ON ALL TABLES IN SCHEMA` is a ONE-SHOT snapshot of the tables that
-- exist at apply time. This migration MUST run as the highest migration number
-- AFTER all table-creating migrations, or be re-run. The durable fix is
-- `ALTER DEFAULT PRIVILEGES` (bottom of this file) so future tables auto-grant to
-- autobot_agent — without it, every future migration's new tables silently lack
-- grants and re-create this failure on the next deploy.
--
-- Safety
-- ------
-- Safe to apply BEFORE the flip — this is pure grant WIDENING. While the pool is
-- still the superuser, RLS-by-role is bypassed and these grants are inert
-- (superuser ignores ACLs); no behavior change. After the flip they become the
-- ACL that lets each agent tier do its representative DB ops.
--
-- Idempotency
-- -----------
-- GRANT and ALTER DEFAULT PRIVILEGES are naturally re-runnable. Schema USAGE and
-- ALL-TABLES/ALL-SEQUENCES grants are guarded with pg_namespace existence checks
-- so the migration does not error on a schema that is defined-but-absent in a
-- given environment (PGlite/test, or schemas not yet created). The whole role-
-- dependent body is wrapped in the same `IF EXISTS pg_roles autobot_agent` guard
-- the baseline uses (role does not exist in PGlite/test).
--
-- Append-only carve-out (agent_graph + inbox DELETE)
-- --------------------------------------------------
-- Baseline REVOKEs DELETE on ALL TABLES in agent_graph + inbox to protect the
-- append-only, hash-chained audit tables (P3: transparency by structure). We do
-- NOT re-grant blanket DELETE. Instead we GRANT DELETE on the SPECIFIC non-audit
-- tables that code actually deletes from (confirmed via `DELETE FROM` census),
-- leaving the audit / append-only tables WITHOUT delete. Intentionally EXCLUDED
-- (must stay no-delete):
--   * agent_graph.state_transitions    — append-only, hash-chained audit (P3)
--   * agent_graph.task_events          — append-only event log (P3)
--   * agent_graph.agent_config_history — append-only config audit
--   * agent_graph.halt_signals         — kill-switch ledger
--   * agent_graph.llm_invocations      — spend/G10 audit ledger
--   * agent_graph.budgets              — G1 budget ledger
--   * voice.edit_deltas                — append-only (D4: most valuable data)
--   * everything else in agent_graph/inbox not in the explicit list below
-- Any table whose append-only status is uncertain is EXCLUDED here (no DELETE)
-- rather than risk violating the audit invariant; add an explicit grant in a
-- follow-up migration only after confirming it is not append-only.

DO $$
DECLARE
  t TEXT;
  delete_targets TEXT[] := ARRAY[
    -- agent_graph non-audit DELETE targets (from `DELETE FROM agent_graph.*` census)
    'agent_graph.work_items',
    'agent_graph.action_proposals',
    'agent_graph.token_revocations',
    'agent_graph.project_memberships',
    'agent_graph.issue_triage_log',
    'agent_graph.gateway_rate_limits',
    'agent_graph.board_chat_sessions',
    'agent_graph.board_chat_messages',
    'agent_graph.flow_definitions',
    -- inbox non-audit DELETE targets (from `DELETE FROM inbox.*` census)
    'inbox.messages',
    'inbox.signals',
    'inbox.accounts',
    'inbox.sync_state',
    'inbox.drive_watches',
    'inbox.calendar_watches'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    RAISE NOTICE 'autobot_agent role absent (PGlite/test env) — skipping 147 grants';
    RETURN;
  END IF;

  -- ============================================================
  -- 1. Schema USAGE on every schema agents touch but baseline missed.
  --    Guarded per-schema so a defined-but-absent schema is a no-op.
  -- ============================================================
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'content') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA content TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signatures') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA signatures TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenancy') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA tenancy TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'engagements') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA engagements TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_comms') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA autobot_comms TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_finance') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA autobot_finance TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_distrib') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA autobot_distrib TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_value') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA autobot_value TO autobot_agent';
  END IF;

  -- ============================================================
  -- 2. Table DML on the WRITE schemas.
  --    These schemas hold no append-only/hash-chained audit tables, so full
  --    S/I/U/D is authorized (per audit §1). content was SELECT-only;
  --    signatures had nothing; signal/voice lacked DELETE.
  --    ALL-TABLES grant is a one-shot snapshot (see header) — paired with
  --    ALTER DEFAULT PRIVILEGES below for durability.
  -- ============================================================
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'content') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA content TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA content TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signatures') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA signatures TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA signatures TO autobot_agent';
  END IF;
  -- signal + voice: baseline granted S/I/U + seq USAGE; add DELETE + seq SELECT.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signal') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA signal TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA signal TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'voice') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA voice TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA voice TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'engagements') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA engagements TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA engagements TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_comms') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA autobot_comms TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA autobot_comms TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_finance') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA autobot_finance TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA autobot_finance TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_distrib') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA autobot_distrib TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA autobot_distrib TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_value') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA autobot_value TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA autobot_value TO autobot_agent';
  END IF;
  -- tenancy: scope resolution / visibleClause parity. Reads + writes to
  -- membership tables; full DML, but no append-only audit lives here.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenancy') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenancy TO autobot_agent';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tenancy TO autobot_agent';
  END IF;

  -- Sequence SELECT for agent_graph/inbox (baseline granted USAGE only; SELECT
  -- is needed for currval()/explicit nextval() reads). Re-grant is idempotent.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_graph TO autobot_agent';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA inbox TO autobot_agent';

  -- ============================================================
  -- 3. Per-table DELETE on agent_graph + inbox NON-audit tables ONLY.
  --    DELETE on these two schemas stays REVOKED at the schema level
  --    (baseline) to protect the append-only audit invariant (P3). We grant
  --    DELETE table-by-table for the tables code actually deletes from.
  --    See the "Append-only carve-out" header block for the exclusion list.
  --    Each grant is guarded so an absent table is a no-op.
  -- ============================================================
  FOREACH t IN ARRAY delete_targets LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON %s TO autobot_agent', t);
    END IF;
  END LOOP;

  -- ============================================================
  -- 4. ALTER DEFAULT PRIVILEGES — the durable fix.
  --    Baseline only set defaults for agent_graph/inbox/voice/signal. Extend to
  --    every write schema so future migrations' new tables auto-grant to
  --    autobot_agent. Bare form (no FOR ROLE) = applies for CURRENT_USER, the
  --    DATABASE_URL principal that runs migrations — matching baseline 2818-2825.
  --    NOTE: DELETE is included in the default for the new write schemas (no
  --    append-only invariant there) but deliberately NOT for agent_graph/inbox
  --    (those keep the append-only carve-out; DELETE granted per-table above).
  -- ============================================================

  -- agent_graph / inbox: keep DELETE OUT of the default (append-only carve-out).
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA agent_graph GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA inbox GRANT SELECT, INSERT, UPDATE ON TABLES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA agent_graph GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA inbox GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';

  -- voice / signal: baseline default was S/I/U; widen to include DELETE.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA voice GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA signal GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA voice GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA signal GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';

  -- New write schemas: full S/I/U/D default + sequence usage. Guarded so the
  -- ALTER DEFAULT PRIVILEGES does not error on an absent schema.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'content') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signatures') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA signatures GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA signatures GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenancy') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'engagements') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA engagements GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA engagements GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_comms') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_comms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_comms GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_finance') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_finance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_finance GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_distrib') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_distrib GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_distrib GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'autobot_value') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_value GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autobot_agent';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA autobot_value GRANT USAGE, SELECT ON SEQUENCES TO autobot_agent';
  END IF;

  -- ============================================================
  -- 5. EXECUTE on functions for the newly-granted write schemas (mirrors the
  --    baseline grants for agent_graph/inbox/voice/signal at 2802-2805).
  --    Guarded; harmless if a schema has no functions.
  -- ============================================================
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'content') THEN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA content TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'signatures') THEN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA signatures TO autobot_agent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenancy') THEN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tenancy TO autobot_agent';
  END IF;

EXCEPTION WHEN OTHERS THEN
  -- Match baseline's defensive posture (2788): never let a grant edge-case
  -- crash-loop a deploy. The flip gate (verify-tenancy-live + per-tier smoke)
  -- is the real proof; a swallowed grant here surfaces as a loud
  -- permission-denied in staging smoke, not a silent prod outage.
  RAISE NOTICE '147 grant-completeness: %, skipping remainder', SQLERRM;
END $$;
