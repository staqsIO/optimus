-- 051: Permission grants for executor-writer (P2: infrastructure enforces)
-- Allows executor-writer to create PRs on external repos and generate images.

INSERT INTO agent_graph.permission_grants (agent_id, resource_type, resource_name, risk_class, credential_scope, granted_by)
VALUES
  ('executor-writer', 'api_client', 'github_content_write', 'External-Write', 'github:umbadvisors', 'migration'),
  ('executor-writer', 'api_client', 'web_fetch', 'External-Read', 'web:*', 'migration'),
  ('executor-writer', 'api_client', 'gemini_image', 'External-Write', 'google:gemini', 'migration')
ON CONFLICT (agent_id, resource_type, resource_name) DO NOTHING;
