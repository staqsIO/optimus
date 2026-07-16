-- 045-rename-feed-subscriptions-to-research-sources.sql
-- Canonical naming: content.research_sources
-- Keep compatibility view: content.feed_subscriptions

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'content' AND table_name = 'feed_subscriptions'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'content' AND table_name = 'research_sources'
  ) THEN
    ALTER TABLE content.feed_subscriptions RENAME TO research_sources;
  END IF;
END $$;

-- Retarget trigger function names for clarity (function body unchanged)
CREATE OR REPLACE FUNCTION content.set_research_sources_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feed_subscriptions_updated_at ON content.research_sources;
DROP TRIGGER IF EXISTS trg_research_sources_updated_at ON content.research_sources;
CREATE TRIGGER trg_research_sources_updated_at
  BEFORE UPDATE ON content.research_sources
  FOR EACH ROW
  EXECUTE FUNCTION content.set_research_sources_updated_at();

-- Compatibility view for legacy readers.
DROP VIEW IF EXISTS content.feed_subscriptions;
CREATE VIEW content.feed_subscriptions AS
SELECT * FROM content.research_sources;
