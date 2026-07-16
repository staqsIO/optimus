-- 154-artifact-registry.sql
-- OPT-92 (Feature 004 item 1): the artifact registry — the company-brain
-- ingress's first-class layer over content.documents. Unblocks OPT-93 (enrichment
-- worker), OPT-94, OPT-95.
--
-- WHAT THIS ADDS (Liotta "Resolved data model", spec/features/004):
--   1. content.artifacts            — first-class registry of managed artifacts
--                                     (PRDs/proposals/specs/ADRs/briefs/decks/…)
--                                     with kind, status, source_system, identity,
--                                     current version pointer, and tenancy.
--   2. content.artifact_versions    — immutable lineage; each version pins ONE
--                                     content.documents row + a content_hash.
--   3. content.artifact_entity_links— links an artifact to a contact/project/
--                                     engagement/org with a confidence + review
--                                     status; the pending partial index IS the
--                                     board review queue.
--   4. content.derived_facts        — enrichment output; every fact traces to
--                                     artifact + document (+ optional span);
--                                     provenance_hash bounds re-enrichment writes.
--   5. content.enrichment_queue     — durable producer queue; INSERTed in the
--                                     same txn as the artifact, AFTER-INSERT
--                                     trigger fires pg_notify('capture_ingested').
--
-- DESIGN (P1/P2/P4):
--   - owner_org_id is NOT NULL with NO column DEFAULT (mig-145-ready). The write
--     path stamps it from writerOrgId(principal) — NEVER from the request body
--     (588/593 leak class). This is a NEW table with no legacy rows, so unlike
--     migration 134 there is no Staqs DEFAULT to grandfather.
--   - No cross-schema FK: artifact_versions.document_id → content.documents is a
--     same-schema FK (allowed); entity links cross schemas, so they use
--     (entity_type, entity_id TEXT) with app-layer integrity.
--   - content_hash is the SAME hash the write path derives (server-side); the
--     UNIQUE (artifact_id, content_hash) makes an identical re-push an idempotent
--     no-op. identity_key is server-derived, never caller-supplied (602 class).
--   - Raw parameterized SQL, no ORM. Idempotent: CREATE TABLE IF NOT EXISTS,
--     guarded ALTER / CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--     DROP TRIGGER IF EXISTS. Runs best-effort at startup and against PGlite.

