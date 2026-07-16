-- Migration 124 — approval state on engagements.generated_proposals
--
-- Until now, every Generate-tailored-proposal call produced a row in
-- engagements.generated_proposals that lived in history and that was it.
-- The contract drafting flow needs a single "this is the version we're
-- committing to" anchor so we know which proposal markdown to feed the
-- legal-template merge.
--
-- Change
-- ------
--   1. approved_at / approved_by columns on engagements.generated_proposals
--   2. Partial unique index: at most one approved tailored-client row per
--      engagement at a time. Generic templates are excluded — they're not
--      committed-to-client artifacts.
--   3. Loosen engagements.spec_edits.change_kind CHECK to allow
--      'proposal_approved' / 'proposal_unapproved' so the existing audit
--      trail captures the lifecycle without a new table.

ALTER TABLE engagements.generated_proposals
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by  TEXT;

-- One approved tailored proposal per engagement at any given time. The
-- approve endpoint clears the previous one before stamping the new one,
-- so we never block legitimate supersession.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_proposals_one_approved
  ON engagements.generated_proposals (engagement_id)
  WHERE approved_at IS NOT NULL AND mode = 'tailored-client';

CREATE INDEX IF NOT EXISTS idx_generated_proposals_approved_lookup
  ON engagements.generated_proposals (engagement_id, approved_at DESC)
  WHERE approved_at IS NOT NULL;

-- Loosen the spec_edits CHECK to record approval lifecycle. The audit
-- table is the canonical P3 trail for everything that happens to an
-- engagement — adding two more kinds keeps that promise intact.
ALTER TABLE engagements.spec_edits
  DROP CONSTRAINT IF EXISTS spec_edits_change_kind_check;

ALTER TABLE engagements.spec_edits
  ADD CONSTRAINT spec_edits_change_kind_check
  CHECK (change_kind IN (
    'edit',
    'pin',
    'unpin',
    'section_add',
    'section_remove',
    'section_reorder',
    'synth_skip_pin',
    'section_proposal_new',
    'section_proposal_accept',
    'section_proposal_reject',
    'proposal_approved',
    'proposal_unapproved'
  ));

DO $$ BEGIN
  RAISE NOTICE '[124] generated_proposals approval columns + spec_edits kinds';
END $$;
