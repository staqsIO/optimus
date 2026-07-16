-- Voice Memo ingest pending-transcripts table.
-- An /api/voice-memo/upload request kicks off async transcription via AssemblyAI;
-- AssemblyAI POSTs back to /api/webhooks/assemblyai when the transcript is ready.
-- This table tracks the in-flight transcripts so the callback can correlate.

CREATE TABLE IF NOT EXISTS inbox.voice_memo_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id TEXT UNIQUE NOT NULL,
  transcript_id TEXT UNIQUE NOT NULL,
  audio_url TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  primary_speaker TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  work_item_id UUID,
  message_id UUID,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS voice_memo_pending_status_idx
  ON inbox.voice_memo_pending (status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS voice_memo_pending_created_idx
  ON inbox.voice_memo_pending (created_at DESC);
