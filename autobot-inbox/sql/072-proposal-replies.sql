-- 072: Reply thread on signer proposals.
--
-- Background
-- ----------
-- Migration 067 shipped signer_proposals with a one-shot Accept / Dismiss
-- resolution model. Real negotiations need back-and-forth: "can you
-- clarify §3?" → "sure, we meant X" → "that works, please apply as-is".
-- Without a thread, those conversations spill to email and lose their
-- connection to the contract history.
--
-- Change
-- ------
-- signatures.proposal_replies — append-only thread of messages attached
-- to a single signer_proposal. Either party (board or signer) can post.
-- Each post sends an email to the other party via the existing Resend
-- pipeline. When the proposal resolves (accepted / dismissed / superseded),
-- the thread freezes — the status gate lives in the application layer,
-- not a trigger, because we still want to read the history.

CREATE TABLE IF NOT EXISTS signatures.proposal_replies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id      UUID        NOT NULL REFERENCES signatures.signer_proposals(id) ON DELETE CASCADE,

  -- Which side authored this reply.
  actor            TEXT        NOT NULL CHECK (actor IN ('board', 'signer')),
  -- For actor='board': the x-board-user header value (github username).
  -- For actor='signer': the signer_id as text, so a thread stays coherent
  -- even if the signer's display_name is edited. Soft reference; no FK.
  actor_identity   TEXT        NOT NULL,
  -- Human-readable attribution for UI display (name, not email).
  actor_display    TEXT,

  message          TEXT        NOT NULL CHECK (length(trim(message)) > 0
                                                AND length(message) <= 5000),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE signatures.proposal_replies IS
  'Append-only message thread on a signer_proposal. Either side posts; '
  'immutability enforced by trigger. Resolution of the parent proposal '
  'does not archive the thread — the history stays readable.';

CREATE INDEX IF NOT EXISTS idx_proposal_replies_proposal
  ON signatures.proposal_replies (proposal_id, created_at);

-- Immutability — same pattern as signer_proposals' parent signature_events
CREATE OR REPLACE FUNCTION signatures.prevent_proposal_reply_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'proposal_replies rows are immutable. id=%', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_replies_immutable ON signatures.proposal_replies;
CREATE TRIGGER trg_proposal_replies_immutable
  BEFORE UPDATE OR DELETE ON signatures.proposal_replies
  FOR EACH ROW EXECUTE FUNCTION signatures.prevent_proposal_reply_modification();

-- RLS — same shape as signer_proposals (board sees replies on their requests)
ALTER TABLE signatures.proposal_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Board sees replies for their requests" ON signatures.proposal_replies;
CREATE POLICY "Board sees replies for their requests"
  ON signatures.proposal_replies
  FOR SELECT
  USING (
    proposal_id IN (
      SELECT p.id FROM signatures.signer_proposals p
      WHERE p.request_id IN (
        SELECT id FROM signatures.signature_requests
        WHERE created_by = auth.uid()::text
      )
    )
  );
