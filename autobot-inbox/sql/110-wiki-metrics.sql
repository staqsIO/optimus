-- Migration 110: agent_graph.v_wiki_metrics (STAQPRO-311 Phase 4)
--
-- Approval-weighted grounding metric for the wiki-in-prompts initiative.
-- Per Liotta's review of the original plan: vanity metric
-- "did we retrieve anything" was rejected in favor of measuring quality:
-- did the LLM *cite* what we surfaced, and did humans *keep* the citations.
--
-- Phase 4 is intentionally separate from agent_graph.v_phase1_metrics
-- (per Linus's review): operational metrics belong in their own view, not
-- the Phase 1 exit gate surface. v_phase1_metrics is already 15+
-- columns and another view rebuild cycle is expensive.
--
-- Two primary metrics, computed over a 14d rolling window of email-draft
-- action_proposals:
--
--   knowledge_citation_rate_pct
--     Of all drafts, what fraction emitted at least one [wiki:slug] or
--     [doc:id] citation in their body. Measures whether the LLM is
--     actually drawing on the RELEVANT KNOWLEDGE section that
--     lib/runtime/context-loader.js Phase 2 surfaces. Will read 0%
--     until STAQPRO-311 Phase 3 (PR #200) lands and agents start
--     emitting citations — by design; the view is a measurement tool.
--
--   kept_citation_rate_pct
--     Of drafts that emitted a citation AND have been acted on by the
--     board (approved | edited | rejected — pending drafts excluded
--     from the denominator), what fraction were approved without
--     edits. Pending citations are not "kept" yet — only acted-on
--     decisions count. A high value here means citations are useful
--     signal, not noise.
--
-- Plus diagnostic counters so the metrics are debuggable from a
-- single SELECT against the view.
--
-- Regex: `\[(wiki|doc):` matches both citation prefixes the responder
-- and strategist emit (Phase 3). Uses `~*` for case-insensitive match
-- — the format the agents emit is lowercase but defensive against
-- future format drift.
--
-- Refs: STAQPRO-311 Phase 4, plan
-- ~/.claude/plans/let-me-pause-and-magical-codd.md.

CREATE OR REPLACE VIEW agent_graph.v_wiki_metrics AS
WITH drafts_14d AS (
  SELECT
    id,
    board_action,
    body ~* '\[(wiki|doc):' AS has_citation,
    board_action IS NOT NULL AS is_acted_on
  FROM agent_graph.action_proposals
  WHERE action_type = 'email_draft'
    AND created_at >= (now() - INTERVAL '14 days')
)
SELECT
  -- 1. Knowledge citation rate: % of drafts that emitted a citation.
  --    Denominator = all drafts in window. NULL when no drafts yet
  --    (avoids divide-by-zero misreading as 0%).
  (SELECT
     CASE
       WHEN count(*) > 0
         THEN round(100.0 * count(*) FILTER (WHERE has_citation) / count(*), 2)
       ELSE NULL
     END
   FROM drafts_14d) AS knowledge_citation_rate_pct,

  -- 2. Kept citation rate: of cited+acted-on drafts, % approved
  --    without edits. Excludes pending citations from denominator
  --    — they haven't been judged yet, so they don't count for or
  --    against the human-kept-it signal.
  (SELECT
     CASE
       WHEN count(*) FILTER (WHERE has_citation AND is_acted_on) > 0
         THEN round(
           100.0
           * count(*) FILTER (WHERE has_citation AND board_action = 'approved')
           / count(*) FILTER (WHERE has_citation AND is_acted_on),
           2
         )
       ELSE NULL
     END
   FROM drafts_14d) AS kept_citation_rate_pct,

  -- 3. Diagnostics: bare counts so it's easy to read what's happening
  --    even when the percentage metrics are NULL or surprising.
  (SELECT count(*) FROM drafts_14d) AS total_drafts_14d,
  (SELECT count(*) FROM drafts_14d WHERE has_citation) AS cited_drafts_14d,
  (SELECT count(*) FROM drafts_14d WHERE has_citation AND board_action = 'approved') AS cited_approved_14d,
  (SELECT count(*) FROM drafts_14d WHERE has_citation AND board_action = 'edited')   AS cited_edited_14d,
  (SELECT count(*) FROM drafts_14d WHERE has_citation AND board_action = 'rejected') AS cited_rejected_14d,
  (SELECT count(*) FROM drafts_14d WHERE has_citation AND board_action IS NULL)      AS cited_pending_14d;

COMMENT ON VIEW agent_graph.v_wiki_metrics IS
  'STAQPRO-311 Phase 4: approval-weighted grounding metrics for the '
  'wiki-in-prompts initiative. knowledge_citation_rate_pct measures '
  'whether agents cite the RELEVANT KNOWLEDGE section context-loader '
  'surfaces; kept_citation_rate_pct measures whether humans keep '
  'those citations on approval. 14d rolling window over email_draft '
  'action_proposals. Separate from v_phase1_metrics (operational '
  'metric, not a Phase 1 exit gate).';

-- Verification: ensure the view is queryable and returns one row
-- with all eight expected columns.
DO $$
DECLARE
  v_total       BIGINT;
  v_cite_rate   NUMERIC;
  v_kept_rate   NUMERIC;
BEGIN
  SELECT total_drafts_14d, knowledge_citation_rate_pct, kept_citation_rate_pct
    INTO v_total, v_cite_rate, v_kept_rate
    FROM agent_graph.v_wiki_metrics;

  RAISE NOTICE '[110] v_wiki_metrics: total_drafts_14d=%, knowledge_citation_rate_pct=%, kept_citation_rate_pct=%',
    v_total, v_cite_rate, v_kept_rate;
END $$;
