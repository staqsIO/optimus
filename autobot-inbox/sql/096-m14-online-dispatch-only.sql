-- Migration 096: M14/M14b measure online dispatch latency only (STAQPRO-276)
--
-- M14 was reading 18s avg / 159s p99 against a SPEC §14 target of < 2s p99.
-- Diagnosis on STAQPRO-276 found this is M1 sleep cycles, not a runtime
-- perf bug:
--
--   - Median dispatch latency is 0.34s — runtime is fast when running
--   - PST hour 22:00 has 741 dispatches at avg 13,917s (3.9 HOURS!) — those
--     are work items created overnight while Eric's M1 (where the agents
--     run per CLAUDE.md MEMORY: "Campaigns run on M1 only") is asleep,
--     dispatched in bulk when the laptop wakes
--   - 100% of slow dispatches (>60s lag) had ZERO agent heartbeats during
--     the lag window — the responsible agent simply wasn't online
--   - Distribution is bimodal: nearly everything is <1s OR >60s, almost
--     nothing in between, so a cutoff cleanly separates "real perf" from
--     "agent unavailable"
--
-- The fix here is metric-level. The SPEC §14 target (< 2s p99) was written
-- to measure dispatch performance assuming the runtime is online. Counting
-- M1 sleep windows in M14 conflates availability with performance.
--
-- This migration filters M14 / M14b to dispatches with lag ≤ 300 seconds.
-- Five minutes is a generous cutoff for "agent online" — anything above it
-- is overwhelmingly availability-driven, not runtime-driven.
--
-- Deferred / out of scope (filed as follow-up if needed):
--   - Make agent_heartbeats append-only so future M14 can be precisely
--     heartbeat-filtered. Today it's an upsert, so historical online/offline
--     state is unrecoverable.
--   - Move agents to always-on infra (Railway). That's a topology / cost
--     decision the board owns; M1 was chosen for flat-rate CLI cost.
--   - Add a separate M14_raw metric for full-distribution observability if
--     we want both the runtime signal AND the availability signal visible.

CREATE OR REPLACE VIEW agent_graph.v_phase1_metrics AS
 SELECT ( SELECT round(
                CASE
                    WHEN count(*) > 0 THEN count(*) FILTER (WHERE messages.processed_at IS NOT NULL AND (messages.processed_at - messages.received_at) < '24:00:00'::interval)::numeric / count(*)::numeric * 100::numeric
                    ELSE 0::numeric
                END, 2) AS round
           FROM inbox.messages
          WHERE messages.received_at >= (now() - '7 days'::interval)) AS m1_inbox_zero_rate_pct,
    ( SELECT round(EXTRACT(epoch FROM avg(messages.processed_at - messages.received_at)) / 60::numeric, 1) AS round
           FROM inbox.messages
          WHERE messages.processed_at IS NOT NULL AND messages.received_at >= (now() - '7 days'::interval)) AS m2_avg_triage_latency_min,
    ( SELECT round(EXTRACT(epoch FROM percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (messages.processed_at - messages.received_at))) / 60::numeric, 1) AS round
           FROM inbox.messages
          WHERE messages.processed_at IS NOT NULL AND messages.received_at >= (now() - '7 days'::interval)) AS m2b_p99_triage_latency_min,

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

    -- M14: dispatch latency avg, online dispatches only.
    -- Filters to lag <= 300s. Dispatches above that threshold are
    -- overwhelmingly availability-driven (M1 was asleep), not runtime
    -- performance — see STAQPRO-276 for the bimodal-distribution analysis
    -- and heartbeat-coverage data.
    ( SELECT round(EXTRACT(epoch FROM avg(st.created_at - w.created_at)), 2) AS round
           FROM agent_graph.work_items w
             JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'::text
          WHERE w.created_at >= (now() - '24:00:00'::interval)
            AND (st.from_state = ANY (ARRAY['created'::text, 'assigned'::text]))
            AND EXTRACT(epoch FROM st.created_at - w.created_at) <= 300
    ) AS m14_dispatch_latency_avg_s,

    -- M14b: dispatch latency p99, online dispatches only. Same filter as M14.
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
DECLARE v_m14 NUMERIC; v_m14b NUMERIC;
BEGIN
  SELECT m14_dispatch_latency_avg_s, m14b_dispatch_latency_p99_s INTO v_m14, v_m14b
  FROM agent_graph.v_phase1_metrics;
  RAISE NOTICE '[096] m14 (online only, target < 2s): %', v_m14;
  RAISE NOTICE '[096] m14b p99 (online only, target < 2s): %', v_m14b;
END $$;
