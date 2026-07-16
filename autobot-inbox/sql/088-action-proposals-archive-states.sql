-- 088: extend action_proposals.board_action with archive states.
--
-- Background
-- ----------
-- The Drafts page filters via /api/drafts which hides any row with
-- board_action IS NOT NULL. Today the only board_action values are
-- (approved | edited | rejected). When Eric replies to a thread directly
-- in Gmail or archives the thread without replying, the corresponding
-- proposal stays visible on the board even though it's effectively
-- handled — clutter that grows over time (audit found 130/134 proposals
-- with no board action).
--
-- This migration adds two non-human-driven archive states so the Gmail
-- reconciler can mark stale proposals automatically:
--   archived_external   — Eric replied directly in Gmail
--   archived_no_reply   — Thread archived in Gmail without an Eric reply
--
-- These are NOT 'rejected' because the reviewer verdict is still meaningful
-- (the AI draft might have been good — Eric just chose not to use it).
-- Keeping them as a distinct state preserves the ability to learn from
-- "draft was reasonable but not used" patterns later.
--
-- The row-level CHECK `send_state != 'delivered' OR board_action IS NOT NULL`
-- continues to hold trivially: archived rows have board_action set, so
-- send_state='delivered' (which never happens for archived) is allowed.

-- Find and drop the existing constraint by name. Postgres auto-names this
-- as action_proposals_board_action_check; the IF EXISTS keeps the
-- migration idempotent if the name differs.
ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_board_action_check;

ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_board_action_check
  CHECK (board_action IN (
    'approved',
    'edited',
    'rejected',
    'archived_external',
    'archived_no_reply'
  ));
