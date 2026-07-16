-- 150-engagements-lifecycle-tenancy.sql
-- STAQPRO-618 (ADR-015) Slice A — deal lifecycle + tenancy on engagements.
--
-- Two changes to engagements.engagements:
--   1. LIFECYCLE: widen the status CHECK from the original 3-state authoring set
--      ('draft','active','archived') to the 7-state deal lifecycle
--      ('prospect','proposed','won','active','closed','lost','archived'), migrate
--      existing 'draft' rows -> 'prospect', and re-point the column DEFAULT to
--      'prospect'. Also add 'advisory' to the kind CHECK (engagements that are not
--      a software build). A "menu, not a turnstile" — any status may follow any
--      other; the DB only constrains the *set* of valid values.
--   2. TENANCY: add owner_org_id (mirrors migration 134's pattern exactly) so the
--      read path can scope engagements with visibleClause() and the write path can
--      owner-stamp from the caller's principal. Backfill NULL -> Staqs, DEFAULT
--      Staqs. The interim DEFAULT is removed later by the mig-145 line of work.
--      proposals/specs are NOT stamped — they scope via their engagement_id join.
--
-- Idempotent + best-effort per the managed-PG bootstrap rule
-- ([[feedback_db_bootstrap_managed_pg.md]]): every statement is wrapped so a
-- re-run, or an environment where a locked/absent schema blocks one step, can
-- never crash boot. The CHECK constraints in migration 115 are inline (unnamed),
-- so Postgres auto-names them <table>_<col>_check; we drop by introspected name
-- rather than assuming, and tolerate either the auto name or a manual one.

-- ── 1a. Lifecycle: widen the status CHECK ────────────────────────────────────
DO $$
DECLARE
  con TEXT;
BEGIN
  -- Drop whatever CHECK currently governs the status column (by introspection,
  -- so we don't depend on the auto-generated name).
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t   ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'engagements'
       AND t.relname = 'engagements'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE engagements.engagements DROP CONSTRAINT %I', con);
  END LOOP;

  -- Drop the old DEFAULT before migrating data (the new value isn't valid under
  -- the old default expression order; do it explicitly to be safe).
  BEGIN
    EXECUTE 'ALTER TABLE engagements.engagements ALTER COLUMN status DROP DEFAULT';
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Migrate the only legacy authoring state that isn't in the new set.
  EXECUTE $migrate$UPDATE engagements.engagements SET status = 'prospect' WHERE status = 'draft'$migrate$;

  -- Re-add the widened CHECK.
  EXECUTE $chk$
    ALTER TABLE engagements.engagements
      ADD CONSTRAINT engagements_status_check
      CHECK (status IN ('prospect','proposed','won','active','closed','lost','archived'))
  $chk$;

  -- New default for fresh rows.
  EXECUTE $def$ALTER TABLE engagements.engagements ALTER COLUMN status SET DEFAULT 'prospect'$def$;
EXCEPTION WHEN others THEN
  RAISE WARNING '150: status lifecycle widen skipped: %', SQLERRM;
END $$;

-- ── 1b. Lifecycle: add 'advisory' to the kind CHECK ──────────────────────────
DO $$
DECLARE
  con TEXT;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t   ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'engagements'
       AND t.relname = 'engagements'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE engagements.engagements DROP CONSTRAINT %I', con);
  END LOOP;

  EXECUTE $chk$
    ALTER TABLE engagements.engagements
      ADD CONSTRAINT engagements_kind_check
      CHECK (kind IN ('website','mobile_app','api','other','advisory'))
  $chk$;
EXCEPTION WHEN others THEN
  RAISE WARNING '150: kind CHECK widen skipped: %', SQLERRM;
END $$;

-- ── 2. Tenancy: owner_org_id (mirrors migration 134 — env-safe, no hardcoded UUID) ──
DO $$
DECLARE
  staqs UUID;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE WARNING '150: tenancy.orgs has no staqs row (run migration 133 first) — owner_org_id left unstamped';
    RETURN;
  END IF;

  -- add column (idempotent)
  EXECUTE 'ALTER TABLE engagements.engagements ADD COLUMN IF NOT EXISTS owner_org_id UUID';
  -- backfill existing rows to Staqs (N=1 operational org today)
  EXECUTE format('UPDATE engagements.engagements SET owner_org_id = %L WHERE owner_org_id IS NULL', staqs);
  -- default future rows to Staqs (overridden by the write-path owner-stamp once org 2 writes;
  -- the interim DEFAULT is removed later by the mig-145 line of work)
  EXECUTE format('ALTER TABLE engagements.engagements ALTER COLUMN owner_org_id SET DEFAULT %L', staqs);
EXCEPTION WHEN others THEN
  RAISE WARNING '150: owner_org_id add/backfill skipped: %', SQLERRM;
END $$;
