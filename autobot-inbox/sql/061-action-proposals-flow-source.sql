-- 061: Allow flow-originated email drafts without a message_id.
--
-- Background
-- ----------
-- `action_proposals_email_requires_fields` enforces that every row with
-- action_type='email_draft' has message_id, to_addresses, and channel.
-- This invariant assumes the pipeline path: orchestrator creates a real
-- inbox.messages row first, then the responder drafts against it.
--
-- Flow-invoked drafts (via flow-wrappers/compose-reply.js) don't have a
-- real inbox.messages row — they're composed from a flat flow payload.
-- Without relaxing this constraint, compose_reply in a flow fails at
-- the responder handler's INSERT.
--
-- Change
-- ------
-- 1. Add a `source` discriminator column (default 'pipeline' preserves
--    existing behaviour).
-- 2. BEFORE INSERT trigger: when the parent work_item.metadata has
--    source='flow', stamp the proposal's source='flow' too. This keeps
--    the responder handler untouched — the discriminator is derived
--    structurally from the work item, not from a handler write.
-- 3. Replace the CHECK to still require message_id for source='pipeline'
--    but only require to_addresses + channel for source='flow'.
--
-- Pipeline invariant preserved: nothing with source='pipeline' can skip
-- message_id. Flow drafts are distinguishable by source='flow' for
-- dashboard filtering (matches work_items.metadata.source='flow').

ALTER TABLE agent_graph.action_proposals
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pipeline'
  CHECK (source IN ('pipeline', 'flow'));

-- BEFORE INSERT trigger: derive source from the parent work_item.
-- This runs before the row-level CHECK, so the relaxed constraint sees
-- the correct source without requiring every call site to set it.
CREATE OR REPLACE FUNCTION agent_graph.stamp_action_proposal_source()
RETURNS TRIGGER AS $$
DECLARE
  wi_source TEXT;
BEGIN
  IF NEW.work_item_id IS NOT NULL AND NEW.source = 'pipeline' THEN
    SELECT metadata->>'source' INTO wi_source
    FROM agent_graph.work_items
    WHERE id = NEW.work_item_id;

    IF wi_source = 'flow' THEN
      NEW.source := 'flow';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_stamp_action_proposal_source ON agent_graph.action_proposals;
CREATE TRIGGER tg_stamp_action_proposal_source
  BEFORE INSERT ON agent_graph.action_proposals
  FOR EACH ROW
  EXECUTE FUNCTION agent_graph.stamp_action_proposal_source();

ALTER TABLE agent_graph.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_email_requires_fields;

ALTER TABLE agent_graph.action_proposals
  ADD CONSTRAINT action_proposals_email_requires_fields
  CHECK (
    action_type != 'email_draft'
    OR (
      to_addresses IS NOT NULL
      AND channel IS NOT NULL
      AND (
        source = 'flow'
        OR message_id IS NOT NULL
      )
    )
  );

-- Index on source so dashboards can cheaply filter flow-originated drafts
-- out of pipeline views (mirrors work_items.metadata->>'source' filtering).
CREATE INDEX IF NOT EXISTS idx_action_proposals_source
  ON agent_graph.action_proposals (source)
  WHERE source = 'flow';
