-- 067: Signer proposals — let counterparties suggest redlines / comments
-- before signing, and let the board accept or dismiss them.
--
-- Background
-- ----------
-- Current flow: signer can only Sign or Decline. Any negotiation happens
-- out-of-band (email, phone), the board edits the draft, revokes, and
-- re-sends — with no connection back to what the signer actually asked for.
-- Stored in the chain is a binary signed/declined, which is legal truth
-- but poor operational truth.
--
-- Change
-- ------
-- Adds signatures.signer_proposals — one row per suggestion made from the
-- /sign/[token] page. Two kinds:
--   comment: freeform note ("please clarify §3")
--   redline: explicit textual edit (quoted_text → proposed_text)
--
-- When the board accepts a redline, the board UI applies the edit to the
-- live draft body (creating a new content.draft_versions row with
-- change_source='counter_proposal'), and revokes the current signature
-- request. The operator then clicks Approve + Send again to start a fresh
-- signing round, keeping the tamper chain truthful.
--
-- Non-goals (deferred)
-- --------------------
-- * Reply thread between board and signer — single note on each side for now.
-- * Automatic re-send of the signing request after accept — manual for this
--   iteration so the operator has a moment to review what else changed.
-- * Diff view of redline — that lives in the board UI layer, not here.

CREATE TABLE IF NOT EXISTS signatures.signer_proposals (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           UUID        NOT NULL REFERENCES signatures.signature_requests(id) ON DELETE CASCADE,
  signer_id            UUID        NOT NULL REFERENCES signatures.signers(id) ON DELETE CASCADE,

  -- Soft reference to content.draft_versions.id (no cross-schema FK per D5).
  -- Anchors "which body text did the signer see when they raised this?".
  draft_version_id     UUID,

  proposal_type        TEXT        NOT NULL
                         CHECK (proposal_type IN ('comment', 'redline')),

  -- quoted_text: the portion of the doc the signer is pointing at.
  -- Required for redlines (otherwise we can't apply it); optional for comments.
  quoted_text          TEXT,
  -- proposed_text: replacement text. Required for redlines.
  proposed_text        TEXT,
  -- Signer's rationale / explanation.
  note                 TEXT,

  status               TEXT        NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'accepted', 'dismissed', 'superseded')),

  -- Resolution metadata (filled when board acts)
  resolved_by          TEXT,
  resolved_at          TIMESTAMPTZ,
  resolution_note      TEXT,
  -- When an accept produces a new draft version, we link back so the
  -- history view can show which proposal drove which version.
  applied_version_id   UUID,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE signatures.signer_proposals IS
  'Signer-side redlines and comments raised from /sign/[token] before signing. '
  'Accepted redlines produce a new content.draft_versions row with '
  'change_source=''counter_proposal''; the current signature request is '
  'auto-revoked so a fresh one can be issued against the new body.';

COMMENT ON COLUMN signatures.signer_proposals.quoted_text IS
  'Required for redlines — the text in the current body the signer wants replaced. '
  'The accept flow does an exact-substring replace; if quoted_text no longer '
  'appears verbatim (board already edited it), accept fails and the operator must '
  'resolve manually.';

-- Shape-integrity: redlines must carry both quoted_text and proposed_text.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so drop-then-add for idempotency.
ALTER TABLE signatures.signer_proposals
  DROP CONSTRAINT IF EXISTS signer_proposals_redline_shape;
ALTER TABLE signatures.signer_proposals
  ADD CONSTRAINT signer_proposals_redline_shape
  CHECK (
    proposal_type = 'comment'
    OR (quoted_text IS NOT NULL AND length(quoted_text) > 0
        AND proposed_text IS NOT NULL)
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signer_proposals_request_status
  ON signatures.signer_proposals (request_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signer_proposals_signer
  ON signatures.signer_proposals (signer_id, created_at DESC);

-- RLS: board members see proposals on requests they created, same as
-- signature_events policy (migration 054). Signers write via a SECURITY
-- DEFINER path — not exposed directly.
ALTER TABLE signatures.signer_proposals ENABLE ROW LEVEL SECURITY;

-- Postgres has no `CREATE POLICY IF NOT EXISTS`, so drop-then-create for idempotency.
DROP POLICY IF EXISTS "Board sees proposals for their requests" ON signatures.signer_proposals;
CREATE POLICY "Board sees proposals for their requests"
  ON signatures.signer_proposals
  FOR SELECT
  USING (
    request_id IN (
      SELECT id FROM signatures.signature_requests
      WHERE created_by = auth.uid()::text
    )
  );
