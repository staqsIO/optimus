-- Add a `viewed_at` signal to action_proposals so the auto-archive sweep
-- can wait for a human to see a draft before reaping it.
--
-- Symptom: after the May 8 audit's auto-archive sweep landed
-- (src/gmail/auto-archive-sweep.js), fresh drafts were being archived
-- before Eric ever opened the drafts page. The reconciler's two reap
-- paths (`gmail-reconciler:tier-override` for senders below the
-- DRAFTABLE_TIERS threshold, `gmail-reconciler` for Gmail-archived
-- threads) both fired within ~15 min of draft creation.
--
-- Fix: track when a draft has been surfaced to the board UI. The
-- reconciler's findCandidates query gates on
-- `viewed_at IS NOT NULL OR created_at < now() - '24 hours'::interval`,
-- so a draft survives until either:
--   (a) the user opened the drafts page (viewed_at stamped), OR
--   (b) 24 hours have elapsed (safety net so the queue can't grow
--       indefinitely if Eric stops looking).
--
-- GET /api/drafts stamps viewed_at on the rows it returns; no client
-- code change required.

ALTER TABLE agent_graph.action_proposals
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_graph.action_proposals.viewed_at IS
  'When a board user first loaded this proposal in the drafts UI. Auto-archive sweep waits for this (or a 24h timeout) before reaping (sql/115-drafts-viewed-gate.sql).';

-- Partial index helps the reconciler''s "drafts not yet viewed AND not
-- yet aged out" query stay fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_action_proposals_unviewed_pending
  ON agent_graph.action_proposals (created_at)
  WHERE board_action IS NULL AND acted_at IS NULL AND viewed_at IS NULL;
