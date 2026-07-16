-- 043-rd-feed-subscriptions.sql
-- RSS/Atom subscriptions for continuous R&D ingestion into the wiki pipeline.

CREATE TABLE IF NOT EXISTS content.feed_subscriptions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id TEXT NULL REFERENCES agent_graph.projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  poll_interval_ms INTEGER NOT NULL DEFAULT 900000, -- 15 minutes
  max_items_per_poll INTEGER NOT NULL DEFAULT 20,
  last_polled_at TIMESTAMPTZ NULL,
  last_success_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  last_etag TEXT NULL,
  last_modified TEXT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow same URL in different projects, but only once per scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_subscriptions_scope_url
  ON content.feed_subscriptions (COALESCE(project_id, ''), url);

CREATE INDEX IF NOT EXISTS idx_feed_subscriptions_active
  ON content.feed_subscriptions(is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_feed_subscriptions_project
  ON content.feed_subscriptions(project_id);

CREATE OR REPLACE FUNCTION content.set_feed_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feed_subscriptions_updated_at ON content.feed_subscriptions;
CREATE TRIGGER trg_feed_subscriptions_updated_at
  BEFORE UPDATE ON content.feed_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION content.set_feed_subscriptions_updated_at();
