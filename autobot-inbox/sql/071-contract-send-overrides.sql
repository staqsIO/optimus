-- 071: Log when the board overrides block-severity pre-send findings.
--
-- Background
-- ----------
-- The G2/G7 pre-send scan (lib/contracts/pre-send-check.js) returns
-- findings with severity info / warn / block. Until now they were all
-- advisory — the send endpoint didn't enforce anything. For "block"
-- severity (unusual liability, pricing that contradicts precedent,
-- etc.) we want a trail: who overrode it, why, what the findings were.
--
-- Change
-- ------
-- content.send_overrides — append-only log of every send that went
-- ahead despite block-severity findings. /api/contracts/:id/send
-- inserts a row here when the operator supplies override_reason, then
-- backfills request_id after the signing request is created.
--
-- Immutability: everything except request_id is write-once. The trigger
-- allows request_id to transition from NULL to non-NULL exactly once
-- (the post-send backfill), and blocks any other field change or
-- delete. No session-local settings or trigger toggling required.

CREATE TABLE IF NOT EXISTS content.send_overrides (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id             UUID        NOT NULL REFERENCES content.drafts(id),
  -- Optional — set after the signing request is successfully created.
  -- Cross-schema FK is prohibited (D5), so this is a soft reference.
  request_id           UUID,

  overridden_by        TEXT        NOT NULL,
  override_reason      TEXT        NOT NULL CHECK (length(trim(override_reason)) >= 10),

  -- Snapshot of the findings at override time. We don't re-run on audit
  -- because findings are LLM-generated and non-deterministic — the
  -- snapshot is the auditable artifact.
  findings             JSONB       NOT NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE content.send_overrides IS
  'Append-only log of sends that proceeded despite block-severity findings '
  'from the G2/G7 pre-send governance scan. request_id is backfilled once '
  'after send succeeds; all other fields are immutable.';

-- Immutability trigger — allows exactly one mutation: stamping request_id
-- when it was NULL. Everything else raises.
CREATE OR REPLACE FUNCTION content.prevent_send_override_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'send_overrides rows cannot be deleted. id=%', OLD.id;
  END IF;
  -- UPDATE: every field except request_id must match, and request_id
  -- can only move from NULL → non-NULL.
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.draft_id IS DISTINCT FROM NEW.draft_id
     OR OLD.overridden_by IS DISTINCT FROM NEW.overridden_by
     OR OLD.override_reason IS DISTINCT FROM NEW.override_reason
     OR OLD.findings::text IS DISTINCT FROM NEW.findings::text
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'send_overrides fields are immutable except request_id. id=%', OLD.id;
  END IF;
  IF OLD.request_id IS NOT NULL AND OLD.request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION 'send_overrides.request_id is write-once. id=%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_send_overrides_immutable ON content.send_overrides;
CREATE TRIGGER trg_send_overrides_immutable
  BEFORE UPDATE OR DELETE ON content.send_overrides
  FOR EACH ROW EXECUTE FUNCTION content.prevent_send_override_modification();

CREATE INDEX IF NOT EXISTS idx_send_overrides_draft
  ON content.send_overrides(draft_id, created_at DESC);

ALTER TABLE content.send_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users see send_overrides" ON content.send_overrides;
CREATE POLICY "Authenticated users see send_overrides"
  ON content.send_overrides
  FOR SELECT
  USING (auth.uid() IS NOT NULL);
