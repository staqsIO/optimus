-- 163-front-door-cold-tail.sql
-- Feature 008 Phase 1.5: templated cold-tail generation (instant intent pages
-- on corpus miss). Liotta + Linus pre-implementation review 2026-06-10.
--
-- source — separates the board-curated head ('seed', never auto-evicted,
-- immutable to the cold-tail path) from auto-generated tail entries
-- ('cold_tail', capped per site + LRU-evicted). Telemetry split comes free.
--
-- publish_status gains 'unlisted' (Linus BLOCKER 1 synthesis): a cold-tail row
-- is servable by DIRECT SLUG immediately (the returned /intent/<slug> link
-- works), but is NEVER in the serve-by-match pool or the list API until the
-- board promotes it to 'published' — one caller's intent can never shape pages
-- served to future organic visitors. Promotion is a telemetry-driven board
-- action (review-as-dashboard, not a gate on the link).
--
-- Partial index supports the DB-backed global daily cap (COUNT of cold_tail
-- rows in 24h) and oldest-first per-site eviction.
--
-- DESIGN (P1/P2/P4): additive, idempotent, no cross-schema FK.

ALTER TABLE content.front_door_corpus
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed';

DO $$ BEGIN
  ALTER TABLE content.front_door_corpus
    ADD CONSTRAINT front_door_corpus_source_check
    CHECK (source IN ('seed', 'cold_tail'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend publish_status to include 'unlisted' (drop + re-add; the original
-- CHECK from sql/162 was unnamed-table-level, so locate it by definition).
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'content' AND t.relname = 'front_door_corpus'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%publish_status%'
     AND pg_get_constraintdef(c.oid) NOT LIKE '%unlisted%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE content.front_door_corpus DROP CONSTRAINT %I', conname);
    ALTER TABLE content.front_door_corpus
      ADD CONSTRAINT front_door_corpus_publish_status_check
      CHECK (publish_status IN ('draft', 'published', 'retired', 'unlisted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS front_door_corpus_cold_tail_idx
  ON content.front_door_corpus (site_host, created_at)
  WHERE source = 'cold_tail';

COMMENT ON COLUMN content.front_door_corpus.source IS
  'seed = board-curated head (immutable to cold-tail writes, never evicted); '
  'cold_tail = auto-generated on corpus miss (unlisted until promoted, per-site '
  'capped + LRU-evicted).';

DO $$ BEGIN
  RAISE NOTICE '[163] front door cold-tail: source column + unlisted publish_status (feature 008 Phase 1.5)';
END $$;
