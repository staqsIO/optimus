-- 161-meeting-source-prefs.sql
-- Feature 007 follow-up: make the D4 transcript/summary "primary" source
-- precedence CONFIGURABLE per-org and per-user, instead of the hardcoded
-- drive > tldv > mcp ordering in lib/content/meetings.js.
--
-- ONE row per scope. scope = (owner_org_id, owner_id):
--   owner_id NULL → the ORG DEFAULT (applies to org-shared meetings and to any
--                   member who has not set their own override).
--   owner_id set  → that user's PERSONAL override (applies to their personal
--                   meetings; an org-shared meeting never reads a user row).
--
-- Resolution (lib/content/meeting-prefs.js, mirrored by content.meetings'
-- primary re-pick): user row → org-default row → SYSTEM DEFAULT (drive,tldv,mcp).
-- Resolution is computed PER MEETING from the meeting's own scope, so a change at
-- either level re-picks correctly without the levels having to know about each
-- other.
--
-- precedence is an ordered jsonb array of source_system strings, e.g.
-- ["drive","tldv","mcp"]. Lower index = higher priority. A source absent from the
-- list sorts LAST (array_position → NULL → NULLS LAST in the re-pick query).
-- Membership is handler-validated against the meeting source kinds (drive/tldv/
-- mcp) — never queried, so jsonb (not a child table) is the right shape (mirrors
-- capture_sources.allowlist).
--
-- DESIGN (P1/P2/P4): owner_org_id NOT NULL, no DEFAULT (stamped from the writer
-- token, never the body). No cross-schema FK. Idempotent.

CREATE TABLE IF NOT EXISTS content.meeting_source_prefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id  UUID NOT NULL,                 -- tenancy boundary; stamped from token
  owner_id      UUID,                          -- NULL = org default; set = user override
  precedence    JSONB NOT NULL,                -- ordered source_system array, e.g. ["drive","tldv","mcp"]
  updated_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One pref row per scope. COALESCE folds the nullable owner_id to a fixed
-- sentinel so the org-default row (owner_id NULL) is unique per org and each
-- user override is unique per (org, user). Mirrors content.meetings' scope index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_source_prefs_scope
  ON content.meeting_source_prefs
     (owner_org_id, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON TABLE content.meeting_source_prefs IS
  'Feature 007: configurable D4 primary-source precedence for meeting transcripts/'
  'summaries. owner_id NULL = org default, set = per-user override. precedence is an '
  'ordered source_system jsonb array; resolution is user → org → system default '
  '(["drive","tldv","mcp"]). owner_org_id NOT NULL, stamped from the writer token.';

DO $$ BEGIN
  RAISE NOTICE '[161] meeting source prefs: content.meeting_source_prefs (configurable D4 precedence, Feature 007)';
END $$;
