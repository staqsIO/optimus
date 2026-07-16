-- Migration 117 — engagements.section_change_proposals
--
-- Synth used to insert and delete spec_sections directly. Per Q4 in the
-- design pass, structural changes (add/remove) should now be queued as
-- proposals the user accepts or rejects from the UI — body edits to
-- existing sections still apply directly (they're lower-stakes and
-- already audited via spec_edits).
--
-- This decouples the synth's structural ideas from immediate mutation,
-- which protects manually-curated section structure from being silently
-- reorganized on every Re-synthesize click.

CREATE TABLE IF NOT EXISTS engagements.section_change_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id         UUID NOT NULL REFERENCES engagements.specs(id) ON DELETE CASCADE,

  -- For 'remove' proposals, this points at the section the synth wants to
  -- drop. For 'add' proposals, it's NULL — the section doesn't exist yet.
  section_id      UUID REFERENCES engagements.spec_sections(id) ON DELETE CASCADE,

  kind            TEXT NOT NULL
    CHECK (kind IN ('add', 'remove')),

  -- Proposed section payload (for 'add') or snapshot of removed section
  -- (for 'remove' — so we have what was dropped if accepted, or what would
  -- have been dropped if rejected). Shape mirrors spec_sections columns:
  -- { section_key, title, body, ordinal, is_core, provenance }
  payload         JSONB NOT NULL,

  -- Human-readable summary for the UI, e.g. "Synth proposes adding 'Open
  -- Questions' section" or "Synth proposes removing 'Communication Standards'".
  summary         TEXT NOT NULL,

  -- Why synth proposed this — e.g. "Two new proposals discussed open
  -- questions that weren't covered" or "No proposal references this section
  -- anymore." Surfaced in the accept/reject UI.
  rationale       TEXT,

  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),

  proposed_by     TEXT NOT NULL DEFAULT 'synth',
  resolved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_section_change_proposals_spec_status
  ON engagements.section_change_proposals (spec_id, status, created_at DESC);

-- Add a new change_kind to spec_edits to track section_proposal lifecycle in
-- the audit trail (proposed / accepted / rejected). We use the existing
-- 'section_add' / 'section_remove' values for the eventual mutation step,
-- and add three new ones for the proposal lifecycle:
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
      'section_reorder',         -- new: explicit reorder event
      'synth_skip_pin',
      'section_proposal_new',    -- new: synth proposed a structural change
      'section_proposal_accept', -- new: user accepted a structural change
      'section_proposal_reject'  -- new: user rejected a structural change
    ));

-- Verification
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.tables
   WHERE table_schema = 'engagements'
     AND table_name = 'section_change_proposals';
  RAISE NOTICE '[117] section_change_proposals exists: %', v_count = 1;
END $$;
