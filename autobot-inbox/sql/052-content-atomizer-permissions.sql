-- 052: Permission grants for content-atomizer (P2: infrastructure enforces)
-- Allows content-atomizer to call LLM for LinkedIn post generation.

INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('content-atomizer', 'api_client', 'llm_invoke', 'Internal', 'anthropic:haiku', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;
