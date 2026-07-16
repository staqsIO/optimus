-- 138-tenancy-owner-messages-accounts-projects.sql
-- ADR-012 M-B continuation (STAQPRO-587): owner columns + backfill for the
-- tables NOT covered by migration 134.
--
-- AUDIT — what 134 already covered (do not touch here):
--   signal.contacts, inbox.signals, inbox.human_tasks, signal.briefings,
--   agent_graph.action_proposals, agent_graph.signals, agent_graph.campaigns,
--   agent_graph.work_items, content.documents, content.drafts,
--   signal.organizations
-- RAG match_chunks already extended in migrations 135, 136, 137.
--
-- GAPS handled by this migration:
--
--   Table                   owner_org_id  owner_user_id  Notes
--   ---------------------   ------------  -------------  ----------------------
--   inbox.messages          MISSING       MISSING        BLOCKER for STAQPRO-588
--                                                        briefing COUNT scoping.
--                                                        Derivation: account_id FK
--                                                        → inbox.accounts.owner_id
--                                                        (via JOIN). N=1 → Staqs.
--                                                        owner_user_id = accounts.
--                                                        owner_id (board_members FK).
--
--   inbox.accounts          MISSING       already owner_id  Derivation: owner_org_id
--                                                        = Staqs (all accts are
--                                                        Staqs board members at N=1).
--                                                        We do NOT add owner_user_id
--                                                        (already exists as owner_id;
--                                                        alias is 566 scope).
--
--   agent_graph.projects    MISSING       MISSING        board-scoped but no FK to
--                                                        a user UUID. created_by is
--                                                        TEXT (GitHub username), not
--                                                        UUID; cannot safely derive
--                                                        board_members UUID without
--                                                        a fragile text-match JOIN.
--                                                        Therefore: owner_user_id →
--                                                        NULL (fail-closed, Linus §11).
--                                                        owner_org_id → Staqs (safe).
--
-- TABLES INTENTIONALLY ABSENT (verified against all SQL migrations):
--   today_items   — does NOT exist as a database table anywhere in sql/*.sql.
--                   It is purely computed in the board API / JS layer.
--                   Confirmed: grep 'today_items' over all SQL files returns 0 hits.
--                   Nothing to alter.
--   signal.signals — does NOT exist as a schema-qualified table. The ADR §4.5
--                   entry was shorthand for inbox.signals + agent_graph.signals,
--                   both covered by migration 134. Confirmed: only
--                   signal.contacts, signal.briefings etc. exist under the
--                   signal schema.
--
-- DESIGN (mirrors migration 134):
--   * Columns NULLABLE — NOT NULL enforcement is STAQPRO-566 (separate step).
--   * DEFAULT owner_org_id = Staqs so agent writes after this migration land in
--     the correct org without requiring M-C write-path stamping to ship first.
--   * No CREATE INDEX — CONCURRENT index builds are needed for production tables
--     but must be issued outside a transaction block; deferred.
--   * Idempotent: ADD COLUMN IF NOT EXISTS + WHERE owner_org_id IS NULL guards.
--   * Supabase-safe: no auth-schema / pgcrypto / locked-schema DDL touch.
--   * THE BACKFILL IS THE BOUNDARY (Linus §11): at N=1, all live data is Staqs.
--     A wrong backfill bakes a permanent tenant boundary no future migration can
--     safely undo. This migration is conservative by design. When a second org
--     begins writing, the Phase-2 write-path stamp (STAQPRO-593) overrides the
--     DEFAULT on new rows.

DO $$
DECLARE
  staqs UUID;
BEGIN
  -- ----------------------------------------------------------------
  -- 0. Resolve Staqs org ID — fail loudly if tenancy schema is absent.
  --    Mirrors migration 134's pattern exactly: no hardcoded UUID.
  -- ----------------------------------------------------------------
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE EXCEPTION 'tenancy.orgs has no staqs row — run migration 133 first';
  END IF;

  -- ================================================================
  -- 1. inbox.messages
  --
  --    owner_org_id derivation:
  --      All existing rows → Staqs (N=1; all inbound email/slack/telegram
  --      predates any second org's write access).
  --
  --    owner_user_id derivation:
  --      JOIN inbox.accounts ON account_id = id → take accounts.owner_id
  --      (the board_members UUID set by migration 007).
  --      Where account_id IS NULL or the linked account has no owner_id,
  --      owner_user_id remains NULL (fail-closed).
  --      We do NOT blanket-default to Eric's UUID.
  -- ================================================================
  ALTER TABLE inbox.messages
    ADD COLUMN IF NOT EXISTS owner_org_id  UUID,
    ADD COLUMN IF NOT EXISTS owner_user_id UUID;

  -- Backfill org: every existing row → Staqs (idempotent guard).
  UPDATE inbox.messages
    SET owner_org_id = staqs
    WHERE owner_org_id IS NULL;

  -- Backfill user: derive from the linked account's owner_id.
  -- Rows with no account_id, or accounts with owner_id IS NULL, stay NULL.
  -- This JOIN uses the indexed FK inbox.messages.account_id → inbox.accounts.id.
  UPDATE inbox.messages m
    SET owner_user_id = a.owner_id
    FROM inbox.accounts a
    WHERE m.account_id = a.id
      AND m.owner_user_id IS NULL
      AND a.owner_id IS NOT NULL;

  -- Set DEFAULT to Staqs so future inserts land in the right org before
  -- write-path stamping (STAQPRO-593) ships.
  EXECUTE format(
    'ALTER TABLE inbox.messages ALTER COLUMN owner_org_id SET DEFAULT %L',
    staqs
  );

  -- ================================================================
  -- 2. inbox.accounts
  --
  --    owner_org_id derivation:
  --      All existing rows → Staqs. Every connected account belongs to a
  --      Staqs board member at N=1.
  --
  --    owner_user_id:
  --      NOT ADDED HERE. The column owner_id (UUID → board_members) already
  --      serves the Tier-1 owner role. Renaming / aliasing it to owner_user_id
  --      is STAQPRO-566 scope (two-phase NOT-NULL + rename). We avoid the
  --      dual-column confusion by leaving that refactor to 566.
  -- ================================================================
  ALTER TABLE inbox.accounts
    ADD COLUMN IF NOT EXISTS owner_org_id UUID;

  UPDATE inbox.accounts
    SET owner_org_id = staqs
    WHERE owner_org_id IS NULL;

  EXECUTE format(
    'ALTER TABLE inbox.accounts ALTER COLUMN owner_org_id SET DEFAULT %L',
    staqs
  );

  -- ================================================================
  -- 3. agent_graph.projects
  --
  --    owner_org_id derivation:
  --      All existing rows → Staqs (all projects are Staqs-internal at N=1).
  --
  --    owner_user_id derivation (INTENTIONALLY NULL — fail-closed):
  --      The only candidate FK is created_by (TEXT, stores GitHub username).
  --      This is not a UUID and has no FK constraint to board_members.
  --      A text-match JOIN against board_members.github_username is fragile
  --      (case differences, stale usernames, test rows). Per Linus §11:
  --      "define its derivation explicitly or leave owner_org_id NULL
  --      (fail-closed) pending review." We apply the same caution to
  --      owner_user_id. The write-path stamp (STAQPRO-593) will populate
  --      owner_user_id on new rows from the authenticated principal.
  -- ================================================================
  ALTER TABLE agent_graph.projects
    ADD COLUMN IF NOT EXISTS owner_org_id  UUID,
    ADD COLUMN IF NOT EXISTS owner_user_id UUID;

  -- Backfill org: all existing rows → Staqs.
  UPDATE agent_graph.projects
    SET owner_org_id = staqs
    WHERE owner_org_id IS NULL;

  -- owner_user_id: NOT backfilled. Remains NULL for all existing rows.
  -- This is the documented fail-closed choice (see header). Do not add a
  -- default or UPDATE here without a reviewed derivation query.

  EXECUTE format(
    'ALTER TABLE agent_graph.projects ALTER COLUMN owner_org_id SET DEFAULT %L',
    staqs
  );

END $$;
