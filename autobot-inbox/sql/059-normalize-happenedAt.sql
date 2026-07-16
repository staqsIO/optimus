-- 059: Normalize tl;dv metadata.happenedAt to ISO.
--
-- tl;dv returns `happenedAt` as JavaScript Date.toString() output, e.g.
-- "Fri Apr 17 2026 16:00:00 GMT+0000 (Coordinated Universal Time)".
-- Postgres can't cast that to timestamptz, so content.documents ordering
-- by happenedAt fails (affects the new ordinal retrieval path in
-- src/api-routes/search.js). Going forward, webhook.js + poller.js
-- convert to ISO before storing. This migration rewrites historical rows.
--
-- Idempotent: skips rows that are already ISO-shaped or that lack the
-- identifying "GMT±HHMM" fragment.

UPDATE content.documents
SET metadata = jsonb_set(
  metadata,
  '{happenedAt}',
  to_jsonb(
    regexp_replace(
      metadata->>'happenedAt',
      '^\w+\s+(\w+\s+\d+\s+\d+\s+\d+:\d+:\d+)\s+GMT([+-]\d{4}).*$',
      '\1 \2'
    )::timestamptz
  )
)
WHERE source = 'tldv'
  AND metadata ? 'happenedAt'
  AND metadata->>'happenedAt' ~ '\s+GMT[+-]\d{4}';
