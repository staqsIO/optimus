/**
 * Post-promotion enrichment worker.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      (PRD §6, AD-1, FR-1..FR-4)
 *
 * Drains inbox.human_tasks rows where enrichment_status='pending', calls
 * enrichTask({ task, contacts, projects, llm }) per row, applies the
 * resulting patch (minus operator-edited "sticky" fields) and stamps the
 * row 'completed'. Errors mark the row 'failed' and never propagate.
 *
 * Wake-up path:
 *   - `pg_notify('human_task_enrichment_pending', <task_id>)` is fired by
 *     signal-task-promoter after a successful auto/propose insert.
 *   - The worker LISTENs on the same channel and processes immediately,
 *     bypassing the poll interval.
 *
 * Startup cleanup (AD-1 / FR-4):
 *   - Rows stuck in 'running' with enrichment_at NULL or older than 5min
 *     are crash-orphans — reset to 'pending'. Fresh 'running' rows (set
 *     within the last 5min) are owned by some other in-flight worker;
 *     leave them alone.
 *
 * P3 — feedback_history is append-only. We `feedback_history || jsonb_build_array(...)`,
 * never replace.
 * P4 — pg_notify, no external queue. Parameterised SQL only.
 */

import { enrichTask as defaultEnrichTask } from '../human-task-enrichment.js';
import { getStickyFields } from '../human-task-sticky.js';
import { _getPgLiteForTest, getMode } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('runtime/human-task-enrichment-worker');

const CHANNEL = 'human_task_enrichment_pending';

// Fields a patch is allowed to write. Matches enrichTask()'s output surface
// (see human-task-enrichment.js). Anything outside this list is dropped at
// build-UPDATE time so a stray field can't slip into the schema.
const ALLOWED_PATCH_FIELDS = [
  'assignee_contact_id',
  'assignee_confidence',
  'task_type',
  'priority',
  'size',
  'project_id',
  'tags',
  'next_action_hint',
  'description',
  'extraction_confidence',
  'related_contact_ids',
  'engagement_id',
];

