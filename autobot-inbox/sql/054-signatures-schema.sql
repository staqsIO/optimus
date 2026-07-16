-- 054: E-signature system schema
-- New `signatures` schema — isolated from content schema per D5 / no cross-schema FKs.
-- content.drafts is referenced by external_id (TEXT) + source_schema (TEXT), not FK.
-- Hash chain follows agent_graph.state_transitions pattern: sha256(prev||payload) stored as BYTEA.

CREATE SCHEMA IF NOT EXISTS signatures;

-- ============================================================
-- ENUMS (CHECK constraints — Postgres-idiomatic, no CREATE TYPE needed)
-- ============================================================

-- ============================================================
-- TABLE: signature_requests
-- One row per document sent for signature.
-- draft_id + draft_schema are soft references to content.drafts.id
-- (UUID stored as TEXT to avoid cross-schema FK per convention).
-- document_hash is SHA-256 of draft body at send time — tamper detection anchor.
-- ============================================================
CREATE TABLE signatures.signature_requests (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Soft reference to content.drafts (no cross-schema FK per D5/CLAUDE.md convention)
  draft_id            UUID        NOT NULL,                         -- content.drafts.id value
  draft_schema        TEXT        NOT NULL DEFAULT 'content',      -- source schema name

  -- Document integrity anchor: SHA-256 of draft body at send time (hex-encoded)
  document_hash       TEXT        NOT NULL,

  -- Routing mode
  signing_mode        TEXT        NOT NULL DEFAULT 'parallel'
                        CHECK (signing_mode IN ('sequential', 'parallel')),

  -- Lifecycle
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'completed', 'declined', 'expired', 'cancelled')),

  expires_at          TIMESTAMPTZ NOT NULL,

  -- Who created this request (board member user id or agent id)
  created_by          TEXT        NOT NULL,

  -- Metadata
  title               TEXT        NOT NULL,
  message             TEXT,                                         -- cover message to signers

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN signatures.signature_requests.document_hash IS
  'SHA-256 hex of content.drafts.body at the moment this request was created. '
  'Compared against re-fetched body on every sign attempt. Mismatch = tamper detected, sign blocked.';

COMMENT ON COLUMN signatures.signature_requests.draft_id IS
  'Soft reference to content.drafts.id. No FK — cross-schema FKs are prohibited (D5). '
  'Application layer must verify the draft exists before creating a request.';

-- ============================================================
-- TABLE: signers
-- One row per expected signer on a request.
-- signing_token is the secret used in the public signing URL — must be unguessable.
-- For sequential mode, signing_order controls who goes first.
-- ============================================================
CREATE TABLE signatures.signers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          UUID        NOT NULL REFERENCES signatures.signature_requests(id) ON DELETE CASCADE,

  -- Signer identity
  email               TEXT        NOT NULL,
  display_name        TEXT        NOT NULL,

  -- Sequential ordering (NULL = parallel / order doesn't apply)
  signing_order       INTEGER,

  -- Status
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'viewed', 'signed', 'declined', 'expired')),

  -- The token embedded in the signing URL — 32-byte random, hex-encoded (64 chars)
  -- This is the ONLY way to authenticate a public signer. Treat like a password.
  signing_token       TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),

  -- Set when the signer completes their action
  completed_at        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (request_id, email)
);

COMMENT ON COLUMN signatures.signers.signing_token IS
  '64-char hex token (32 random bytes). Embedded in signing URL as the sole auth mechanism '
  'for the public-facing signing endpoint. Never log this value. Rotated on expiry.';

COMMENT ON COLUMN signatures.signers.signing_order IS
  'Only meaningful when signature_requests.signing_mode = sequential. '
  'NULL-safe: parallel signers all have NULL. Sequential signers use 1, 2, 3...';

