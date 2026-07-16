-- STAQPRO-326 — bound signal.notify_graph_change payloads to stay under
-- the 8 KB pg_notify limit.
--
-- Migration 083 documented the limit but did not enforce it. A single
-- signal.contacts row with a large `notes` blob (or a contact with
-- accumulated `to_addresses` from years of email threads) would silently
-- drop the notification on the producer side, leaving Postgres and Neo4j
-- divergent until the next manual reconciliation pass.
--
-- The producer side cannot retry: Postgres NOTIFY is fire-and-forget. So
-- the fix is to detect over-size payloads BEFORE pg_notify and instead
-- emit a minimal `{ op, id, _truncated: true }` envelope. The sync.js
-- listener (lib/graph/sync.js) refetches the full row from Postgres when
-- it sees `_truncated`.
--
-- Threshold is 7,900 bytes — leaves headroom for the channel name + JSON
-- framing overhead. Postgres's hard cap is 8,000 (configurable, but we
-- target the default for portability).

CREATE OR REPLACE FUNCTION signal.notify_graph_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  channel        TEXT := TG_ARGV[0];
  op             TEXT;
  payload        JSONB;
  payload_text   TEXT;
  truncated      BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    op := 'insert';
    payload := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    op := 'update';
    payload := to_jsonb(NEW);
  ELSE
    op := 'delete';
    payload := jsonb_build_object('id', OLD.id);
  END IF;

  payload := payload || jsonb_build_object('op', op);
  payload_text := payload::text;

  -- Truncation path. Only triggered for insert/update; delete payloads are
  -- already minimal by construction. The listener resolves the full row
  -- by selecting on the id contained in the minimal payload.
  IF octet_length(payload_text) > 7900 THEN
    truncated := true;
    payload := jsonb_build_object(
      'op',          op,
      'id',          COALESCE(NEW.id::text, OLD.id::text),
      '_truncated',  true,
      '_table',      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      '_size_bytes', octet_length(payload_text)
    );
    payload_text := payload::text;
  END IF;

  PERFORM pg_notify(channel, payload_text);

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION signal.notify_graph_change() IS
  'Emits Postgres → Neo4j sync signals via pg_notify. Payloads >7,900 bytes are reduced to {op, id, _truncated:true, _table, _size_bytes} so the listener can re-fetch the full row.';
