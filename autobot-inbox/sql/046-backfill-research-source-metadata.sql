-- 046-backfill-research-source-metadata.sql
-- Backfill canonical metadata keys on historical research-source ingests.
-- Keep legacy feed_* keys for compatibility.

UPDATE content.documents
SET metadata =
  COALESCE(metadata, '{}'::jsonb)
  || CASE
       WHEN (COALESCE(metadata, '{}'::jsonb)->>'research_source_id') IS NULL
            AND (COALESCE(metadata, '{}'::jsonb)->>'feed_subscription_id') IS NOT NULL
       THEN jsonb_build_object('research_source_id', COALESCE(metadata, '{}'::jsonb)->>'feed_subscription_id')
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN (COALESCE(metadata, '{}'::jsonb)->>'research_source_url') IS NULL
            AND (COALESCE(metadata, '{}'::jsonb)->>'feed_url') IS NOT NULL
       THEN jsonb_build_object('research_source_url', COALESCE(metadata, '{}'::jsonb)->>'feed_url')
       ELSE '{}'::jsonb
     END
WHERE source = 'feed'
  AND (
    (
      (COALESCE(metadata, '{}'::jsonb)->>'research_source_id') IS NULL
      AND (COALESCE(metadata, '{}'::jsonb)->>'feed_subscription_id') IS NOT NULL
    )
    OR
    (
      (COALESCE(metadata, '{}'::jsonb)->>'research_source_url') IS NULL
      AND (COALESCE(metadata, '{}'::jsonb)->>'feed_url') IS NOT NULL
    )
  );
