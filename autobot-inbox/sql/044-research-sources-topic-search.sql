-- 044-research-sources-topic-search.sql
-- Expand feed_subscriptions into generic research sources:
-- - url_watch: monitor a known URL/feed/page
-- - topic_search: execute a fresh web query and ingest latest results

ALTER TABLE content.feed_subscriptions
  ADD COLUMN IF NOT EXISTS source_mode TEXT NOT NULL DEFAULT 'url_watch'
  CHECK (source_mode IN ('url_watch', 'topic_search'));

ALTER TABLE content.feed_subscriptions
  ADD COLUMN IF NOT EXISTS topic_query TEXT NULL;

ALTER TABLE content.feed_subscriptions
  ALTER COLUMN url DROP NOT NULL;

-- Ensure each source has the required selector for its mode
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_feed_subscriptions_mode_selector'
  ) THEN
    ALTER TABLE content.feed_subscriptions
      ADD CONSTRAINT chk_feed_subscriptions_mode_selector
      CHECK (
        (source_mode = 'url_watch' AND url IS NOT NULL)
        OR
        (source_mode = 'topic_search' AND topic_query IS NOT NULL)
      );
  END IF;
END $$;

DROP INDEX IF EXISTS uq_feed_subscriptions_scope_url;
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_subscriptions_scope_selector
  ON content.feed_subscriptions (COALESCE(project_id, ''), source_mode, COALESCE(url, ''), COALESCE(topic_query, ''));
