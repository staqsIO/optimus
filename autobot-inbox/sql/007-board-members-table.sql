-- 007: Proper board member identity table + owner_id migration.
-- Replaces TEXT owner (GitHub username) with UUID FK to board_members.
-- Stable identity anchor for multi-user system (5 board members).

-- 1. Create board_members table
CREATE TABLE IF NOT EXISTS agent_graph.board_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_username TEXT UNIQUE NOT NULL,
  github_id       TEXT,           -- numeric GitHub user ID (immutable)
  display_name    TEXT NOT NULL,
  email           TEXT,
  telegram_id     TEXT,           -- for Telegram bot auth
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_graph.board_members IS 'Board member identity. Stable UUID anchor for multi-user ownership.';

-- 2. Seed initial board members
INSERT INTO agent_graph.board_members (github_username, display_name, email, role)
VALUES
  ('ecgang', 'Eric Gang', 'eric@staqs.io', 'admin'),
  ('ConsultingFuture4200', 'Dustin Powers', 'dustin@example.com', 'admin'),
  ('cboone', 'Casey Boone', 'casey@example.com', 'member')
ON CONFLICT (github_username) DO NOTHING;

-- 3. Add owner_id to inbox.accounts (FK to board_members)
ALTER TABLE inbox.accounts
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES agent_graph.board_members(id);

-- Backfill owner_id from existing owner (TEXT) column
UPDATE inbox.accounts a
SET owner_id = bm.id
FROM agent_graph.board_members bm
WHERE a.owner = bm.github_username AND a.owner_id IS NULL;

-- 4. Add owner_id to inbox.messages for signal-level ownership
ALTER TABLE inbox.messages
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES agent_graph.board_members(id);

-- Backfill messages owner_id from their account's owner_id
UPDATE inbox.messages m
SET owner_id = a.owner_id
FROM inbox.accounts a
WHERE m.account_id = a.id AND m.owner_id IS NULL AND a.owner_id IS NOT NULL;

-- 5. Add owner_id to action_proposals for draft ownership
ALTER TABLE agent_graph.action_proposals
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES agent_graph.board_members(id);

-- Backfill from messages
UPDATE agent_graph.action_proposals ap
SET owner_id = m.owner_id
FROM inbox.messages m
WHERE ap.message_id = m.id AND ap.owner_id IS NULL AND m.owner_id IS NOT NULL;