-- ============================================================
-- TABLE: signature_events
-- Append-only audit log. One row per action (viewed, signed, declined, expired).
-- Hash chain: sha256(prev_hash || event_id || signer_id || event_type || timestamp)
-- Mirrors agent_graph.state_transitions chain exactly.
-- ip_address stored as TEXT (supports both IPv4 and IPv6).
-- ============================================================
CREATE TABLE signatures.signature_events (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),

  request_id          UUID        NOT NULL REFERENCES signatures.signature_requests(id),
  signer_id           UUID        NOT NULL REFERENCES signatures.signers(id),

  event_type          TEXT        NOT NULL
                        CHECK (event_type IN ('viewed', 'signed', 'declined', 'expired', 'bounced')),

  -- What the signer saw and agreed to
  consent_text        TEXT,                                         -- exact text shown at sign time
  typed_name          TEXT,                                         -- typed name (for 'signed' events)

  -- Document integrity: re-hash of draft body at event time for comparison
  -- Must match signature_requests.document_hash or event is rejected
  document_hash_at_event TEXT,

  -- Signer context
  ip_address          TEXT,
  user_agent          TEXT,

  -- Hash chain (mirrors state_transitions: hash_chain_prev + hash_chain_current as BYTEA)
  hash_chain_prev     BYTEA,                                        -- NULL for genesis event
  hash_chain_current  BYTEA        NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions — extend as needed (same pattern as state_transitions)
CREATE TABLE signatures.signature_events_2026_04 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE signatures.signature_events_2026_05 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE signatures.signature_events_2026_06 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE signatures.signature_events_2026_07 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE signatures.signature_events_2026_08 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE signatures.signature_events_2026_09 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE signatures.signature_events_2026_10 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE signatures.signature_events_2026_11 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE signatures.signature_events_2026_12 PARTITION OF signatures.signature_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE signatures.signature_events_default PARTITION OF signatures.signature_events DEFAULT;

COMMENT ON TABLE signatures.signature_events IS
  'Append-only. Immutability enforced by trigger (see prevent_signature_event_modification). '
  'Hash chain anchored at first event (hash_chain_prev IS NULL), each event covers: '
  'prev_hash || id || signer_id || event_type || document_hash_at_event || created_at.';

-- ============================================================
-- INDEXES
-- ============================================================

-- signature_requests: primary lookup patterns
CREATE INDEX idx_sig_requests_draft
  ON signatures.signature_requests (draft_id);                     -- "all requests for this draft"

CREATE INDEX idx_sig_requests_status_expires
  ON signatures.signature_requests (status, expires_at)
  WHERE status IN ('pending', 'in_progress');                       -- expiry sweep (only open requests)

CREATE INDEX idx_sig_requests_created_by
  ON signatures.signature_requests (created_by);                   -- board member's sent requests

-- signers: THE critical public-facing lookup
-- Signing URL is /sign/<token> — this lookup runs on every page load and form submit.
-- UNIQUE already creates an index, but explicit name + comment for clarity.
-- The UNIQUE constraint on signing_token already creates a btree index.
-- No additional index needed — UNIQUE index IS the lookup index.

-- signers: FK lookup (join from request to its signers)
CREATE INDEX idx_signers_request_id
  ON signatures.signers (request_id);                              -- MANDATORY: FK index (Prisma footgun avoided)

-- signers: status filter (find pending signers for a request)
CREATE INDEX idx_signers_request_status
  ON signatures.signers (request_id, status)
  WHERE status = 'pending';                                         -- partial: only pending signers

-- signers: sequential ordering lookup
CREATE INDEX idx_signers_request_order
  ON signatures.signers (request_id, signing_order)
  WHERE signing_order IS NOT NULL;                                  -- only sequential requests

-- signature_events: per-signer timeline (primary audit query)
CREATE INDEX idx_sig_events_signer
  ON signatures.signature_events (signer_id, created_at);

-- signature_events: per-request full audit trail
CREATE INDEX idx_sig_events_request
  ON signatures.signature_events (request_id, created_at);

-- signature_events: chain verification query (needs latest event per signer fast)
CREATE INDEX idx_sig_events_signer_desc
  ON signatures.signature_events (signer_id, created_at DESC);

-- ============================================================
-- IMMUTABILITY TRIGGER on signature_events
-- Mirrors the agent_graph.threat_memory immutability pattern.
-- ============================================================
CREATE OR REPLACE FUNCTION signatures.prevent_event_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signature_events rows are immutable. id=%, created_at=%',
    OLD.id, OLD.created_at;
