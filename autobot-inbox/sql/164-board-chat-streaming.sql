-- 164: Board chat streaming support (chat overhaul P1)
--
-- status: assistant rows are inserted at stream start with status='streaming'
-- and content='' so a crashed/aborted turn is never silently lost; periodic
-- flushes update content; the final flush sets status='complete' (or 'error').
-- History reload renders 'streaming' rows as partial with a regenerate
-- affordance.
--
-- feedback: board thumbs up/down on assistant messages (-1 / 1, NULL = none).
-- Consumed by the P5 self-improvement loop (failure memories).

ALTER TABLE agent_graph.board_chat_messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'complete';

ALTER TABLE agent_graph.board_chat_messages
  ADD COLUMN IF NOT EXISTS feedback smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_messages_status_check'
  ) THEN
    ALTER TABLE agent_graph.board_chat_messages
      ADD CONSTRAINT board_chat_messages_status_check
      CHECK (status IN ('streaming', 'complete', 'error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'board_chat_messages_feedback_check'
  ) THEN
    ALTER TABLE agent_graph.board_chat_messages
      ADD CONSTRAINT board_chat_messages_feedback_check
      CHECK (feedback IS NULL OR feedback IN (-1, 1));
  END IF;
END $$;
