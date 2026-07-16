-- 157-meeting-hierarchy.sql
-- OPT (Feature 007): content.meetings — the meeting IDENTITY layer that sits ABOVE
-- content.artifacts and deduplicates the same real-world meeting across SOURCES
-- (Gemini Notes on Drive, TLDv, MCP/manual) and across SCOPES (a person's private
-- note vs the org's shared capture). This is the "cross-source COLLAPSE" the
-- meeting-identity helper deferred ("613/Carlos" — see lib/runtime/meeting-identity.js).
--
-- WHAT THIS ADDS (Feature 007 Layer 1 + 2):
--   1. content.meetings           — one row per (scope, meeting). scope =
--                                    (owner_org_id, owner_id). owner_id NULL =
--                                    org-shared; owner_id set = a personal capture.
--   2. artifacts.meeting_id        — transcripts/summaries become CHILDREN of a
--                                    meeting (nullable; NULL for non-meeting artifacts).
--
-- IDENTITY (reuses, does NOT reinvent):
--   - meeting_fingerprint IS the string computeSourceMeetingId() already produces
--     (lib/runtime/meeting-identity.js): `cal:<calendarEventId>` > `mtg:<hash>` >
--     `src:<fallbackId>`. It therefore EQUALS the source_meeting_id already stamped
--     on agent_graph.signals and the signal_meeting_id on inbox.human_tasks
--     (migration 151) — the meeting row is the canonical HUB those rows already
--     point at by string. No backfill of those tables is needed.
--
-- DEDUP (the core invariants):
--   - WITHIN a scope: UNIQUE (owner_org_id, COALESCE(owner_id), meeting_fingerprint).
--     The same call captured twice in the same scope upserts ONE row; each capture
--     attaches its artifact as a child. Identical bytes still collapse at the
--     version layer (content_hash, migration 154) — this layer groups ABOVE that.
--   - ACROSS scopes (personal <-> org): rows share a meeting_fingerprint but stay
--     SEPARATE (non-unique fingerprint index is the only cross-scope join key).
--     No silent merge (P1). The link is surfaced ONLY where tenancy.visible()
--     already permits the viewer to see both — see the VISIBILITY note below.
--     Promotion (personal -> org) is an explicit, audited action (Feature 007 L4).
--
-- CONFIDENCE (Q1): fingerprint_confidence gates auto-merge. A 'weak' row (a Drive
--   drop whose only "participants" are the Google Doc owners, not real attendees,
--   and no recovered calendar_event_id) never auto-merges onto a 'derived'/'calendar'
--   row; it is UPGRADED if a later calendar reconciliation recovers a calendar_event_id.
--
-- VISIBILITY: no change to tenancy.visible() is required. meetings carry
--   (owner_id, owner_org_id) — the exact shape visible(row_owner_user, row_owner_org)
--   already resolves. A UMB member sees their personal UMB meeting (Tier 1: own) AND
--   the org UMB meeting (Tier 2: org-shared); a different org sees neither. The
--   "also at org level" link is therefore a QUERY over the existing predicate
--   (WHERE meeting_fingerprint = $1 AND tenancy.visible(owner_id, owner_org_id)),
--   NOT a new branch on the security spine.
--
-- DESIGN (P1/P2/P4, mirrors 154/156): owner_org_id NOT NULL with NO column DEFAULT
--   (a NEW table, no legacy rows to grandfather; an un-stamped write is a hard error,
--   never a silent Staqs). No cross-schema FK — the calendar reconciler reads
--   inbox.calendar_events at the APP layer (Feature 007 item 3a). Raw parameterized
--   SQL, no ORM. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, guarded ALTER.

-- 1. content.meetings -------------------------------------------------------
CREATE TABLE IF NOT EXISTS content.meetings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The computeSourceMeetingId() output (cal:/mtg:/src:). Equals
  -- agent_graph.signals.source_meeting_id for the same meeting (the HUB key).
  meeting_fingerprint     TEXT NOT NULL,

  -- Which identity tier + input quality produced the fingerprint (Q1 merge gate).
  fingerprint_confidence  TEXT NOT NULL DEFAULT 'weak'
    CHECK (fingerprint_confidence IN ('calendar', 'derived', 'weak')),

  title                   TEXT,
  started_at              TIMESTAMPTZ,     -- 15-min window anchor (identity input)
  participants            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- normalized {email,name,role}
  calendar_event_id       TEXT,            -- real or reconciled; the cross-source bridge

  -- Prior fingerprints this row answered to (jsonb array of strings). When a
  -- 'weak' row is UPGRADED to the `cal:` tier (calendar reconciliation recovers
  -- the event id) its fingerprint re-keys — the old `mtg:`/`src:` string lands
  -- here so signals/tasks stamped with it (migration 151) still join the hub.
  fingerprint_aliases     JSONB NOT NULL DEFAULT '[]'::jsonb,

  owner_org_id            UUID NOT NULL,   -- tenancy boundary; NO DEFAULT (stamped from a trusted source)
  owner_id                UUID,            -- board_members.id; NULL = org-shared scope

  -- Deterministic canonical pick by source precedence (TLDv > Gemini > manual).
  -- ON DELETE SET NULL: dropping the chosen artifact just clears the pointer (the
  -- meeting survives; the next write re-picks). Same-schema FK (allowed).
  primary_transcript_id   UUID REFERENCES content.artifacts(id) ON DELETE SET NULL,
  primary_summary_id      UUID REFERENCES content.artifacts(id) ON DELETE SET NULL,

  status                  TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'archived')),
  superseded_by           UUID REFERENCES content.meetings(id),  -- promotion lineage (P3: never delete)

  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WITHIN-SCOPE dedup: one meeting per (org, owner-or-org-shared, fingerprint).
