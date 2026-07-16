-- 031: Add 'sending' to action_proposals send_state CHECK constraint.
-- Required for atomic double-send prevention: sendApprovedDraft() claims the
-- 'sending' state as a lock before calling the Gmail API.

ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_send_state_check;

ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_send_state_check
  CHECK (send_state IN ('pending', 'reviewed', 'approved', 'staged', 'sending', 'delivered', 'cancelled'));
