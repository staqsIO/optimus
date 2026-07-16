-- 136-events-org-payload.sql — Phase-2 tenancy (live read-leak, Commit B)
--
-- Closes the SSE cross-tenant broadcast leak at the EMISSION boundary (P3:
-- transparency by structure, not by effort). Today the 087 needs_attention
-- trigger emits pg_notify('autobot_events', …) with a payload that carries NO
-- owner_org_id, so /api/events fans every org's terminal-failure event out to
-- every connected board client verbatim. This migration enriches the payload so
-- the SSE boundary filter (autobot-inbox/src/api.js GET /api/events) can drop
-- events whose org is not in the viewer principal's readOrgIds.
--
-- Mechanism (Linus blocker 2 — robust against missed call sites): the trigger
-- already holds NEW.work_item_id; agent_graph.work_items.owner_org_id exists
-- (migration 134). We do a single indexed PK lookup
--   SELECT owner_org_id FROM agent_graph.work_items WHERE id = NEW.work_item_id
-- and add it to the JSON payload. The trigger's FIRING CONDITIONS are unchanged
-- (still only terminal failed/timed_out at retry_count >= 3) — only the payload
-- is enriched. If the lookup returns NULL (un-stamped / legacy work item) the
-- payload carries owner_org_id = null; the SSE filter treats org-less events per
-- its CONTROL_EVENT_TYPES allowlist (needs_attention is NOT a control event, so
-- a null-org needs_attention event fails closed — dropped for non-admins).
--
-- Idempotent + Supabase-safe: CREATE OR REPLACE only, no auth-schema / pgcrypto
-- touch (pgcrypto already ensured by 087). Runs on deploy via best-effort migrate.
--
-- campaigns.owner_org_id: confirmed present (migration 134). campaign_hitl_requests
-- has NO owner_org_id and gets NO new column here — the SSE heartbeat HITL count
-- is scoped in api.js via a JOIN campaign_hitl_requests → campaigns on
-- campaigns.owner_org_id (no schema change needed). The IF-block below adds the
-- campaigns column only as a defensive backfill in the (not-expected) case 134
-- did not land it, so this migration is self-sufficient.

-- Defensive: ensure campaigns.owner_org_id exists (should already, from mig 134).
-- ADD COLUMN IF NOT EXISTS + backfill-to-Staqs + DEFAULT Staqs keeps the SSE
-- HITL join (api.js) functional even on a DB where 134's column add was skipped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'agent_graph' AND table_name = 'campaigns'
  ) THEN
    ALTER TABLE agent_graph.campaigns
      ADD COLUMN IF NOT EXISTS owner_org_id UUID
        DEFAULT '7c164445-43f2-4802-a7d3-5cab06611e99'::uuid;
    UPDATE agent_graph.campaigns
      SET owner_org_id = '7c164445-43f2-4802-a7d3-5cab06611e99'::uuid
      WHERE owner_org_id IS NULL;
  END IF;
END $$;

-- Re-create the 087 trigger function with owner_org_id enriched into the payload.
-- Body is byte-for-byte the 087 function PLUS:
--   * a v_owner_org_id lookup against agent_graph.work_items (one indexed PK read,
--     only on the already-rare terminal-failure path the function reaches here)
--   * 'owner_org_id' added to the jsonb_build_object payload
-- Everything else (early exits, retry gate, reason normalization/hashing, the
-- durable needs_attention_log insert, the pg_notify channel) is UNCHANGED.
CREATE OR REPLACE FUNCTION agent_graph.notify_needs_attention()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_retry_count INTEGER;
  v_max_retries CONSTANT INTEGER := 3;  -- SPEC §11
  v_signature   TEXT;
  v_normalized  TEXT;
  v_owner_org_id UUID;
  v_payload     JSONB;
BEGIN
  IF NEW.to_state NOT IN ('failed', 'timed_out') THEN
    RETURN NEW;
  END IF;

  IF NEW.work_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- One indexed PK read. Fetch retry_count AND owner_org_id together (was already
  -- selecting retry_count from this row in mig 087 — owner_org_id is free here).
  -- owner_org_id added to work_items by migration 134; COALESCE handled by the
  -- SSE filter, not here (we forward the raw value, possibly NULL).
  -- NOTE: PGlite divergence accepted — prod Staqs UUID is the canonical fallback for legacy NULL owner_org_id; PGlite seeds a random org UUID (mig 133) so legacy docs are Staqs-visible in prod only.
  -- Unlike the RAG path (mig 135) this trigger does NOT COALESCE NULL → Staqs; it
  -- forwards owner_org_id verbatim and the SSE filter fails closed on a null-org
  -- needs_attention event for non-admins.
  SELECT retry_count, owner_org_id
    INTO v_retry_count, v_owner_org_id
  FROM agent_graph.work_items
  WHERE id = NEW.work_item_id;

  IF v_retry_count IS NULL OR v_retry_count < v_max_retries THEN
    RETURN NEW;
  END IF;

  -- Normalize reason text before hashing so transient values (UUIDs,
  -- timestamps, large numeric IDs) don't fragment the cluster.
  v_normalized := lower(coalesce(NEW.reason, ''));
  v_normalized := regexp_replace(
    v_normalized,
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
    '<uuid>', 'g'
  );
  v_normalized := regexp_replace(
    v_normalized,
    '\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}',
    '<ts>', 'g'
  );
  v_normalized := regexp_replace(v_normalized, '\d{6,}', '<num>', 'g');

  v_signature := substring(
    encode(digest(v_normalized::bytea, 'sha256'), 'hex')
    from 1 for 12
  );

  v_payload := jsonb_build_object(
    'event_type', 'needs_attention',
    'work_item_id', NEW.work_item_id,
    'agent_id', NEW.agent_id,
    'to_state', NEW.to_state,
    'retry_count', v_retry_count,
    'reason_signature', v_signature,
    'created_at', NEW.created_at,
    -- Commit B: stamp the owning org so the SSE boundary filter can drop this
    -- event for principals outside the org. NULL if the work item is un-stamped.
    'owner_org_id', v_owner_org_id
  );

  -- Log first (durable), then notify (fire-and-forget).
  INSERT INTO agent_graph.needs_attention_log
    (signature, work_item_id, agent_id, payload)
  VALUES
    (v_signature, NEW.work_item_id, NEW.agent_id, v_payload);

  -- pg_notify caps payload at 8000 bytes; this payload is well under.
  PERFORM pg_notify('autobot_events', v_payload::text);

  RETURN NEW;
END;
$$;

-- Trigger binding is unchanged from 087; re-assert idempotently so a fresh DB
-- that applies 136 without 087 (it won't, but defensively) still wires it.
DROP TRIGGER IF EXISTS state_transitions_notify_attention
  ON agent_graph.state_transitions;
CREATE TRIGGER state_transitions_notify_attention
  AFTER INSERT ON agent_graph.state_transitions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.notify_needs_attention();
