-- 023-issue-triage.sql
-- Issue triage log for the proactive triage agent.
--
-- Tracks every issue the triage agent has evaluated, with its
-- clarity score, feasibility assessment, and decision outcome.
-- UNIQUE constraint on (source, source_issue_id) provides dedup.

CREATE TABLE IF NOT EXISTS agent_graph.issue_triage_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source          TEXT NOT NULL CHECK (source IN ('linear', 'github')),
  source_issue_id TEXT NOT NULL,          -- Linear UUID or "owner/repo#number"
  source_issue_url TEXT,
  title           TEXT NOT NULL,

  -- Triage evaluation results
  clarity_score   INTEGER CHECK (clarity_score BETWEEN 1 AND 5),
  feasibility     TEXT CHECK (feasibility IN ('auto_assign', 'needs_clarification', 'board_review', 'skip')),
  scope_estimate  TEXT CHECK (scope_estimate IN ('S', 'M', 'L')),
  classification  TEXT,                   -- bug_fix, feature, research, documentation, config
  target_repos    TEXT[],                 -- resolved repo(s)
  playbook_id     TEXT,                   -- resolved playbook
  reasoning       TEXT,                   -- LLM reasoning for the decision

  -- Decision + outcome
  decision        TEXT NOT NULL CHECK (decision IN ('pending', 'auto_assigned', 'needs_clarification', 'board_review', 'skipped')),
  decision_overridden_by TEXT,
  decision_overridden_at TIMESTAMPTZ,

  -- Linkage to created work
  work_item_id    TEXT,
  campaign_id     TEXT,

  -- Raw issue data for board review
  raw_issue       JSONB,
  metadata        JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (source, source_issue_id)
);

CREATE INDEX IF NOT EXISTS idx_triage_log_decision
  ON agent_graph.issue_triage_log(decision);
CREATE INDEX IF NOT EXISTS idx_triage_log_created
  ON agent_graph.issue_triage_log(created_at DESC);
