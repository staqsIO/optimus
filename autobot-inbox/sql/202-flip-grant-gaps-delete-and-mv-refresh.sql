-- 202 — Post-flip grant gaps: DELETE on drain/mapping tables + trust-score MV refresh.
--
-- Root cause: migration 147's ALTER DEFAULT PRIVILEGES for schema inbox grants
-- future tables SELECT, INSERT, UPDATE — deliberately NOT DELETE (append-only
-- posture protecting audit tables). Any *queue/mapping* table created after 147
-- therefore silently lacks DELETE for autobot_agent, and the failure only
-- surfaces post-flip when the pool stopped being superuser. Ground-truth census
-- of every `DELETE FROM <schema>.<table>` call site against prod
-- has_table_privilege() found exactly two gaps (2026-07-16):
--
--   * inbox.gmail_fetch_retries (mig 193) — the poller's loss-free retry set.
--     Draining it DELETEs on success; the denial aborted the whole account
--     poll, stalling ingestion for any account with a pending retry row.
--   * inbox.slack_project_map — unmap path DELETEs a row.
--
-- Neither table has RLS enabled (rowsecurity=false, no policies), so a plain
-- GRANT restores the drain path. These are operational queue/mapping tables,
-- not audit records — the append-only carve-out was never meant for them.
--
-- Second gap: REFRESH MATERIALIZED VIEW requires *ownership*, and
-- agent_graph.agent_trust_scores (mig 168) is owned by the migration role.
-- Post-flip the runtime's scheduled 'trust-score-refresh' service fails with
-- "permission denied for materialized view". We do NOT transfer ownership to
-- autobot_agent: the refresh would then evaluate the MV's source query under
-- autobot_agent's RLS, silently thinning the aggregate. Instead a narrow
-- SECURITY DEFINER function (owned by the migration role, search_path pinned)
-- performs the refresh with full visibility; autobot_agent gets EXECUTE on
-- that function only (P2: infrastructure enforces the boundary).
--
-- NOTE for future migrations: any new table that code DELETEs from needs an
-- explicit GRANT DELETE here-style — the schema default privileges will not
-- provide it, and the failure is invisible until the row-drain path fires.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    GRANT DELETE ON inbox.gmail_fetch_retries TO autobot_agent;
    GRANT DELETE ON inbox.slack_project_map TO autobot_agent;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION agent_graph.refresh_agent_trust_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agent_graph, pg_temp
AS $fn$
BEGIN
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY agent_graph.agent_trust_scores;
  EXCEPTION WHEN OTHERS THEN
    -- CONCURRENTLY needs a populated view + unique index; fall back for the
    -- never-populated case. Both paths yield identical deterministic output.
    REFRESH MATERIALIZED VIEW agent_graph.agent_trust_scores;
  END;
END;
$fn$;

COMMENT ON FUNCTION agent_graph.refresh_agent_trust_scores() IS
  'Owner-privileged refresh of the OPT-82 trust-score MV. SECURITY DEFINER so '
  'the post-flip agent pool can refresh without owning the MV (ownership would '
  'make the refresh run under agent RLS and silently thin the aggregate).';

REVOKE ALL ON FUNCTION agent_graph.refresh_agent_trust_scores() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    GRANT EXECUTE ON FUNCTION agent_graph.refresh_agent_trust_scores() TO autobot_agent;
  END IF;
END $$;