END;
$$;

CREATE TRIGGER trg_signature_events_immutable
  BEFORE UPDATE OR DELETE ON signatures.signature_events
  FOR EACH ROW EXECUTE FUNCTION signatures.prevent_event_modification();

-- ============================================================
-- FUNCTION: append_signature_event
-- Computes the hash chain and inserts atomically.
-- Payload: prev_hash_hex || '|' || id || '|' || signer_id || '|' ||
--          event_type || '|' || COALESCE(document_hash_at_event,'') || '|' || created_at
-- Callers pass document_hash_at_event; function validates it matches
-- signature_requests.document_hash before inserting.
-- Returns the new event id and chain hash (hex) for the caller to log.
-- ============================================================
CREATE OR REPLACE FUNCTION signatures.append_signature_event(
  p_request_id            UUID,
  p_signer_id             UUID,
  p_event_type            TEXT,
  p_document_hash         TEXT,         -- SHA-256 of document body re-fetched by caller
  p_consent_text          TEXT DEFAULT NULL,
  p_typed_name            TEXT DEFAULT NULL,
  p_ip_address            TEXT DEFAULT NULL,
  p_user_agent            TEXT DEFAULT NULL
) RETURNS TABLE (
  event_id                UUID,
  chain_hash_hex          TEXT,
  tamper_detected         BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
  v_expected_hash   TEXT;
  v_prev_bytea      BYTEA;
  v_prev_hex        TEXT;
  v_event_id        UUID := gen_random_uuid();
  v_now             TIMESTAMPTZ := now();
  v_payload         TEXT;
  v_hash            BYTEA;
BEGIN
  -- 1. Tamper check: compare document hash against the anchor
  SELECT document_hash INTO v_expected_hash
  FROM signatures.signature_requests
  WHERE id = p_request_id;

  IF v_expected_hash IS DISTINCT FROM p_document_hash THEN
    -- Return tamper_detected = true without inserting — caller decides how to surface this
    event_id         := NULL;
    chain_hash_hex   := NULL;
    tamper_detected  := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 2. Fetch previous event hash for this signer (most recent)
  SELECT hash_chain_current INTO v_prev_bytea
  FROM signatures.signature_events
  WHERE signer_id = p_signer_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_prev_hex := COALESCE(encode(v_prev_bytea, 'hex'), 'genesis');

  -- 3. Compute chain hash (same pattern as transition_state())
  v_payload := v_prev_hex || '|' ||
               v_event_id::text || '|' ||
               p_signer_id::text || '|' ||
               p_event_type || '|' ||
               COALESCE(p_document_hash, '') || '|' ||
               v_now::text;

  v_hash := sha256(v_payload::bytea);

  -- 4. Insert (trigger will block any UPDATE/DELETE)
  INSERT INTO signatures.signature_events (
    id, request_id, signer_id, event_type,
    consent_text, typed_name, document_hash_at_event,
    ip_address, user_agent,
    hash_chain_prev, hash_chain_current,
    created_at
  ) VALUES (
    v_event_id, p_request_id, p_signer_id, p_event_type,
    p_consent_text, p_typed_name, p_document_hash,
    p_ip_address, p_user_agent,
    v_prev_bytea, v_hash,
    v_now
  );

  -- 5. Update signer status
  UPDATE signatures.signers
  SET status       = p_event_type,
      completed_at = CASE WHEN p_event_type IN ('signed', 'declined', 'expired') THEN v_now ELSE completed_at END,
      updated_at   = v_now
  WHERE id = p_signer_id;

  -- 6. Update request status if all signers are done
  UPDATE signatures.signature_requests sr
  SET status     = CASE
                     WHEN NOT EXISTS (
                       SELECT 1 FROM signatures.signers s
                       WHERE s.request_id = p_request_id
                         AND s.status = 'pending'
                     ) THEN
                       CASE
                         WHEN EXISTS (SELECT 1 FROM signatures.signers s2
                                      WHERE s2.request_id = p_request_id AND s2.status = 'declined')
                         THEN 'declined'
                         ELSE 'completed'
                       END
                     ELSE sr.status
                   END,
      updated_at = v_now
  WHERE sr.id = p_request_id;

  event_id        := v_event_id;
  chain_hash_hex  := encode(v_hash, 'hex');
  tamper_detected := FALSE;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- FUNCTION: verify_signature_chain
-- Walks the event chain for a signer and validates hash continuity.
-- Returns (is_valid, broken_at_id, rows_checked) — same shape as verify_ledger_chain.
-- ============================================================
CREATE OR REPLACE FUNCTION signatures.verify_signature_chain(
  p_signer_id UUID
) RETURNS TABLE (
  is_valid        BOOLEAN,
  broken_at_id    UUID,
  broken_at_time  TIMESTAMPTZ,
  expected_prev   TEXT,
  actual_prev     TEXT,
  rows_checked    BIGINT
) LANGUAGE plpgsql AS $$
DECLARE
  v_row       RECORD;
  v_prev      BYTEA := NULL;
  v_count     BIGINT := 0;
BEGIN
  FOR v_row IN
    SELECT id, hash_chain_prev, hash_chain_current, created_at
    FROM signatures.signature_events
    WHERE signer_id = p_signer_id
    ORDER BY created_at, id
  LOOP
    v_count := v_count + 1;
    IF v_prev IS NOT NULL THEN
      IF v_row.hash_chain_prev IS DISTINCT FROM v_prev THEN
        is_valid       := FALSE;
        broken_at_id   := v_row.id;
        broken_at_time := v_row.created_at;
        expected_prev  := encode(v_prev, 'hex');
        actual_prev    := COALESCE(encode(v_row.hash_chain_prev, 'hex'), 'NULL');
        rows_checked   := v_count;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
    v_prev := v_row.hash_chain_current;
  END LOOP;

  is_valid       := TRUE;
  broken_at_id   := NULL;
  broken_at_time := NULL;
  expected_prev  := NULL;
  actual_prev    := NULL;
  rows_checked   := v_count;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE signatures.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures.signers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures.signature_events   ENABLE ROW LEVEL SECURITY;

-- Policy: board members (authenticated via Supabase session) see all requests they created
-- or where they are a signer.
CREATE POLICY "Board members see their own requests"
  ON signatures.signature_requests
  FOR SELECT
  USING (created_by = auth.uid()::text);

-- Policy: signers access their own row via token — but token lookup happens via
-- a SECURITY DEFINER function, not direct table access. Public signers have no
-- Supabase session. The signing endpoint uses the service role to call
-- append_signature_event() after validating the token in application code.
-- This policy intentionally restricts direct SELECT to authenticated board members only.
CREATE POLICY "Board members see signers for their requests"
  ON signatures.signers
  FOR SELECT
  USING (
    request_id IN (
      SELECT id FROM signatures.signature_requests
      WHERE created_by = auth.uid()::text
    )
  );

CREATE POLICY "Board members see events for their requests"
  ON signatures.signature_events
  FOR SELECT
  USING (
    request_id IN (
      SELECT id FROM signatures.signature_requests
      WHERE created_by = auth.uid()::text
    )
  );

-- Service role (application backend) bypasses RLS — inserts go through
-- append_signature_event() which is called with service role credentials.
-- No INSERT policy needed: service role = RLS bypass by default in Supabase.

-- ============================================================
-- VERIFICATION QUERIES (run after applying migration)
-- ============================================================
-- Verify RLS is enabled:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'signatures';
--   -- Expected: rowsecurity = true for all three tables
--
-- Verify token uniqueness index exists:
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'signatures' AND tablename = 'signers'
--   AND indexname LIKE '%signing_token%';
--
-- Verify tamper detection (should return tamper_detected = true):
--   SELECT * FROM signatures.append_signature_event(
--     '<valid_request_id>', '<valid_signer_id>',
--     'viewed', 'deadbeef00000000000000000000000000000000000000000000000000000000'
--   );
