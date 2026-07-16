-- NemoClaw dedicated identities (Linus security review 2026-03-30)
-- External agents get their own board_members entries with 'external_agent' role.
-- Tokens issued to these identities have narrow scope, never wildcard.

-- 1. Extend role CHECK to include external_agent
ALTER TABLE agent_graph.board_members
  DROP CONSTRAINT IF EXISTS board_members_role_check;

ALTER TABLE agent_graph.board_members
  ADD CONSTRAINT board_members_role_check
  CHECK (role IN ('admin', 'member', 'external_agent'));

-- 2. Insert NemoClaw identities
INSERT INTO agent_graph.board_members (github_username, display_name, email, role)
VALUES
  ('nemoclaw-ecgang', 'NemoClaw (Eric)', 'nemoclaw-eric@staqs.io', 'external_agent'),
  ('nemoclaw-dustin', 'NemoClaw (Dustin)', 'nemoclaw-dustin@staqs.io', 'external_agent')
ON CONFLICT (github_username) DO NOTHING;
