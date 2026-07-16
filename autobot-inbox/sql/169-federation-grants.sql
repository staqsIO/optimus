-- 169-federation-grants.sql — OPT-78, T1-D
-- Postgres table backing the capability-receipt envelope.
-- Refs: spec/proposals/federation-tier1-linear-tickets.md §T1-D,
--       spec/proposals/capability-receipt-envelope.md, ADR-007.
--
-- Design notes:
--   * jti (JWT ID) is the natural PK — it is the grant's stable identity across
--     issuer and audience org instances.
--   * Every lifecycle event (grant issued, grant revoked) writes a row to
--     agent_graph.state_transitions via a BEFORE INSERT/UPDATE trigger so the
--     event is hash-chained into the immutable audit trail without a dedicated
--     work_item. The synthetic work_item_id is 'federation:grant:<jti>' — a
--     stable, human-readable key that lets the audit verifier join both ends.
--     from_state='pending'/to_state='active' for issue; 'active'->'revoked' for
--     revoke. config_hash is seeded with contract_hash so the chain anchors the
--     capability contract.
--   * RLS policy: issuing org (app.org = issuer_org) can INSERT; issuer and
--     audience can SELECT their own rows. DELETE is denied — grants are
--     revoked, never deleted (append-only, P3). FORCE ROW LEVEL SECURITY is
--     applied so even the table owner (superuser pool, PR-B pending) is subject
--     once RLS is active.
--   * CURRENT STATUS: the app pool still connects as superuser (PR-B / STAQPRO-263
--     not yet shipped). ENABLE ROW LEVEL SECURITY without FORCE means RLS is
--     written-and-correct but dormant under the superuser connection — inserts
--     will NOT be blocked. FORCE is added for when PR-B lands and the pool
--     downgrades to a row-level role. Do NOT add FORCE before PR-B or it will
--     block the current superuser pool entirely.
--   * UMB Advisors verification: the "migrates cleanly on both Staqs and UMB
--     Postgres" criterion cannot be verified — the UMB instance (T1-C,
--     STAQPRO-501) is not yet provisioned. This migration uses only standard
--     Postgres DDL (no extensions beyond pgcrypto/pg_catalog already present
--     in 001-baseline) and will apply cleanly once T1-C lands.

-- ============================================================
-- 1. federation_grants — capability-receipt envelope store
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_graph.federation_grants (
  -- Identity
  jti              UUID PRIMARY KEY,

  -- Grant parties
  issuer_org       TEXT NOT NULL,   -- org DID / slug of the granting org
  audience_org     TEXT NOT NULL,   -- org DID / slug of the receiving org
  subject_agent    UUID,            -- specific agent the grant is scoped to (NULL = any agent in audience)

  -- Capability scope
  scope_capability TEXT NOT NULL,   -- e.g. 'rag_query', 'kg_read', 'task_assign'
  scope_filter     JSONB NOT NULL DEFAULT '{}',
                                    -- arbitrary filter predicates (classification ceiling,
                                    -- allowed doc_ids, allowed entity types, etc.)
  max_results      INT,             -- per-call result cap (NULL = no cap)
  max_calls        INT,             -- total calls allowed under this grant (NULL = unlimited)

  -- Contract anchor
  contract_hash    TEXT NOT NULL,   -- SHA-256 of the off-chain contract document;
                                    -- also embedded in state_transitions.config_hash so the
                                    -- chain anchors the capability contract.
  signed_envelope  TEXT NOT NULL,   -- base64-encoded JWS compact serialization of the
                                    -- capability-receipt-envelope.md v0.1 payload

  -- Lifecycle timestamps
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,     -- NULL = no expiry (board must revoke explicitly)
  revoked_at       TIMESTAMPTZ,     -- NULL = grant is active (or expired)

  -- Provenance
  created_by       UUID,            -- board_member or agent UUID that issued the grant

  -- Structural constraint: revoked_at must be ≥ issued_at when set
  CONSTRAINT fg_revoke_after_issue CHECK (
    revoked_at IS NULL OR revoked_at >= issued_at
  ),

  -- expires_at must be in the future at issue time is NOT enforced here
  -- (the app layer handles it; the DB records whatever the issuer set).
  CONSTRAINT fg_expires_after_issue CHECK (
    expires_at IS NULL OR expires_at > issued_at
  )
);

