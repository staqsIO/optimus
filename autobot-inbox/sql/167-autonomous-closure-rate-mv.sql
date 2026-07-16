-- 167-autonomous-closure-rate-mv.sql — OPT-52: instrument the headline metric.
--
-- The single Postgres materialized view that computes Optimus's headline
-- governance numbers, per org:
--
--   autonomous_closure_rate
--     = fraction of CLOSED LOOPS that closed with ZERO human round-trips.
--
--   cost_per_closed_loop
--     = SUM(state_transitions.cost_usd) over closed loops / closed-loop count.
--
-- This is the acceptance gate for the bridge `dryRun=false` flip and the demo
-- headline number — it MUST exist before that decision (SPEC §0 P5: "measure
-- before you trust"). It is computed structurally from the audit spine, not
-- re-derived per query (P3: transparency by structure, P4: boring Postgres).
--
-- ── Definitions (the predicate, spelled out) ─────────────────────────────────
--
--   CLOSED LOOP  — one agent_graph.work_items row that reached status
--                  'completed'. A work_item reaching 'completed' is exactly one
--                  loop. 'cancelled'/'failed'/open states are NOT closed loops.
--
--   AUTONOMOUS   — that closed loop has NO human_task touch. There is no direct
--                  FK from inbox.human_tasks to agent_graph.work_items (cross-
--                  schema FKs are forbidden, SPEC §12 / D5). The human-task
--                  surface bridges into the task graph through
--                  inbox.signals.work_item_id (migration 127, the signal→action
--                  bridge): a human_task references a signal (human_tasks.signal_id),
--                  and a signal can carry the work_item_id it was bridged into.
--                  So a loop is "human-touched" iff some live (deleted_at IS NULL)
--                  human_task's signal bridges to that work_item. "autonomous" =
--                  NOT human-touched.
--
--   loop cost    — SUM(state_transitions.cost_usd) for that work_item across all
--                  its transitions (the hash-chained audit spine, partitioned by
--                  created_at; we sum across all partitions transparently).
--
-- ── Tenancy ──────────────────────────────────────────────────────────────────
-- agent_graph.work_items carries owner_org_id (migration 134, default Staqs), so
-- the view groups by org and the read path can scope/aggregate by org. A NULL
-- owner_org_id (pre-134 rows that somehow escaped the backfill) collapses into
-- its own group rather than being dropped.

-- ── The materialized view ────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS agent_graph.autonomous_closure_metrics AS
WITH closed_loops AS (
  SELECT
    wi.id,
    wi.owner_org_id,
    -- human-touched iff a live human_task bridges (via its signal) to this loop
    EXISTS (
      SELECT 1
        FROM inbox.human_tasks ht
        JOIN inbox.signals s ON s.id = ht.signal_id
       WHERE s.work_item_id = wi.id
         AND ht.deleted_at IS NULL
    ) AS human_touched,
    -- total cost charged to this loop across the audit spine
    COALESCE((
      SELECT SUM(st.cost_usd)
        FROM agent_graph.state_transitions st
       WHERE st.work_item_id = wi.id
    ), 0) AS loop_cost_usd
  FROM agent_graph.work_items wi
  WHERE wi.status = 'completed'      -- a completed work_item == one closed loop
)
SELECT
  owner_org_id,
  COUNT(*)                                            AS closed_loops,
  COUNT(*) FILTER (WHERE NOT human_touched)           AS autonomous_loops,
  COUNT(*) FILTER (WHERE human_touched)               AS human_touched_loops,
  -- headline #1: fraction of closed loops with zero human round-trips
  CASE WHEN COUNT(*) = 0 THEN NULL
       ELSE ROUND(
              COUNT(*) FILTER (WHERE NOT human_touched)::numeric / COUNT(*),
              4)
  END                                                 AS autonomous_closure_rate,
  SUM(loop_cost_usd)                                  AS total_loop_cost_usd,
  -- headline #2: average cost to close one loop
  CASE WHEN COUNT(*) = 0 THEN NULL
       ELSE ROUND(SUM(loop_cost_usd) / COUNT(*), 6)
  END                                                 AS cost_per_closed_loop,
  now()                                               AS computed_at
FROM closed_loops
GROUP BY owner_org_id
WITH NO DATA;

-- Unique index on the grouping key. Two jobs at once: (1) enables
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (no read-lock during refresh), and
-- (2) the per-org lookup index for the read endpoint. COALESCE the NULL org to a
-- sentinel so the unique index stays valid when a NULL-org group exists.
CREATE UNIQUE INDEX IF NOT EXISTS ux_autonomous_closure_metrics_org
  ON agent_graph.autonomous_closure_metrics
  (COALESCE(owner_org_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── Refresh hook ─────────────────────────────────────────────────────────────
-- No existing MVs in this repo, so there is no prior refresh convention to
-- mirror. The pattern that fits this codebase (no external scheduler; agents +
-- API drive everything) is a SECURITY DEFINER refresh function the read path
-- calls opportunistically (stale-on-read with a poll backstop, exactly like the
-- enrichment worker, migration 155). CONCURRENTLY keeps reads live during the
-- refresh; the unique index above is its prerequisite.
CREATE OR REPLACE FUNCTION agent_graph.refresh_autonomous_closure_metrics()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agent_graph, inbox, public
AS $fn$
BEGIN
  -- CONCURRENTLY needs the MV to be populated once first; on a never-refreshed
  -- MV it raises, so fall back to a plain refresh on the first call.
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY agent_graph.autonomous_closure_metrics;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW agent_graph.autonomous_closure_metrics;
  END;
END;
$fn$;

-- Populate once so first reads return data (and the CONCURRENTLY path is armed).
REFRESH MATERIALIZED VIEW agent_graph.autonomous_closure_metrics;

COMMENT ON MATERIALIZED VIEW agent_graph.autonomous_closure_metrics IS
  'OPT-52 headline metric: per-org autonomous_closure_rate (closed loops with '
  'zero human-task touch / closed loops) + cost_per_closed_loop '
  '(sum state_transitions.cost_usd / closed loops). Closed loop = work_item at '
  'status=completed. Human touch = a live human_task bridged via signals.work_item_id. '
  'Refresh via agent_graph.refresh_autonomous_closure_metrics().';
