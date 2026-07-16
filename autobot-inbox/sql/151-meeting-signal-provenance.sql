-- Migration 151 — meeting → work provenance + idempotency (STAQPRO-612)
--
-- Feature spec: spec/features/003-meeting-to-work.md
--
-- The meeting→work classifier (lib/runtime/meeting-classifier.js) turns a
-- `meeting.received` signal into board tasks / Linear tickets. Three concerns
-- need durable, infrastructure-enforced (P2) support:
--
--   1. PROVENANCE on the source signal. agent_graph.signals records what fired
--      a flow, but for a meeting we need to know WHICH meeting (so the M4
--      click-through can jump from a task back to its transcript) and that the
--      signal originated from a meeting (vs an ambient email/slack signal of
--      the same downstream type). → add source_meeting_id + origin.
--
--   2. PROVENANCE on the derived cards. inbox.human_tasks already carries
--      signal_id, but classifier-derived cards intentionally do NOT reference an
--      inbox.signals row (they come from the agent_graph signal/transcript path,
--      not the executor-triage path, and 128's partial-unique on signal_id would
--      otherwise cap a meeting at one card). They need their own back-reference
--      to the meeting + an origin tag. → add signal_meeting_id + origin.
--
--   3. IDEMPOTENCY across re-runs AND across the ambient signal-detector. Both
--      the classifier (on a re-ingested/edited transcript) and the ambient
--      detector can independently see "the same action item". A stable dedup_key
--      (source_meeting_id + sha256(normalized action text)) with a UNIQUE partial
--      index turns the double-create into a no-op at the DB layer (P2), not a
--      best-effort app-level SELECT. → add dedup_key + partial unique index.
--
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) and
-- safe to re-run. No data backfill is required — new columns default NULL.

-- ---------------------------------------------------------------------------
-- 1. agent_graph.signals — meeting provenance on the source signal.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_graph.signals
  ADD COLUMN IF NOT EXISTS source_meeting_id TEXT;
ALTER TABLE agent_graph.signals
  ADD COLUMN IF NOT EXISTS origin TEXT;

COMMENT ON COLUMN agent_graph.signals.source_meeting_id IS
  'Stable meeting identity (calendar_event_id when present, else a deterministic '
  'hash of the 15-min-rounded start window + sorted participant emails + '
  'normalized title). Set on meeting.received signals so derived work can be '
  'traced back to one canonical meeting. NULL for non-meeting signals.';
COMMENT ON COLUMN agent_graph.signals.origin IS
  'Coarse provenance tag for where this signal came from (e.g. ''meeting''). '
  'Lets a flow distinguish a meeting-derived signal from an ambient '
  'email/slack signal of the same signal_type. NULL = legacy/unspecified.';

CREATE INDEX IF NOT EXISTS idx_signals_source_meeting
  ON agent_graph.signals (source_meeting_id)
  WHERE source_meeting_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. inbox.human_tasks — meeting provenance + idempotency key on derived cards.
-- ---------------------------------------------------------------------------
ALTER TABLE inbox.human_tasks
  ADD COLUMN IF NOT EXISTS signal_meeting_id TEXT;
ALTER TABLE inbox.human_tasks
  ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE inbox.human_tasks
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

COMMENT ON COLUMN inbox.human_tasks.signal_meeting_id IS
  'Back-reference to the canonical meeting (agent_graph.signals.source_meeting_id) '
  'this card was derived from. Enables the M4 click-through (task → transcript) '
  'and the edited-transcript supersede sweep. NULL for non-meeting cards.';
COMMENT ON COLUMN inbox.human_tasks.origin IS
  'Coarse provenance tag (e.g. ''meeting''). Distinguishes classifier-derived '
  'cards from executor-triage promoted cards. NULL = legacy/triage path.';
COMMENT ON COLUMN inbox.human_tasks.dedup_key IS
  'Idempotency key = source_meeting_id + '':'' + sha256(normalized action text). '
  'The partial unique index below makes a duplicate create a no-op at the DB '
  'layer (P2) — covers classifier re-runs AND ambient signal-detector overlap '
  'when both stamp the same key.';

-- The invariant: at most one LIVE (non-deleted) card per dedup_key. Partial so
-- soft-deleted history (supersede) and NULL-dedup_key legacy/triage cards are
-- unconstrained. Built inline — works on PGlite and is sub-second on the small
-- human_tasks table.
CREATE UNIQUE INDEX IF NOT EXISTS human_tasks_dedup_key_unique_live
  ON inbox.human_tasks (dedup_key)
  WHERE dedup_key IS NOT NULL AND deleted_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE '[151] meeting provenance: agent_graph.signals.{source_meeting_id,origin} + inbox.human_tasks.{signal_meeting_id,origin,dedup_key} + dedup partial-unique index';
END $$;
