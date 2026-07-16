-- 062: Contract draft body versioning
-- Append-only history of every draft body. Every AI edit, manual autosave,
-- revert, and counter-proposal snapshots here. Immutability enforced by trigger.
-- Dedup: if the new body matches the latest version's hash, insert is a no-op —
-- this prevents AI-edit + debounced-autosave from creating duplicate versions.
-- content.drafts.id is the soft reference (same schema, so FK is allowed).

-- ============================================================
-- TABLE: content.draft_versions
-- ============================================================
CREATE TABLE IF NOT EXISTS content.draft_versions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            UUID        NOT NULL REFERENCES content.drafts(id) ON DELETE CASCADE,

  -- Sequential per draft. 1 = initial version.
  version_number      INTEGER     NOT NULL,

  -- Full body snapshot. Bodies are small (<100KB typical) so we store them
  -- in full rather than deltas — simpler, and makes revert a one-row read.
  body                TEXT        NOT NULL,
  body_hash           TEXT        NOT NULL,  -- sha256 hex; used for dedup
  word_count          INTEGER     NOT NULL DEFAULT 0,

  -- Provenance
  change_source       TEXT        NOT NULL
                        CHECK (change_source IN ('initial', 'manual', 'ai_edit', 'revert', 'counter_proposal')),
  change_summary      TEXT,                               -- LLM summary or "Reverted to v3" etc
  created_by          TEXT        NOT NULL DEFAULT 'unknown',  -- board user or agent name

  -- AI edit context (NULL for manual/initial/revert)
  cost_usd            NUMERIC(10, 6),
  model               TEXT,

  -- Chain pointer — previous version id, NULL for initial
  parent_version_id   UUID        REFERENCES content.draft_versions(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (draft_id, version_number)
);

COMMENT ON TABLE content.draft_versions IS
  'Append-only version history for content.drafts.body. Every save goes through '
  'append_draft_version() which dedups by body_hash against the latest version.';

COMMENT ON COLUMN content.draft_versions.body_hash IS
  'SHA-256 hex of body. Used for dedup — if a new save produces the same hash as '
  'the latest version, no new row is inserted. Handles AI-edit + autosave races.';

COMMENT ON COLUMN content.draft_versions.change_source IS
  'initial = first version on draft creation; manual = autosave from editor; '
  'ai_edit = AI Bar edit applied; revert = user reverted to prior version; '
  'counter_proposal = signer-proposed change accepted into the doc.';

-- ============================================================
-- INDEXES
-- ============================================================

-- Latest version lookup (for dedup check and history list)
CREATE INDEX IF NOT EXISTS idx_draft_versions_draft_number
  ON content.draft_versions (draft_id, version_number DESC);

-- History listing by time (usually equivalent to version_number but cheap to have)
CREATE INDEX IF NOT EXISTS idx_draft_versions_draft_created
  ON content.draft_versions (draft_id, created_at DESC);

-- ============================================================
-- IMMUTABILITY TRIGGER
-- Mirrors signatures.signature_events and agent_graph.state_transitions patterns.
-- ============================================================
CREATE OR REPLACE FUNCTION content.prevent_draft_version_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'draft_versions rows are immutable. id=%, version=%',
    OLD.id, OLD.version_number;
END;
$$;

DROP TRIGGER IF EXISTS trg_draft_versions_immutable ON content.draft_versions;
CREATE TRIGGER trg_draft_versions_immutable
  BEFORE UPDATE OR DELETE ON content.draft_versions
  FOR EACH ROW EXECUTE FUNCTION content.prevent_draft_version_modification();

