-- Migration 125 — link content.drafts back to the engagement + generated_proposal
--
-- Before: contracts drafted from the engagement flow had to encode the
-- engagement/generated_proposal linkage inside seo_metadata JSON, which
-- nothing could JOIN against. We need first-class columns so the
-- engagement detail page can render "latest contract for this engagement"
-- cheaply and so the contract drafter can audit its inputs.
--
-- Cross-schema FKs are forbidden (D5/SPEC §12). We store the IDs as UUID
-- columns with indexes; the engagements schema is logically isolated.
-- ON DELETE: nothing — if an engagement or generated_proposal is removed,
-- the contract draft survives with a dangling reference (matches how
-- counterparty_id behaves when a counterparty is archived).

ALTER TABLE content.drafts
  ADD COLUMN IF NOT EXISTS engagement_id               UUID,
  ADD COLUMN IF NOT EXISTS source_generated_proposal_id UUID;

COMMENT ON COLUMN content.drafts.engagement_id IS
  'Soft reference to engagements.engagements(id). Only populated for '
  'content_type = ''contract'' drafted from an engagement-approved proposal. '
  'No cross-schema FK per D5/SPEC §12.';

COMMENT ON COLUMN content.drafts.source_generated_proposal_id IS
  'Soft reference to engagements.generated_proposals(id) — the exact approved '
  'tailored proposal that the contract drafter folded into the legal template. '
  'Enables reconstruction of the contract''s source proposal at any time.';

-- "All contracts spawned from engagement X" — used by the engagement
-- detail's latest_contract summary. Partial index since most drafts are
-- LinkedIn posts / briefings with NULL engagement_id.
CREATE INDEX IF NOT EXISTS idx_drafts_engagement
  ON content.drafts (engagement_id, created_at DESC)
  WHERE engagement_id IS NOT NULL;

-- "Which contract was drafted from this exact approved proposal" — keeps
-- the drafter idempotent: re-clicking Draft surfaces the existing draft
-- instead of producing a duplicate.
CREATE INDEX IF NOT EXISTS idx_drafts_source_generated_proposal
  ON content.drafts (source_generated_proposal_id)
  WHERE source_generated_proposal_id IS NOT NULL;

DO $$ BEGIN
  RAISE NOTICE '[125] content.drafts engagement linkage columns added';
END $$;
