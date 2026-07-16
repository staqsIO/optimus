-- Migration 119 — engagements.generated_proposals
--
-- Persist every proposal/template generation so the user has a history.
-- Previously: each Generate .docx call produced a one-off file and
-- nothing was saved. Re-generating wiped any context of prior outputs.
-- Now: every generation produces a row with the markdown, format, mode
-- (generic-template vs tailored-client), cost, and the URL when sent to
-- Google Doc. Users can re-download any prior version.

CREATE TABLE IF NOT EXISTS engagements.generated_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   UUID NOT NULL REFERENCES engagements.engagements(id) ON DELETE CASCADE,
  spec_version    INT NOT NULL,
  mode            TEXT NOT NULL
    CHECK (mode IN ('generic-template', 'tailored-client')),
  format          TEXT NOT NULL
    CHECK (format IN ('md', 'docx', 'gdoc')),
  markdown        TEXT NOT NULL,
  gdoc_url        TEXT,
  gdoc_id         TEXT,
  cost_usd        NUMERIC(10, 6),
  model_key       TEXT,
  generated_by    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_proposals_engagement
  ON engagements.generated_proposals (engagement_id, created_at DESC);

DO $$
BEGIN
  RAISE NOTICE '[119] generated_proposals table created';
END $$;
