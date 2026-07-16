-- 155-enrichment-queue-processing-index.sql
-- OPT-93 (Feature 004 item 2): the enrichment WORKER (consumer) over the durable
-- content.enrichment_queue producer + pg_notify('capture_ingested') trigger
-- shipped in OPT-92 / migration 154.
--
-- WHAT THIS ADDS: a single partial index supporting the worker's startup
-- orphan-reset scan. On boot the worker resets crash-orphaned rows:
--
--   UPDATE content.enrichment_queue
--      SET status = 'pending'
--    WHERE status = 'processing'
--      AND updated_at < now() - interval '5 minutes';
--
-- 154 already has idx_enrichment_queue_pending (created_at) WHERE status='pending'
-- which serves the atomic FOR UPDATE SKIP LOCKED claim. The orphan reset filters
-- on a DIFFERENT predicate (status='processing', ordered by updated_at), so it
-- gets its own narrow partial index. Both indexes are tiny — the queue drains to
-- near-empty in steady state.
--
-- No new column, no new table. Idempotent: CREATE INDEX IF NOT EXISTS. Runs
-- best-effort at startup and against PGlite.

CREATE INDEX IF NOT EXISTS idx_enrichment_queue_processing
  ON content.enrichment_queue (updated_at)
  WHERE status = 'processing';

COMMENT ON INDEX content.idx_enrichment_queue_processing IS
  'OPT-93: supports the enrichment worker''s startup orphan-reset scan '
  '(status=processing AND updated_at < now() - 5min).';
