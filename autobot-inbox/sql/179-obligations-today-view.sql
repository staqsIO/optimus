-- 179-obligations-today-view.sql
-- OPT-162 Phase 3 (ADR-020): unify the Today "Open Obligations" read onto the
-- task graph (agent_graph.work_items, the SPEC §3 single source of truth) WITHOUT
-- regressing the shipped per-viewer / per-org tenancy guarantees
-- (OPT-115 / OPT-126 / STAQPRO-588) and WITHOUT double-surfacing an obligation
-- that exists in BOTH inbox.human_tasks (board card) and agent_graph.work_items
-- (gated obligations have both).
--
-- This migration is ADDITIVE: it only CREATEs a VIEW. No table, column, or row is
-- changed; nothing reads the view until the api.js cutover, which is itself behind
-- a flag defaulting OFF (TODAY_OBLIGATIONS_SOURCE != 'union'). Rollback = DROP VIEW.
--
-- A VIEW that spans the inbox + agent_graph schemas is permitted — the project rule
-- forbids cross-schema FOREIGN KEYS, not cross-schema views. No FK is created here.
--
-- ---------------------------------------------------------------------------
-- Plan deviations (plans/opt-162-obligation-sot-migration.md is a design sketch):
--
--   1. Migration number: the plan said "176" but 176/177/178 are already taken.
--      This is 179 (the next free number after mig 178, the P1/P2 columns).
--
--   2. Per-viewer parity is carried by EXPLICIT, UNIFORM columns the view emits on
--      BOTH legs — `is_email_scoped` (bool) + `viewer_match_emails` (text[]) — so a
--      SINGLE caller-side predicate reproduces api.js's htViewerFilter EXACTLY for
--      both legs. The plan's sketch said "filter on message_id"; that cannot
--      reproduce htViewerFilter (which tests m.to_addresses||m.cc_addresses for
--      channel='email' and BYPASSES non-email / no-message rows). Using the
--      bridge-denormalized work_items.viewer_emails (mig 178) for the wi leg and the
--      joined message recipient set for the ht leg makes the two legs provably
--      identical. See the per-leg derivation comments below.
--
--   3. Dedup: per the plan's view SQL, the ht leg DROPS any card linked to a
--      work_item (next_action_hint LIKE 'work_item:%'); the wi leg KEEPS the
--      work_item row. So a gated obligation present in BOTH stores appears ONCE
--      (the work_item row wins — it owns the lifecycle per ADR-020). The view is
--      exclusive by construction; no DISTINCT needed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW agent_graph.obligations_today_v AS
  -- ===================================================================
  -- LEG 1 — pre-migration / card-only obligations: inbox.human_tasks rows
  -- that are NOT linked to a work_item. The recipient set + email-scoping
  -- flag come from the source message (LEFT JOIN), mirroring api.js's
  -- LEFT JOIN inbox.messages used by htViewerFilter.
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
    -- Dedup: exclude any card that is linked to a work_item; the work_item row
    -- (LEG 2) represents that obligation instead. next_action_hint carries
    -- 'work_item:<id>' for every bridge-spawned gated card.
    AND (ht.next_action_hint IS NULL OR ht.next_action_hint NOT LIKE 'work_item:%')

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
    -- (signal-action-bridge.js:808: `if (route.klass === 'gated')`) and stamps
    -- metadata.reversibility_class = route.klass on EVERY bridge work_item (bridge:789).
    -- So restricting LEG 2 to reversibility_class='gated' = exactly the set that had a
    -- card today, and EXCLUDES autonomous (auto-handled draft/ticket) work_items that
    -- never appeared on Today. Invariant: a gated obligation's card is dropped from
    -- LEG 1 (next_action_hint LIKE 'work_item:%') and its work_item is included here →
    -- appears ONCE; an autonomous obligation has no card (absent from LEG 1) and is
    -- excluded here → does NOT appear. Unioned set == today's Today set.
    AND wi.metadata->>'reversibility_class' = 'gated';

-- ---------------------------------------------------------------------------
-- ROLLBACK:
--   DROP VIEW IF EXISTS agent_graph.obligations_today_v;
--
-- The api.js cutover is independently reversible: set (or unset)
-- TODAY_OBLIGATIONS_SOURCE so it != 'union' and the handler reads inbox.human_tasks
-- directly (exact pre-Phase-3 behavior). This view becoming unused is inert.
-- ---------------------------------------------------------------------------
