-- Migration 104: redefine M3 as voice similarity, replace m3_draft_accuracy_pct (STAQPRO-301)
--
-- STAQPRO-296 Decision A: the original M3 (m3_draft_accuracy_pct, set by
-- migration 094) measured count(approved) / count(acted) over email-draft
-- action_proposals. Eric works in Gmail directly — the /drafts board
-- approve flow has never been used in production — so this metric was
-- structurally NULL by design. The board reframed it as a quality signal
-- we can compute from data we already collect:
--
--     mean cosine similarity between AI draft body embedding and Eric's
--     actual sent reply embedding on the same email thread, over the
--     last 14 days, returning NULL when fewer than 5 paired drafts exist.
--
-- Join shape (after migration 103 adds the draft embedding column):
--
--   agent_graph.action_proposals (action_type='email_draft', embedding)
--     -> inbox.messages (msg.id = ap.message_id; msg.thread_id is the join key)
--     -> voice.sent_emails (se.thread_id = msg.thread_id, embedding,
--                           sent_at > ap.created_at — only count replies
--                           that came AFTER the draft was generated)
--
-- pgvector is required for the cosine operator. PGlite / CI envs return
-- NULL via the pg_extension guard inside agent_graph.m3_voice_similarity(),
-- so the view itself stays creatable everywhere.
--
-- M4 (m4_edit_rate_14d_pct) is left untouched — board decision pending on
-- whether to redefine via Levenshtein/edit-distance or retire. See the
-- "Out of scope" section of STAQPRO-301.
--
-- Column renamed m3_draft_accuracy_pct -> m3_voice_similarity_pct. Grep
-- found no JS/TS consumers reading the old name directly; only the
-- metrics snapshot script reads via SELECT * which is name-tolerant.
--
-- Refs: STAQPRO-301, STAQPRO-296 Decision A, parent STAQPRO-252.

-- 1. The metric computation function. Hides pgvector behind a function
--    boundary so the view stays creatable on pgvector-less environments.
--    EXECUTE-with-string defers parsing of the vector operator until the
--    function actually runs, and the v_has_vector early-return prevents
--    that path from being taken when the extension is missing.
CREATE OR REPLACE FUNCTION agent_graph.m3_voice_similarity()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_has_vector BOOLEAN;
  v_result     NUMERIC;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;
  IF NOT v_has_vector THEN
    RETURN NULL;
  END IF;

  EXECUTE $sql$
    SELECT
      CASE
        WHEN count(*) >= 5
          THEN round((avg(1 - (ap.embedding <=> se.embedding)) * 100)::numeric, 2)
        ELSE NULL::numeric
      END
    FROM agent_graph.action_proposals ap
    JOIN inbox.messages msg
      ON msg.id = ap.message_id
    JOIN voice.sent_emails se
      ON se.thread_id = msg.thread_id
     AND se.sent_at > ap.created_at
    WHERE ap.action_type = 'email_draft'
      AND ap.embedding IS NOT NULL
      AND se.embedding IS NOT NULL
      AND ap.created_at >= (now() - INTERVAL '14 days')
  $sql$ INTO v_result;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION agent_graph.m3_voice_similarity() IS
  'STAQPRO-301: M3 metric. Mean cosine similarity (as percent) between '
  'email-draft embeddings and Eric''s actual sent reply on the same '
  'thread, 14d window, NULL when paired-count < 5. Returns NULL on '
  'pgvector-less environments (PGlite/CI).';

-- 2. v_phase1_metrics with M3 swapped for the function call. Every other
--    column is unchanged from migration 094 — diffing this against 094
--    should show ONLY the M3 subquery being replaced by the function call.
--
--    DROP + CREATE (not CREATE OR REPLACE): Postgres refuses to rename
--    a column via CREATE OR REPLACE VIEW, and m3_draft_accuracy_pct ->
--    m3_voice_similarity_pct is a rename. Grep confirmed no external
--    views/functions/RLS policies depend on this view, only follow-on
--    migrations that themselves do CREATE OR REPLACE (which is fine).
DROP VIEW IF EXISTS agent_graph.v_phase1_metrics;
CREATE VIEW agent_graph.v_phase1_metrics AS
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

    -- M3: voice similarity (STAQPRO-301). See agent_graph.m3_voice_similarity().
    -- Replaces the post-094 approval-accuracy definition that was structurally
    -- NULL because the /drafts board approve flow is unused (Eric replies in
    -- Gmail directly). NULL when fewer than 5 paired drafts in the 14d window
    -- or when pgvector is unavailable.
    agent_graph.m3_voice_similarity() AS m3_voice_similarity_pct,

    -- M4: email-draft edit rate. Unchanged from 094 — board decision pending
    -- on whether to redefine via edit-distance or retire (STAQPRO-301 out of
    -- scope, deferred). Still structurally NULL with current data.
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

    -- M5: drafts reviewed in 14d. Unchanged — see STAQPRO-278 for L0 exit semantics.
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
          WHERE drafts.created_at >= (now() - '7 days'::interval)) AS m9_gate_enforcement_pct,
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

    -- M13: L0 autonomy exit ready. Unchanged — see STAQPRO-278.
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
          WHERE w.created_at >= (now() - '24:00:00'::interval) AND (st.from_state = ANY (ARRAY['created'::text, 'assigned'::text]))) AS m14_dispatch_latency_avg_s,
    ( SELECT round(EXTRACT(epoch FROM percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (st.created_at - w.created_at))), 2) AS round
           FROM agent_graph.work_items w
             JOIN agent_graph.state_transitions st ON st.work_item_id = w.id AND st.to_state = 'in_progress'::text
          WHERE w.created_at >= (now() - '24:00:00'::interval) AND (st.from_state = ANY (ARRAY['created'::text, 'assigned'::text]))) AS m14b_dispatch_latency_p99_s,
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

-- Verification + sanity check on join shape.
-- The pair count tells you whether the draft<->reply join is producing
-- any data. If it's zero post-backfill in production, the join key
-- (ap.message_id = msg.id) is the first thing to look at.
DO $$
DECLARE
  v_has_vector  BOOLEAN;
  v_m3          NUMERIC;
  v_m4          NUMERIC;
  v_pair_count  BIGINT := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;

  SELECT m3_voice_similarity_pct, m4_edit_rate_14d_pct INTO v_m3, v_m4
    FROM agent_graph.v_phase1_metrics;

  IF v_has_vector THEN
    EXECUTE $sql$
      SELECT count(*)
        FROM agent_graph.action_proposals ap
        JOIN inbox.messages msg ON msg.id = ap.message_id
        JOIN voice.sent_emails se ON se.thread_id = msg.thread_id
         AND se.sent_at > ap.created_at
       WHERE ap.action_type = 'email_draft'
         AND ap.embedding IS NOT NULL
         AND se.embedding IS NOT NULL
         AND ap.created_at >= (now() - INTERVAL '14 days')
    $sql$ INTO v_pair_count;
  END IF;

  RAISE NOTICE '[104] pgvector present: %', v_has_vector;
  RAISE NOTICE '[104] m3_voice_similarity_pct (expect NULL until drafts embedded + 5+ paired): %', v_m3;
  RAISE NOTICE '[104] m4_edit_rate_14d_pct (unchanged, still NULL with current data): %', v_m4;
  RAISE NOTICE '[104] joinable (draft, reply) pairs in 14d window: % (0 expected pre-backfill)', v_pair_count;
END $$;
