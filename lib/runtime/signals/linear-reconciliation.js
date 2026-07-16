/**
 * Linear ↔ human_tasks reconciliation cron.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      FR-16 (10-min reconcile), AD-11 (drift detection + sticky overrides).
 *
 * Periodic (default 10-min) sweep that compares the locally mirrored Linear
 * fields on `inbox.human_tasks` against Linear's authoritative state and
 * heals any drift that webhooks may have missed. Mirrors the cron-loop
 * pattern in `lib/linear/team-cache.js` (initial-tick + in-flight guard +
 * timer unref) and reuses the push guardrail for state→status translation
 * the same way `autobot-inbox/src/linear/ingest.js` does.
 *
 * Contract:
 *   startReconciliation({ query, linearClient, teamId, intervalMs=600000 })
 *     → { stop(): Promise<void> }
 *
 *   - Fires an initial pass immediately (callers don't wait for intervalMs).
 *   - Each pass: SELECT live human_tasks rows with linear_issue_id, batch
 *     fetch via linearClient.fetchIssues({ ids }), value-level diff per row,
 *     parameterised UPDATE on drifting columns, append a 'linear_pull' entry
 *     to feedback_history, pg_notify('human_task_divergence', task_id).
 *   - Sticky fields (AD-5) preserved — operator edits never overwritten
 *     except for `status`, which is never sticky.
 *   - Single failure (Linear throws, one row blows up) never stops the pass
 *     or the cron loop. Next interval still fires.
 *   - stop() halts further passes and lets any in-flight pass settle.
 *
 * P2 — linearClient is injectable. P4 — parameterised SQL, no new deps.
 */

import { createLogger } from '../../logger.js';
import { getStickyFields } from '../human-task-sticky.js';

const log = createLogger('linear-reconciliation');

const DEFAULT_INTERVAL_MS = 600_000; // 10 minutes (FR-16).
const ROW_LIMIT = 500;

// Columns we mirror from Linear → human_tasks. Order matters only for
// deterministic UPDATE statements (helps when reading logs).
const MIRRORED_COLUMNS = [
  'linear_state_id',
  'linear_assignee_id',
  'linear_project_id',
  'title',
  'description',
];

/**
 * Start the reconciliation cron.
 *
 * @param {Object}   opts
 * @param {Function} opts.query         pg-style query fn (required)
 * @param {Object}   opts.linearClient  must expose fetchIssues({ ids }) → array
 * @param {string}   opts.teamId        Linear team UUID (passed through for log context)
 * @param {number}   [opts.intervalMs=600000]
 * @returns {{ stop: () => Promise<void> }}
 */
