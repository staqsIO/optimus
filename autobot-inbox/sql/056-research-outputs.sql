-- 056: agent_graph.research_outputs — canonical home for completed deep-research artifacts
--
-- Replaces the abuse of agent_graph.action_proposals (action_type='research_report')
-- as a dumping ground for research markdown. action_proposals is for outbound drafts
-- with send semantics; research outputs are read artifacts with no send.
--
-- Producer: agents/research/deep-research-handler.js (final report write).
-- Consumers: daily briefing reads recent rows; future board UI / RAG / wiki can
-- read by id without coupling to the briefing's query shape.
--
-- Related: research_iterations table (prior work) keeps the per-iteration trace;
-- this table holds only the final assembled artifact.

CREATE TABLE IF NOT EXISTS agent_graph.research_outputs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstream_id     TEXT NOT NULL,                             -- references work_items.id (no cross-schema FK per CLAUDE.md)
  objective         TEXT NOT NULL,                             -- the research question
  focus_areas       TEXT[] NOT NULL DEFAULT '{}',
  body_md           TEXT NOT NULL,                             -- the full markdown report
  key_finding       TEXT,                                      -- 1-sentence executive summary for briefing
  confidence        NUMERIC(3,2),                              -- mean of finding confidences, 0.00-1.00
  coverage_score    NUMERIC(3,2),                              -- final coverage from the loop
  source_count      INTEGER NOT NULL DEFAULT 0,
  iteration_count   INTEGER NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  staleness_window  INTERVAL NOT NULL DEFAULT '30 days',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_research_outputs_workstream
  ON agent_graph.research_outputs(workstream_id);

CREATE INDEX IF NOT EXISTS idx_research_outputs_created
  ON agent_graph.research_outputs(created_at DESC);
