-- 133-tenancy-schema.sql
-- ADR-012 M-A: the authorization-spine foundation. PURE ADDITIVE — no read path
-- changes here. The leak does NOT close until M-C (STAQPRO-588) routes reads
-- through scopedQuery; this migration only lays the schema + the one predicate.
--
-- `tenancy` is its own schema (clean RLS ownership; no cross-schema FK per
-- SPEC §12 — we reference board_members / data rows by UUID, validated in the
-- app layer, FKs only within tenancy).

CREATE SCHEMA IF NOT EXISTS tenancy;

-- ---------------------------------------------------------------------------
-- Orgs (tenancy boundary). NOT signal.organizations (that is CRM: "which
-- company is this contact from"). Different axis; do not merge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Membership (user x org x role) — the heart of the model. A person belongs to
-- MANY orgs with a DIFFERENT role per org (multi-org decision, board 2026-05-31).
-- user_id = agent_graph.board_members.id (validated in app; no cross-schema FK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.memberships (
  user_id    UUID NOT NULL,
  org_id     UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS memberships_org_idx ON tenancy.memberships(org_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Org-to-org federation grants (Tier 3) — SCHEMA ONLY, no runtime yet (ADR-007
-- "do not build yet"). The predicate's 3rd branch consults this; it matches
-- nothing until a real grant is issued. revocation = set revoked_at (never
-- delete; P3 audit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.federation_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_org_id  UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  grantee_org_id  UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL,
  scope           JSONB NOT NULL DEFAULT '{}',
  granted_by      UUID NOT NULL,            -- board_members.id (must hold grantFederation cap)
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Canonical user alias. We do NOT fork identity: board_members.id IS the user
-- id. This view lets policies/joins read one canonical shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW tenancy.users AS
  SELECT id AS user_id, github_username, display_name, email, is_active
  FROM agent_graph.board_members;

-- ---------------------------------------------------------------------------
-- THE single resolution predicate (ADR-012 §5.1), hardened per Linus §11:
--   * NULLIF guards -> unset GUC fails CLOSED (NULL comparison = false), never
--     ''::uuid throw (would error/escape, BLOCKER 2).
--   * SECURITY DEFINER + pinned search_path so a caller's search_path cannot
--     shadow tenancy.federation_grants (same class as the 2026-05-30 SEV-1).
-- GUCs (set by lib/tenancy via SET LOCAL in a per-request txn — BLOCKER 3):
--   app.user    = board_members.id
--   app.org_ids = csv of org ids where the caller holds a read:'org' role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.visible(row_owner_user UUID, row_owner_org UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog AS $$
  -- COALESCE(..., false): unset GUCs / NULL owner columns resolve to an explicit
  -- FALSE, not NULL — fail-closed in ANY boolean context, not only in WHERE.
  SELECT COALESCE(
    -- Tier 1: own
    row_owner_user = NULLIF(current_setting('app.user', true), '')::uuid
    -- Tier 2: org-shared, only for orgs where caller holds read:'org'
    OR row_owner_org = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
    -- Tier 3: federation (dormant until a grant exists)
    OR EXISTS (
      SELECT 1 FROM tenancy.federation_grants g
      WHERE g.grantee_org_id = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
        AND g.grantor_org_id = row_owner_org
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
    )
  , false);
$$;

-- ---------------------------------------------------------------------------
-- Seed: orgs that are known to exist. (Org rows are low-risk; MEMBERSHIP
-- assignment is the security boundary and is seeded minimally below.)
-- ---------------------------------------------------------------------------
-- Tenant orgs = orgs whose PEOPLE log into Optimus. FrontPoint Security is a
-- CLIENT (CRM entity / Linear project), NOT a tenant — Daniel Tovar leads that
-- work but is a Staqs member. FrontPoint joins later via Tier-3 federation if
-- its people ever log in. Tenants today: Staqs, Consulting Futures, UMB Advisors.
INSERT INTO tenancy.orgs (slug, name) VALUES
  ('staqs',              'Staqs'),
  ('consulting-futures', 'Consulting Futures'),
  ('umb-advisors',       'UMB Advisors')
ON CONFLICT (slug) DO NOTHING;

-- Membership mapping — BOARD-CONFIRMED by Eric 2026-05-31:
--   - Eric + Dustin are both in UMB Advisors together (multi-org case).
--   - Daniel Tovar is a Staqs lead dev (leads FrontPoint client work) -> Staqs.
--   - Carlos + Isaias are Staqs engineers.
-- Roles: owner/admin/member all grant read:'org' (org-shared reads) — the
-- distinction is write/manage scope, NOT read; nobody is a 'viewer' so nobody
-- is over-blocked. (username, org slug, role):
INSERT INTO tenancy.memberships (user_id, org_id, role)
SELECT bm.id, o.id, m.role
FROM (VALUES
  ('ecgang',               'staqs',              'owner'),
  ('ecgang',               'umb-advisors',       'owner'),
  ('ConsultingFuture4200', 'consulting-futures', 'owner'),
  ('ConsultingFuture4200', 'umb-advisors',       'owner'),
  ('cboone',               'umb-advisors',       'member'),
  ('mikemaibach',          'umb-advisors',       'member'),
  ('patking',              'umb-advisors',       'member'),
  ('DanielTovar-bord',     'staqs',              'member'),
  ('DaemonAeon',           'staqs',              'admin'),
  ('guitartsword',         'staqs',              'admin'),
  ('nemoclaw-ecgang',      'staqs',              'member'),
  ('nemoclaw-dustin',      'consulting-futures', 'member')
) AS m(username, slug, role)
JOIN agent_graph.board_members bm ON bm.github_username = m.username
JOIN tenancy.orgs o ON o.slug = m.slug
ON CONFLICT (user_id, org_id) DO NOTHING;