export function startReconciliation({ query, linearClient, teamId, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (typeof query !== 'function') {
    throw new Error('startReconciliation requires { query } function');
  }
  if (!linearClient || typeof linearClient.fetchIssues !== 'function') {
    throw new Error('startReconciliation requires { linearClient.fetchIssues } function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('startReconciliation requires positive intervalMs');
  }

  let stopped = false;
  let inFlight = null;
  let timer = null;

  async function tick() {
    if (stopped) return;
    if (inFlight) return; // coalesce — never overlap passes
    inFlight = runPass({ query, linearClient, teamId })
      .catch((err) => {
        // Pass-level safety net. Per-row + Linear-fetch errors are already
        // handled inside runPass; this only fires on truly unexpected throws.
        log.error(`reconciliation pass failed for team ${teamId}: ${err.message}`);
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  // Initial pass — don't make callers wait for the first interval.
  tick();

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) {
      try { await inFlight; } catch { /* already logged */ }
    }
  }

  return { stop };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Run one reconciliation pass. Exported for manual triggering (e.g. the
 * POST /api/linear/reconcile endpoint) so the cron's safety net and the
 * operator's "reconcile now" button share the same code path.
 *
 * Returns `{ processed_count, divergent_count }`. Resilient by construction:
 *   - 0 rows → early return, no Linear call.
 *   - Linear throws → log + return; the cron keeps ticking.
 *   - Per-row work wrapped in try/catch so one bad row doesn't drop siblings.
 */
export async function runReconciliationPass({ query, linearClient, teamId } = {}) {
  if (typeof query !== 'function') {
    throw new Error('runReconciliationPass requires { query } function');
  }
  if (!linearClient || typeof linearClient.fetchIssues !== 'function') {
    throw new Error('runReconciliationPass requires { linearClient.fetchIssues } function');
  }
  return runPass({ query, linearClient, teamId });
}

async function runPass({ query, linearClient, teamId }) {
  // 1. Select live, Linear-linked rows.
  let rows;
  try {
    const res = await query(
      `SELECT id, linear_issue_id, linear_state_id, linear_assignee_id,
              linear_project_id, title, description, feedback_history
         FROM inbox.human_tasks
        WHERE linear_issue_id IS NOT NULL
          AND deleted_at IS NULL
        LIMIT ${ROW_LIMIT}`,
    );
    rows = res.rows;
  } catch (err) {
    log.error(`reconciliation select failed for team ${teamId}: ${err.message}`);
    return { processed_count: 0, divergent_count: 0 };
  }

  if (!rows || rows.length === 0) return { processed_count: 0, divergent_count: 0 };

  // 2. Batch-fetch Linear issues. ONE call per pass.
  const ids = rows.map((r) => r.linear_issue_id);
  let issues;
  try {
    issues = await linearClient.fetchIssues({ ids });
  } catch (err) {
    log.error(`linear fetchIssues failed for team ${teamId}: ${err.message}`);
    return { processed_count: rows.length, divergent_count: 0 };
  }

  // 3. Build id → issue map for O(1) lookup.
  const issueById = new Map();
  for (const issue of issues || []) {
    if (issue && typeof issue.id === 'string') {
      issueById.set(issue.id, issue);
    }
  }

  // 4. Load current push guardrail once per pass (for state→status mapping).
  const mapping = await loadCurrentPushMapping(query);

  // 5. Per-row diff + UPDATE.
  let divergentCount = 0;
  for (const row of rows) {
    try {
      const diverged = await reconcileRow({ row, issueById, mapping, query });
      if (diverged) divergentCount += 1;
    } catch (err) {
      log.error(`reconciliation row ${row.id} failed: ${err.message}`);
      // continue — sibling rows must still reconcile
    }
  }
  return { processed_count: rows.length, divergent_count: divergentCount };
}

// Allow-list of column names safe to inject as jsonb_build_object keys. Used
// for both before_ and after_ snapshots so we never interpolate user-supplied
// strings into SQL.
const SNAPSHOT_ALLOWED_KEYS = new Set([
  'linear_state_id', 'linear_state_name', 'status',
  'linear_assignee_id', 'linear_project_id',
  'title', 'description',
]);

/**
 * Reconcile a single human_tasks row against the matching Linear issue.
 */
async function reconcileRow({ row, issueById, mapping, query }) {
  const issue = issueById.get(row.linear_issue_id);
  if (!issue) {
    log.warn(`reconciliation: linear issue ${row.linear_issue_id} not returned for task ${row.id}`);
    return false;
  }

  // Value-level diff (no updated_at compare — drift is the source of truth).
  const drift = {};
  if (issue.stateId !== undefined && issue.stateId !== row.linear_state_id) {
    drift.linear_state_id = issue.stateId;
  }
  if (issue.assigneeId !== undefined && issue.assigneeId !== row.linear_assignee_id) {
    drift.linear_assignee_id = issue.assigneeId;
  }
  if (issue.projectId !== undefined && issue.projectId !== row.linear_project_id) {
    drift.linear_project_id = issue.projectId;
  }
  if (typeof issue.title === 'string' && issue.title !== row.title) {
    drift.title = issue.title;
  }
  if (typeof issue.description === 'string' && issue.description !== row.description) {
    drift.description = issue.description;
  }

  if (Object.keys(drift).length === 0) return false; // no UPDATE, no notify

  // Sticky-field filter (AD-5). Status is never sticky; mirrored columns
  // (linear_state_id/assignee/project) are likewise infra fields — only the
  // operator-facing copies (title, description) participate in sticky.
  const sticky = getStickyFields(parseFeedbackHistory(row.feedback_history));
  const filtered = {};
  for (const [col, val] of Object.entries(drift)) {
    if (sticky.has(col)) continue; // operator wins
    filtered[col] = val;
  }

  if (Object.keys(filtered).length === 0) return false;

  // Derive status from new state id (when state changed) via the guardrail
  // mapping. Status is never blocked by sticky.
  let derivedStatus;
  let derivedStateName;
  if (Object.prototype.hasOwnProperty.call(filtered, 'linear_state_id')) {
    const newStateId = filtered.linear_state_id;
    if (mapping && Object.prototype.hasOwnProperty.call(mapping.mapping, newStateId)) {
      derivedStatus = mapping.mapping[newStateId];
    } else if (mapping) {
      log.warn(
        `reconciliation: state id ${newStateId} not in guardrail mapping; status omitted for task ${row.id}`,
      );
    }
    if (typeof issue.stateName === 'string') {
      derivedStateName = issue.stateName;
    }
  }

  // Build a single parameterised UPDATE that also appends a linear_pull
  // entry to feedback_history.
  const setClauses = [];
  const params = [];
  let i = 1;

  for (const col of MIRRORED_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(filtered, col)) {
      setClauses.push(`${col} = $${i++}`);
      params.push(filtered[col]);
    }
  }
  if (derivedStateName !== undefined) {
    setClauses.push(`linear_state_name = $${i++}`);
    params.push(derivedStateName);
  }
  if (derivedStatus !== undefined) {
    setClauses.push(`status = $${i++}`);
    params.push(derivedStatus);
  }
  setClauses.push(`linear_last_event_at = now()`);

  const entry = {
    verb: 'linear_pull',
    source: 'reconcile',
    fields_changed: Object.keys(filtered),
    guardrail_id: mapping?.id || null,
    at: new Date().toISOString(),
  };
  setClauses.push(
    `feedback_history = COALESCE(feedback_history, '[]'::jsonb) || jsonb_build_array($${i++}::jsonb)`,
  );
  params.push(JSON.stringify(entry));

  // WHERE
  params.push(row.id);
  const sql = `UPDATE inbox.human_tasks SET ${setClauses.join(', ')} WHERE id = $${i}`;

  // Wall-clock start (NFR-13 sync_log duration_ms) — measured around the
  // UPDATE only so transient SELECT/network jitter from earlier in the pass
  // doesn't pollute the per-row reconcile-write timing.
  const startMs = Date.now();
  await query(sql, params);

  // NFR-13: append one inbox.human_task_sync_log row per drift-correcting
  // UPDATE. Wrapped in try/catch — sync_log failure must not affect the
  // main reconcile flow. before_snapshot reflects the pre-reconcile row,
  // after_snapshot the applied patch. Both built via jsonb_build_object so
  // values are never interpolated.
  try {
    // before_snapshot — fixed set of mirrored columns from the pre-reconcile row.
    const beforeKeys = ['linear_state_id', 'linear_assignee_id', 'linear_project_id', 'title', 'description'];
    const beforeArgs = [];
    const logParams = [];
    let p = 1;
    for (const k of beforeKeys) {
      if (!SNAPSHOT_ALLOWED_KEYS.has(k)) continue;
      // ::text cast lets PGlite/postgres infer the parameter type even when
      // the row value is null.
      beforeArgs.push(`'${k}', $${p++}::text`);
      logParams.push(row[k] ?? null);
    }
    const beforeExpr = beforeArgs.length > 0
      ? `jsonb_build_object(${beforeArgs.join(', ')})`
      : `'{}'::jsonb`;

    // after_snapshot — applied patch (drift fields the UPDATE actually wrote).
    const afterArgs = [];
    for (const [k, v] of Object.entries(filtered)) {
      if (!SNAPSHOT_ALLOWED_KEYS.has(k)) continue;
      afterArgs.push(`'${k}', $${p++}::text`);
      logParams.push(v);
    }
    if (derivedStatus !== undefined && SNAPSHOT_ALLOWED_KEYS.has('status')) {
      afterArgs.push(`'status', $${p++}::text`);
      logParams.push(derivedStatus);
    }
    if (derivedStateName !== undefined && SNAPSHOT_ALLOWED_KEYS.has('linear_state_name')) {
      afterArgs.push(`'linear_state_name', $${p++}::text`);
      logParams.push(derivedStateName);
    }
    const afterExpr = afterArgs.length > 0
      ? `jsonb_build_object(${afterArgs.join(', ')})`
      : `'{}'::jsonb`;

    // Trailing params: task_id, guardrail_id, duration_ms.
    logParams.push(row.id, mapping?.id ?? null, Date.now() - startMs);
    const taskParam = `$${p++}`;
    const grParam = `$${p++}`;
    const durParam = `$${p++}`;

    await query(
      `INSERT INTO inbox.human_task_sync_log
         (task_id, direction, outcome, guardrail_id,
          before_snapshot, after_snapshot, duration_ms)
       VALUES (${taskParam}, 'reconcile', 'conflict_resolved', ${grParam},
               ${beforeExpr}, ${afterExpr}, ${durParam})`,
      logParams,
    );
  } catch (logErr) {
    log.error(`reconciliation sync_log insert failed for task ${row.id}: ${logErr.message}`);
  }

  // One pg_notify per drifting row — payload is the bare task id string.
  try {
    await query(`SELECT pg_notify('human_task_divergence', $1)`, [row.id]);
  } catch (err) {
    log.error(`reconciliation pg_notify failed for task ${row.id}: ${err.message}`);
  }
  return true;
}

/**
 * Load the current push guardrail (kind='push', is_current=true). Returns
 * `{ id, mapping }` or null if none is configured. Errors degrade to null
 * so a missing guardrail merely suppresses status derivation — drift on
 * other columns still heals.
 */
async function loadCurrentPushMapping(query) {
  try {
    const res = await query(
      `SELECT id, mapping FROM inbox.llm_guardrails
        WHERE kind = 'push' AND is_current = true
        LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    const mapping = parseJsonObject(row.mapping);
    return { id: row.id, mapping };
  } catch (err) {
    log.error(`reconciliation guardrail load failed: ${err.message}`);
    return null;
  }
}

function parseFeedbackHistory(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
