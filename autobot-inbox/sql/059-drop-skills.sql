-- Migration 059: Drop the Skills Repository.
--
-- Migration 029 added a skills table + agent_skills view + extended
-- permission_grants/tool_invocations CHECK constraints to include 'skill'.
-- An audit on 2026-04-26 confirmed: 14 seeded skills, ZERO agents had any
-- active permission_grant for resource_type='skill', no runtime code outside
-- skill-loader.js (which itself was only consumed by api-routes/skills.js)
-- ever resolved a skill.
--
-- Tools is the real contract (enforced via tool-registry.js); Skills was
-- aspirational documentation that never wired. This migration removes it.

BEGIN;

-- 1. Remove any rows that would block constraint changes
DELETE FROM agent_graph.permission_grants WHERE resource_type = 'skill';
DELETE FROM agent_graph.tool_invocations WHERE resource_type = 'skill';

-- 2. Drop the convenience view
DROP VIEW IF EXISTS agent_graph.agent_skills;

-- 3. Tighten resource_type CHECKs back to the original allowed set
ALTER TABLE agent_graph.permission_grants
  DROP CONSTRAINT IF EXISTS permission_grants_resource_type_check;
ALTER TABLE agent_graph.permission_grants
  ADD CONSTRAINT permission_grants_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

ALTER TABLE agent_graph.tool_invocations
  DROP CONSTRAINT IF EXISTS tool_invocations_resource_type_check;
ALTER TABLE agent_graph.tool_invocations
  ADD CONSTRAINT tool_invocations_resource_type_check
  CHECK (resource_type IN ('tool', 'adapter', 'api_client', 'subprocess', 'external_api'));

-- 4. Drop the skills table
DROP TABLE IF EXISTS agent_graph.skills CASCADE;

COMMIT;
