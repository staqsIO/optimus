-- Migration 115 — engagements schema (client project scoping → living spec)
--
-- One engagement = one client project we are scoping (website, mobile app,
-- API, etc.). Each engagement accumulates many proposal documents (initial
-- RFP, internal scoping drafts, sales-call notes, finalized signed scope)
-- and produces ONE living .md spec that gets tighter as more proposals get
-- ingested. Humans can edit the spec in the board UI; their edits are
-- higher-signal than raw proposal text. Pinned sections are immutable to
-- the LLM synthesizer (P2: infrastructure enforces, prompts advise).
--
-- Namespace note: a sibling /api/projects route + content.wiki_pages table
-- already exist for an unrelated internal-wiki feature. This schema is
-- deliberately named `engagements` to avoid that collision.
--
-- Six tables. No cross-schema FKs (SPEC §12). All audit is append-only (P3).

CREATE SCHEMA IF NOT EXISTS engagements;

-- =====================================================================
-- engagements.engagements — one row per client project
-- =====================================================================
CREATE TABLE IF NOT EXISTS engagements.engagements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  client        TEXT,
  kind          TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('website', 'mobile_app', 'api', 'other')),
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagements_status_updated
  ON engagements.engagements (status, updated_at DESC);

-- =====================================================================
-- engagements.proposals — every ingested document feeding an engagement
-- =====================================================================
CREATE TABLE IF NOT EXISTS engagements.proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id     UUID NOT NULL REFERENCES engagements.engagements(id) ON DELETE CASCADE,
  title             TEXT,
  kind              TEXT NOT NULL DEFAULT 'draft'
    CHECK (kind IN ('draft', 'finalized', 'note')),
  source_type       TEXT NOT NULL
    CHECK (source_type IN ('paste', 'upload', 'url')),
  source_uri        TEXT,
  raw_content       TEXT NOT NULL,
  parsed_markdown   TEXT NOT NULL,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_engagement_created
  ON engagements.proposals (engagement_id, created_at DESC);

-- Embedding column: pgvector(1536) on real Postgres, JSONB fallback on PGlite/CI.
-- Mirrors the pattern in migration 103.
DO $$
DECLARE
  v_has_vector BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;

  IF v_has_vector THEN
    EXECUTE 'ALTER TABLE engagements.proposals
             ADD COLUMN IF NOT EXISTS embedding vector(1536)';
  ELSE
    EXECUTE 'ALTER TABLE engagements.proposals
             ADD COLUMN IF NOT EXISTS embedding JSONB';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_proposals_embedding
             ON engagements.proposals
             USING hnsw (embedding vector_cosine_ops)
             WHERE embedding IS NOT NULL';
  END IF;
END $$;

-- =====================================================================
-- engagements.specs — one living spec document per engagement
-- =====================================================================
CREATE TABLE IF NOT EXISTS engagements.specs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id               UUID NOT NULL UNIQUE
                                REFERENCES engagements.engagements(id) ON DELETE CASCADE,
  version                     INT NOT NULL DEFAULT 0,
  last_synth_at               TIMESTAMPTZ,
  last_synth_proposal_count   INT NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- engagements.spec_sections — the editable blocks that make up a spec
-- =====================================================================
CREATE TABLE IF NOT EXISTS engagements.spec_sections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id               UUID NOT NULL REFERENCES engagements.specs(id) ON DELETE CASCADE,
  section_key           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL DEFAULT '',
  ordinal               INT NOT NULL,
  is_core               BOOLEAN NOT NULL DEFAULT false,
  pin_state             TEXT NOT NULL DEFAULT 'unpinned'
    CHECK (pin_state IN ('unpinned', 'pinned')),
  last_human_edit_at    TIMESTAMPTZ,
  last_human_edit_by    TEXT,
  provenance            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spec_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_spec_sections_spec_ordinal
  ON engagements.spec_sections (spec_id, ordinal);

-- =====================================================================
-- engagements.spec_edits — append-only audit trail (P3)
-- =====================================================================
-- Every body change, pin/unpin, section add/remove. Actor is either a user
-- email or the literal 'synth' (LLM apply phase). Pin-skip noops also land
-- here with change_kind='synth_skip_pin' so the audit makes pin enforcement
-- visible. This table is never updated or deleted.
CREATE TABLE IF NOT EXISTS engagements.spec_edits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id       UUID NOT NULL REFERENCES engagements.specs(id) ON DELETE CASCADE,
  section_id    UUID REFERENCES engagements.spec_sections(id) ON DELETE SET NULL,
  actor         TEXT NOT NULL,
  change_kind   TEXT NOT NULL
    CHECK (change_kind IN (
      'edit',             -- human or synth changed body
      'pin',              -- human pinned a section
      'unpin',            -- human unpinned a section
      'section_add',      -- synth added a new section
      'section_remove',   -- synth removed a section
      'synth_skip_pin'    -- synth tried to update a pinned section; skipped
    )),
  before        TEXT,
  after         TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spec_edits_spec_created
  ON engagements.spec_edits (spec_id, created_at DESC);

-- =====================================================================
-- engagements.spec_conflicts — queue of unresolved contradictions
-- =====================================================================
-- Surfaced by the synth pipeline when two proposals contradict each other
-- in a way the LLM doesn't want to silently pick. Human resolves by
-- selecting an option; the spec section then updates and an audit row is
-- written.
CREATE TABLE IF NOT EXISTS engagements.spec_conflicts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id       UUID NOT NULL REFERENCES engagements.specs(id) ON DELETE CASCADE,
  section_id    UUID REFERENCES engagements.spec_sections(id) ON DELETE SET NULL,
  summary       TEXT NOT NULL,
  options       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution    JSONB,
  resolved_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spec_conflicts_spec_status
  ON engagements.spec_conflicts (spec_id, status);

-- =====================================================================
-- updated_at triggers
-- =====================================================================
CREATE OR REPLACE FUNCTION engagements.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS engagements_touch_updated_at ON engagements.engagements;
CREATE TRIGGER engagements_touch_updated_at
  BEFORE UPDATE ON engagements.engagements
  FOR EACH ROW EXECUTE FUNCTION engagements.touch_updated_at();

DROP TRIGGER IF EXISTS specs_touch_updated_at ON engagements.specs;
CREATE TRIGGER specs_touch_updated_at
  BEFORE UPDATE ON engagements.specs
  FOR EACH ROW EXECUTE FUNCTION engagements.touch_updated_at();

DROP TRIGGER IF EXISTS spec_sections_touch_updated_at ON engagements.spec_sections;
CREATE TRIGGER spec_sections_touch_updated_at
  BEFORE UPDATE ON engagements.spec_sections
  FOR EACH ROW EXECUTE FUNCTION engagements.touch_updated_at();

-- =====================================================================
-- Verification
-- =====================================================================
DO $$
DECLARE
  v_has_vector  BOOLEAN;
  v_table_count INT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
    INTO v_has_vector;
  SELECT count(*) INTO v_table_count
    FROM information_schema.tables
   WHERE table_schema = 'engagements';

  RAISE NOTICE '[115] engagements schema created with % tables (expect 6)', v_table_count;
  RAISE NOTICE '[115] pgvector present: % (embedding column is %)',
               v_has_vector,
               CASE WHEN v_has_vector THEN 'vector(1536)' ELSE 'JSONB fallback' END;
END $$;
