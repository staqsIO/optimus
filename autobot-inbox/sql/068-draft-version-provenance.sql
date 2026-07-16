-- 068: Provenance on AI-edit draft versions.
--
-- Background
-- ----------
-- /api/contracts/:id/edit calls retrieveContext() to pull email / meeting /
-- KB chunks as context for the LLM, then throws the chunks away once the
-- response is back. The board has no way to audit "where did this clause
-- come from" — which is the single most differentiated feature /contracts
-- has over DocuSign-style tools.
--
-- Change
-- ------
-- Adds content.draft_versions.rag_chunks JSONB holding the trimmed-down
-- shape we actually need in the UI:
--   [{ id, text, source, documentId, similarity, metadata? }, ...]
-- append_draft_version() grows a p_rag_chunks trailing parameter so AI
-- edits can stamp it at insert time (immutability trigger blocks later
-- updates).
--
-- Non-goals
-- ---------
-- * No inline citation markers in the body text — that would need editor
--   surgery. The UI surfaces sources via a per-version panel instead.

ALTER TABLE content.draft_versions
  ADD COLUMN IF NOT EXISTS rag_chunks JSONB;

COMMENT ON COLUMN content.draft_versions.rag_chunks IS
  'For change_source=ai_edit only. Array of RAG chunks passed to the LLM as '
  'context: [{ id, text, source, documentId, similarity, metadata }]. Surfaced '
  'in the version history panel as "N sources" — click shows original excerpts.';

-- Partial index for "show me AI versions that had citations" queries. Tiny
-- data so GIN is overkill; just flag presence.
CREATE INDEX IF NOT EXISTS idx_draft_versions_has_rag
  ON content.draft_versions (draft_id, version_number DESC)
  WHERE rag_chunks IS NOT NULL;

-- ============================================================
-- Extend append_draft_version() with p_rag_chunks
-- Correction to an earlier comment: CREATE OR REPLACE FUNCTION in Postgres
-- matches by argument list, not by name. Adding a new parameter produces a
-- second overload alongside 062's 7-arg version rather than replacing it,
-- which then breaks any bare `COMMENT ON FUNCTION content.append_draft_version`
-- (and any call without argument coercion) with "function name is not unique".
--
-- Drop the 7-arg signature explicitly so only the 8-arg version remains.
-- DROP FUNCTION IF EXISTS must cite the exact parameter types it originally
-- had — defaults don't count at DROP time. Safe to run on a fresh DB where
-- the 7-arg version never existed (IF EXISTS short-circuits cleanly).
-- ============================================================

DROP FUNCTION IF EXISTS content.append_draft_version(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT
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

  SELECT id, version_number, body_hash, change_source, created_at
    INTO v_latest_id, v_latest_num, v_latest_hash, v_latest_source, v_latest_created
  FROM content.draft_versions
  WHERE draft_id = p_draft_id
  ORDER BY version_number DESC
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

-- Explicit argument list so the comment targets the one-and-only remaining
-- overload. If someone ever re-introduces a second overload, this breaks
-- loudly rather than attaching to the wrong function.
COMMENT ON FUNCTION content.append_draft_version(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB
) IS
  'Appends a new draft version with two dedup rules: (1) hash match short-circuits '
  'to the existing row; (2) consecutive manual autosaves within 2 minutes collapse '
  'into the first one so typing sessions do not spam history. AI edits, reverts, '
  'and counter-proposals always create a new row. p_rag_chunks carries provenance '
  'for AI edits (populated at insert, not updatable — immutability trigger).';
