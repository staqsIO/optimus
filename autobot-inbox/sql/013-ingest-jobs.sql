-- 013: Ingestion job tracking, visibility column, soft-delete support
-- Liotta: job table + polling for progress tracking
-- Liotta: visibility seam for future access control
-- Linus: soft-delete with audit trail (P3)

-- Ingestion job tracking
CREATE TABLE IF NOT EXISTS content.ingest_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source TEXT NOT NULL,              -- 'email', 'upload', 'tldv', 'drive'
  identifier TEXT,                   -- email address, filename, etc.
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|completed|failed
  total_items INT DEFAULT 0,
  processed_items INT DEFAULT 0,
  error_msg TEXT,
  started_by TEXT,                   -- board member (X-Board-User)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status
  ON content.ingest_jobs(status) WHERE status IN ('queued', 'processing');

-- Visibility column on documents (Liotta: design the seam now, defer RLS)
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'board';
-- Values: 'board' (default), 'agent-only', 'public'

-- Soft-delete column (Linus: P3 audit trail)
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Update match_chunks to exclude deleted documents
CREATE OR REPLACE FUNCTION content.match_chunks(
  query_embedding vector(1536),
  match_count INT DEFAULT 30,
  min_similarity FLOAT DEFAULT 0.15,
  filter_owner_id UUID DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  document_id UUID,
  text TEXT,
  metadata JSONB,
  similarity FLOAT
) AS $$
  SELECT
    c.id,
    c.document_id,
    c.text,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM content.chunks c
  JOIN content.documents d ON d.id = c.document_id
  WHERE 1 - (c.embedding <=> query_embedding) > min_similarity
    AND (filter_owner_id IS NULL OR d.owner_id = filter_owner_id)
    AND d.sanitized = true
    AND d.deleted_at IS NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE sql STABLE;
