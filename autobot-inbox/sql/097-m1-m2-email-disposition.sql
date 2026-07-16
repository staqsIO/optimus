-- Migration 097: M1/M2/M2b measure email disposition, not all-channel processing (STAQPRO-277)
--
-- M1 was reading 20.54% (target ≥ 90%) and M2/M2b were 154 min / 68 hours
-- (targets ≤ 30 min / ≤ 60 min). Diagnosis on STAQPRO-277 found two
-- separate issues conflated in the metric:
--
-- 1) Channel scope: inbox.messages has channel='email' AND channel='webhook'
--    (Linear/tldv events with `signal-only` label, etc.). Webhook events are
--    audit signals, not "emails to triage" — they don't need executor-intake
--    to run on them. Counting them in M1's denominator misrepresents the
--    metric (102 stale Linear webhook rows alone drag the numerator down).
--
-- 2) Disposition definition: M1 uses processed_at as the success signal, but
--    auto-archived emails (archived_at NOT NULL, processed_at NULL — same
--    pattern as M9) are legitimately disposed without triage. Counting them
--    as "not triaged" double-penalizes the metric.
--
-- This migration:
--   - Filters M1/M2/M2b to channel = 'email'
--   - Uses COALESCE(processed_at, archived_at) as the disposition timestamp
--     so auto-archived emails count as disposed (matching the workflow)
--   - Restricts M2/M2b to disposed emails (un-disposed have no latency to
--     average)
--
-- Result on current data:
--   M1: 20.54% -> 55.31%   (still < 90%, but reflects a real backlog)
--   M2:  154.1 -> 9.0 min  (passes ≤ 30 min)
--   M2b: 4068.3 -> 35.9 min (passes ≤ 60 min)
--
-- M1 still fails target, but now it's an honest signal: 202 of 452 emails
-- in the last 7d have not been disposed. ~139 of those have work_items but
-- never reached the agent — that's a real triage throughput / availability
-- problem, not a metric definition problem. Filed separately as a follow-up
-- (see STAQPRO-277 comment).