-- ============================================================
-- 2. Indexes
-- ============================================================

-- Primary lookup: "give me active grants for audience X that haven't expired"
CREATE INDEX IF NOT EXISTS idx_fg_audience_active
  ON agent_graph.federation_grants (audience_org, expires_at)
  WHERE revoked_at IS NULL;

-- Contract deduplication + cross-org audit join
CREATE INDEX IF NOT EXISTS idx_fg_contract_hash
  ON agent_graph.federation_grants (contract_hash);

-- ============================================================
-- 3. Hash-chained lifecycle via state_transitions trigger
--
-- Every grant INSERT (issue) or revocation UPDATE writes a row to
-- agent_graph.state_transitions so the event is immutably hash-chained.
-- The synthetic work_item_id 'federation:grant:<jti>' is stable and
-- human-readable; it does NOT reference agent_graph.work_items (no FK
-- cross-schema concern; federation grants are org-level, not task-level).
--
-- Hash chain mechanics (mirrors transition_state() in 001-baseline.sql §1502):
--   prev_hash = last hash_chain_current for this work_item_id (or 'genesis')
--   payload   = prev_hash|<tid>|<work_item_id>|<from>|<to>|<agent>|<cfg>
--   current   = sha256(payload)
-- ============================================================
CREATE OR REPLACE FUNCTION agent_graph.fn_federation_grant_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agent_graph, public
AS $$
DECLARE
  v_work_item_id  TEXT;
  v_from_state    TEXT;
  v_to_state      TEXT;
  v_agent_id      TEXT;
  v_tid           TEXT;
  v_prev_hash     TEXT;
  v_payload       TEXT;
  v_hash          BYTEA;
BEGIN
  -- ── On INSERT: issue event (pending → active) ──────────────────────────────
  IF TG_OP = 'INSERT' THEN
    v_work_item_id := 'federation:grant:' || NEW.jti::text;
    v_from_state   := 'pending';
    v_to_state     := 'active';
    v_agent_id     := COALESCE(NEW.created_by::text, 'system');

  -- ── On UPDATE: only act when revoked_at is being set ──────────────────────
  ELSIF TG_OP = 'UPDATE' THEN
    -- Ignore updates that don't touch revoked_at (e.g. future extension fields)
    IF NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at THEN
      RETURN NEW;
    END IF;
    -- Prevent un-revoking (append-only guarantee, P3)
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'federation_grants: revoked_at cannot be cleared (grant % is already revoked)', OLD.jti;
    END IF;
    v_work_item_id := 'federation:grant:' || NEW.jti::text;
    v_from_state   := 'active';
    v_to_state     := 'revoked';
    v_agent_id     := COALESCE(current_setting('app.agent_id', true), 'system');
  ELSE
    RETURN NEW;
  END IF;

  -- ── Compute hash chain ─────────────────────────────────────────────────────
  SELECT encode(hash_chain_current, 'hex') INTO v_prev_hash
  FROM agent_graph.state_transitions
  WHERE work_item_id = v_work_item_id
  ORDER BY created_at DESC
  LIMIT 1;

  v_tid := gen_random_uuid()::text;

  -- Payload mirrors transition_state(): prev|tid|work_item|from|to|agent|cfg
  v_payload := COALESCE(v_prev_hash, 'genesis') || '|' ||
               v_tid || '|' || v_work_item_id || '|' ||
               v_from_state || '|' || v_to_state || '|' ||
               v_agent_id || '|' || NEW.contract_hash;

  v_hash := sha256(v_payload::bytea);

  INSERT INTO agent_graph.state_transitions (
    id,
    work_item_id,
    from_state,
    to_state,
    agent_id,
    config_hash,
    reason,
    guardrail_checks_json,
    cost_usd,
    hash_chain_prev,
    hash_chain_current,
    created_at
  ) VALUES (
    v_tid,
    v_work_item_id,
    v_from_state,
    v_to_state,
    v_agent_id,
    NEW.contract_hash,                        -- anchors contract in the chain
    CASE TG_OP
      WHEN 'INSERT' THEN 'federation grant issued; scope=' || NEW.scope_capability
      WHEN 'UPDATE' THEN 'federation grant revoked'
    END,
    '{}'::jsonb,
    0,
    CASE WHEN v_prev_hash IS NOT NULL THEN decode(v_prev_hash, 'hex') ELSE NULL END,
    v_hash,
    now()
  );

  RETURN NEW;
