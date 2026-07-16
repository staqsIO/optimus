-- 180-obligations-today-view-dedup-fix.sql
-- OPT-162 Phase 3 (ADR-020) — SUPERSEDES mig 179's agent_graph.obligations_today_v.
--
-- WHY A NEW MIGRATION (not an edit to 179): mig 179 ALREADY RAN in prod (the P3
-- deploy). The migration runner tracks applied files by FILENAME
-- (public._migrations.filename TEXT PRIMARY KEY, lib/db.js), so editing 179 would be
-- SKIPPED on prod and the fix would never land. An applied migration is immutable;
-- the corrected view ships as this new file. 179 uses CREATE OR REPLACE VIEW, so this
-- 180 cleanly supersedes its definition in place (no DROP needed; dependents keep
-- working; column list is unchanged).
--
-- WHAT IT FIXES (prod incident: the P3 cutover DROPPED 26 LIVE obligations):
-- 179's LEG 1 (human_tasks) excluded EVERY work_item-linked card
-- (next_action_hint LIKE 'work_item:%'), ASSUMING LEG 2 would surface that work_item.
-- But LEG 2 requires obligation_type IS NOT NULL AND reversibility_class='gated' AND
-- live status. A card linked to a NULL-obligation_type / deleted / non-gated /
-- terminal work_item was dropped from LEG 1 AND absent from LEG 2 → it VANISHED.
-- Prod hit: 25 task_type='action' cards → status='created' work_items with
-- obligation_type NULL (deploy-window gap: created after mig-178's backfill ran but
-- before the P2 bridge-stamp deployed; also non-bridge card creators whose work_items
-- mig-178's bridge-only backfill never stamped), +1 orphan card → deleted work_item.
--
-- THE FIX (LEG 1 dedup): suppress a card ONLY when its linked work_item ACTUALLY
-- QUALIFIES for LEG 2 — i.e. when a work_item with the card's linked id meets ALL
-- three LEG 2 predicates (obligation_type IS NOT NULL, reversibility_class='gated',
-- live status). Otherwise the card STAYS in LEG 1. Linkage is the work_item id encoded
-- in next_action_hint as 'work_item:<id>' (signal-action-bridge.js). This guarantees
-- every legacy card appears EXACTLY ONCE — via its work_item in LEG 2 when it
-- qualifies, else via itself in LEG 1 — so the union set is provably a
-- SUPERSET-or-equal of the legacy human_tasks set and no obligation can vanish.
--
-- Everything else is byte-identical to 179: case-insensitive (lowercased)
-- viewer_match_emails arrays on both legs, the uniform is_email_scoped /
-- viewer_match_emails per-viewer parity columns, and the gated-only LEG 2 filter.
--
-- ROLLBACK: re-apply 179's view body (re-CREATE OR REPLACE VIEW
-- agent_graph.obligations_today_v with 179's LEG 1 `next_action_hint NOT LIKE
-- 'work_item:%'` dedup), or DROP VIEW IF EXISTS agent_graph.obligations_today_v. The
-- api.js cutover remains independently reversible via TODAY_OBLIGATIONS_SOURCE
-- (default OFF → legacy human_tasks read), so this view going unused is inert.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW agent_graph.obligations_today_v AS
  -- ===================================================================
  -- LEG 1 — pre-migration / card-only obligations: inbox.human_tasks rows
  -- whose linked work_item does NOT qualify for LEG 2 (or which have no link).
  -- The recipient set + email-scoping flag come from the source message
  -- (LEFT JOIN), mirroring api.js's LEFT JOIN inbox.messages used by htViewerFilter.
  -- ===================================================================
  SELECT
    'ht:' || ht.id                       AS obligation_id,
    'human_task'::text                   AS source,
    ht.id                                AS ht_id,
    NULL::text                           AS work_item_id,
    ht.title,
    ht.description,
    ht.due_date,
    ht.task_type                         AS obligation_type,
    ht.status                            AS kanban_status,
    NULL::text                           AS work_item_status,
    ht.extraction_confidence             AS confidence,
    ht.message_id,
    ht.signal_id,
    ht.owner_org_id,
    ht.created_at,
    -- snooze + soft-delete are HT-native; the wi leg has no equivalent yet.
    ht.snoozed_until,
    ht.deleted_at,
    -- Per-viewer parity columns (UNIFORM across legs):
    --   is_email_scoped     = does htViewerFilter's recipient test APPLY to this row?
    --                          (true only for an email-channel source message)
    --   viewer_match_emails = the to/cc set to overlap-test against the viewer.
    -- These reproduce api.js exactly: htViewerFilter bypasses (returns the row for)
    -- any task with no source message (m.id IS NULL) or a non-email channel.
    (m.id IS NOT NULL AND m.channel = 'email')                              AS is_email_scoped,
    -- LOWERCASED so the caller's overlap test is case-insensitive, matching the
    -- legacy htViewerFilter's defensive `lower(addr) = ANY($1)` (api.js). Covers
    -- existing mixed-case rows regardless of upstream casing (non-email channels /
    -- importers that did not normalize before storing to/cc addresses).
    ARRAY(
      SELECT lower(x)
      FROM unnest(COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])) AS x
    )                                                                       AS viewer_match_emails
  FROM inbox.human_tasks ht
  LEFT JOIN inbox.messages m ON m.id = ht.message_id
  WHERE ht.deleted_at IS NULL
    -- Dedup (SUPERSET-SAFE — fixes the prod drop of 26 live obligations): suppress a
    -- card ONLY when its linked work_item ACTUALLY QUALIFIES for LEG 2. The previous
    -- (179) rule excluded a card whenever it was work_item-linked, assuming LEG 2
    -- would surface it — but a card linked to a NULL-obligation_type / deleted /
    -- non-gated / terminal work_item was then dropped from BOTH legs → it vanished.
    -- Now: keep the card UNLESS there EXISTS a linked work_item meeting ALL LEG 2
    -- predicates (the same three predicates as LEG 2's WHERE below, kept in sync).
    -- Linkage = next_action_hint 'work_item:<id>' (signal-action-bridge.js).
    AND NOT EXISTS (
      SELECT 1
      FROM agent_graph.work_items wi2
      WHERE ht.next_action_hint LIKE 'work_item:%'
        AND wi2.id = substring(ht.next_action_hint FROM '^work_item:(.+)$')
        AND wi2.obligation_type IS NOT NULL
        AND wi2.metadata->>'reversibility_class' = 'gated'
        AND wi2.status NOT IN ('completed', 'failed', 'cancelled', 'timed_out')
    )

  UNION ALL

  -- ===================================================================
  -- LEG 2 — task-graph obligations: agent_graph.work_items promoted by the
  -- Phase 2 bridge (obligation_type IS NOT NULL) and still live. The recipient
  -- set + email-scoping flag come from the bridge-denormalized viewer_emails
  -- column (mig 178), which the bridge stamps to EXACTLY the api.js htViewerFilter
  -- set: (to||cc) for channel='email', else NULL (the bypass case).
  -- ===================================================================
  SELECT
    'wi:' || wi.id                       AS obligation_id,
    'work_item'::text                    AS source,
    NULL::text                           AS ht_id,
    wi.id                                AS work_item_id,
    wi.title,
    wi.description,
    -- Cast to DATE to match inbox.human_tasks.due_date (DATE) on the other leg, so
    -- the UNION ALL is type-exact and the response contract (date) is preserved.
    wi.deadline::date                    AS due_date,
    wi.obligation_type,
    NULL::text                           AS kanban_status,
    wi.status                            AS work_item_status,
    -- NUMERIC(3,2) on the ht leg (extraction_confidence); match the type exactly.
    NULL::numeric                        AS confidence,
    wi.source_message_id                 AS message_id,
    (wi.metadata->>'source_signal_id')   AS signal_id,
    wi.owner_org_id,
    wi.created_at,
    NULL::timestamptz                    AS snoozed_until,
    NULL::timestamptz                    AS deleted_at,
    -- viewer_emails IS NULL is the bridge's encoding of "no recipient set"
    -- (non-email / no source message) → htViewerFilter bypass → is_email_scoped=false.
    (wi.viewer_emails IS NOT NULL)       AS is_email_scoped,
    -- LOWERCASED to match the ht leg + the legacy `lower(addr) = ANY($1)`. The
    -- bridge does not normalize viewer_emails at stamp time, so any mixed-case
    -- address is folded here so the overlap is case-insensitive end-to-end.
    ARRAY(SELECT lower(x) FROM unnest(COALESCE(wi.viewer_emails, ARRAY[]::text[])) AS x) AS viewer_match_emails
  FROM agent_graph.work_items wi
  WHERE wi.obligation_type IS NOT NULL
    AND wi.status NOT IN ('completed', 'failed', 'cancelled', 'timed_out')
    -- LIKE-FOR-LIKE (Eric, OPT-162 P3): Today must show the SAME obligations it shows
    -- now — gated / needs-you items — just sourced from the task graph. The bridge
    -- creates a VISIBLE human_task card ONLY for the gated path
    -- (signal-action-bridge.js: `if (route.klass === 'gated')`) and stamps
    -- metadata.reversibility_class = route.klass on EVERY bridge work_item. So
    -- restricting LEG 2 to reversibility_class='gated' = exactly the set that had a
    -- card today, and EXCLUDES autonomous (auto-handled draft/ticket) work_items that
    -- never appeared on Today.
    -- NOTE: these three predicates MUST stay in sync with LEG 1's NOT EXISTS dedup
    -- above — the card is suppressed iff its work_item genuinely re-surfaces here.
    AND wi.metadata->>'reversibility_class' = 'gated';
