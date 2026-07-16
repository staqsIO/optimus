-- 076-voice-memo-strand-index.sql
-- Compound partial index for the reaper's voice-memo strand detector.
-- Query shape: WHERE status IN ('pending','processing') AND created_at < now() - interval 'N min'
-- Existing indexes: status_idx covers only WHERE status='pending', created_idx has no status filter.

CREATE INDEX IF NOT EXISTS voice_memo_pending_strand_detect_idx
  ON inbox.voice_memo_pending (status, created_at DESC)
  WHERE status IN ('pending', 'processing');
