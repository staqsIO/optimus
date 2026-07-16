-- 156-capture-sources.sql
-- OPT-96 (Feature 005 Layer 1): content.capture_sources — the board-managed,
-- per-org registry of passive capture sources (Drive folders now; Gmail labels /
-- Slack channels later). One row per source maps an external_id to the org that
-- OWNS the captures from it, so a dropped doc lands under the right org instead of
-- silently Staqs.
--
-- DESIGN (P1/P2/P4, mirrors the 619-A linear_sync_teams board-managed pattern):
--   - owner_org_id is NOT NULL with NO column DEFAULT. The board PATCH/POST surface
--     stamps it from a validated tenancy.orgs row — never from an untrusted body.
--     A NEW table with no legacy rows, so (like 154) there is no Staqs DEFAULT to
--     grandfather. enable-with-org is guarded in the handler.
--   - UNIQUE (source_type, external_id) is GLOBAL, not per-org: a folder has exactly
--     ONE true owner. A second org claiming the same folder IS the mis-attribution
--     bug -> 409 at the handler. (Contrast content.artifacts, whose identity is
--     per-tenant; here the external_id is a shared-world identifier.)
--   - allowlist is jsonb (per-source policy, never queried) so future source_types
--     can carry different knobs without a reshape; shape-validated in the handler.
--   - cursor holds the Drive changes-API pageToken for O(delta) polling (Layer 2).
--   - Raw parameterized SQL, no ORM. Idempotent: CREATE TABLE IF NOT EXISTS,
--     CREATE INDEX IF NOT EXISTS. Runs best-effort at startup and against PGlite.

CREATE TABLE IF NOT EXISTS content.capture_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   TEXT NOT NULL
    CHECK (source_type IN ('drive_folder','gmail_label','slack_channel')),
  external_id   TEXT NOT NULL,         -- Drive folder id / Gmail label / Slack channel
  label         TEXT,                  -- human display label
  owner_org_id  UUID NOT NULL,         -- tenancy boundary; stamped from a validated org, never body
  owner_id      TEXT,                  -- optional personal owner (board_members.id as text)
  default_kind  TEXT NOT NULL DEFAULT 'doc'
    CHECK (default_kind IN ('prd','proposal','spec','adr','brief','deck',
                            'transcript','summary','doc','other')),
  allowlist     JSONB NOT NULL DEFAULT '{"mime":[],"ext":[],"max_bytes":1000000}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  cursor        TEXT,                  -- Drive changes-API pageToken (Layer 2 watcher)
  last_poll_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT
);

-- GLOBAL uniqueness on (source_type, external_id): a folder has exactly one owner.
-- A second org claiming it is rejected at the handler with 409.
CREATE UNIQUE INDEX IF NOT EXISTS uq_capture_sources_type_external
  ON content.capture_sources (source_type, external_id);

-- The enabled-source partial index is the watcher's poll set (Layer 2).
CREATE INDEX IF NOT EXISTS idx_capture_sources_enabled
  ON content.capture_sources (source_type)
  WHERE enabled = true;

COMMENT ON TABLE content.capture_sources IS
  'OPT-96 (Feature 005): board-managed per-org registry of passive capture sources. '
  'owner_org_id stamped from a validated tenancy.orgs row, NEVER the body. '
  'UNIQUE (source_type, external_id) is GLOBAL (one true owner per folder); a second '
  'org claiming a folder -> 409. allowlist jsonb is per-source policy, handler-validated.';
