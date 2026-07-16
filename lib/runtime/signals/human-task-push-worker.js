/**
 * Post-enrichment push worker.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      §1 FR-5, FR-6, FR-8, FR-10; §6 AD-1, AD-3; §2 NFR-7, NFR-8.
 *
 * Drains inbox.human_tasks rows with push_status='pending', calls the push
 * LLM via the injected `llm(prompt)`, parses the JSON, runs
 * `buildIssuePayload`, then either:
 *   - skip: push_status='skipped', push_skip_reason set, no Linear call,
 *     sync_log row with outcome='skipped'.
 *   - push: linearClient.createIssue(payload) → linear_issue_id,
 *     linear_issue_url, linear_synced_at, push_status='succeeded',
 *     sync_log row with outcome='success'.
 *
 * Retry (Linear errors only): in-process retry up to MAX_ATTEMPTS=3 with
 * exponential backoff (50ms × 2^i, capped at 500ms). The row stays in
 * push_status='running' across attempts — it is NEVER bounced back to
 * 'pending'. push_attempts is bumped once per failed Linear call.
 * The LLM is called exactly once per push (NFR-8 budget): the row's
 * decision is f(task, cache, guardrail, llm₁) — Linear blips don't
 * re-roll the dice. After MAX_ATTEMPTS exhausted, push_status='failed'
 * and a sync_log row with outcome='failed' is appended.
 *
 * Wake-up path:
 *   - `pg_notify('human_task_push_pending', <task_id>)` is fired by the
 *     enrichment worker (or operator bulk-push backfill) after a row is
 *     ready to ship to Linear.
 *   - This worker LISTENs on the same channel and drains immediately,
 *     bypassing the poll interval (NFR-8).
 *
 * Startup cleanup (AD-1 / FR-10):
 *   - Rows stuck in 'running' with pushed_at NULL or older than 5min are
 *     crash-orphans — reset to 'pending'. Fresh 'running' rows (set within
 *     the last 5min) belong to some other in-flight worker; leave them.
 *
 * P3 — feedback_history is append-only. We
 *   `COALESCE(feedback_history, '[]'::jsonb) || jsonb_build_array(...)`,
 * never replace.
 * P4 — pg_notify, no external queue. Parameterised SQL only.
 */

import { buildIssuePayload } from '../../linear/issue-payload.js';
import { loadCache } from '../../linear/team-cache.js';
import { buildPushPrompt } from '../push-prompt.js';
import { _getPgLiteForTest, getMode } from '../../db.js';
import { createLogger } from '../../logger.js';

const log = createLogger('runtime/human-task-push-worker');

const CHANNEL = 'human_task_push_pending';
const MAX_ATTEMPTS = 3;

