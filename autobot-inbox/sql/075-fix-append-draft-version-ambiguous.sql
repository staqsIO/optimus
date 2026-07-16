-- 075: Fix "column reference 'version_number' is ambiguous" in
-- content.append_draft_version().
--
-- Bug
-- ---
-- POST /api/contracts/new fails with:
--   ERROR: column reference "version_number" is ambiguous
-- because the function declares `version_number` as both an OUT parameter
-- (from RETURNS TABLE on line 68 of migration 068) and references the
-- column `content.draft_versions.version_number` inside the body without
-- a table alias. Postgres' planner treats both as candidates in
-- SELECT/ORDER BY contexts and refuses to guess.
--
-- The same body shipped in 062 and worked, then 068's CREATE OR REPLACE
-- (with the new p_rag_chunks parameter) re-parsed the function and the
-- ambiguity surfaced.
--
-- Fix
-- ---
-- Alias `content.draft_versions` as `dv` and fully qualify all column
-- references inside the SELECT INTO and ORDER BY. Function signature
-- and return shape are unchanged so callers (api-routes/contracts.js)
-- need no edits.

DROP FUNCTION IF EXISTS content.append_draft_version(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB
);

CREATE OR REPLACE FUNCTION content.append_draft_version(
  p_draft_id      UUID,
  p_body          TEXT,
  p_source        TEXT,
  p_summary       TEXT    DEFAULT NULL,
  p_created_by    TEXT    DEFAULT 'unknown',
  p_cost_usd      NUMERIC DEFAULT NULL,
  p_model         TEXT    DEFAULT NULL,
  p_rag_chunks    JSONB   DEFAULT NULL
) RETURNS TABLE (
  version_id      UUID,
  version_number  INTEGER,
  deduplicated    BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
  v_hash              TEXT;
  v_latest_hash       TEXT;
  v_latest_id         UUID;
  v_latest_num        INTEGER;
  v_latest_source     TEXT;
  v_latest_created    TIMESTAMPTZ;
  v_word_count        INTEGER;
  v_new_id            UUID;
  v_manual_debounce   INTERVAL := INTERVAL '2 minutes';
BEGIN
  v_hash := encode(sha256(p_body::bytea), 'hex');
  v_word_count := array_length(
    regexp_split_to_array(regexp_replace(p_body, '<[^>]+>', ' ', 'g'), '\s+'),
    1
  );
  IF v_word_count IS NULL THEN v_word_count := 0; END IF;

  -- Disambiguate: dv.version_number is the table column; bare
  -- version_number would also match the function's OUT parameter.
  SELECT dv.id, dv.version_number, dv.body_hash, dv.change_source, dv.created_at
    INTO v_latest_id, v_latest_num, v_latest_hash, v_latest_source, v_latest_created
  FROM content.draft_versions dv
  WHERE dv.draft_id = p_draft_id
  ORDER BY dv.version_number DESC
  LIMIT 1;

  -- Dedup #1: identical body = no-op
  IF v_latest_hash IS NOT NULL AND v_latest_hash = v_hash THEN
    version_id     := v_latest_id;
    version_number := v_latest_num;
    deduplicated   := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Dedup #2: consecutive manual autosaves within debounce window collapse
  IF p_source = 'manual'
     AND v_latest_source = 'manual'
     AND v_latest_created IS NOT NULL
     AND v_latest_created > now() - v_manual_debounce THEN
    version_id     := v_latest_id;
    version_number := v_latest_num;
    deduplicated   := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_new_id := gen_random_uuid();
  INSERT INTO content.draft_versions (
    id, draft_id, version_number, body, body_hash, word_count,
    change_source, change_summary, created_by,
    cost_usd, model, parent_version_id, rag_chunks
  ) VALUES (
    v_new_id, p_draft_id, COALESCE(v_latest_num, 0) + 1,
    p_body, v_hash, v_word_count,
    p_source, p_summary, p_created_by,
    p_cost_usd, p_model, v_latest_id, p_rag_chunks
  );

  version_id     := v_new_id;
  version_number := COALESCE(v_latest_num, 0) + 1;
  deduplicated   := FALSE;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION content.append_draft_version(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB
) IS
  'Appends a new draft version with two dedup rules: (1) hash match short-circuits '
  'to the existing row; (2) consecutive manual autosaves within 2 minutes collapse '
  'into the first one so typing sessions do not spam history. AI edits, reverts, '
  'and counter-proposals always create a new row. p_rag_chunks carries provenance '
  'for AI edits (populated at insert, not updatable — immutability trigger). '
  '075 fix: alias content.draft_versions as dv to disambiguate version_number '
  'from the OUT parameter of the same name.';