-- ============================================================
-- FUNCTION: append_draft_version
-- Inserts a new version row. Dedup: if the body hash matches the latest
-- version's hash for this draft, returns NULL without inserting.
-- Caller pattern:
--   SELECT * FROM content.append_draft_version(
--     p_draft_id, p_body, p_source, p_summary, p_created_by,
--     p_cost_usd, p_model
--   );
-- ============================================================
CREATE OR REPLACE FUNCTION content.append_draft_version(
  p_draft_id      UUID,
  p_body          TEXT,
  p_source        TEXT,
  p_summary       TEXT    DEFAULT NULL,
  p_created_by    TEXT    DEFAULT 'unknown',
  p_cost_usd      NUMERIC DEFAULT NULL,
  p_model         TEXT    DEFAULT NULL
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
  -- Compute body hash (strip HTML tags for word_count, hash raw body)
  v_hash := encode(sha256(p_body::bytea), 'hex');
  v_word_count := array_length(
    regexp_split_to_array(regexp_replace(p_body, '<[^>]+>', ' ', 'g'), '\s+'),
    1
  );
  IF v_word_count IS NULL THEN v_word_count := 0; END IF;

  -- Look up the most recent version for this draft
  SELECT id, version_number, body_hash, change_source, created_at
    INTO v_latest_id, v_latest_num, v_latest_hash, v_latest_source, v_latest_created
  FROM content.draft_versions
  WHERE draft_id = p_draft_id
  ORDER BY version_number DESC
  LIMIT 1;

  -- Dedup check #1 — same body as the latest version? No-op.
  IF v_latest_hash IS NOT NULL AND v_latest_hash = v_hash THEN
    version_id     := v_latest_id;
    version_number := v_latest_num;
    deduplicated   := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Dedup check #2 — manual-save debounce. Autosave fires every 1.5s while
  -- typing; without this, a single editing session produces dozens of rows.
  -- If the latest version is also 'manual' and within the debounce window,
  -- skip the insert. AI edits, reverts, and counter-proposals bypass this
  -- because they always represent meaningful checkpoints.
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

  -- Insert new version (version_number = latest + 1, or 1 if none exist)
  v_new_id := gen_random_uuid();
  INSERT INTO content.draft_versions (
    id, draft_id, version_number, body, body_hash, word_count,
    change_source, change_summary, created_by,
    cost_usd, model, parent_version_id
  ) VALUES (
    v_new_id, p_draft_id, COALESCE(v_latest_num, 0) + 1,
    p_body, v_hash, v_word_count,
    p_source, p_summary, p_created_by,
    p_cost_usd, p_model, v_latest_id
  );

  version_id     := v_new_id;
  version_number := COALESCE(v_latest_num, 0) + 1;
  deduplicated   := FALSE;
  RETURN NEXT;
END;
$$;

-- Explicit 7-arg signature. If this migration is re-run after 068 has added
-- the 8-arg overload, a bare name reference here would fail with
-- "function name is not unique". Citing the signature explicitly binds the
-- comment to this specific overload.
COMMENT ON FUNCTION content.append_draft_version(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT
) IS
  'Appends a new draft version with two dedup rules: (1) hash match short-circuits '
  'to the existing row; (2) consecutive manual autosaves within 2 minutes collapse '
  'into the first one so typing sessions do not spam history. AI edits, reverts, '
  'and counter-proposals always create a new row.';

-- ============================================================
-- BACKFILL: one initial version per existing contract draft
-- Anything older than this migration gets a single "initial" row so
-- the history view has something to show. Safe to re-run (IF NOT EXISTS).
-- ============================================================
INSERT INTO content.draft_versions (
  draft_id, version_number, body, body_hash, word_count,
  change_source, change_summary, created_by, created_at
)
SELECT
  d.id,
  1,
  d.body,
  encode(sha256(d.body::bytea), 'hex'),
  COALESCE(d.word_count, 0),
  'initial',
  'Backfilled at migration 062 — prior history not captured',
  COALESCE(d.author, 'unknown'),
  d.created_at
FROM content.drafts d
WHERE d.content_type = 'contract'
  AND NOT EXISTS (
    SELECT 1 FROM content.draft_versions v WHERE v.draft_id = d.id
  );
