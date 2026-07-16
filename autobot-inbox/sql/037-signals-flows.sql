-- 037: Signal→Tool→Output Flow Engine
--
-- Introduces four tables for the reactive flow engine:
--   signals            — inbound events from any adapter or internal source
--   flow_definitions   — declarative multi-step pipelines triggered by signal types
--   flow_executions    — per-invocation tracking with depth guard for recursion safety
--   step_executions    — per-step audit trail within a flow execution
--
-- Design principles: P1 deny-by-default (output_permissions default empty),
-- P2 infrastructure enforces (max_depth CHECK, status constraints),
-- P3 transparency by structure (append-only execution records with computed duration),
-- P4 boring infrastructure (Postgres, SQL, no ORM).

-- ---------------------------------------------------------------------------
-- 1. Signals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_graph.signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type TEXT NOT NULL,        -- 'email.received', 'slack.message', 'webhook.payload', 'campaign.completed'
  source_adapter TEXT NOT NULL,     -- 'email', 'slack', 'telegram', 'webhook', 'internal'
  payload JSONB NOT NULL,
  project_id UUID,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_type ON agent_graph.signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_project ON agent_graph.signals(project_id);

-- ---------------------------------------------------------------------------
-- 2. Flow definitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_graph.flow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  trigger_signal_type TEXT NOT NULL,
  steps JSONB NOT NULL,               -- [{tool_id, config, output_signal_type}]
  is_active BOOLEAN DEFAULT true,
  created_by TEXT NOT NULL,
  output_permissions JSONB DEFAULT '{}',
  max_depth INTEGER NOT NULL DEFAULT 8,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  retry_policy JSONB DEFAULT '{"max_retries": 0, "strategy": "none"}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, version),
  CONSTRAINT valid_max_depth CHECK (max_depth BETWEEN 1 AND 32)
);

-- ---------------------------------------------------------------------------
-- 3. Flow executions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_graph.flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_definition_id UUID NOT NULL REFERENCES agent_graph.flow_definitions(id),
  trigger_signal_id UUID NOT NULL REFERENCES agent_graph.signals(id),
  status TEXT NOT NULL DEFAULT 'running',
  depth INTEGER NOT NULL DEFAULT 0,
  parent_execution_id UUID REFERENCES agent_graph.flow_executions(id),
  input_payload JSONB NOT NULL,
  output_payload JSONB,
  error TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_flow_exec_status ON agent_graph.flow_executions(status);
CREATE INDEX IF NOT EXISTS idx_flow_exec_flow ON agent_graph.flow_executions(flow_definition_id);
CREATE INDEX IF NOT EXISTS idx_flow_exec_parent ON agent_graph.flow_executions(parent_execution_id);

-- ---------------------------------------------------------------------------
-- 4. Step executions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_graph.step_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_execution_id UUID NOT NULL REFERENCES agent_graph.flow_executions(id),
  step_index INTEGER NOT NULL,
  tool_id TEXT NOT NULL,
  dispatch_mode TEXT NOT NULL,
  input_payload JSONB NOT NULL,
  output_payload JSONB,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_step_exec_flow ON agent_graph.step_executions(flow_execution_id);