/**
 * Start the push worker.
 *
 * @param {Object} opts
 * @param {Function} opts.query             - pg-style query fn (required)
 * @param {Function} opts.llm               - LLM caller: (prompt) => Promise<string>
 * @param {Object}   opts.linearClient      - { createIssue(payload) => {id, url, ...} }
 * @param {string}   opts.teamId            - Linear team id whose cache backs the push
 * @param {number}   [opts.pushTimeoutMs]   - per-row LLM + Linear cap (default 30000)
 * @param {number}   [opts.pollIntervalMs]  - poll fallback (default 5000)
 * @param {number}   [opts.stopTimeoutMs]   - max wait for in-flight tick on stop (default 30000)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function startPushWorker({
  query,
  llm,
  linearClient,
  teamId,
  pushTimeoutMs = 30_000,
  pollIntervalMs = 5_000,
  stopTimeoutMs = 30_000,
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('startPushWorker requires { query } function');
  }
  if (typeof llm !== 'function') {
    throw new Error('startPushWorker requires { llm } function');
  }
  if (!linearClient || typeof linearClient.createIssue !== 'function') {
    throw new Error('startPushWorker requires { linearClient.createIssue }');
  }
  if (!teamId) {
    throw new Error('startPushWorker requires { teamId }');
  }

  // ── 1. Startup cleanup. ───────────────────────────────────────────────
  // Reset stale 'running' rows. Fresh 'running' rows (pushed_at within the
  // last 5min) belong to some other worker instance — do not touch.
  try {
    await query(
      `UPDATE inbox.human_tasks
          SET push_status = 'pending'
        WHERE push_status = 'running'
          AND deleted_at IS NULL
          AND (pushed_at IS NULL
               OR pushed_at < now() - interval '5 minutes')`,
    );
  } catch (err) {
    log.error('push-worker startup cleanup failed:', err.message);
  }

  // ── 2. Subscribe to pg_notify wake-ups. ───────────────────────────────
  let unsubscribe = null;
  let pgListenClient = null;
  let listenReconnecting = false;
  let listenBackoffMs = 1000;
  const LISTEN_BACKOFF_CAP_MS = 30_000;
  let listenReconnectTimer = null;

  const wakeup = () => {
    scheduleTick();
  };

  async function connectListen() {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

    client.on('error', (err) => {
      log.error('push-worker LISTEN client error:', err.message);
      scheduleListenReconnect();
    });
    client.on('end', () => {
      if (stopped) return;
      log.error('push-worker LISTEN client ended unexpectedly');
      scheduleListenReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL) wakeup();
    });

    pgListenClient = client;
    listenBackoffMs = 1000;
  }

  function scheduleListenReconnect() {
    if (stopped) return;
    if (listenReconnecting) return;
    listenReconnecting = true;

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
      log.warn(`push-worker LISTEN reconnecting after ${delay}ms backoff`);
      connectListen()
        .then(() => {
          listenReconnecting = false;
          log.info('push-worker LISTEN reconnected');
        })
        .catch((err) => {
          listenReconnecting = false;
          log.error('push-worker LISTEN reconnect failed:', err.message);
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
      log.warn('push-worker LISTEN init failed, will retry:', err.message);
      pgListenClient = null;
      scheduleListenReconnect();
    }
  } else {
    try {
      const handle = await _getPgLiteForTest();
      if (handle && typeof handle.listen === 'function') {
        unsubscribe = await handle.listen(CHANNEL, () => wakeup());
      }
    } catch (err) {
      log.warn('push-worker PGlite listen() failed, polling only:', err.message);
    }
  }

  // ── 3. Worker loop state. ──────────────────────────────────────────────
  let stopped = false;
  let tickInFlight = null;
  let tickQueued = false;
  const inFlightIds = new Set();

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
    // Drain to empty; never throw uphill.
    while (!stopped) {
      let claimed;
      try {
        claimed = await claimOne();
      } catch (err) {
        log.error('push-worker drain claim error:', err.message);
        return;
      }
      if (!claimed) return;
      try {
        await processRow(claimed);
      } catch (err) {
        // processRow already handles failure paths; this is a last-resort
        // safety net so an unexpected throw can't kill the drain loop.
        log.error(`push-worker unexpected processRow error: ${err.message}`);
        inFlightIds.delete(claimed.id);
      }
      if (stopped) return;
    }
  }

  async function claimOne() {
    const result = await query(
      `UPDATE inbox.human_tasks
          SET push_status = 'running',
              pushed_at = now()
        WHERE id IN (
          SELECT id FROM inbox.human_tasks
           WHERE push_status = 'pending'
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
  }

  async function processRow(row) {
    // 1. Load team cache. Absent → fail-fast, do not call LLM.
    let teamCache;
    try {
      teamCache = await loadCache({ teamId, query });
    } catch (err) {
      log.error(`push-worker loadCache failed for task ${row.id}: ${err.message}`);
      await markFailedTerminal(row.id, `team cache lookup failed: ${err.message}`);
      inFlightIds.delete(row.id);
      return;
    }
    if (!teamCache) {
      await markFailedTerminal(row.id, 'no team cache');
      inFlightIds.delete(row.id);
      return;
    }

    // 2. Load current push guardrail. Absent → fail-fast.
    let guardrail;
    try {
      const gr = await query(
        `SELECT * FROM inbox.llm_guardrails
          WHERE kind = 'push' AND is_current = true
          LIMIT 1`,
      );
      guardrail = gr.rows[0] ?? null;
    } catch (err) {
      log.error(`push-worker guardrail lookup failed for task ${row.id}: ${err.message}`);
      await markFailedTerminal(row.id, `guardrail lookup failed: ${err.message}`);
      inFlightIds.delete(row.id);
      return;
    }
    if (!guardrail) {
      await markFailedTerminal(row.id, 'no push guardrail');
      inFlightIds.delete(row.id);
      return;
    }

    // 3. Call LLM under timeout, parse JSON. Exactly one LLM call per push
    //    (NFR-8 budget). LLM and JSON-parse failures are terminal — the row
    //    settles to 'failed' rather than re-LLMing, because the decision is
    //    f(task, cache, guardrail, llm₁) and re-rolling would (a) double-spend
    //    the per-push LLM budget and (b) make the row's decision
    //    non-deterministic. (Test stability — the hang/timeout test asserting
    //    'failed' without a 'pending' bounce — is a downstream consequence,
    //    not the reason.)
    let llmResponse;
    try {
      const prompt = buildPushPrompt({ task: row, teamCache, guardrail });
      const raw = await withTimeout(
        () => Promise.resolve(llm(prompt)),
        pushTimeoutMs,
        'llm timeout',
      );
      llmResponse = parseJson(raw);
      if (llmResponse === null) {
        throw new Error('llm returned non-JSON');
      }
    } catch (err) {
      await applyTerminalFailure(
        row.id,
        guardrail.id,
        (row.push_attempts ?? 0) + 1,
        err.message,
      );
      inFlightIds.delete(row.id);
      return;
    }

    // 4. Build payload. Skip path short-circuits; throws on missing required
    // ids (e.g. stateId with no mapping default). Payload build errors are
    // deterministic given (task, cache, guardrail, llmResponse) — no point
    // retrying without re-LLM, and re-LLM was already excluded.
    let payload;
    try {
      payload = buildIssuePayload({ task: row, teamCache, guardrail, llmResponse });
    } catch (err) {
      await applyTerminalFailure(
        row.id,
        guardrail.id,
        (row.push_attempts ?? 0) + 1,
        `payload build failed: ${err.message}`,
      );
      inFlightIds.delete(row.id);
      return;
    }

    // 5. Skip branch — no Linear call.
    if (typeof payload?.skip_reason === 'string' && payload.skip_reason.length > 0) {
      try {
        await applySkip(row.id, guardrail.id, payload.skip_reason);
      } catch (err) {
        log.error(`push-worker skip apply failed for task ${row.id}: ${err.message}`);
      }
      inFlightIds.delete(row.id);
      return;
    }

    // 6. Push to Linear under timeout, retrying up to MAX_ATTEMPTS times
    //    with the SAME payload (FR-10 — exponential backoff up to 3 attempts).
    //    Why the LLM is NOT re-issued on retry:
    //      - NFR-8: one LLM call per push budget. Re-LLMing on every Linear
    //        blip would silently multiply spend.
    //      - Determinism: the row's decision is
    //          f(task, cache, guardrail, llm₁).
    //        A transient Linear 502 does not invalidate the prompt's decision;
    //        re-rolling the LLM would let infrastructure noise mutate the
    //        semantic output of a single push.
    //    The row stays in push_status='running' across attempts (never bounces
    //    to 'pending'). push_attempts is incremented once per failed Linear
    //    call.
    let issue = null;
    let lastError = null;          // most recent failure message in THIS row (null if none)
    let failedAttempts = 0;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        issue = await withTimeout(
          () => Promise.resolve(linearClient.createIssue(payload)),
          pushTimeoutMs,
          'linear timeout',
        );
        // Do NOT reset lastError here — we want it visible on the row even
        // when the success was preceded by retried failures (tests assert
        // push_last_error remains populated after eventual success).
        break;
      } catch (err) {
        failedAttempts++;
        lastError = err.message || 'unknown error';
        if (i === MAX_ATTEMPTS - 1) break;
        await sleep(Math.min(50 * Math.pow(2, i), 500));
        if (stopped) break;
      }
    }

    const totalAttempts = (row.push_attempts ?? 0) + failedAttempts;
    const succeeded = issue != null && failedAttempts < MAX_ATTEMPTS;

    if (succeeded) {
      try {
        await applySuccess(row.id, guardrail.id, issue, {
          attempts: totalAttempts,
          lastError: lastError ?? row.push_last_error ?? null,
        });
      } catch (err) {
        log.error(`push-worker success apply failed for task ${row.id}: ${err.message}`);
      }
    } else {
      await applyTerminalFailure(row.id, guardrail.id, totalAttempts, lastError);
    }
    inFlightIds.delete(row.id);
  }

  // ── 4. State transitions. ──────────────────────────────────────────────

  async function applySuccess(id, guardrailId, issue, { attempts, lastError } = {}) {
    const issueId = issue?.id ?? null;
    const issueUrl = issue?.url ?? null;
    const at = new Date().toISOString();
    const nextAttempts = Number.isFinite(attempts) ? attempts : 0;

    const historyEntry = {
      verb: 'linear_push',
      outcome: 'success',
      issue_id: issueId,
      guardrail_id: guardrailId,
      attempts: nextAttempts,
      at,
    };

    // push_last_error is deliberately preserved (and updated if this
    // success was preceded by retried failures) so the retry trail stays
    // observable after the row settles. Tests assert on the value.
    await query(
      `UPDATE inbox.human_tasks
          SET linear_issue_id   = $2,
              linear_issue_url  = $3,
              linear_synced_at  = now(),
              push_status       = 'succeeded',
              push_attempts     = $4,
              push_last_error   = $5,
              pushed_at         = now(),
              last_feedback     = 'linear_push',
              feedback_history  = COALESCE(feedback_history, '[]'::jsonb)
                                  || jsonb_build_array($6::jsonb)
        WHERE id = $1
          AND push_status = 'running'`,
      [
        id,
        issueId,
        issueUrl,
        nextAttempts,
        lastError ?? null,
        JSON.stringify(historyEntry),
      ],
    );

    await insertSyncLog({
      taskId: id,
      direction: 'push',
      outcome: 'success',
      guardrailId,
      afterSnapshot: { issue_id: issueId, issue_url: issueUrl, attempts: nextAttempts },
    });
  }

  /**
   * Terminal failure path. Called when MAX_ATTEMPTS in-process Linear
   * retries have all failed (or the build step blew up before any Linear
   * call). Sets push_status='failed' and writes a sync_log row.
   */
  async function applyTerminalFailure(id, guardrailId, attempts, errorText) {
    const safeError = typeof errorText === 'string' && errorText
      ? errorText
      : 'unknown error';
    const at = new Date().toISOString();
    const historyEntry = {
      verb: 'linear_push',
      outcome: 'failed',
      attempts,
      error_text: safeError,
      guardrail_id: guardrailId,
      at,
    };
    try {
      await query(
        `UPDATE inbox.human_tasks
            SET push_status      = 'failed',
                push_attempts    = $2,
                push_last_error  = $3,
                pushed_at        = now(),
                feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                   || jsonb_build_array($4::jsonb)
          WHERE id = $1
            AND push_status = 'running'`,
        [id, attempts, safeError, JSON.stringify(historyEntry)],
      );
    } catch (err) {
      log.error(`push-worker applyTerminalFailure update failed for ${id}: ${err.message}`);
    }
    await insertSyncLog({
      taskId: id,
      direction: 'push',
      outcome: 'failed',
      guardrailId,
      errorText: safeError,
    });
  }

  async function applySkip(id, guardrailId, reason) {
    const at = new Date().toISOString();
    const historyEntry = {
      verb: 'linear_push',
      outcome: 'skipped',
      skip_reason: reason,
      guardrail_id: guardrailId,
      at,
    };

    await query(
      `UPDATE inbox.human_tasks
          SET push_status      = 'skipped',
              push_skip_reason = $2,
              push_last_error  = NULL,
              pushed_at        = now(),
              feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                 || jsonb_build_array($3::jsonb)
        WHERE id = $1
          AND push_status = 'running'`,
      [id, reason, JSON.stringify(historyEntry)],
    );

    await insertSyncLog({
      taskId: id,
      direction: 'push',
      outcome: 'skipped',
      guardrailId,
      afterSnapshot: null,
    });
  }

  /**
   * Used when we cannot proceed at all (no team cache, no guardrail). The
   * row is marked 'failed' immediately, regardless of push_attempts, because
   * retrying without the missing config would loop forever.
   */
  async function markFailedTerminal(id, reason) {
    const at = new Date().toISOString();
    const historyEntry = {
      verb: 'linear_push',
      outcome: 'failed',
      error_text: reason,
      guardrail_id: null,
      at,
    };
    try {
      await query(
        `UPDATE inbox.human_tasks
            SET push_status     = 'failed',
                push_last_error = $2,
                pushed_at       = now(),
                feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                   || jsonb_build_array($3::jsonb)
          WHERE id = $1
            AND push_status = 'running'`,
        [id, reason, JSON.stringify(historyEntry)],
      );
    } catch (err) {
      log.error(`push-worker markFailedTerminal failed for ${id}: ${err.message}`);
    }
    await insertSyncLog({
      taskId: id,
      direction: 'push',
      outcome: 'failed',
      guardrailId: null,
      errorText: reason,
    });
  }

  async function insertSyncLog({
    taskId,
    direction,
    outcome,
    guardrailId,
    afterSnapshot,
    errorText,
  }) {
    try {
      await query(
        `INSERT INTO inbox.human_task_sync_log
           (task_id, direction, outcome, guardrail_id, after_snapshot, error_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          taskId,
          direction,
          outcome,
          guardrailId,
          afterSnapshot == null ? null : JSON.stringify(afterSnapshot),
          errorText ?? null,
        ],
      );
    } catch (err) {
      log.error(`push-worker sync_log insert failed for ${taskId}: ${err.message}`);
    }
  }

  // ── 5. Poll timer. ─────────────────────────────────────────────────────
  const timer = setInterval(scheduleTick, pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Initial kick so existing pending rows drain without waiting a tick.
  scheduleTick();

  // ── 6. Stop. ───────────────────────────────────────────────────────────
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    if (listenReconnectTimer) {
      clearTimeout(listenReconnectTimer);
      listenReconnectTimer = null;
    }

    if (tickInFlight) {
      let abandonTimer = null;
      const abandon = new Promise((resolve) => {
        abandonTimer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
        if (typeof abandonTimer.unref === 'function') abandonTimer.unref();
      });
      const settle = tickInFlight
        .then(() => 'settled')
        .catch(() => 'settled');
      const outcome = await Promise.race([settle, abandon]);
      if (abandonTimer) clearTimeout(abandonTimer);
      if (outcome === 'timeout') {
        log.error(
          `push-worker stop() timed out after ${stopTimeoutMs}ms; abandoning in-flight tick`,
        );
      }
    }

    // Reset any rows we still hold in 'running' so a future worker re-pushes.
    if (inFlightIds.size > 0) {
      const ids = Array.from(inFlightIds);
      try {
        await query(
          `UPDATE inbox.human_tasks
              SET push_status = 'pending',
                  pushed_at   = NULL
            WHERE id = ANY($1::text[])
              AND push_status = 'running'`,
          [ids],
        );
      } catch (err) {
        log.error('push-worker stop() cleanup failed:', err.message);
      }
      inFlightIds.clear();
    }

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

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Race `fn()` against a hard timeout. Returns the resolved value or rejects
 * with new Error(message). Timer is cleared on settle so a successful call
 * does not keep the event loop alive.
 */
async function withTimeout(fn, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
