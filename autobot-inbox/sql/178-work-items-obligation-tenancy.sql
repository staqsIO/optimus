-- 178-work-items-obligation-tenancy.sql
-- OPT-162 Phase 1 (ADR-020): make agent_graph.work_items able to carry an
-- obligation with the same tenancy + provenance fields human_tasks already has,
-- so a later phase can move the Today read path onto the task graph (the SPEC §3
-- single source of truth) without regressing the shipped tenancy guarantees
-- (OPT-115 / OPT-126 / STAQPRO-588).
--
-- ADDITIVE ONLY. Reversible by ignoring (no code reads these columns until P2/P3)
-- or by the DROP statements noted under ROLLBACK below.
--
-- ---------------------------------------------------------------------------
-- Plan deviations (the plan file is a design sketch; this matches live schema +
-- the actual migration runner):
--
--  1. Migration number: the plan said "175" but 175/176/177 are already taken.
--     This is 178 (the next free number).
--
--  2. owner_org_id ALREADY EXISTS on agent_graph.work_items. Migration 134
--     (134-tenancy-owner-columns.sql) added owner_org_id to work_items (it is in
--     mig 134's table array) with a DEFAULT of the Staqs org and a backfill of
--     all existing rows to Staqs; migration 149 already reads wi.owner_org_id as
--     an existing column. The plan's premise that work_items lacks owner_org_id
--     is out of date. The ADD COLUMN IF NOT EXISTS below is therefore a harmless
--     no-op safety net (idempotent), NOT the substantive change.
--
--  3. NO `SET NOT NULL` on owner_org_id. Mig 134 deliberately kept the org
--     columns NULLABLE (fail-closed via tenancy.visible COALESCE), because a
--     hard NOT NULL would break the ~65 agent INSERT sites that do not yet stamp
--     owner_org_id (the row instead picks up mig 134's DEFAULT). Forcing NOT NULL
--     now is out of scope for an additive Phase-1 prerequisite and is a
--     correctness risk. Left as-is.
--
--  4. NO `CREATE INDEX CONCURRENTLY`. The migration runner (lib/db.js) wraps
--     each .sql file in a single BEGIN/COMMIT transaction; CREATE INDEX
--     CONCURRENTLY cannot run inside a transaction block and would error the
--     whole migration. A plain CREATE INDEX is used (this also matches mig 134's
--     explicit choice to avoid CONCURRENT). work_items is small (<< the row
--     counts where a brief build lock matters); see LOCKING note below.
-- ---------------------------------------------------------------------------

-- New obligation columns (the substantive change). All NULLABLE + additive.
ALTER TABLE agent_graph.work_items
  -- owner_org_id: tenancy parity with inbox.signals / inbox.human_tasks. Already
  -- present from mig 134; IF NOT EXISTS keeps this idempotent. Plain UUID, NO FK
  -- to agent_graph.board_members or tenancy.orgs (project rule: no cross-schema
  -- FKs; matches the mig 134 pattern of a bare UUID column).
  ADD COLUMN IF NOT EXISTS owner_org_id UUID,

  -- obligation_type: maps from inbox.signals.signal_type / human_tasks.task_type.
  -- CHECK mirrors the human_tasks task_type domain plus the obligation-flavored
  -- signal types the bridge promotes. NULL = "this work_item is not an
  -- obligation" (directives / engineering tasks / campaigns stay NULL), so reads
  -- can distinguish obligations from ordinary task-graph work in a later phase.
  ADD COLUMN IF NOT EXISTS obligation_type TEXT
    CHECK (
      obligation_type IS NULL
      OR obligation_type IN (
        'action', 'request', 'commitment', 'deadline',
        'blocker', 'decision_followup'
      )
    ),

  -- source_message_id: denormalized from the source signal so a later Today
  -- query can apply the per-viewer recipient-overlap filter (htViewerFilter)
  -- without an extra join back through inbox.signals.
  ADD COLUMN IF NOT EXISTS source_message_id TEXT,

  -- viewer_emails: denormalized recipient list, stamped at bridge time from
  -- resolveViewerEmails(), to preserve viewer-scoping parity with the
  -- human_tasks Today read.
  ADD COLUMN IF NOT EXISTS viewer_emails TEXT[];

-- Backfill the obligation/tenancy fields on EXISTING bridge-spawned work_items
-- from their source signal. Idempotent + set-based + parameter-free (no string
-- interpolation of user data). Guarded so it is safe to re-run:
--   * matches only bridge-spawned items (metadata.source = 'signal-action-bridge')
--   * joins the source signal via metadata.source_signal_id (the exact key the
--     bridge stamps: signal-action-bridge.js metadata.source_signal_id)
--   * only writes columns that are still NULL (re-run never clobbers a value
--     that a later write path may have set)
--   * NULL-guards: the JOIN itself drops rows whose source_signal_id does not
--     resolve to a live signal, so no NULL source rows are touched.
UPDATE agent_graph.work_items wi
   SET owner_org_id      = COALESCE(wi.owner_org_id, s.owner_org_id),
       source_message_id = COALESCE(wi.source_message_id, s.message_id),
       obligation_type   = COALESCE(
         wi.obligation_type,
         CASE s.signal_type
           WHEN 'action'            THEN 'action'
           WHEN 'action_item'       THEN 'action'
           WHEN 'request'           THEN 'request'
           WHEN 'commitment'        THEN 'commitment'
           WHEN 'deadline'          THEN 'deadline'
           WHEN 'approval_needed'   THEN 'decision_followup'
           WHEN 'decision_followup' THEN 'decision_followup'
           WHEN 'blocker'           THEN 'blocker'
           ELSE NULL   -- unknown/unmapped signal types stay NULL (not an obligation)
         END
       )
  FROM inbox.signals s
 WHERE (wi.metadata->>'source_signal_id') = s.id
   AND wi.metadata->>'source' = 'signal-action-bridge'
   AND (
        wi.owner_org_id      IS NULL
     OR wi.source_message_id IS NULL
     OR wi.obligation_type   IS NULL
   );

-- Tenant-scoped read index. Plain (non-CONCURRENT) per the runner's transaction
-- wrapping (see deviation #4). Partial on live work_items only, mirroring the
-- partial-index convention used by inbox.human_tasks (mig 119/134).
CREATE INDEX IF NOT EXISTS idx_work_items_owner_org_obligation
  ON agent_graph.work_items (owner_org_id, status)
  WHERE obligation_type IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'cancelled', 'timed_out');

-- ---------------------------------------------------------------------------
-- ROLLBACK (manual; additive columns are otherwise reversible by ignoring them
-- since nothing reads them until OPT-162 Phase 2/3):
--
--   DROP INDEX IF EXISTS agent_graph.idx_work_items_owner_org_obligation;
--   ALTER TABLE agent_graph.work_items
--     DROP COLUMN IF EXISTS obligation_type,
--     DROP COLUMN IF EXISTS source_message_id,
--     DROP COLUMN IF EXISTS viewer_emails;
--   -- NOTE: do NOT drop owner_org_id on rollback — it predates this migration
--   -- (added by mig 134) and other code depends on it.
--
-- LOCKING / PERF on the live work_items table:
--   * ADD COLUMN ... (all NULL default, no volatile DEFAULT) is metadata-only in
--     PG 11+ — no table rewrite, sub-millisecond ACCESS EXCLUSIVE lock.
--   * The UPDATE touches only bridge-spawned rows (a small subset) and only
--     those still missing a value; it runs in the migration's single
--     transaction. Negligible on the current row count.
--   * CREATE INDEX (non-CONCURRENT) takes a brief SHARE lock blocking writes for
--     the build duration. On the current small work_items table this is
--     sub-second. If work_items grows large before this ships to prod, consider
--     building the index out-of-band with CONCURRENTLY in a separate, non-
--     transactional step.
-- ---------------------------------------------------------------------------
