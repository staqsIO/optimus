-- Migration 056: Contract attachments (exhibits, diagrams, supplementary docs)
-- MVP: files stored inline as BYTEA. CASCADE deletes with the parent draft.
-- Future: migrate to R2/S3 with storage_path column (one-off ETL).

CREATE TABLE IF NOT EXISTS content.contract_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES content.drafts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),  -- 25 MB cap
  content BYTEA NOT NULL,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_attachments_draft_id_idx
  ON content.contract_attachments(draft_id);

CREATE INDEX IF NOT EXISTS contract_attachments_created_at_idx
  ON content.contract_attachments(created_at DESC);

COMMENT ON TABLE content.contract_attachments IS
  'Per-contract file attachments (exhibits, diagrams). MVP stores content as BYTEA; future may move to object storage.';
