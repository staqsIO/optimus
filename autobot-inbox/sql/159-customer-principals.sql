-- 159-customer-principals.sql
-- OPT-37: external (non-board) customer principals for the MCP + CLI access layer.
--
-- A customer principal is an EXTERNAL API client (a customer's own agent system:
-- Cursor, bespoke) bound to exactly ONE tenancy org. It is deliberately NOT a
-- board_members row and NOT an internal agent — it is the third token class
-- (see lib/runtime/agents/customer-jwt.js). The token carries this row's id as
-- `sub` and the org as `org_id`; the request principal becomes
-- syntheticPrincipal(org_id), so every tenant-scoped read fail-closes to this
-- one org via visibleClause(). A customer can only ever see its own org.
--
-- Durable identity vs. ephemeral token: this row is the durable identity (org
-- binding + active flag); JWTs (jti) are ephemeral and rotate. Deactivating the
-- row (is_active=false) instantly kills EVERY token the principal holds — the
-- verifier checks is_active on every request. Per-token kill uses the shared
-- agent_graph.token_revocations table (jti).
--
-- No cross-schema FK to tenancy.orgs (SPEC §12 — schemas isolated by role); the
-- org_id is validated against tenancy.orgs in the issuance handler, not by an FK.

CREATE TABLE IF NOT EXISTS agent_graph.customer_principals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,                 -- tenancy.orgs.id (app-validated; no cross-schema FK)
  label       TEXT NOT NULL,                 -- human label, e.g. "Acme — Cursor agent"
  scope       TEXT[] NOT NULL DEFAULT '{}',  -- allowed API scopes baked into issued tokens
  created_by  TEXT,                          -- github_username of the issuing board admin
  is_active   BOOLEAN NOT NULL DEFAULT true, -- false = all tokens for this principal are dead
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ                    -- set alongside is_active=false (P3 audit; never deleted)
);

-- Fast "list active principals for an org" (board admin surface).
CREATE INDEX IF NOT EXISTS customer_principals_org_idx
  ON agent_graph.customer_principals(org_id) WHERE is_active;
