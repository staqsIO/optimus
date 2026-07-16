-- 158-verification-spine.sql
-- Phase 1 of the 18+hr-unattended-runs effort: the self-correction verification spine.
--
-- Adds Scenario-Factory storage, a Tester verdict log, and the state-machine
-- wiring for a withhold-edge-cases -> tester -> failure-feedback loop on top of
-- the existing first-class-agent + Postgres task-graph architecture.
--
-- Design notes (verified against 001-baseline.sql):
--   * work_items.acceptance_criteria (JSONB) already exists -> holds AGENT-VISIBLE
--     scenarios only. WITHHELD scenarios live solely in work_item_scenarios and are
--     hidden from implementer agents by FORCED RLS (the secrecy guarantee, not a
--     convention). The agent context-loader must never read this table for an
--     executor app.agent_id.
--   * in_progress->review and review->in_progress ALREADY exist in valid_transitions;
--     only review->failed is missing -> added below.
--   * The state_transitions hash chain is scoped per work_item_id, so adding
--     transitions is safe under concurrent inserts.
--   * The Tester reuses agent_type 'reviewer' (satisfies the agent_configs CHECK
--     without altering it); it is a DISTINCT agent_id 'tester', separate from the
--     email-draft 'reviewer' agent which is left untouched.
--   * fix_attempts is a SEPARATE counter from retry_count: the reaper increments
--     retry_count for infra flakes, so sharing the budget would let flakes drain
--     the verification budget.

BEGIN;

-- ============================================================
-- 1. work_items: verification fix-attempt counter (independent of retry_count)
-- ============================================================
ALTER TABLE agent_graph.work_items
  ADD COLUMN IF NOT EXISTS fix_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_graph.work_items
  DROP CONSTRAINT IF EXISTS work_items_fix_attempts_bound;
ALTER TABLE agent_graph.work_items
  ADD CONSTRAINT work_items_fix_attempts_bound CHECK (fix_attempts <= 5);

-- ============================================================
-- 2. work_item_scenarios — Scenario Factory output
--    Visible scenarios are ALSO mirrored into work_items.acceptance_criteria by
--    the Factory; withheld scenarios live ONLY here and are RLS-hidden from
--    implementer agents.
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_graph.work_item_scenarios (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id  TEXT NOT NULL REFERENCES agent_graph.work_items(id) ON DELETE CASCADE,
  scenario      JSONB NOT NULL,                       -- { given, when, then }
  withheld      BOOLEAN NOT NULL DEFAULT false,       -- true = tester-only, hidden from implementer
  category      TEXT CHECK (category IN ('happy_path', 'edge_case')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wis_item ON agent_graph.work_item_scenarios(work_item_id);

-- Secrecy guarantee (Linus blocker): enforce at the DB layer, not by convention.
-- Follows the existing app.agent_id / app.role RLS pattern. FORCE is required
-- because the app may connect as the table owner, which would otherwise bypass RLS
-- and silently leak withheld rows the first time someone JOINs this table.
ALTER TABLE agent_graph.work_item_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_graph.work_item_scenarios FORCE ROW LEVEL SECURITY;

-- Implementer agents see ONLY visible scenarios. The tester (and board) see all.
CREATE POLICY scenarios_hide_withheld ON agent_graph.work_item_scenarios
  FOR SELECT USING (
    withheld = false
    OR agent_graph.current_agent_id() = 'tester'
    OR current_setting('app.role', true) = 'board'
  );

-- Only the tester (Factory writes withheld) and board may write; Factory runs
-- under its own context. Keep INSERT open like the other agent_graph tables
-- (writes are mediated by app code), but block the secrecy bypass via SELECT above.
CREATE POLICY scenarios_insert ON agent_graph.work_item_scenarios
  FOR INSERT WITH CHECK (true);

CREATE POLICY scenarios_no_delete ON agent_graph.work_item_scenarios
  FOR DELETE USING (false);

-- ============================================================
-- 3. verification_verdicts — append-only Tester verdict log
--    Plain table (NOT partitioned) by deliberate choice: a partitioned table
--    cannot enforce UNIQUE(work_item_id, attempt) without folding the partition
--    key (created_at) into the constraint, which would defeat the "one verdict
--    per attempt" guarantee that stops double-tester verdicts racing past the
--    fix-attempt budget (Linus). Correctness > partition-scale at MVP volume.
--    Scale path (Liotta): convert to monthly RANGE(created_at) partitioning once
--    verdict volume justifies it; the real uniqueness then moves to a partial
--    unique index + the tester's row-lock-on-claim already prevents the race.
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_graph.verification_verdicts (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  work_item_id     TEXT NOT NULL REFERENCES agent_graph.work_items(id) ON DELETE CASCADE,
  verdict          TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
  failure_mode     TEXT,                              -- fed back into the implementer prompt
  scenario_results JSONB,                             -- per-scenario pass/fail detail
  attempt          INTEGER NOT NULL DEFAULT 0,
  tester_agent     TEXT NOT NULL,
  cost_usd         NUMERIC(15,6) DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One verdict per (work_item, attempt): prevents double-tester verdicts racing
  -- past the fix-attempt budget.
  UNIQUE (work_item_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_vv_item ON agent_graph.verification_verdicts(work_item_id);

-- ============================================================
-- 4. State-machine wiring: add the missing review->failed transition.
--    (in_progress->review and review->in_progress already exist in baseline.)
--    allowed_roles matches on agent_id; include the tester explicitly plus '*'.
-- ============================================================
INSERT INTO agent_graph.valid_transitions (from_state, to_state, allowed_roles, required_guardrails) VALUES
  ('review', 'failed', ARRAY['tester', 'reviewer', 'orchestrator', '*'], ARRAY[]::text[])
ON CONFLICT (from_state, to_state) DO NOTHING;

-- ============================================================
-- 5. Tester agent config — distinct agent_id 'tester', agent_type 'reviewer'
--    (satisfies the agent_configs agent_type CHECK without altering it).
-- ============================================================
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, tools_allowed, config_hash) VALUES
('tester', 'reviewer', 'claude-sonnet-4-6',
 'You are the Tester agent. You verify that an executor''s completed work satisfies its acceptance scenarios — including WITHHELD edge-case scenarios the implementer never saw. Run each scenario as an observable outcome (given/when/then), not a unit test. Return a verdict: pass, or fail with a concrete, actionable failure_mode describing exactly which scenario broke and how. Do not reward plausible-but-wrong work; if an outcome cannot be observed to hold, it fails.',
 ARRAY['task_read', 'task_update'],
 'seed-v1')
ON CONFLICT (id) DO NOTHING;

COMMIT;
