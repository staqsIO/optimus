-- 047: Retrospective tracking for native feedback loop (G11)
-- Hermes-inspired auto-retrospective, built natively with P2/P3 compliance.
-- Two tables: skill_performance (aggregated stats) + retrospective_log (audit trail).

-- Skill performance: aggregated per agent+event_type+tool_name (UPSERT pattern)
-- Feeds back into context-loader for "what am I good/bad at" data (P2: structural, not instructional)
CREATE TABLE IF NOT EXISTS agent_graph.skill_performance (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  tool_name       TEXT DEFAULT '_task',
  total_runs      INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  fail_count      INTEGER DEFAULT 0,
  total_duration_ms BIGINT DEFAULT 0,
  total_cost_usd  NUMERIC(10,6) DEFAULT 0,
  last_run_at     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, event_type, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_skill_perf_agent
  ON agent_graph.skill_performance(agent_id, success_count DESC);

-- Retrospective log: append-only audit trail per work_item (P3 compliant)
-- Records every retrospective decision (including 'skip') for full traceability.
CREATE TABLE IF NOT EXISTS agent_graph.retrospective_log (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  work_item_id    UUID NOT NULL,
  agent_id        TEXT NOT NULL,
  classification  TEXT NOT NULL CHECK (classification IN ('skip', 'failure', 'pattern', 'llm_retrospect')),
  route           TEXT CHECK (route IN ('tactical', 'strategic', NULL)),
  learning_type   TEXT,
  memory_id       UUID,
  intent_id       UUID,
  cost_usd        NUMERIC(10,6) DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retro_log_work_item
  ON agent_graph.retrospective_log(work_item_id);

CREATE INDEX IF NOT EXISTS idx_retro_log_agent
  ON agent_graph.retrospective_log(agent_id, created_at DESC);
