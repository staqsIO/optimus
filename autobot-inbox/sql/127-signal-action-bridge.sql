-- Migration 127 — signal→action bridge + staleness/dedup columns on inbox.signals
--
-- Why: inbox.signals is a telemetry layer today — obligations are extracted and
-- displayed but never connected to agent-actionable work and never expire, so a
-- Sept-2024 onboarding commitment still surfaces as "overdue" 1.5 years later
-- (2,629 unresolved obligations in prod). This migration adds the columns the
-- signal→action bridge (lib/runtime/signal-action-bridge.js) needs to:
--   (1) judge staleness by the SOURCE EVENT date, not the re-ingest date
--       (occurred_at, backfilled from inbox.messages.received_at);
--   (2) link an obligation to the agent_graph.work_item it spawned, with no
--       cross-schema FK (work_item_id) per D5/SPEC §12;
--   (3) link an obligation to the contact it concerns so a departed/inactive
--       contact short-circuits bridging (contact_id, soft ref to signal.contacts);
--   (4) guarantee at-most-once bridging across re-ingested transcripts and
--       concurrent reconciler runs (content_hash + partial UNIQUE index);
--   (5) stamp the atomic claim (bridged_at).
--
-- Cross-schema FKs are forbidden (D5/SPEC §12). work_item_id and contact_id are
-- bare id columns with indexes; agent_graph and signal schemas stay isolated.
-- ON DELETE: nothing — a dangling reference is acceptable (matches how
-- content.drafts.engagement_id behaves, migration 125).

ALTER TABLE inbox.signals
  ADD COLUMN IF NOT EXISTS occurred_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS work_item_id  TEXT,
  ADD COLUMN IF NOT EXISTS contact_id    TEXT,
  ADD COLUMN IF NOT EXISTS bridged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_hash  TEXT;

COMMENT ON COLUMN inbox.signals.occurred_at IS
  'Source-event timestamp (the meeting/email the obligation came from), copied '
  'from inbox.messages.received_at. Staleness is judged on occurred_at, NOT '
  'created_at (the re-ingest time). NULL only if the parent message is gone.';

COMMENT ON COLUMN inbox.signals.work_item_id IS
  'Soft reference to agent_graph.work_items(id) — the work item this obligation '
  'was bridged into. No cross-schema FK per D5/SPEC §12. NULL until bridged.';

COMMENT ON COLUMN inbox.signals.contact_id IS
  'Soft reference to signal.contacts(id) — the person this obligation concerns. '
  'Used by isStillLive() to short-circuit bridging for departed/inactive '
  'contacts. No cross-schema FK per D5/SPEC §12.';

COMMENT ON COLUMN inbox.signals.bridged_at IS
  'Atomic-claim stamp. Set by the bridge via UPDATE ... WHERE bridged_at IS NULL '
  'to win the race to spawn a work item exactly once.';

COMMENT ON COLUMN inbox.signals.content_hash IS
  'Dedup key = hash(normalized content | signal_type | message_id). The bridge '
  'writes it ATOMICALLY in the same UPDATE that sets bridged_at (the claim), so '
  'the unique index below rejects a second signal with the same hash AT CLAIM '
  'TIME — before any work item is created. Survives re-extraction (a re-ingested '
  'transcript yields a new signal id but the same hash) ONLY because message_id '
  'is stable across re-ingest: ingest is idempotent on the provider/channel key '
  '(tl;dv reuses the inbox.messages row keyed on channel_id=meetingId; Gmail on '
  'provider_msg_id). If ingest is ever changed to mint a fresh inbox.messages row '
  'on re-process, this hash changes across re-ingest and the same obligation '
  'bridges twice. See lib/runtime/signal-action-bridge.js computeContentHash().';

-- Backfill occurred_at from the parent message''s received_at. Idempotent via the
-- occurred_at IS NULL guard. NOTE for prod: if inbox.signals is large (tens of
-- thousands of rows), run this single UPDATE via the DIRECT connection (port
-- 5432 / DIRECT_URL), NOT the transaction pooler (6543) — a long single-statement
-- UPDATE through PgBouncer txn-mode can stall the pool (project memory). On
-- PGlite (test/local) the table is tiny and this is instant.
UPDATE inbox.signals s
   SET occurred_at = m.received_at
  FROM inbox.messages m
 WHERE m.id = s.message_id
   AND s.occurred_at IS NULL;

-- At-most-once bridging: no two CLAIMED signals may share a content_hash. Keyed
-- on bridged_at (the claim stamp), NOT work_item_id — content_hash is written in
-- the same statement as bridged_at, so the loser of a concurrent race collides
-- here at claim time, before it can create a work item. Partial: unbridged rows
-- (the vast majority) carry NULL content_hash and are unconstrained.
-- NOTE: built inline (not CONCURRENTLY) — works on PGlite and is sub-second on a
-- few-thousand-row table. For a very large prod table, build CONCURRENTLY
-- out-of-band via psql on the direct connection instead.
CREATE UNIQUE INDEX IF NOT EXISTS signals_bridge_dedup
  ON inbox.signals (content_hash)
  WHERE content_hash IS NOT NULL AND bridged_at IS NOT NULL;

-- Reconciler hot path: "eligible obligations not yet bridged." Column order
-- (occurred_at, confidence) matches the reconciler''s ORDER BY occurred_at ASC.
-- Partial predicate keeps the index tiny regardless of resolved/non-obligation
-- signal volume.
CREATE INDEX IF NOT EXISTS signals_bridge_eligible
  ON inbox.signals (occurred_at, confidence)
  WHERE resolved = false
    AND work_item_id IS NULL
    AND bridged_at IS NULL
    AND signal_type IN ('commitment', 'request', 'action_item');

DO $$ BEGIN
  RAISE NOTICE '[127] inbox.signals bridge columns added (occurred_at backfilled, dedup + eligibility indexes created)';
END $$;