-- 1. content.artifacts ------------------------------------------------------
CREATE TABLE IF NOT EXISTS content.artifacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT NOT NULL
    CHECK (kind IN ('prd','proposal','spec','adr','brief','deck',
                    'transcript','summary','doc','other')),
  title               TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','archived')),
  source_system       TEXT,           -- mcp/claude-code/drive/linear/notion/manual/web
  identity_key        TEXT NOT NULL,  -- server-derived dedup key (never caller-supplied)
  current_version_id  UUID,           -- FK added by ALTER below (artifact_versions exists after)
  owner_org_id        UUID NOT NULL,  -- tenancy boundary; stamped from token, never body
  owner_id            UUID,           -- board_members.id of the creator (no cross-schema FK)
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dedup is PER-TENANT, not global: the same identity_key in two orgs is two
  -- distinct artifacts.
  UNIQUE (owner_org_id, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_org_kind_status
  ON content.artifacts (owner_org_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_created
  ON content.artifacts (owner_org_id, created_at DESC);

COMMENT ON TABLE content.artifacts IS
  'OPT-92: first-class registry of managed artifacts over content.documents. '
  'owner_org_id stamped from the writer token (writerOrgId), NEVER the body. '
  'identity_key + content_hash are server-derived (602/588 leak classes).';

-- 2. content.artifact_versions ----------------------------------------------
CREATE TABLE IF NOT EXISTS content.artifact_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id    UUID NOT NULL REFERENCES content.artifacts(id) ON DELETE CASCADE,
  version_no     INT NOT NULL,
  document_id    UUID REFERENCES content.documents(id),  -- same-schema FK (allowed)
  content_hash   TEXT,
  supersedes_id  UUID REFERENCES content.artifact_versions(id),  -- self-ref lineage
  created_by     UUID,
  owner_org_id   UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version_no),
  -- Identical re-push (same content_hash for the same artifact) is an idempotent
  -- no-op: ON CONFLICT (artifact_id, content_hash) DO NOTHING on the write path.
  UNIQUE (artifact_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
  ON content.artifact_versions (artifact_id, version_no DESC);

COMMENT ON TABLE content.artifact_versions IS
  'OPT-92: immutable version lineage. Each version pins ONE content.documents row '
  'and a server-derived content_hash. Supersession is at the version level: a new '
  'version bumps version_no and flips artifacts.current_version_id.';

-- current_version_id FK (added after artifact_versions exists; idempotent guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifacts_current_version'
  ) THEN
    ALTER TABLE content.artifacts
      ADD CONSTRAINT fk_artifacts_current_version
      FOREIGN KEY (current_version_id)
      REFERENCES content.artifact_versions(id);
  END IF;
END $$;

-- 3. content.artifact_entity_links ------------------------------------------
CREATE TABLE IF NOT EXISTS content.artifact_entity_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id   UUID NOT NULL REFERENCES content.artifacts(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL
    CHECK (entity_type IN ('contact','project','engagement','org')),
  entity_id     TEXT NOT NULL,   -- cross-schema reference → TEXT + app-layer integrity
  confidence    NUMERIC(4,3),
  link_status   TEXT NOT NULL DEFAULT 'auto'
    CHECK (link_status IN ('auto','pending','confirmed','rejected')),
  resolved_by   UUID,
  resolved_at   TIMESTAMPTZ,
  owner_org_id  UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, entity_type, entity_id)
);

-- The pending partial index IS the board review queue (0.55–0.85 confidence band).
CREATE INDEX IF NOT EXISTS idx_artifact_entity_links_pending
  ON content.artifact_entity_links (owner_org_id, created_at DESC)
  WHERE link_status = 'pending';

COMMENT ON TABLE content.artifact_entity_links IS
  'OPT-92: artifact ↔ entity links with confidence + review status. The pending '
  'partial index is the board review queue. entity_id is TEXT (cross-schema).';

-- 4. content.derived_facts --------------------------------------------------
CREATE TABLE IF NOT EXISTS content.derived_facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT,
  entity_id       TEXT,
  fact            TEXT,
  artifact_id     UUID REFERENCES content.artifacts(id) ON DELETE CASCADE,
  document_id     UUID,            -- logical link to content.documents.id
  span            INT4RANGE,       -- optional source span in the document
  confidence      NUMERIC(4,3),
  provenance_hash TEXT,
  owner_org_id    UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent re-enrichment: the same (entity, fact, source) hash writes once.
  -- Scoped per-tenant (Linus m1) so two orgs deriving the same fact from
  -- structurally identical content cannot collide on a global unique.
  UNIQUE (owner_org_id, provenance_hash)
);

CREATE INDEX IF NOT EXISTS idx_derived_facts_entity
  ON content.derived_facts (entity_type, entity_id, created_at DESC);

COMMENT ON TABLE content.derived_facts IS
  'OPT-92: enrichment output. Every fact traces to artifact + document (+ optional '
  'span). provenance_hash UNIQUE bounds write volume on re-enrichment.';

-- 5. content.enrichment_queue -----------------------------------------------
CREATE TABLE IF NOT EXISTS content.enrichment_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL,   -- producer always supplies both (Linus m2)
  artifact_id   UUID NOT NULL,
  owner_org_id  UUID NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed')),
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_queue_pending
  ON content.enrichment_queue (created_at)
  WHERE status = 'pending';

COMMENT ON TABLE content.enrichment_queue IS
  'OPT-92: durable enrichment producer queue. INSERTed in the same txn as the '
  'artifact; the AFTER-INSERT trigger fires pg_notify(capture_ingested). The '
  'enrichment WORKER (consumer) is OPT-93 — this migration is producer-side only.';

-- AFTER INSERT trigger → pg_notify('capture_ingested', {ids}). The worker LISTENs
-- for latency + polls the queue as the restart-safety backstop (notify is
-- fire-and-forget — the 087 lesson). Producer-side only here.
CREATE OR REPLACE FUNCTION content.notify_capture_ingested()
RETURNS trigger AS $fn$
BEGIN
  PERFORM pg_notify(
    'capture_ingested',
    json_build_object(
      'queue_id', NEW.id,
      'document_id', NEW.document_id,
      'artifact_id', NEW.artifact_id
    )::text
  );
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enrichment_queue_notify ON content.enrichment_queue;
CREATE TRIGGER trg_enrichment_queue_notify
  AFTER INSERT ON content.enrichment_queue
  FOR EACH ROW
  EXECUTE FUNCTION content.notify_capture_ingested();
