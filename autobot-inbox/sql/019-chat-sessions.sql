-- 019-chat-sessions.sql
-- Dedicated chat sessions table for board workstation session management (Phase 3).

CREATE TABLE IF NOT EXISTS agent_graph.board_chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_user text NOT NULL,
  title text,
  agent_id text NOT NULL DEFAULT 'orchestrator',
  is_shared boolean DEFAULT false,
  pinned boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON agent_graph.board_chat_sessions (board_user, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_shared ON agent_graph.board_chat_sessions (is_shared) WHERE is_shared = true;

-- Add tool_calls column to messages for Phase 2 tool result cards
ALTER TABLE agent_graph.board_chat_messages ADD COLUMN IF NOT EXISTS tool_calls jsonb;

-- Backfill: create session records from existing messages
INSERT INTO agent_graph.board_chat_sessions (id, board_user, title, created_at, updated_at)
SELECT
  session_id,
  COALESCE(MIN(board_user), 'unknown'),
  LEFT(MIN(CASE WHEN role = 'user' THEN content END), 60),
  MIN(created_at),
  MAX(created_at)
FROM agent_graph.board_chat_messages
GROUP BY session_id
ON CONFLICT (id) DO NOTHING;
