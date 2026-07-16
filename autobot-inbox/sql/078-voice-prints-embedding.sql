-- Generalize voice.voice_prints so it can hold either an opaque vendor
-- profile (Picovoice Eagle, BYTEA) or a numeric speaker embedding
-- (Transformers.js / HF inference / etc., pgvector). Whichever engine is
-- active populates the relevant column; the other stays NULL.
--
-- The `embedder` column records which engine produced the row so match
-- time can dispatch correctly without re-deriving the choice.

ALTER TABLE voice.voice_prints
  ALTER COLUMN profile DROP NOT NULL;

ALTER TABLE voice.voice_prints
  ADD COLUMN IF NOT EXISTS embedding vector(512);

ALTER TABLE voice.voice_prints
  ADD COLUMN IF NOT EXISTS embedder TEXT NOT NULL DEFAULT 'transformers'
    CHECK (embedder IN ('transformers', 'eagle', 'hf-inference'));

-- At least one of the two storage forms must be populated.
ALTER TABLE voice.voice_prints
  ADD CONSTRAINT voice_prints_payload_check
    CHECK (profile IS NOT NULL OR embedding IS NOT NULL);

-- HNSW for cosine distance over speaker embeddings — small N, but cheap to
-- build and keeps the matching path consistent with the rest of our pgvector
-- usage (RAG chunks, voice profiles).
CREATE INDEX IF NOT EXISTS voice_prints_embedding_cosine_idx
  ON voice.voice_prints USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
