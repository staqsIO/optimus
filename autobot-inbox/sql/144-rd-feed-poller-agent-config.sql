-- 144: Register `rd-feed-poller` as an agent_config so the research-source
-- poller's LLM / web_search / embedding spend can be recorded to
-- agent_graph.llm_invocations (which has a FK to agent_configs.id) and thus
-- become visible to G10 (per-agent daily-spend cap) and the financial cost
-- dashboards / M6 daily-cost views. NOTE: this does NOT wire the G1 budgets
-- envelope (that is an atomic reserve→commit on agent_graph.budgets, not a
-- row insert); the poller self-enforces a daily cap instead. See STAQPRO-601.
--
-- This is a METERING IDENTITY, not a runtime agent loop:
--   * is_active = false  → excluded from agent-loop boot, prompt-drift monitors,
--     and tier audits (which scan WHERE is_active = true). It does NOT gate the
--     FK or the G10 daily-spend SUM, both of which match on agent_id regardless.
--   * Not added to config/agents.json on purpose — agents.json drives which agent
--     loops start; the poller is a scheduled service, not an interactive agent.
--
-- Idempotent: safe to re-run.
INSERT INTO agent_graph.agent_configs
  (id, agent_type, model, system_prompt, tools_allowed, config_hash, is_active, guardrails)
VALUES (
  'rd-feed-poller',
  'executor',
  'gpt-4o-mini',
  'Scheduled research-source poller (rd-feed-poller). Metering identity for web_search + embedding spend incurred by the feed/topic-search ingestion service. Not an interactive agent loop.',
  ARRAY['web_search', 'embed', 'ingest'],
  'static-rd-feed-poller-v1',
  false,
  -- G10 only: spend is recorded to llm_invocations (G10's SUM source). G1 is
  -- NOT wired here — see the header note. Don't imply enforcement we don't have.
  ARRAY['G10']
)
ON CONFLICT (id) DO NOTHING;
