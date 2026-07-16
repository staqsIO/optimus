-- 149-owner-org-id-deals-counterparties-feeds-activity.sql
-- STAQPRO-608 r2a (cluster A): add owner_org_id to the 4 remaining tenant tables
-- behind the DEFERRED /api/deals, /api/counterparties, /api/feeds, /api/activity
-- routes, so the sibling route-scoping work in this same PR can apply
-- visibleClause(owner_org_id) fail-closed and verify end-to-end under PGlite.
--
-- Pattern matches migrations 134 (tenancy-owner-columns), 138
-- (owner-messages-accounts-projects), and 148 (voice/calendar): nullable
-- owner_org_id UUID, NO FK, NO index (tables are small; CONCURRENT build
-- deferred), NO NOT NULL, NO DEFAULT. Backfill existing rows via the real
-- relationship to an org-bearing table. visibleClause COALESCEs legacy NULL ->
-- Staqs (mig 135), so any row left NULL stays visible to Staqs members — the
-- correct fail-safe single-org behavior. NOT NULL / DROP DEFAULT / the
-- write-path stamp belong to the separate 566 / PR-B track.
--
-- On DEFAULT (deliberately omitted, mirroring 148's reasoning): migs 134/138 set
-- a column DEFAULT = Staqs so agent writes land visible before the write-path
-- stamp ships. The 4 tables here are written by HTTP routes (deal CRUD,
-- counterparty CRUD, feed subscription upsert) or are an append-only agent log
-- (agent_activity_steps). To keep this migration purely additive (no behavior
-- change for the route-scoping work in the same PR) we add the nullable column +
-- backfill only; NULL rows fail safe to Staqs via visibleClause.
--
-- BACKFILL JOIN PATHS (investigated against live schema 2026-06-02):
--   signal.deals.contact_id        -> signal.contacts.id (owner_org_id, mig 134).
--       contact_id is NOT NULL on every deal (the route requires it on create),
--       so this is the authoritative path. Fallback for any deal whose contact
--       has NULL owner_org_id: organization_id -> signal.organizations.id
--       (owner_org_id, mig 134). Anything still NULL -> Staqs via COALESCE.
--   content.counterparties         -> NO per-org FK. Counterparties are
--       declared org-AGNOSTIC by design (mig 065: "internal-only — single UMB
--       tenant", "No multi-tenant org column. Optimus is staying internal").
--       There is no org-bearing parent: a counterparty is referenced BY
--       content.drafts (the contract), not the reverse, and one counterparty can
--       back many drafts across (in principle) many orgs. At N=1 every
--       counterparty is a Staqs client. Backfill ALL existing rows -> Staqs
--       explicitly (the safe, documented single-org default). When a second org
--       starts authoring contracts, a follow-up can derive ownership from the
--       owning draft(s) via content.drafts.counterparty_id ->
--       content.drafts.owner_org_id (mig 134) — left as a documented follow-up,
--       not guessed here.
--   content.research_sources       -> project_id -> agent_graph.projects.id
--       (owner_org_id, mig 138). research_sources are the rd-feed-poller
--       knowledge sources; many carry a NULL project_id (org-agnostic shared
--       Staqs knowledge base). Rows with a project inherit that project's org;
--       rows with NULL project_id -> Staqs (the shared single-org KB). Documented
--       as Staqs-shared.
--   agent_graph.agent_activity_steps -> work_item_id -> agent_graph.work_items.id
--       (owner_org_id, mig 134). Append-only step log keyed by work_item_id (and
--       campaign_id for campaign steps). Steps with a work_item inherit the
--       work_item's org. Steps with NULL work_item_id (campaign-only or
--       orphaned) -> Staqs via COALESCE. agent_activity_steps carries the
--       activity_steps_immutable BEFORE-UPDATE trigger (baseline 001), which
--       HARD-blocks UPDATE of any row whose status != 'in_progress'. The backfill
--       UPDATE therefore disables that trigger for the duration of the backfill
--       and re-enables it (proven pattern: mig 091 on agent_graph.state_transitions).
--       owner_org_id is NOT in the trigger's structural-immutability list, so the
--       column itself is a permitted addition.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + WHERE owner_org_id IS NULL guards.
-- Parameterized via format(%L) on a live-read staqs id (no hardcoded UUID; fresh
-- DBs get their own staqs id from migration 133's seed). Matches the DO-block
-- style of migs 134/138/148.

DO $$
DECLARE
  staqs UUID;
BEGIN
  SELECT id INTO staqs FROM tenancy.orgs WHERE slug = 'staqs';
  IF staqs IS NULL THEN
    RAISE EXCEPTION 'tenancy.orgs has no staqs row — run migration 133 first';
  END IF;

  -- 1. signal.deals
  --    Primary backfill: contact_id -> signal.contacts.owner_org_id.
  ALTER TABLE signal.deals ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE signal.deals d
     SET owner_org_id = c.owner_org_id
    FROM signal.contacts c
   WHERE c.id = d.contact_id
     AND c.owner_org_id IS NOT NULL
     AND d.owner_org_id IS NULL;
  --    Fallback: deals whose contact had NULL org but that carry an organization.
  UPDATE signal.deals d
     SET owner_org_id = o.owner_org_id
    FROM signal.organizations o
   WHERE o.id = d.organization_id
     AND o.owner_org_id IS NOT NULL
     AND d.owner_org_id IS NULL;
  --    Anything still NULL -> Staqs (legacy single-org default).
  UPDATE signal.deals SET owner_org_id = staqs WHERE owner_org_id IS NULL;

  -- 2. content.counterparties
  --    NO derivable per-org parent (org-agnostic by design, mig 065). Backfill
  --    ALL existing rows -> Staqs explicitly. Documented as the single-org
  --    default; a follow-up can derive from the owning draft when org 2 authors
  --    contracts.
  ALTER TABLE content.counterparties ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE content.counterparties SET owner_org_id = staqs WHERE owner_org_id IS NULL;

  -- 3. content.research_sources
  --    Backfill: project_id -> agent_graph.projects.owner_org_id (mig 138).
  --    NULL project_id rows are the shared org-agnostic Staqs knowledge base.
  ALTER TABLE content.research_sources ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  UPDATE content.research_sources rs
     SET owner_org_id = p.owner_org_id
    FROM agent_graph.projects p
   WHERE p.id::text = rs.project_id::text
     AND p.owner_org_id IS NOT NULL
     AND rs.owner_org_id IS NULL;
  --    NULL-project (shared KB) + any unresolved -> Staqs.
  UPDATE content.research_sources SET owner_org_id = staqs WHERE owner_org_id IS NULL;

  -- 4. agent_graph.agent_activity_steps (append-only; trigger-guarded)
  --    Backfill: work_item_id -> agent_graph.work_items.owner_org_id (mig 134).
  --    The activity_steps_immutable trigger blocks UPDATE on non-in_progress
  --    rows; disable it for the backfill, re-enable after (mig 091 pattern).
  ALTER TABLE agent_graph.agent_activity_steps ADD COLUMN IF NOT EXISTS owner_org_id UUID;
  EXECUTE 'ALTER TABLE agent_graph.agent_activity_steps DISABLE TRIGGER activity_steps_immutable';
  UPDATE agent_graph.agent_activity_steps s
     SET owner_org_id = wi.owner_org_id
    FROM agent_graph.work_items wi
   WHERE wi.id = s.work_item_id::text
     AND wi.owner_org_id IS NOT NULL
     AND s.owner_org_id IS NULL;
  --    Steps with NULL/unresolved work_item (campaign-only, orphaned) -> Staqs.
  UPDATE agent_graph.agent_activity_steps SET owner_org_id = staqs WHERE owner_org_id IS NULL;
  EXECUTE 'ALTER TABLE agent_graph.agent_activity_steps ENABLE TRIGGER activity_steps_immutable';
END $$;
