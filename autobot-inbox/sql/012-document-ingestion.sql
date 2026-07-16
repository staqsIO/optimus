-- 012: Document ingestion pipeline (brain-rag consolidation)
-- Adds document + chunk storage with pgvector embeddings to content schema.
-- Ported from staqsIO/brain-rag Supabase migrations, adapted for Optimus.

-- Ensure pgvector is available (already in 001-baseline, but be safe)
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents: one per ingested file, transcript, paste, or email
CREATE TABLE IF NOT EXISTS content.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,             -- 'drive', 'email', 'upload', 'transcript', 'webhook'
  source_id TEXT NOT NULL,          -- dedup key (file ID, message ID, tldv meeting ID)
  title TEXT,
  raw_text TEXT NOT NULL,
  format TEXT DEFAULT 'plain',      -- 'plain', 'tldv', 'markdown', 'html'
  metadata JSONB DEFAULT '{}',      -- source-specific (speaker info, timestamps, etc.)
  owner_id UUID REFERENCES agent_graph.board_members(id),
  sanitized BOOLEAN DEFAULT false,
  threat_count INT DEFAULT 0,
  token_count INT,
  embedding_model TEXT,             -- model used for chunk embeddings (model-agnostic)
  embedding_dimensions INT,         -- vector dimensions used
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON content.documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON content.documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_created ON content.documents(created_at DESC);

-- Chunks: embedded segments of documents
CREATE TABLE IF NOT EXISTS content.chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES content.documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  text TEXT NOT NULL,
  token_count INT,
  embedding vector(1536),           -- OpenAI text-embedding-3-small default
  metadata JSONB DEFAULT '{}',      -- speaker, timestamp from transcript segments
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON content.chunks(document_id);

-- HNSW index for similarity search (brain-rag used HNSW, better than IVFFlat for our scale)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content.chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- match_chunks(): similarity search RPC
-- Ported from brain-rag, adapted for Optimus (no tenant_id, uses owner_id filter)
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
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE sql STABLE;
