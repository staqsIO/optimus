-- Migration 116 — Master engagement (inheritable baseline spec).
--
-- A "master" engagement is a regular row in engagements.engagements with
-- is_master = true. Same schema, same code paths — same proposals, sections,
-- pins, audit. The only difference is *consumption*: when a non-master
-- engagement is synthesized, the master's spec_sections are loaded and
-- injected into the LLM prompt as BASELINE STANDARDS — defaults the LLM
-- should apply unless engagement-specific proposals override them.
--
-- Singleton: a partial unique index ensures at most one master exists.
-- One master row is auto-seeded by this migration so the system always has
-- a baseline to inherit from. Its kind is 'other' (the master applies to
-- all kinds) and its initial proposals/sections are empty — the user adds
-- general scoping principles to it like any other engagement.

-- Add the flag.
ALTER TABLE engagements.engagements
  ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false;

-- Singleton invariant. Partial unique index = at most one row with is_master=true.
CREATE UNIQUE INDEX IF NOT EXISTS idx_engagements_one_master
  ON engagements.engagements ((1))
  WHERE is_master = true;

-- Seed the master row if none exists. Idempotent via the unique index above.
DO $$
DECLARE
  v_master_id UUID;
BEGIN
  SELECT id INTO v_master_id FROM engagements.engagements WHERE is_master = true LIMIT 1;
  IF v_master_id IS NULL THEN
    INSERT INTO engagements.engagements (name, client, kind, status, is_master, created_by)
    VALUES (
      'Master spec',
      NULL,
      'other',
      'active',
      true,
      'system'
    )
    RETURNING id INTO v_master_id;
    RAISE NOTICE '[116] master engagement created: %', v_master_id;
  ELSE
    RAISE NOTICE '[116] master engagement already exists: %', v_master_id;
  END IF;

  -- Ensure the master has a spec row (mirrors the lazy ensureSpec() path).
  INSERT INTO engagements.specs (engagement_id)
  VALUES (v_master_id)
  ON CONFLICT (engagement_id) DO NOTHING;
END $$;

-- Verification
DO $$
DECLARE
  v_master_count INT;
BEGIN
  SELECT count(*) INTO v_master_count
    FROM engagements.engagements WHERE is_master = true;
  RAISE NOTICE '[116] master count: % (expected 1)', v_master_count;
  IF v_master_count <> 1 THEN
    RAISE EXCEPTION '[116] expected exactly 1 master engagement, found %', v_master_count;
  END IF;
END $$;
