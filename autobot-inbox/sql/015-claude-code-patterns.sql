-- Migration 015: Claude Code Architecture Patterns
-- Adds tables for: context compaction, auto-classifier audit,
-- agent memory, and daemon tick logging.
-- All tables in agent_graph schema, append-only per P3.

-- ── Context Summaries (Change 3: Context Compaction) ──────────────────
-- Stores LLM-generated summaries of compacted campaign iteration history.
-- Keyed by (work_item_id, iteration_count) for idempotent re-summarization.
CREATE TABLE IF NOT EXISTS agent_graph.context_summaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  UUID NOT NULL,
  iteration_count INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  cost_usd      NUMERIC(10,6) DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_context_summary UNIQUE (work_item_id, iteration_count)
);

CREATE INDEX IF NOT EXISTS idx_context_summaries_work_item
  ON agent_graph.context_summaries (work_item_id, created_at DESC);

COMMENT ON TABLE agent_graph.context_summaries IS
  'Claude Code pattern: compacted iteration history summaries for long-running campaigns';

-- ── Auto-Classifications (Change 4: YOLO Classifier / G9) ────────────
-- Audit trail for the auto-classifier's allow/deny/review decisions.
-- Every classification is logged for governance review and rule tuning.
CREATE TABLE IF NOT EXISTS agent_graph.auto_classifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  work_item_id    UUID,
  action_type     TEXT NOT NULL,
  autonomy_level  TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'review')),
  method          TEXT NOT NULL CHECK (method IN ('table', 'llm', 'error')),
  cost_usd        NUMERIC(10,6) DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_classifications_agent
  ON agent_graph.auto_classifications (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_classifications_decision
  ON agent_graph.auto_classifications (decision, created_at DESC);

COMMENT ON TABLE agent_graph.auto_classifications IS
  'Claude Code YOLO pattern: G9 classifier audit trail for graduated autonomy';

-- ── Agent Memories (Change 5: Agent Memory System) ────────────────────
-- DB-backed persistent memory. Append-only: old memories are superseded,
-- never deleted (P3 compliance). content_hash prevents duplicate saves.
CREATE TABLE IF NOT EXISTS agent_graph.agent_memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  memory_type     TEXT NOT NULL CHECK (memory_type IN ('pattern', 'preference', 'context', 'failure')),
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  work_item_id    UUID,
  metadata        JSONB DEFAULT '{}',
  superseded_by   TEXT,            -- NULL = active; 'consolidated' = merged into newer memory
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_active
  ON agent_graph.agent_memories (agent_id, created_at DESC)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_memories_hash
  ON agent_graph.agent_memories (agent_id, content_hash)
  WHERE superseded_by IS NULL;

COMMENT ON TABLE agent_graph.agent_memories IS
  'Claude Code memdir pattern: persistent agent learnings across sessions (pattern/preference/context/failure)';

-- ── Daemon Ticks (Change 6: KAIROS Daemon Mode) ──────────────────────
-- Append-only log of tick decisions for daemon-mode agents.
-- Tracks whether the agent acted, skipped, or deferred on each tick.
CREATE TABLE IF NOT EXISTS agent_graph.daemon_ticks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('acted', 'skipped', 'deferred')),
  alert_count INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daemon_ticks_agent
  ON agent_graph.daemon_ticks (agent_id, created_at DESC);

COMMENT ON TABLE agent_graph.daemon_ticks IS
  'Claude Code KAIROS pattern: daemon tick decisions for proactive agent execution';
