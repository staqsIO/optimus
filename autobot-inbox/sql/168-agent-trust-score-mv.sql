-- 168-agent-trust-score-mv.sql
-- OPT-82: Per-agent trust score — reification of P5 ("measure before you trust").
--
-- WHAT THIS IS
-- A materialized view, keyed per agent, that computes a composite TRUST SCORE
-- in [0,1] from OBSERVABLE, STRUCTURAL signals already emitted by the task
-- graph and audit tables. No component is LLM-inferred or self-reported by the
-- agent (P2: infrastructure enforces; prompts advise; P3: derived from the
-- side-effect logs of operating, not from a feature an agent chooses to provide).
--
-- WHY A MATERIALIZED VIEW
-- The inputs are append-only audit tables (state_transitions, work_items,
-- skill_performance, llm_invocations). The score is a pure deterministic
-- aggregate over them, so it is cheap to recompute on a schedule and must never
-- drift from the data. Reads are hot (board surfaces, future autonomy gating),
-- writes are nonexistent — exactly the MV trade-off.
--
-- OBSERVE-ONLY (IMPORTANT)
-- This migration ONLY exposes the score. It does NOT gate, graduate, or demote
-- any agent's autonomy level (L0–L3). Today autonomy levels in config/agents.json
-- are CONFIGURED, not EARNED. Wiring the score into actual autonomy graduation
-- (an agent may only graduate when the data supports it) is a deliberate
-- FOLLOW-UP, enforced in the orchestration layer (guardCheck), not here. Nothing
-- reads agent_trust_scores for an enforcement decision yet.
--
-- COMPONENTS (each in [0,1], all structural / observable)
--   1. gate_pass_rate        — fraction of this agent's state transitions over
--                              the window that landed in a HEALTHY state vs a
--                              guard/gate FAILURE state (failed/blocked/timed_out).
--                              Source: agent_graph.state_transitions.to_state.
--   2. retro_outcome_rate    — success_count / total_runs from the native
--                              retrospector aggregates (G11 feedback loop).
--                              Source: agent_graph.skill_performance.
--   3. retry_health          — 1 - (avg retry_count / RETRY_CAP). Work that the
--                              agent completes/owns with few retries scores high.
--                              Source: agent_graph.work_items.retry_count.
--   4. cost_stability        — 1 - normalized coefficient of variation of this
--                              executor's per-invocation cost. Predictable spend
--                              = trustworthy; wild cost variance = not yet.
--                              Source: agent_graph.llm_invocations.cost_usd.
--
-- COMPOSITE
--   trust_score = w1*gate_pass_rate + w2*retro_outcome_rate
--               + w3*retry_health   + w4*cost_stability
--   with weights (0.40, 0.25, 0.20, 0.15). Components with NO observations in
--   the window are treated as NULL and EXCLUDED from both numerator and the
--   weight denominator (an agent is not penalized for signals it cannot yet
--   produce — P5: pass on data, not on absence of data). sample_size carries the
--   evidence volume so a consumer can require a minimum before trusting a score.
--
-- WINDOW: trailing 30 days (TRUST_WINDOW). Deterministic, recomputed on refresh.
--
-- TENANCY: agent_graph.agent_configs and the audit tables are ORG-INTERNAL
-- (single Optimus org operates all agents); none of these carry owner_org_id, so
-- the MV is intentionally NOT org-keyed. When agents become multi-org this MV
-- gains an owner_org_id column alongside the audit tables, not before (P1: don't
-- invent a tenancy boundary the data doesn't have).

-- ---------------------------------------------------------------------------
-- Materialized view
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS agent_graph.agent_trust_scores;

CREATE MATERIALIZED VIEW agent_graph.agent_trust_scores AS
WITH
-- 1. Gate / guard pass rate from state transitions this agent drove.
--    Healthy landing states = pass; failure landing states = fail. Structural:
--    the orchestration layer writes the to_state, the agent cannot forge it.
gate AS (
  SELECT
    st.agent_id,
    COUNT(*) FILTER (
      WHERE st.to_state NOT IN ('failed', 'blocked', 'timed_out')
    )::numeric
      / NULLIF(COUNT(*), 0)                          AS gate_pass_rate,
    COUNT(*)                                          AS gate_transitions
  FROM agent_graph.state_transitions st
  WHERE st.created_at >= now() - interval '30 days'
  GROUP BY st.agent_id
),
-- 2. Retrospector outcome rate (G11 native feedback aggregates).
retro AS (
  SELECT
    sp.agent_id,
    SUM(sp.success_count)::numeric
      / NULLIF(SUM(sp.total_runs), 0)                 AS retro_outcome_rate,
    SUM(sp.total_runs)                                AS retro_runs
  FROM agent_graph.skill_performance sp
  GROUP BY sp.agent_id
),
-- 3. Retry health from work items this agent owns. Lower avg retries = higher
--    health. RETRY_CAP = 3 (the escalate-after-3 contract in CLAUDE.md §3).
retry AS (
  SELECT
    wi.assigned_to                                    AS agent_id,
    GREATEST(
      0,
      1 - (AVG(wi.retry_count) / 3.0)
    )                                                 AS retry_health,
    COUNT(*)                                          AS retry_items
  FROM agent_graph.work_items wi
  WHERE wi.assigned_to IS NOT NULL
    AND wi.status IN ('completed', 'failed', 'cancelled', 'timed_out')
    AND wi.updated_at >= now() - interval '30 days'
  GROUP BY wi.assigned_to
),
-- 4. Cost stability = 1 - clamp(coefficient of variation) of per-invocation
--    cost. CV = stddev/mean. Predictable cost => stable => trustworthy.
--    Requires >= 2 metered invocations; otherwise NULL (no variance signal).
cost AS (
  SELECT
    li.agent_id,
    CASE
      WHEN COUNT(*) < 2 OR AVG(li.cost_usd) <= 0 THEN NULL
      ELSE GREATEST(
        0,
        1 - LEAST(
          1,
          STDDEV_SAMP(li.cost_usd) / NULLIF(AVG(li.cost_usd), 0)
        )
      )
    END                                               AS cost_stability,
    COUNT(*)                                          AS cost_invocations
  FROM agent_graph.llm_invocations li
  WHERE li.created_at >= now() - interval '30 days'
  GROUP BY li.agent_id
),
-- Spine: every known agent (so a brand-new agent appears with NULL components
-- and a 0-evidence score rather than being absent).
agents AS (
  SELECT id AS agent_id, agent_type FROM agent_graph.agent_configs
),
components AS (
  SELECT
    a.agent_id,
    a.agent_type,
    g.gate_pass_rate,
    r.retro_outcome_rate,
    rt.retry_health,
    c.cost_stability,
    COALESCE(g.gate_transitions, 0)  AS gate_transitions,
    COALESCE(r.retro_runs, 0)        AS retro_runs,
    COALESCE(rt.retry_items, 0)      AS retry_items,
    COALESCE(c.cost_invocations, 0)  AS cost_invocations
  FROM agents a
  LEFT JOIN gate  g  ON g.agent_id  = a.agent_id
  LEFT JOIN retro r  ON r.agent_id  = a.agent_id
  LEFT JOIN retry rt ON rt.agent_id = a.agent_id
  LEFT JOIN cost  c  ON c.agent_id  = a.agent_id
)
SELECT
  comp.agent_id,
  comp.agent_type,
  comp.gate_pass_rate,
  comp.retro_outcome_rate,
  comp.retry_health,
  comp.cost_stability,
  comp.gate_transitions,
  comp.retro_runs,
  comp.retry_items,
  comp.cost_invocations,
  (comp.gate_transitions + comp.retro_runs
     + comp.retry_items + comp.cost_invocations)      AS sample_size,
  -- Weighted mean over ONLY the components that have data. Each weight is added
  -- to the denominator iff its component is non-NULL, so absent signals neither
  -- contribute nor penalize. Result is NULL when the agent has zero evidence.
  CASE
    WHEN (
      (CASE WHEN comp.gate_pass_rate     IS NOT NULL THEN 0.40 ELSE 0 END) +
      (CASE WHEN comp.retro_outcome_rate IS NOT NULL THEN 0.25 ELSE 0 END) +
      (CASE WHEN comp.retry_health       IS NOT NULL THEN 0.20 ELSE 0 END) +
      (CASE WHEN comp.cost_stability     IS NOT NULL THEN 0.15 ELSE 0 END)
    ) = 0 THEN NULL
    ELSE round(
      (
        COALESCE(comp.gate_pass_rate     * 0.40, 0) +
        COALESCE(comp.retro_outcome_rate * 0.25, 0) +
        COALESCE(comp.retry_health       * 0.20, 0) +
        COALESCE(comp.cost_stability     * 0.15, 0)
      )
      / (
        (CASE WHEN comp.gate_pass_rate     IS NOT NULL THEN 0.40 ELSE 0 END) +
        (CASE WHEN comp.retro_outcome_rate IS NOT NULL THEN 0.25 ELSE 0 END) +
        (CASE WHEN comp.retry_health       IS NOT NULL THEN 0.20 ELSE 0 END) +
        (CASE WHEN comp.cost_stability     IS NOT NULL THEN 0.15 ELSE 0 END)
      )
    , 4)
  END                                                 AS trust_score,
  now()                                               AS computed_at
FROM components comp;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- UNIQUE index on the key is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY
-- (Postgres needs it to diff rows). One row per agent guarantees uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS agent_trust_scores_agent_id_uq
  ON agent_graph.agent_trust_scores (agent_id);

-- Leaderboard / threshold scans (e.g. "agents above 0.85 with >=N samples").
CREATE INDEX IF NOT EXISTS agent_trust_scores_score_idx
  ON agent_graph.agent_trust_scores (trust_score DESC NULLS LAST);

COMMENT ON MATERIALIZED VIEW agent_graph.agent_trust_scores IS
  'OPT-82 / P5: per-agent composite trust score in [0,1] from observable audit '
  'signals (gate pass rate, retrospector outcomes, retry health, cost stability). '
  'OBSERVE-ONLY — not yet wired into autonomy graduation. Refreshed on a schedule '
  'by src/runtime/trust-scores.js (REFRESH MATERIALIZED VIEW CONCURRENTLY).';
