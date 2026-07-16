-- 153-linear-sync-teams.sql
-- STAQPRO-619-A: Linear-native → Optimus import engine.
--
-- WHAT THIS ADDS
--   1. inbox.linear_sync_teams — board-managed registry of which Linear teams
--      Optimus mirrors onto the /issues kanban, and (critically) which
--      owner_org_id each imported issue is stamped with. This replaces the
--      single hardcoded LINEAR_TEAM_ID with a tenancy-aware, multi-team table
--      so a future UMB Linear team imports as UMB, not Staqs.
--   2. A partial UNIQUE index on inbox.human_tasks(linear_issue_id) for live
--      (non-deleted) rows so import-on-no-match is idempotent at the DB layer
--      (P2 — infrastructure enforces; the ON CONFLICT target depends on it).
--
-- DESIGN
--   - owner_org_id is the federation tenancy boundary (mirrors 134). The Staqs
--     org id is read live from tenancy.orgs (env-safe — no hardcoded UUID; fresh
--     DBs get their own staqs id from migration 133's seed; prod resolves the
--     backfilled 7c164445 row). NEVER trust an org id from a webhook payload.
--   - import_filter defaults to 'all_open' (every non-archived issue incl.
--     Backlog — full mirror per Eric's decision). Reserved for future scoping
--     (e.g. 'active_only') without a schema change.
--   - Seed is best-effort: migrations cannot read env vars, so we only auto-seed
--     an enabled row when the current LINEAR_TEAM_ID is already discoverable in
--     inbox.linear_team_cache (populated in prod by the team-cache cron). On a
--     fresh/test DB the table starts empty and the board enables teams via
--     PUT /api/linear/teams/:id. Idempotent: ON CONFLICT DO NOTHING.
--
-- P4: raw SQL, idempotent (IF NOT EXISTS / ON CONFLICT), best-effort DO block.

-- 1. Board-managed team → org mapping --------------------------------------
CREATE TABLE IF NOT EXISTS inbox.linear_sync_teams (
  team_id        TEXT PRIMARY KEY,
  team_name      TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  owner_org_id   UUID,
  import_filter  TEXT NOT NULL DEFAULT 'all_open'
    CHECK (import_filter IN ('all_open')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE inbox.linear_sync_teams IS
  'STAQPRO-619-A: board-managed registry of Linear teams mirrored to /issues. '
  'Each enabled row maps a Linear team_id to the owner_org_id that imported '
  'issues are tenancy-stamped with. Replaces the single hardcoded LINEAR_TEAM_ID.';
COMMENT ON COLUMN inbox.linear_sync_teams.owner_org_id IS
  'tenancy.orgs.id that issues imported for this team are stamped with. The '
  'import path reads this column — it NEVER derives owner_org_id from the '
  'Linear webhook payload (imported external data; treat like 588/593).';

-- touch updated_at on UPDATE (mirror inbox.touch_human_tasks_updated_at style).
CREATE OR REPLACE FUNCTION inbox.touch_linear_sync_teams_updated_at()
RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_linear_sync_teams_updated_at ON inbox.linear_sync_teams;
CREATE TRIGGER trg_linear_sync_teams_updated_at
  BEFORE UPDATE ON inbox.linear_sync_teams
  FOR EACH ROW EXECUTE FUNCTION inbox.touch_linear_sync_teams_updated_at();

-- 2. Idempotent import target on human_tasks -------------------------------
-- A non-deleted human_task can mirror at most one Linear issue. This is the
-- ON CONFLICT arbiter the import upsert depends on. Partial so soft-deleted
-- history and NULL-linear_issue_id (meeting/triage-native) rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS human_tasks_linear_issue_unique_live
  ON inbox.human_tasks (linear_issue_id)
  WHERE linear_issue_id IS NOT NULL AND deleted_at IS NULL;

-- 3. Best-effort seed: enable the current single-org team if discoverable ---
DO $$
DECLARE
  staqs   UUID;
  cached  RECORD;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE NOTICE '[153] no staqs org (migration 133 not applied?) — skipping team seed';
    RETURN;
  END IF;

  -- Only seed teams already known to the team-cache (prod). Fresh/test DBs have
  -- no cache rows → loop is empty → table starts clean (board enables via API).
  IF to_regclass('inbox.linear_team_cache') IS NULL THEN
    RAISE NOTICE '[153] no linear_team_cache table — skipping team seed';
    RETURN;
  END IF;

  -- linear_team_cache has no team_name column; team_name is backfilled later
  -- by the teams API (getTeams() ⨝ linear_sync_teams). Seed team_id + org only.
  FOR cached IN
    SELECT team_id FROM inbox.linear_team_cache
  LOOP
    INSERT INTO inbox.linear_sync_teams (team_id, enabled, owner_org_id)
    VALUES (cached.team_id, true, staqs)
    ON CONFLICT (team_id) DO NOTHING;
  END LOOP;

  RAISE NOTICE '[153] linear_sync_teams created; seeded enabled teams from team-cache → Staqs (%).', staqs;
END $$;
