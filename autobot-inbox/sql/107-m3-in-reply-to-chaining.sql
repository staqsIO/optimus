-- Migration 107: M3 voice-similarity — RFC822 In-Reply-To chaining
--                 (STAQPRO-305 follow-up to STAQPRO-301).
--
-- Migration 105 ships closest-in-time matching on thread_id. Live prod
-- showed this matches the draft to Eric's *earlier* turn on multi-turn
-- threads — different topic, negative cosine (-0.034, -0.071 on the
-- two real pairs in the 14d window). Not a "voice doesn't match"
-- signal — a cross-turn mismatch artifact.
--
-- This migration adds RFC822-precise chaining: voice.sent_emails.in_reply_to
-- (Gmail's `In-Reply-To` header) joined to inbox.messages.message_id
-- (the source inbound message's RFC822 Message-ID, already stored).
-- Each AI draft on an inbound message X is now matched to Eric's
-- specific reply to X — turn-level, not thread-level.
--
-- Backfill is a separate Node script
-- (autobot-inbox/scripts/backfill-sent-email-in-reply-to.js) that walks
-- existing voice.sent_emails rows and pulls In-Reply-To from Gmail via
-- messages.get format=metadata. ~1011 sent rows; some have no
-- In-Reply-To (original sends, not replies) — those genuinely have no
-- chain and fall back to migration 105's closest-in-time path.
--
-- Migration 105's closest-in-time logic stays as a fallback for drafts
-- the in_reply_to path doesn't match — belt-and-suspenders for rows
-- where backfill hasn't reached, or for replies with empty headers.
--
-- Refs: STAQPRO-305, parent STAQPRO-252, predecessors STAQPRO-301,
-- migrations 094 (original M3), 103 (draft embeddings),
-- 104 (M3 voice-similarity redef), 105 (closest-in-time fallback).

-- 1. Add the in_reply_to column to voice.sent_emails. Forward-going
--    ingests will populate it via src/gmail/sent-analyzer.js (same
--    migration's companion code change).
ALTER TABLE voice.sent_emails
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT;

-- 2. Partial index on the join key. Filters NULLs out of the index
--    so it's small (only-rows-that-could-match) and fast.
CREATE INDEX IF NOT EXISTS idx_sent_emails_in_reply_to
  ON voice.sent_emails (in_reply_to)
  WHERE in_reply_to IS NOT NULL;

-- 3. Rewrite m3_voice_similarity() to prefer the RFC822 join, with a
--    closest-in-time fallback for unmatched drafts.
--
--    Structure: two CTEs (primary_pairs via in_reply_to, fallback_pairs
--    via thread_id closest-time for drafts NOT in primary_pairs), then
--    UNION ALL averaged. Each draft contributes exactly one pair across
--    the two CTEs combined.
--
--    EXECUTE-with-dollar-quoted-string defers parsing of the vector
--    operator until function-call time; v_has_vector early-return
--    prevents PGlite / pgvector-less environments from ever reaching
--    that path.
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
    WITH primary_pairs AS (
      -- Turn-level match: Eric's reply chained via In-Reply-To header.
      -- DISTINCT ON (ap.id) ORDER BY sent_at DESC picks the newest send
      -- if Eric somehow replied twice with the same In-Reply-To
      -- (rare — usually a forward/correction).
      SELECT DISTINCT ON (ap.id)
        ap.id  AS ap_id,
        1 - (ap.embedding <=> se.embedding) AS sim
      FROM agent_graph.action_proposals ap
      JOIN inbox.messages msg
        ON msg.id = ap.message_id
      JOIN voice.sent_emails se
        ON se.in_reply_to = msg.message_id
      WHERE ap.action_type = 'email_draft'
        AND ap.embedding IS NOT NULL
        AND se.embedding IS NOT NULL
        AND ap.created_at >= (now() - INTERVAL '14 days')
      ORDER BY ap.id, se.sent_at DESC
    ),
    fallback_pairs AS (
      -- Migration 105's logic, scoped to drafts NOT matched by
      -- in_reply_to. Closest-in-time send on the same thread.
      -- Picks up drafts where backfill hasn't reached, replies with
      -- empty In-Reply-To headers, or threads where Eric's reply
      -- predates the agent's draft and was outside the in_reply_to
      -- chain we just indexed.
      SELECT DISTINCT ON (ap.id)
        ap.id  AS ap_id,
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
        AND NOT EXISTS (SELECT 1 FROM primary_pairs pp WHERE pp.ap_id = ap.id)
      ORDER BY ap.id,
               abs(EXTRACT(EPOCH FROM (se.sent_at - ap.created_at))) ASC
    ),
    all_pairs AS (
      SELECT sim FROM primary_pairs
      UNION ALL
      SELECT sim FROM fallback_pairs
    )
    SELECT
      CASE
        WHEN count(*) >= 5
          THEN round((avg(sim) * 100)::numeric, 2)
        ELSE NULL::numeric
      END
    FROM all_pairs
  $sql$ INTO v_result;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION agent_graph.m3_voice_similarity() IS
  'STAQPRO-305: M3 metric. Mean cosine similarity (as percent) between '
  'email-draft embeddings and Eric''s sent reply, joined primarily via '
  'RFC822 In-Reply-To (turn-level match) with closest-in-time on '
  'thread_id as fallback (migration 105 path). 14d window, NULL when '
  'paired-count < 5 or pgvector missing.';

-- Verification: counts on both join paths so we can read whether the
-- backfill is making progress and whether the fallback is shouldering
-- drafts the primary path can't yet match.
DO $$
DECLARE
  v_has_vector       BOOLEAN;
  v_m3               NUMERIC;
  v_primary_count    BIGINT := 0;
  v_fallback_count   BIGINT := 0;
  v_backfilled_rows  BIGINT := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;

  SELECT m3_voice_similarity_pct INTO v_m3
    FROM agent_graph.v_phase1_metrics;

  SELECT count(*) INTO v_backfilled_rows
    FROM voice.sent_emails
    WHERE in_reply_to IS NOT NULL;

  IF v_has_vector THEN
    EXECUTE $sql$
      SELECT count(*) FROM (
        SELECT DISTINCT ON (ap.id) ap.id
          FROM agent_graph.action_proposals ap
          JOIN inbox.messages msg ON msg.id = ap.message_id
          JOIN voice.sent_emails se ON se.in_reply_to = msg.message_id
         WHERE ap.action_type = 'email_draft'
           AND ap.embedding IS NOT NULL
           AND se.embedding IS NOT NULL
           AND ap.created_at >= (now() - INTERVAL '14 days')
         ORDER BY ap.id, se.sent_at DESC
      ) sub
    $sql$ INTO v_primary_count;

    EXECUTE $sql$
      SELECT count(*) FROM (
        SELECT DISTINCT ON (ap.id) ap.id
          FROM agent_graph.action_proposals ap
          JOIN inbox.messages msg ON msg.id = ap.message_id
          JOIN voice.sent_emails se ON se.thread_id = msg.thread_id
         WHERE ap.action_type = 'email_draft'
           AND ap.embedding IS NOT NULL
           AND se.embedding IS NOT NULL
           AND se.is_reply = true
           AND ap.created_at >= (now() - INTERVAL '14 days')
           AND NOT EXISTS (
             SELECT 1
               FROM agent_graph.action_proposals ap2
               JOIN inbox.messages msg2 ON msg2.id = ap2.message_id
               JOIN voice.sent_emails se2 ON se2.in_reply_to = msg2.message_id
              WHERE ap2.id = ap.id
                AND ap2.action_type = 'email_draft'
                AND ap2.embedding IS NOT NULL
                AND se2.embedding IS NOT NULL
                AND ap2.created_at >= (now() - INTERVAL '14 days')
           )
         ORDER BY ap.id,
                  abs(EXTRACT(EPOCH FROM (se.sent_at - ap.created_at))) ASC
      ) sub
    $sql$ INTO v_fallback_count;
  END IF;

  RAISE NOTICE '[107] pgvector present: %', v_has_vector;
  RAISE NOTICE '[107] voice.sent_emails rows with in_reply_to populated: % (backfill progress)', v_backfilled_rows;
  RAISE NOTICE '[107] primary in_reply_to-matched draft pairs (14d): %', v_primary_count;
  RAISE NOTICE '[107] fallback closest-in-time pairs (14d, drafts not matched by primary): %', v_fallback_count;
  RAISE NOTICE '[107] m3_voice_similarity_pct (primary + fallback combined): %', v_m3;
END $$;