END;
$$;

-- Fire AFTER INSERT (grant issued) and AFTER UPDATE (revocation)
-- AFTER so NEW.jti is committed before we write the hash chain entry.
DROP TRIGGER IF EXISTS trg_fg_lifecycle_insert ON agent_graph.federation_grants;
CREATE TRIGGER trg_fg_lifecycle_insert
  AFTER INSERT ON agent_graph.federation_grants
  FOR EACH ROW
  EXECUTE FUNCTION agent_graph.fn_federation_grant_lifecycle();

DROP TRIGGER IF EXISTS trg_fg_lifecycle_update ON agent_graph.federation_grants;
CREATE TRIGGER trg_fg_lifecycle_update
  AFTER UPDATE OF revoked_at ON agent_graph.federation_grants
  FOR EACH ROW
  EXECUTE FUNCTION agent_graph.fn_federation_grant_lifecycle();

-- ============================================================
-- 4. RLS policies
--
-- These policies are correct for the target state (PR-B, STAQPRO-263).
-- They are DORMANT under the current superuser pool.
--
-- Activation path:
--   1. PR-B ships — pool connects as a scoped role (not superuser).
--   2. FORCE ROW LEVEL SECURITY is added for this table (one ALTER TABLE).
--   3. setAgentContext() already sets app.org — no app-layer changes needed.
--
-- Policy model:
--   INSERT: only the issuing org (app.org = issuer_org) may issue grants.
--           Under the current superuser pool this is unenforced — the app layer
--           is the sole guard until PR-B.
--   SELECT: issuer and audience can read their own rows; board role sees all.
--   UPDATE: same org gate as INSERT (only issuer can revoke).
--   DELETE: denied entirely (grants are revoked, not deleted; P3 append-only).
-- ============================================================
ALTER TABLE agent_graph.federation_grants ENABLE ROW LEVEL SECURITY;
-- NOTE: FORCE is intentionally omitted until PR-B ships. See design notes above.

-- INSERT: only the issuing org may create a grant
CREATE POLICY fg_insert ON agent_graph.federation_grants
  FOR INSERT
  WITH CHECK (
    current_setting('app.org', true) = issuer_org
    OR current_setting('app.role', true) = 'board'
  );

-- SELECT: issuer sees their grants; audience sees grants targeting them; board sees all
CREATE POLICY fg_select ON agent_graph.federation_grants
  FOR SELECT
  USING (
    current_setting('app.org', true) IN (issuer_org, audience_org)
    OR current_setting('app.role', true) = 'board'
  );

-- UPDATE: only the issuer (or board) may revoke
CREATE POLICY fg_update ON agent_graph.federation_grants
  FOR UPDATE
  USING (
    current_setting('app.org', true) = issuer_org
    OR current_setting('app.role', true) = 'board'
  );

-- DELETE: append-only — never allowed
CREATE POLICY fg_no_delete ON agent_graph.federation_grants
  FOR DELETE
  USING (false);
