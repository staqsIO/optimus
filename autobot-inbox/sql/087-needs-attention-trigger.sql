-- 087: Loud terminal failures.
--
-- When a work item exhausts retries (status -> failed/timed_out at
-- retry_count >= 3 per SPEC §11), emit pg_notify('needs_attention', ...)
-- and append to needs_attention_log so the board dashboard surfaces it
-- by structure rather than relying on someone scrolling the activity feed
-- (P3: transparency by structure, not by effort).
--
-- Payload deliberately excludes raw reason text (PII concern — reasons
-- can include email subjects, sender names, etc.). Reason is hashed to
-- a stable 12-char signature so the dashboard can group duplicates and
-- the retrospector can populate failure_signatures with cluster counts.

-- pgcrypto provides digest() for the signature hash.
-- Wrapped in DO/EXCEPTION so PGlite (tests/dev) — which doesn't ship
-- pgcrypto — can still apply the rest of the migration (the trigger fires
-- only on state_transitions INSERTs, which the PGlite test path doesn't
-- exercise; production Postgres has pgcrypto so digest() resolves at runtime).
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto not available — needs_attention trigger digest() will fail at runtime if invoked';
END $$;

-- Cluster table populated by the retrospector (lib/runtime/retrospector.js).
-- The trigger below does NOT write here — it only writes to needs_attention_log.
-- Keeping the two tables decoupled lets the trigger stay synchronous-cheap
-- and lets the retrospector do more aggressive reason normalization in JS.
CREATE TABLE IF NOT EXISTS agent_graph.failure_signatures (
  signature           TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  sample_work_item_id TEXT,
  sample_reason       TEXT,
  count               INTEGER NOT NULL DEFAULT 1,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signature, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_failure_signatures_last_seen
  ON agent_graph.failure_signatures (last_seen DESC);

-- Durable log of every needs_attention emission. The dashboard queries this
-- on (re)connect to catch up on events it missed while the SSE stream was
-- down (pg_notify is fire-and-forget — without this log, restarts lose data).
-- TODO(infra): add a pruner (pg_cron or app-level) for rows older than 30 days
-- with acknowledged_at IS NOT NULL.
CREATE TABLE IF NOT EXISTS agent_graph.needs_attention_log (
  id              BIGSERIAL PRIMARY KEY,
  signature       TEXT NOT NULL,
  work_item_id    TEXT,
  agent_id        TEXT,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_needs_attention_log_unack
  ON agent_graph.needs_attention_log (created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_needs_attention_log_signature
  ON agent_graph.needs_attention_log (signature, created_at DESC);

-- Trigger function. Fires on every state_transitions INSERT but exits
-- cheaply for non-terminal transitions, which is the vast majority.
--
-- Hot-path concern: state_transitions is hash-chained and on the agent
-- runtime hot path. The early-exit on to_state guarantees we only do the
-- work_items lookup for failed/timed_out rows.
CREATE OR REPLACE FUNCTION agent_graph.notify_needs_attention()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_retry_count INTEGER;
  v_max_retries CONSTANT INTEGER := 3;  -- SPEC §11
  v_signature   TEXT;
  v_normalized  TEXT;
  v_payload     JSONB;
BEGIN
  IF NEW.to_state NOT IN ('failed', 'timed_out') THEN
    RETURN NEW;
  END IF;

  IF NEW.work_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT retry_count INTO v_retry_count
  FROM agent_graph.work_items
  WHERE id = NEW.work_item_id;

  IF v_retry_count IS NULL OR v_retry_count < v_max_retries THEN
    RETURN NEW;
  END IF;

  -- Normalize reason text before hashing so transient values (UUIDs,
  -- timestamps, large numeric IDs) don't fragment the cluster.
  -- The retrospector does deeper normalization in JS; this is the
  -- minimal version sufficient for dashboard grouping.
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
    'created_at', NEW.created_at
  );

  -- Log first (durable), then notify (fire-and-forget). The log lets the
  -- dashboard catch up on reconnect — pg_notify alone loses events when
  -- the LISTEN session drops.
  INSERT INTO agent_graph.needs_attention_log
    (signature, work_item_id, agent_id, payload)
  VALUES
    (v_signature, NEW.work_item_id, NEW.agent_id, v_payload);

  -- Use the existing 'autobot_events' channel that lib/runtime/event-bus.js
  -- already LISTENs on, so /api/events fans this out to all SSE clients
  -- (including the board's EventStreamProvider) without new infrastructure.
  -- pg_notify caps payload at 8000 bytes; this payload is well under.
  PERFORM pg_notify('autobot_events', v_payload::text);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS state_transitions_notify_attention
  ON agent_graph.state_transitions;
CREATE TRIGGER state_transitions_notify_attention
  AFTER INSERT ON agent_graph.state_transitions
  FOR EACH ROW EXECUTE FUNCTION agent_graph.notify_needs_attention();
