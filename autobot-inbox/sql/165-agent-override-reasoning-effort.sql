-- 165: allow chat.reasoningEffort as an agent config override field
--
-- PR #387 plumbed agent.chat.reasoningEffort through to OpenRouter's
-- reasoning parameter (caps thinking-model TTFT). Tuning it must not require
-- a deploy — same operational story as the orchestrator's model override —
-- but the field CHECK on agent_config_overrides predates dotted chat.* paths.
-- setNestedValue() in lib/runtime/agents/config-loader.js already merges
-- dotted fields into the nested agent config.

ALTER TABLE agent_graph.agent_config_overrides
  DROP CONSTRAINT IF EXISTS agent_config_overrides_field_check;

ALTER TABLE agent_graph.agent_config_overrides
  ADD CONSTRAINT agent_config_overrides_field_check
  CHECK (field IN ('model', 'temperature', 'maxTokens', 'enabled', 'chat.reasoningEffort'));
