-- 046: Add trace_id column to llm_invocations for executor audit chain (P3 transparency)
-- The executor-adapter generates a UUID traceId per invocation. Persisting it here
-- enables correlating agent-loop LLM calls with their parent executor run.

ALTER TABLE agent_graph.llm_invocations ADD COLUMN IF NOT EXISTS trace_id TEXT;

COMMENT ON COLUMN agent_graph.llm_invocations.trace_id IS 'Executor-adapter trace UUID for correlating LLM calls to executor runs';

CREATE INDEX IF NOT EXISTS idx_llm_invocations_trace ON agent_graph.llm_invocations(trace_id) WHERE trace_id IS NOT NULL;
