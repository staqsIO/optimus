-- 063: Include attachments in the document tamper-detection hash.
--
-- Background
-- ----------
-- signatures.signature_requests.document_hash was computed as sha256(body) only.
-- Attachments (exhibits, diagrams, supplementary docs) live in
-- content.contract_attachments and could be swapped after the request was sent
-- without any tamper flag firing at sign time.
--
-- Change
-- ------
--   1. content.contract_attachments gains content_hash, derived from BYTEA
--      content by a BEFORE trigger. Backfill existing rows.
--   2. signatures.signature_requests gains hash_version (1 = body only,
--      2 = body + sorted attachment fingerprints). Existing rows stay on v1
--      so their anchors continue to compare correctly; new rows default to v2.
--   3. signatures.compute_document_hash() is the single canonical formula.
--      All signing code (lib/signatures/session.js, lib/signatures/signer.js)
--      must call it instead of computing sha256 in Node.

-- ============================================================
-- 1. Attachment content hash
-- ============================================================

ALTER TABLE content.contract_attachments
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE OR REPLACE FUNCTION content.set_attachment_content_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_hash := encode(sha256(NEW.content), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attachments_content_hash ON content.contract_attachments;
CREATE TRIGGER trg_attachments_content_hash
  BEFORE INSERT OR UPDATE OF content ON content.contract_attachments
  FOR EACH ROW EXECUTE FUNCTION content.set_attachment_content_hash();

-- Backfill any rows that existed before the trigger was attached
UPDATE content.contract_attachments
SET content_hash = encode(sha256(content), 'hex')
WHERE content_hash IS NULL;

ALTER TABLE content.contract_attachments
  ALTER COLUMN content_hash SET NOT NULL;

COMMENT ON COLUMN content.contract_attachments.content_hash IS
  'SHA-256 hex of content bytes. Maintained by trg_attachments_content_hash. '
  'Used by signatures.compute_document_hash() to include attachments in the '
  'document tamper-detection anchor.';

-- ============================================================
-- 2. Hash version on signature_requests
-- ============================================================

ALTER TABLE signatures.signature_requests
  ADD COLUMN IF NOT EXISTS hash_version INTEGER NOT NULL DEFAULT 2
    CHECK (hash_version IN (1, 2));

-- Grandfather existing requests onto v1 (body-only). We can't re-anchor them
-- safely because we don't know whether their attachments have changed since send.
-- New requests default to v2 via the column default.
UPDATE signatures.signature_requests
SET hash_version = 1
WHERE created_at < now();

COMMENT ON COLUMN signatures.signature_requests.hash_version IS
  'Which formula was used to compute document_hash. 1 = sha256(body) only; '
  '2 = sha256(body || sep || sorted attachment fingerprints). Stored so '
  'existing anchors keep comparing correctly after the formula evolved.';

-- ============================================================
-- 3. compute_document_hash — single canonical formula
-- ============================================================

CREATE OR REPLACE FUNCTION signatures.compute_document_hash(
  p_draft_id      UUID,
  p_hash_version  INTEGER DEFAULT 2
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_body         TEXT;
  v_attach_part  TEXT;
BEGIN
  SELECT body INTO v_body FROM content.drafts WHERE id = p_draft_id;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Draft % not found', p_draft_id;
  END IF;

  IF p_hash_version = 1 THEN
    -- convert_to for explicit UTF-8 bytes; matches what Node's
    -- createHash('sha256').update(body) produced for pre-063 anchors.
    RETURN encode(sha256(convert_to(v_body, 'UTF8')), 'hex');
  END IF;

  -- v2: body + sorted attachment fingerprints, hashed over bytea (not text)
  -- so the separator can use NUL bytes that TEXT can't hold.
  -- Canonical byte sequence:
  --   body_utf8 || 0x00 'ATTACH' 0x00 || attach_part_utf8
  -- Attachment part is: id1 || ':' || hash1 || '|' || id2 || ':' || hash2 || ...
  -- Sorted by id for determinism; empty string when no attachments.
  SELECT COALESCE(
    string_agg(id::text || ':' || content_hash, '|' ORDER BY id),
    ''
  )
  INTO v_attach_part
  FROM content.contract_attachments
  WHERE draft_id = p_draft_id;

  RETURN encode(
    sha256(
      convert_to(v_body, 'UTF8')
      || '\x0041545441434800'::bytea   -- NUL 'A' 'T' 'T' 'A' 'C' 'H' NUL
      || convert_to(v_attach_part, 'UTF8')
    ),
    'hex'
  );
END;
$$;

COMMENT ON FUNCTION signatures.compute_document_hash IS
  'Canonical document hash. v1 = sha256(body utf8). v2 = sha256(body utf8 || '
  'NUL ATTACH NUL || sorted(attachment_id:content_hash, ...) utf8). Hashed over '
  'bytea so the separator can use NUL bytes that Postgres TEXT can''t hold. '
  'Callers must use the same version as stored in signature_requests.hash_version '
  'for that request. lib/signatures/*.js MUST use this rather than computing '
  'sha256 in Node to avoid formula drift.';

-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================
-- 1. Attachment hash populated:
--   SELECT count(*) FILTER (WHERE content_hash IS NULL) AS missing,
--          count(*) FILTER (WHERE content_hash ~ '^[0-9a-f]{64}$') AS valid,
--          count(*) AS total
--   FROM content.contract_attachments;
--
-- 2. Hash version assignment:
--   SELECT hash_version, count(*) FROM signatures.signature_requests GROUP BY 1;
--
-- 3. Re-computation matches anchor for existing v1 requests:
--   SELECT id,
--          document_hash,
--          signatures.compute_document_hash(draft_id, hash_version) AS recomputed,
--          document_hash = signatures.compute_document_hash(draft_id, hash_version) AS matches
--   FROM signatures.signature_requests
--   WHERE status IN ('pending', 'in_progress')
--   LIMIT 20;