CREATE OR REPLACE VIEW agent_graph.v_phase1_metrics AS
 SELECT
    -- M1: % of emails disposed (processed_at OR archived_at) within 24h of receipt.
    -- Filtered to channel='email' (webhook events aren't triage candidates).
    -- See migration 097 + STAQPRO-277.
    ( SELECT round(
                CASE
                    WHEN count(*) > 0 THEN count(*) FILTER (
                      WHERE COALESCE(processed_at, archived_at) IS NOT NULL
                        AND COALESCE(processed_at, archived_at) - received_at < '24:00:00'::interval
                    )::numeric / count(*)::numeric * 100::numeric
                    ELSE 0::numeric
                END, 2) AS round
           FROM inbox.messages
          WHERE received_at >= (now() - '7 days'::interval)
            AND channel = 'email') AS m1_inbox_zero_rate_pct,

    -- M2: average disposition latency for emails that ARE disposed.
    ( SELECT round(EXTRACT(epoch FROM avg(COALESCE(processed_at, archived_at) - received_at)) / 60::numeric, 1) AS round
           FROM inbox.messages
          WHERE COALESCE(processed_at, archived_at) IS NOT NULL
            AND received_at >= (now() - '7 days'::interval)
            AND channel = 'email') AS m2_avg_triage_latency_min,

    -- M2b: p99 disposition latency for emails that ARE disposed.
    ( SELECT round(EXTRACT(epoch FROM percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (COALESCE(processed_at, archived_at) - received_at))) / 60::numeric, 1) AS round
           FROM inbox.messages
          WHERE COALESCE(processed_at, archived_at) IS NOT NULL
            AND received_at >= (now() - '7 days'::interval)
            AND channel = 'email') AS m2b_p99_triage_latency_min,

    ( SELECT
        CASE
          WHEN count(*) >= 5 THEN round(
            count(*) FILTER (WHERE board_action = 'approved'::text)::numeric
              / count(*)::numeric * 100::numeric, 2)
          ELSE NULL::numeric
        END
      FROM agent_graph.action_proposals
      WHERE action_type = 'email_draft'
        AND board_action IN ('approved', 'edited', 'rejected')
        AND acted_at >= (now() - '14 days'::interval)
    ) AS m3_draft_accuracy_pct,

    ( SELECT
        CASE
          WHEN count(*) >= 5 THEN round(
            count(*) FILTER (WHERE board_action = 'edited'::text)::numeric
              / count(*)::numeric * 100::numeric, 2)
          ELSE NULL::numeric
        END
      FROM agent_graph.action_proposals
      WHERE action_type = 'email_draft'
        AND board_action IN ('approved', 'edited', 'rejected')
        AND acted_at >= (now() - '14 days'::interval)
    ) AS m4_edit_rate_14d_pct,

    ( SELECT count(*) AS count
           FROM inbox.drafts
          WHERE drafts.board_action IS NOT NULL AND drafts.acted_at >= (now() - '14 days'::interval)) AS m5_drafts_reviewed_14d,

    ( SELECT round(COALESCE(avg(sub.daily_cost), 0::numeric), 4) AS round
           FROM ( SELECT sum(llm_invocations.cost_usd) AS daily_cost
                   FROM agent_graph.llm_invocations
                  WHERE llm_invocations.created_at >= (now() - '7 days'::interval)
                  GROUP BY (date(llm_invocations.created_at))) sub) AS m6_avg_daily_cost_usd,
    ( SELECT round(
                CASE
                    WHEN budgets.allocated_usd > 0::numeric THEN budgets.spent_usd / budgets.allocated_usd * 100::numeric
                    ELSE 0::numeric
                END, 2) AS round
           FROM agent_graph.budgets
          WHERE budgets.scope = 'daily'::text AND budgets.period_start = CURRENT_DATE
         LIMIT 1) AS m7_budget_utilization_pct,
    ( SELECT COALESCE(bool_and(verify_all_ledger_chains.is_valid), true) AS "coalesce"
           FROM agent_graph.verify_all_ledger_chains() verify_all_ledger_chains(work_item_id, is_valid, rows_checked, broken_at_id)) AS m8_hash_chain_valid,

    ( SELECT round(
                CASE
                    WHEN count(*) > 0 THEN count(*) FILTER (WHERE drafts.reviewer_verdict IS NOT NULL)::numeric / count(*)::numeric * 100::numeric
                    ELSE 0::numeric
                END, 2) AS round
           FROM inbox.drafts
          WHERE drafts.created_at >= (now() - '7 days'::interval)
            AND (drafts.board_action IS NULL OR drafts.board_action NOT LIKE 'archived%')
    ) AS m9_gate_enforcement_pct,

    ( SELECT count(*) AS count
           FROM agent_graph.halt_signals) AS m10_total_halts,
    ( SELECT round(
                CASE
                    WHEN count(DISTINCT m.id) > 0 THEN count(s.id)::numeric / count(DISTINCT m.id)::numeric
                    ELSE 0::numeric
                END, 2) AS round
           FROM inbox.messages m
             LEFT JOIN inbox.signals s ON s.message_id = m.id
          WHERE m.received_at >= (now() - '7 days'::interval)) AS m11_signals_per_email,
    ( SELECT COALESCE(sum(profiles.sample_count), 0::bigint) AS "coalesce"
           FROM voice.profiles
          WHERE profiles.scope = 'global'::text) AS m12_voice_samples,
    ( SELECT
                CASE
                    WHEN (( SELECT count(*) AS count
                       FROM inbox.drafts
                      WHERE drafts.board_action IS NOT NULL AND drafts.acted_at >= (now() - '14 days'::interval))) >= 50 AND (( SELECT round(
                            CASE
                                WHEN count(*) > 0 THEN count(*) FILTER (WHERE drafts.board_action = 'edited'::text)::numeric / count(*)::numeric * 100::numeric
                                ELSE 0::numeric
                            END, 2) AS round
                       FROM inbox.drafts
                      WHERE drafts.board_action IS NOT NULL AND drafts.acted_at >= (now() - '14 days'::interval))) < 10::numeric THEN true
                    ELSE false
                END AS "case") AS m13_l0_exit_ready,

    ( SELECT round(EXTRACT(epoch FROM avg(st.created_at - w.created_at)), 2) AS round
           FROM agent_graph.work_items w
             JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'::text
          WHERE w.created_at >= (now() - '24:00:00'::interval)
            AND (st.from_state = ANY (ARRAY['created'::text, 'assigned'::text]))
            AND EXTRACT(epoch FROM st.created_at - w.created_at) <= 300
    ) AS m14_dispatch_latency_avg_s,

    ( SELECT round(EXTRACT(epoch FROM percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (st.created_at - w.created_at))), 2) AS round
           FROM agent_graph.work_items w
             JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'::text
          WHERE w.created_at >= (now() - '24:00:00'::interval)
            AND (st.from_state = ANY (ARRAY['created'::text, 'assigned'::text]))
            AND EXTRACT(epoch FROM st.created_at - w.created_at) <= 300
    ) AS m14b_dispatch_latency_p99_s,

    ( SELECT round(avg(EXTRACT(epoch FROM sub.child_completed - sub.parent_created)), 2) AS round
           FROM ( SELECT w.created_at AS parent_created,
                    max(st.created_at) AS child_completed
                   FROM agent_graph.work_items w
                     JOIN agent_graph.edges e ON e.from_id = w.id AND e.edge_type = 'decomposes_into'::text
                     JOIN agent_graph.work_items c ON c.id = e.to_id AND c.status = 'completed'::text
                     JOIN agent_graph.state_transitions st ON st.work_item_id = c.id AND st.to_state = 'completed'::text
                  WHERE w.type = 'directive'::text AND w.created_at >= (now() - '24:00:00'::interval)
                  GROUP BY w.id, w.created_at) sub) AS m15_e2e_latency_avg_s,
    ( SELECT round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (sub.e2e_seconds::double precision))::numeric, 2) AS round
           FROM ( SELECT EXTRACT(epoch FROM max(st.created_at) - w.created_at) AS e2e_seconds
                   FROM agent_graph.work_items w
                     JOIN agent_graph.edges e ON e.from_id = w.id AND e.edge_type = 'decomposes_into'::text
                     JOIN agent_graph.work_items c ON c.id = e.to_id AND c.status = 'completed'::text
                     JOIN agent_graph.state_transitions st ON st.work_item_id = c.id AND st.to_state = 'completed'::text
                  WHERE w.type = 'directive'::text AND w.created_at >= (now() - '24:00:00'::interval)
                  GROUP BY w.id, w.created_at) sub) AS m15b_e2e_latency_p99_s;

DO $$
DECLARE v1 NUMERIC; v2 NUMERIC; v2b NUMERIC;
BEGIN
  SELECT m1_inbox_zero_rate_pct, m2_avg_triage_latency_min, m2b_p99_triage_latency_min
  INTO v1, v2, v2b FROM agent_graph.v_phase1_metrics;
  RAISE NOTICE '[097] m1 (was 20.54, target ≥ 90): %', v1;
  RAISE NOTICE '[097] m2 (was 154.1, target ≤ 30): %', v2;
  RAISE NOTICE '[097] m2b (was 4068.3, target ≤ 60): %', v2b;
END $$;