-- COALESCE folds the nullable owner_id to a fixed sentinel so org-shared rows
-- (owner_id NULL) collapse to one row per (org, fingerprint), while personal rows
-- key per (org, user, fingerprint). Expression unique index (real Postgres / PGlite).
CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_scope_fingerprint
  ON content.meetings
     (owner_org_id, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), meeting_fingerprint);

-- CROSS-SCOPE discovery: the only join key between a personal row and its org peer.
-- Non-unique by design (two scopes legitimately share a fingerprint).
CREATE INDEX IF NOT EXISTS idx_meetings_fingerprint
  ON content.meetings (meeting_fingerprint);

-- Browser/list surface: a tenant's meetings, newest first.
CREATE INDEX IF NOT EXISTS idx_meetings_org_started
  ON content.meetings (owner_org_id, started_at DESC);

-- Calendar reconciler lookups (item 3a) by recovered calendar_event_id.
CREATE INDEX IF NOT EXISTS idx_meetings_calendar_event
  ON content.meetings (calendar_event_id) WHERE calendar_event_id IS NOT NULL;

COMMENT ON TABLE content.meetings IS
  'Feature 007: meeting IDENTITY layer over content.artifacts. meeting_fingerprint = '
  'computeSourceMeetingId() output (= agent_graph.signals.source_meeting_id). '
  'UNIQUE (owner_org_id, COALESCE(owner_id), meeting_fingerprint) dedups within a '
  'scope; rows across scopes share a fingerprint but stay separate (link, never '
  'merge — P1). owner_org_id NOT NULL no-default. Visibility via tenancy.visible().';

-- 2. content.artifacts.meeting_id -------------------------------------------
-- Transcripts/summaries become children of a meeting. NULL for non-meeting kinds.
ALTER TABLE content.artifacts
  ADD COLUMN IF NOT EXISTS meeting_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_artifacts_meeting'
  ) THEN
    ALTER TABLE content.artifacts
      ADD CONSTRAINT fk_artifacts_meeting
      FOREIGN KEY (meeting_id)
      REFERENCES content.meetings(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_artifacts_meeting
  ON content.artifacts (meeting_id) WHERE meeting_id IS NOT NULL;

COMMENT ON COLUMN content.artifacts.meeting_id IS
  'Feature 007: parent meeting (content.meetings.id) for transcript/summary artifacts. '
  'NULL for non-meeting artifacts. One meeting legitimately has MANY transcript '
  'artifacts (Gemini + TLDv + manual); the canonical pick lives in '
  'content.meetings.primary_transcript_id/primary_summary_id.';

DO $$ BEGIN
  RAISE NOTICE '[157] meeting hierarchy: content.meetings + content.artifacts.meeting_id (Feature 007)';
END $$;
