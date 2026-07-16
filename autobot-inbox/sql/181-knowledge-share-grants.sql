-- 181-knowledge-share-grants.sql
-- ADR-017 — Knowledge Share Grants. User-tier sharing primitive that lets a
-- board member (or org admin) grant retrieval access to a target user,
-- group, or org. v0 ships "share all"; v1 adds per-doc/per-collection scope;
-- vN adds per-topic. One table evolves across versions — only CHECK
-- constraint widening and retriever logic change.
--
-- Sits ALONGSIDE the existing federation primitives, doesn't replace them:
--   * tenancy.federation_grants (mig 133) — org→org grants consulted by
--     tenancy.visible()'s federation tier. Dormant in prod but live in code.
--   * agent_graph.federation_grants (mig 169, OPT-78) — capability-receipt
--     envelope for cross-org agent calls (signed JWS, contract_hash).
-- share_grants is the USER-FACING document-share primitive; the federation
-- tables remain the system-of-record for agent-tier cross-org work.
--
-- Per codebase convention (see migration 054 §ENUMS), domain enums are TEXT
-- columns with CHECK constraints rather than CREATE TYPE — keeps DDL simple
-- and PGlite-safe.
--
-- This migration:
--   1. Creates tenancy.groups + tenancy.group_memberships (schema-only; v0 UI
--      hides the group target picker behind a flag, v1 activates it).
--   2. Creates tenancy.share_grants with TEXT + CHECK enums for principal,
--      scope, and status ('expired' is a distinct state from 'revoked').
--   3. Adds a trigger on tenancy.memberships DELETE that cascade-revokes
--      grants tied to that org-membership (granter_type='user' AND
--      granter_id=user_id AND granter_org_id=org_id).
--
-- Deliberately does NOT modify tenancy.visible() — share-grant visibility is
-- opt-in per resource kind at the retriever layer (lib/rag/retriever.js),
-- narrowed by share_grants.applies_to (mig 183). Generic tenant-scoped
-- tables (signals, briefings, contracts) keep their existing 3-tier
-- predicate (own + org-shared + federation_grants) unchanged.

-- ---------------------------------------------------------------------------
-- Groups (schema only in v0; UI in v1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS groups_org_idx ON tenancy.groups(org_id);

CREATE TABLE IF NOT EXISTS tenancy.group_memberships (
  group_id   UUID NOT NULL REFERENCES tenancy.groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by   UUID,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_memberships_user_idx ON tenancy.group_memberships(user_id);

-- ---------------------------------------------------------------------------
-- share_grants — the unified sharing primitive (ADR-017 §a)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.share_grants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Granter (who is sharing). v0: 'user' or 'org'; 'group' reserved.
  granter_type        TEXT NOT NULL CHECK (granter_type IN ('user', 'org')),
  granter_id          UUID NOT NULL,
  granter_org_id      UUID NOT NULL REFERENCES tenancy.orgs(id),

  -- Target (who receives access). v0+: 'user', 'group', 'org'.
  target_type         TEXT NOT NULL CHECK (target_type IN ('user', 'group', 'org')),
  target_id           UUID NOT NULL,
  target_org_id       UUID NOT NULL REFERENCES tenancy.orgs(id),

  -- Scope. v0 = 'all'; v1 adds 'collection' + 'document'; vN adds 'topic'.
  scope_type          TEXT NOT NULL DEFAULT 'all'
                        CHECK (scope_type IN ('all', 'collection', 'document', 'topic')),
  scope_ref           TEXT,

  -- Lifecycle. 'expired' is distinct from 'revoked' (D10).
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending', 'active', 'revoked', 'declined', 'expired')),
  requires_acceptance BOOLEAN NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID NOT NULL,
  accepted_at         TIMESTAMPTZ,
  accepted_by         UUID,
  declined_at         TIMESTAMPTZ,
  declined_by         UUID,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID,
  expires_at          TIMESTAMPTZ,

  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- An 'active' grant that requires acceptance must have been accepted.
  CHECK (NOT (status = 'active' AND requires_acceptance = true AND accepted_at IS NULL)),

  -- One grant per (granter, target, scope). Two grants with the same shape but
  -- different scope_ref are distinct (e.g., doc:A vs doc:B).
  UNIQUE (granter_type, granter_id, target_type, target_id, scope_type, scope_ref)
);

CREATE INDEX IF NOT EXISTS share_grants_target_active_idx
  ON tenancy.share_grants (target_type, target_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS share_grants_granter_idx
  ON tenancy.share_grants (granter_type, granter_id, status);
CREATE INDEX IF NOT EXISTS share_grants_expires_idx
  ON tenancy.share_grants (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS share_grants_status_org_idx
  ON tenancy.share_grants (status, target_org_id);

COMMENT ON TABLE tenancy.share_grants IS
  'User-tier knowledge-share grants (ADR-017). Complements — does NOT replace — tenancy.federation_grants (mig 133, org→org dormant) and agent_graph.federation_grants (mig 169, capability receipts). Status lifecycle: pending → active → (revoked|declined|expired). The generic tenancy.visible() predicate intentionally does NOT consult this table — share-grant visibility is opt-in per resource kind at the retriever layer (lib/rag/retriever.js) so signals/briefings/contracts never auto-share.';

-- NOTE: we intentionally do NOT modify tenancy.visible() here. Share-grant
-- visibility is enforced by share-aware callers (content.match_chunks +
-- lib/rag/retriever.js lexicalChunkSearch/wikiPageSearch), narrowed by
-- share_grants.applies_to (mig 183). Leaving the generic predicate alone
-- preserves the existing federation_grants org→org branch and keeps the
-- security spine identical for every non-share-aware tenant table.

-- ---------------------------------------------------------------------------
-- Cascade-revoke trigger on memberships DELETE (D9)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.cascade_revoke_on_membership_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tenancy.share_grants
     SET status = 'revoked',
         revoked_at = COALESCE(revoked_at, now()),
         revoked_by = NULL,
         metadata   = metadata || jsonb_build_object(
                        'cascaded_from_membership', true,
                        'cascaded_org_id', OLD.org_id::text,
                        'cascaded_user_id', OLD.user_id::text
                      )
   WHERE granter_type   = 'user'
     AND granter_id     = OLD.user_id
     AND granter_org_id = OLD.org_id
     AND status IN ('pending', 'active');
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS share_grants_cascade_on_membership_delete ON tenancy.memberships;
CREATE TRIGGER share_grants_cascade_on_membership_delete
  AFTER DELETE ON tenancy.memberships
  FOR EACH ROW
  EXECUTE FUNCTION tenancy.cascade_revoke_on_membership_delete();
