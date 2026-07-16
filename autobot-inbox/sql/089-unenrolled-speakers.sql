-- 089: speaker prints awaiting enrollment.
--
-- Companion table to voice.voice_prints. When a voice memo arrives and
-- lib/voice/speaker-resolver.js can't match an utterance bucket to any
-- enrolled speaker (cosine < 0.55), we now persist that speaker's
-- embedding here as a candidate. Same voice across multiple memos
-- collapses to one row via cosine match within this table, and the
-- occurrence_count climbs as the system hears them again.
--
-- The board surfaces these on the Voice Prints page; assigning one to
-- a contact promotes it into voice.voice_prints, after which the
-- standard resolver matches them automatically and no further approval
-- is ever needed.
--
-- Schema is deliberately a sibling of voice_prints rather than a column
-- on it: a row in this table has NO contact_id (the whole point — we
-- don't know who they are yet), the lifecycle is different (rows
-- disappear on approval, voice_prints rows persist), and unique
-- constraints differ (no UNIQUE(contact_id) here).

CREATE TABLE IF NOT EXISTS voice.unenrolled_speakers (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  embedding           vector(512) NOT NULL,
  embedder            TEXT NOT NULL DEFAULT 'transformers'
                          CHECK (embedder IN ('transformers', 'eagle', 'hf-inference')),
  occurrence_count    INTEGER NOT NULL DEFAULT 1,
  first_heard_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heard_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sample text from the most recent utterance — handy for the board
  -- to show "Who said this?" without needing to fetch audio.
  sample_utterance    TEXT,
  -- AssemblyAI label from the most recent memo (A | B | C | …) so the
  -- board can correlate with the transcript view.
  candidate_label     TEXT,
  -- Memos this speaker has been heard in. Audit trail; capped at ~50
  -- entries by the resolver to bound row size.
  source_memo_ids     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT unenrolled_speakers_count_positive CHECK (occurrence_count > 0)
);

-- HNSW index: cosine match a fresh embedding against existing candidates
-- in O(log n) so the resolver can dedupe within the table cheaply.
CREATE INDEX IF NOT EXISTS unenrolled_speakers_embedding_cosine_idx
  ON voice.unenrolled_speakers
  USING hnsw (embedding vector_cosine_ops);

-- Surface most-frequent candidates first on the board.
CREATE INDEX IF NOT EXISTS unenrolled_speakers_occurrence_idx
  ON voice.unenrolled_speakers (occurrence_count DESC, last_heard_at DESC);
