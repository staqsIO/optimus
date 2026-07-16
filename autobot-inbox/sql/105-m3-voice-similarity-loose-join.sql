-- Migration 105: M3 voice-similarity — drop the sent_at > created_at constraint
--                 and dedupe to closest-in-time Eric reply per draft.
--
-- Migration 104 shipped the M3 redefinition with a strict
-- `se.sent_at > ap.created_at` constraint, on the assumption that Eric
-- reads the AI draft and then writes his own reply (so the actual send
-- would be newer than the draft). Production data immediately disproved
-- this: of 76 drafts in the 14d window, only 7 had any same-thread Eric
-- reply at all, and *zero* had a reply newer than the draft. Eric replies
-- in Gmail before or independently of the agent's draft cycle.
--
-- Two changes here:
--
-- 1. Drop `se.sent_at > ap.created_at`. The metric becomes "how similar
--    is the AI draft to whatever Eric actually wrote on the same thread,"
--    regardless of order. We lose the strict "what Eric wrote AFTER
--    seeing the draft" semantic, but we gain a metric that fires at all.
--
-- 2. DISTINCT ON (ap.id) picking the Eric send with the smallest absolute
--    time delta from the draft. Without this, a draft on a multi-turn
--    thread (Nicole → Eric → Nicole → Eric → ...) contributes one pair
--    PER Eric send on that thread, biasing the average toward
--    heavily-replied threads and inflating the count for the n≥5
--    threshold. With DISTINCT ON, each draft contributes one cosine,
--    weighted equally — what we actually want from a "voice match" signal.
--
-- Known weakness left for STAQPRO-302 (follow-up): closest-in-time can
-- still match a draft to an unrelated turn in a long-running thread. The
-- proper fix is RFC822 in_reply_to chaining (voice.sent_emails would need
-- an in_reply_to column populated from Gmail headers), tracked separately.
-- Until then, M3 measures topical-thread alignment rather than 1:1
-- draft-vs-actual-reply, and the value should be read as a noisy lower
-- bound on voice fidelity.
--
-- Refs: STAQPRO-301, parent STAQPRO-252, follow-up STAQPRO-302.

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
    WITH closest_reply_per_draft AS (
      SELECT DISTINCT ON (ap.id)
        ap.id AS ap_id,
        1 - (ap.embedding <=> se.embedding) AS sim
      FROM agent_graph.action_proposals ap
      JOIN inbox.messages msg
        ON msg.id = ap.message_id
      JOIN voice.sent_emails se
        ON se.thread_id = msg.thread_id
      WHERE ap.action_type = 'email_draft'
        AND ap.embedding IS NOT NULL
        AND se.embedding IS NOT NULL
        AND se.is_reply = true
        AND ap.created_at >= (now() - INTERVAL '14 days')
      ORDER BY ap.id,
               abs(EXTRACT(EPOCH FROM (se.sent_at - ap.created_at))) ASC
    )
    SELECT
      CASE
        WHEN count(*) >= 5
          THEN round((avg(sim) * 100)::numeric, 2)
        ELSE NULL::numeric
      END
    FROM closest_reply_per_draft
  $sql$ INTO v_result;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION agent_graph.m3_voice_similarity() IS
  'STAQPRO-301 + STAQPRO-302 follow-up: M3 metric. Mean cosine '
  'similarity (as percent) between email-draft embeddings and Eric''s '
  'closest-in-time sent reply on the same thread, 14d window, NULL '
  'when paired-count < 5. Returns NULL on pgvector-less environments. '
  'Note: closest-in-time matching is noisy on multi-turn threads; '
  'STAQPRO-302 tracks the proper in_reply_to-based fix.';

-- Verification
DO $$
DECLARE
  v_has_vector  BOOLEAN;
  v_m3          NUMERIC;
  v_pair_count  BIGINT := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;

  SELECT m3_voice_similarity_pct INTO v_m3
    FROM agent_graph.v_phase1_metrics;

  IF v_has_vector THEN
    EXECUTE $sql$
      SELECT count(*) FROM (
        SELECT DISTINCT ON (ap.id) ap.id
          FROM agent_graph.action_proposals ap
          JOIN inbox.messages msg ON msg.id = ap.message_id
          JOIN voice.sent_emails se ON se.thread_id = msg.thread_id
         WHERE ap.action_type = 'email_draft'
           AND ap.embedding IS NOT NULL
           AND se.embedding IS NOT NULL
           AND se.is_reply
           AND ap.created_at >= (now() - INTERVAL '14 days')
         ORDER BY ap.id,
                  abs(EXTRACT(EPOCH FROM (se.sent_at - ap.created_at))) ASC
      ) sub
    $sql$ INTO v_pair_count;
  END IF;

  RAISE NOTICE '[105] pgvector present: %', v_has_vector;
  RAISE NOTICE '[105] m3_voice_similarity_pct (loose join, closest-in-time dedupe): %', v_m3;
  RAISE NOTICE '[105] distinct (draft, closest-reply) pairs in 14d window: % (n>=5 threshold)', v_pair_count;
END $$;