/**
 * Start the enrichment worker.
 *
 * @param {Object} opts
 * @param {Function} opts.query                 - pg-style query fn (required)
 * @param {Function} [opts.enrichTask]          - override (default: human-task-enrichment.js)
 * @param {Function} opts.llm                   - LLM caller passed through to enrichTask
 * @param {number}   [opts.pollIntervalMs]      - poll fallback (default 5000)
 * @param {number}   [opts.stopTimeoutMs]       - max wait for in-flight tick on stop() (default 30000)
 * @param {number}   [opts.enrichmentTimeoutMs] - per-row enrichTask hard cap (default 60000, matches NFR-1 P99)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startEnrichmentWorker({
  query,
  enrichTask = defaultEnrichTask,
  llm,
  pollIntervalMs = 5000,
  stopTimeoutMs = 30_000,
  enrichmentTimeoutMs = 60_000,
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('startEnrichmentWorker requires { query } function');
  }

  // ── 1. Startup cleanup: reset stale 'running' rows back to 'pending'. ──
  // Fresh 'running' rows (enrichment_at within the last 5min) belong to
  // some other worker instance — do not touch.
  try {
    await query(
      `UPDATE inbox.human_tasks
          SET enrichment_status = 'pending'
        WHERE enrichment_status = 'running'
          AND deleted_at IS NULL
          AND (enrichment_at IS NULL
               OR enrichment_at < now() - interval '5 minutes')`,
    );
  } catch (err) {
    log.error('enrichment-worker startup cleanup failed:', err.message);
  }

  // ── 2. Subscribe to pg_notify wake-ups. ────────────────────────────────
  // In PGlite mode (tests) we grab the handle directly. In real-Postgres
  // mode we open a dedicated pg.Client because LISTEN must hold a single
  // connection outside the pool (matches lib/runtime/event-bus.js).
  //
  // Reconnect strategy (mirrors lib/runtime/event-bus.js#schedulePgListenReconnect):
  // - On client 'error' or 'end', schedule a reconnect with exponential
  //   backoff starting at 1s and capped at 30s.
  // - Each reconnect attempt re-issues LISTEN. Success resets the backoff.
  // - Reconnects halt once stopped=true.
  let unsubscribe = null;
  let pgListenClient = null;
  let listenReconnecting = false;
  let listenBackoffMs = 1000;
  const LISTEN_BACKOFF_CAP_MS = 30_000;
  let listenReconnectTimer = null;

  const wakeup = () => {
    // Coalesce: a NOTIFY storm shouldn't fan out into many in-flight loops.
    scheduleTick();
  };

  async function connectListen() {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

    // Register handlers BEFORE connect so we never miss an early error.
    client.on('error', (err) => {
      log.error('enrichment-worker LISTEN client error:', err.message);
      scheduleListenReconnect();
    });
    client.on('end', () => {
      if (stopped) return;
      log.error('enrichment-worker LISTEN client ended unexpectedly');
      scheduleListenReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL) wakeup();
    });

    pgListenClient = client;
    // Successful connect — reset backoff so the next failure starts at 1s.
    listenBackoffMs = 1000;
  }

  function scheduleListenReconnect() {
    if (stopped) return;
    if (listenReconnecting) return;
    listenReconnecting = true;

    // Drop the dead client (best-effort).
    if (pgListenClient) {
      const dead = pgListenClient;
      pgListenClient = null;
      dead.end().catch(() => { /* swallowed */ });
    }

    const delay = listenBackoffMs;
    listenBackoffMs = Math.min(listenBackoffMs * 2, LISTEN_BACKOFF_CAP_MS);

    listenReconnectTimer = setTimeout(() => {
      listenReconnectTimer = null;
      if (stopped) {
        listenReconnecting = false;
        return;
      }
      log.warn(`enrichment-worker LISTEN reconnecting after ${delay}ms backoff`);
      connectListen()
        .then(() => {
          listenReconnecting = false;
          log.info('enrichment-worker LISTEN reconnected');
        })
        .catch((err) => {
          listenReconnecting = false;
          log.error('enrichment-worker LISTEN reconnect failed:', err.message);
          scheduleListenReconnect();
        });
    }, delay);
    if (typeof listenReconnectTimer.unref === 'function') {
      listenReconnectTimer.unref();
    }
  }

  if (getMode() === 'postgres') {
    try {
      await connectListen();
    } catch (err) {
      log.warn('enrichment-worker LISTEN init failed, will retry:', err.message);
      pgListenClient = null;
      // Schedule a reconnect rather than running poll-only — the worker
      // must self-heal once Postgres is reachable again.
      scheduleListenReconnect();
    }
  } else {
    try {
      const handle = await _getPgLiteForTest();
      if (handle && typeof handle.listen === 'function') {
        unsubscribe = await handle.listen(CHANNEL, () => wakeup());
      }
    } catch (err) {
      log.warn('enrichment-worker PGlite listen() failed, polling only:', err.message);
    }
  }

  // ── 3. Worker loop state. ──────────────────────────────────────────────
  let stopped = false;
  let tickInFlight = null;       // promise of the currently-running drain
  let tickQueued = false;        // a tick was requested while one was running
  const inFlightIds = new Set(); // rows we currently hold in 'running'

  function scheduleTick() {
    if (stopped) return;
    if (tickInFlight) {
      tickQueued = true;
      return;
    }
    tickInFlight = drain().finally(() => {
      tickInFlight = null;
      if (tickQueued && !stopped) {
        tickQueued = false;
        scheduleTick();
      }
    });
  }

  async function drain() {
    // Claim + process one row at a time. If we got one, immediately try
    // again — drain to empty before yielding to the timer.
    // eslint-disable-next-line no-constant-condition
    while (!stopped) {
      const claimed = await claimOne();
      if (!claimed) return;
      await processRow(claimed);
      if (stopped) return;
    }
  }

  async function claimOne() {
    try {
      // Atomic claim: a single UPDATE...WHERE id IN (SELECT ... FOR UPDATE
      // SKIP LOCKED LIMIT 1). Two workers racing on the same row → only
      // one gets a RETURNING row, the other gets zero.
      const result = await query(
        `UPDATE inbox.human_tasks
            SET enrichment_status = 'running',
                enrichment_at = now()
          WHERE id IN (
            SELECT id FROM inbox.human_tasks
             WHERE enrichment_status = 'pending'
               AND deleted_at IS NULL
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING *`,
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      inFlightIds.add(row.id);
      return row;
    } catch (err) {
      log.error('enrichment-worker claimOne failed:', err.message);
      return null;
    }
  }

  async function processRow(row) {
    let patch;
    let timeoutHandle = null;
    try {
      const contacts = await loadContacts(query);
      const projects = await loadProjects(query);
      const engagements = await loadEngagements(query);
      // Hard cap per-row enrichment (NFR-1 P99). A hung LLM or network
      // call cannot freeze this worker — the orphan cleanup at 5min is
      // only a secondary safety net.
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('enrichment timeout')),
          enrichmentTimeoutMs,
        );
        if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
      });
      try {
        patch = await Promise.race([
          enrichTask({ task: row, contacts, projects, engagements, llm }),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (err) {
      log.error(`enrichment failed for task ${row.id}: ${err.message}`);
      await markFailed(row.id, err.message).catch((e) =>
        log.error(`could not mark failed: ${e.message}`),
      );
      inFlightIds.delete(row.id);
      return;
    }

    // Sticky-field guard: drop any field the operator already edited.
    const history = parseHistory(row.feedback_history);
    const sticky = getStickyFields(history);
    const appliedPatch = {};
    for (const key of ALLOWED_PATCH_FIELDS) {
      if (!(key in (patch || {}))) continue;
      if (sticky.has(key)) continue;
      appliedPatch[key] = patch[key];
    }

    try {
      await applyPatch(row.id, appliedPatch);
    } catch (err) {
      log.error(`enrichment apply failed for task ${row.id}: ${err.message}`);
      await markFailed(row.id, err.message).catch((e) =>
        log.error(`could not mark failed: ${e.message}`),
      );
      inFlightIds.delete(row.id);
      return;
    }

    // ── Two-tier push trigger (FR-6) ────────────────────────────────────
    // Only on successful enrichment completion. A single conditional UPDATE
    // does all the gating — relevance ≥ 0.8, non-terminal status, push_status
    // still NULL. If no row comes back, the row is not eligible for auto-push
    // (operator/force-push owns it, or it's confirm-tier) and we skip notify.
    try {
      await maybeEnqueuePush(row.id);
    } catch (err) {
      log.error(`enrichment push-enqueue failed for task ${row.id}: ${err.message}`);
    }

    inFlightIds.delete(row.id);
  }

  async function maybeEnqueuePush(id) {
    const result = await query(
      `UPDATE inbox.human_tasks
          SET push_status = 'pending',
              updated_at = now()
        WHERE id = $1
          AND relevance_score >= 0.8
          AND push_status IS NULL
          AND status NOT IN ('done','skipped','not_for_us')
          AND deleted_at IS NULL
        RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) return;
    // Notify only after the UPDATE confirms eligibility — keeps push workers
    // from racing on a row that was never enqueued.
    await query(`SELECT pg_notify('human_task_push_pending', $1)`, [id]);
  }

  async function applyPatch(id, appliedPatch) {
    // Build SET clauses for the surviving patch fields + bookkeeping.
    const sets = [];
    const params = [];
    let p = 1;

    for (const [key, value] of Object.entries(appliedPatch)) {
      sets.push(`${key} = $${p++}`);
      params.push(value);
    }

    sets.push(`enrichment_status = 'completed'`);
    sets.push(`enrichment_at = now()`);

    // Append-only feedback_history entry. Captures the patch that was
    // actually applied (post-sticky-filter) so an audit can replay.
    const entry = {
      verb: 'llm_decision',
      kind: 'enrichment',
      guardrail_id: null,
      patch: appliedPatch,
      at: new Date().toISOString(),
    };
    sets.push(
      `feedback_history = COALESCE(feedback_history, '[]'::jsonb) ` +
      `|| jsonb_build_array($${p++}::jsonb)`,
    );
    params.push(JSON.stringify(entry));

    params.push(id);
    const idParam = `$${p}`;

    await query(
      `UPDATE inbox.human_tasks SET ${sets.join(', ')} WHERE id = ${idParam}`,
      params,
    );
  }

  async function markFailed(id, errorText) {
    // P3 — feedback_history is append-only. Stamp the error there so audit
    // can replay why a row failed. The human_tasks table has no dedicated
    // error column; the row's enrichment_status='failed' + the latest
    // feedback_history entry together carry the diagnosis.
    //
    // WHERE filter on enrichment_status='running' is defensive: if another
    // concurrent worker already moved the row (completed/cancelled), we do
    // not clobber its terminal state.
    const entry = {
      verb: 'llm_decision',
      kind: 'enrichment_failure',
      guardrail_id: null,
      error_text: typeof errorText === 'string' && errorText ? errorText : 'unknown',
      at: new Date().toISOString(),
    };
    await query(
      `UPDATE inbox.human_tasks
          SET enrichment_status = 'failed',
              enrichment_at = now(),
              feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                 || jsonb_build_array($2::jsonb)
        WHERE id = $1
          AND enrichment_status = 'running'`,
      [id, JSON.stringify(entry)],
    );
  }

  // ── 4. Poll timer (NOTIFY-or-poll, whichever comes first). ─────────────
  const timer = setInterval(scheduleTick, pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Kick once on startup so existing pending rows get drained without
  // waiting for the first poll tick.
  scheduleTick();

  // ── 5. Stop: drain in-flight, reset any rows we still hold. ────────────
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    // Cancel any pending LISTEN reconnect attempt.
    if (listenReconnectTimer) {
      clearTimeout(listenReconnectTimer);
      listenReconnectTimer = null;
    }

    // Race the in-flight tick against stopTimeoutMs. A hung enrichTask
    // must not be able to block stop() indefinitely. The enrichmentTimeoutMs
    // race inside processRow() is the primary fence; this is a backstop
    // for unanticipated synchronous-loop or unawaited-promise hangs.
    if (tickInFlight) {
      let abandonTimer = null;
      const abandon = new Promise((resolve) => {
        abandonTimer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
        if (typeof abandonTimer.unref === 'function') abandonTimer.unref();
      });
      const settle = tickInFlight
        .then(() => 'settled')
        .catch(() => 'settled' /* drain() swallows; failure is still a settle */);
      const outcome = await Promise.race([settle, abandon]);
      if (abandonTimer) clearTimeout(abandonTimer);
      if (outcome === 'timeout') {
        log.error(
          `enrichment-worker stop() timed out after ${stopTimeoutMs}ms; abandoning in-flight tick`,
        );
        // Detach from the in-flight promise so we proceed to cleanup. The
        // orphan row(s) are recovered by the inFlightIds reset below; if
        // that misses (e.g. a fresh claim mid-stop), the 5min orphan sweep
        // on the next worker startup picks them up.
      }
    }

    // Anything still in inFlightIds was holding 'running' when we cut the
    // tick short — reset it to 'pending' so a future worker re-enriches.
    if (inFlightIds.size > 0) {
      const ids = Array.from(inFlightIds);
      try {
        await query(
          `UPDATE inbox.human_tasks
              SET enrichment_status = 'pending',
                  enrichment_at = NULL
            WHERE id = ANY($1::text[])
              AND enrichment_status = 'running'`,
          [ids],
        );
      } catch (err) {
        log.error('enrichment-worker stop() cleanup failed:', err.message);
      }
      inFlightIds.clear();
    }

    // Tear down the LISTEN subscription.
    try {
      if (typeof unsubscribe === 'function') await unsubscribe();
    } catch { /* swallowed */ }
    unsubscribe = null;

    if (pgListenClient) {
      try { await pgListenClient.end(); } catch { /* swallowed */ }
      pgListenClient = null;
    }
  }

  return { stop };
}

// ───── helpers ─────────────────────────────────────────────────────────────

function parseHistory(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

async function loadContacts(query) {
  try {
    const r = await query(
      `SELECT id, email_address, name FROM signal.contacts`,
    );
    return r.rows;
  } catch {
    return [];
  }
}

async function loadProjects(query) {
  try {
    const r = await query(
      `SELECT id, slug, name FROM agent_graph.projects`,
    );
    return r.rows;
  } catch {
    return [];
  }
}

async function loadEngagements(query) {
  try {
    const r = await query(
      `SELECT id, name FROM engagements.engagements WHERE status = 'active'`,
    );
    return r.rows;
  } catch {
    return [];
  }
}
