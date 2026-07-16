-- 032: Per-user dashboard preferences + new board member seeds.
-- Stores customizable view preferences (widget layout, default view, etc.)
-- as JSONB per board member. Lightweight — no new schema needed.

-- 1. Create user_preferences table
CREATE TABLE IF NOT EXISTS agent_graph.user_preferences (
  board_member_id UUID PRIMARY KEY REFERENCES agent_graph.board_members(id),
  preferences     JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_graph.user_preferences IS 'Per-user dashboard preferences (widget layout, default view, collapsed nav, etc.)';

-- 2. Seed new board members (Casey already exists from 007, add Mike and Pat)
INSERT INTO agent_graph.board_members (github_username, display_name, email, role)
VALUES
  ('mikemaibach', 'Mike Maibach', 'mike@acme-advisors-group.example', 'member'),
  ('patking', 'Patrick King', 'pat@example.com', 'member')
ON CONFLICT (github_username) DO NOTHING;

-- 3. Update Casey's email if needed (was seeded in 007 with different email)
UPDATE agent_graph.board_members
SET email = 'casey@example.com'
WHERE github_username = 'cboone' AND email != 'casey@example.com';
