/**
 * ServiceScheduler — manages periodic services with DB-backed visibility.
 *
 * Replaces the inline scheduleService() function in index.js.
 * Each registered service upserts to agent_graph.scheduled_services,
 * checks is_paused before each run, and updates status/duration/failures.
 *
 * DB writes are fire-and-forget (catch errors, don't block the service).
 */

import { query } from '../../../lib/db.js';

export class ServiceScheduler {
  constructor() {
    /** @type {Array<NodeJS.Timeout>} */
    this._timers = [];
    /** @type {Map<string, () => Promise<void>>} */
    this._runners = new Map();
    /** @type {Map<string, number>} track consecutive failures for alerting */
    this._failureCounts = new Map();
  }

  /**
   * Register and start a periodic service.
   *
   * @param {string} name - Unique service name
   * @param {() => Promise<void>} fn - Async function to run
   * @param {number} intervalMs - Repeat interval in ms
   * @param {{ delayMs?: number, critical?: boolean }} opts
   */
  register(name, fn, intervalMs, opts = {}) {
    const { delayMs = 0, critical = false } = opts;

    // Fire-and-forget DB upsert
    this._upsertService(name, intervalMs, delayMs, critical);

    const runWithTracking = async () => {
      // Check pause flag before running
      const paused = await this._isPaused(name);
      if (paused) {
        this._dbWrite(
          `UPDATE agent_graph.scheduled_services
           SET last_status = 'skipped', last_run_at = now()
           WHERE name = $1`,
          [name]
        );
        return;
      }

      // Mark as running
      this._dbWrite(
        `UPDATE agent_graph.scheduled_services SET last_status = 'running', last_run_at = now() WHERE name = $1`,
        [name]
      );

      const start = Date.now();
      try {
        await fn();
        const dur = Date.now() - start;

        if (dur > 30000) {
          console.warn(`[${name}] Slow execution: ${(dur / 1000).toFixed(1)}s`);
        }

        // Reset failure count on success
        if (this._failureCounts.has(name)) {
          const prev = this._failureCounts.get(name);
          if (prev >= 2) console.log(`[${name}] Recovered after ${prev} consecutive failure(s)`);
          this._failureCounts.delete(name);
        }

        this._dbWrite(
          `UPDATE agent_graph.scheduled_services
           SET last_status = 'ok', last_duration_ms = $2, failure_count = 0, total_runs = total_runs + 1
           WHERE name = $1`,
          [name, dur]
        );
      } catch (err) {
        const dur = Date.now() - start;
        const count = (this._failureCounts.get(name) || 0) + 1;
        this._failureCounts.set(name, count);

        console.error(`[${name}] Error (failure #${count}):`, err.message);

        if (count > 0 && count % 3 === 0) {
          console.error(`[${name}] ALERT: ${count} consecutive failures — service may be broken`);
          try {
            const { notifyBoard } = await import('../telegram/sender.js');
            await notifyBoard(`WARNING: Service "${name}" failed 3x consecutively: ${err.message.slice(0, 100)}`);
          } catch { /* telegram not configured — log only */ }
        }

        this._dbWrite(
          `UPDATE agent_graph.scheduled_services
           SET last_status = 'failed', last_error = $2, last_duration_ms = $3,
               failure_count = failure_count + 1, total_runs = total_runs + 1
           WHERE name = $1`,
          [name, err.message.slice(0, 500), dur]
        );
      }
    };

    // Store runner for manual trigger
    this._runners.set(name, runWithTracking);

    const timer = setTimeout(() => {
      runWithTracking();
      const interval = setInterval(runWithTracking, intervalMs);
      this._timers.push(interval);
    }, delayMs);
    this._timers.push(timer);
  }

  /**
   * Trigger a service to run immediately.
   * @param {string} name
   * @returns {Promise<boolean>} true if triggered
   */
  async trigger(name) {
    const runner = this._runners.get(name);
    if (!runner) return false;
    // Run async, don't await — fire and forget
    runner().catch(err => console.error(`[${name}] Manual trigger error:`, err.message));
    return true;
  }

  /** Stop all timers. */
  stopAll() {
    for (const timer of this._timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this._timers.length = 0;
  }

  /** @private */
  async _isPaused(name) {
    try {
      const result = await query(
        `SELECT is_paused FROM agent_graph.scheduled_services WHERE name = $1`,
        [name]
      );
      return result.rows[0]?.is_paused === true;
    } catch {
      return false; // If DB is unavailable, don't block the service
    }
  }

  /** @private */
  _upsertService(name, intervalMs, delayMs, critical) {
    this._dbWrite(
      `INSERT INTO agent_graph.scheduled_services (name, interval_ms, delay_ms, is_critical, registered_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (name) DO UPDATE SET
         interval_ms = EXCLUDED.interval_ms,
         delay_ms = EXCLUDED.delay_ms,
         is_critical = EXCLUDED.is_critical,
         registered_at = now()`,
      [name, intervalMs, delayMs, critical]
    );
  }

  /** @private Fire-and-forget DB write. */
  _dbWrite(sql, params) {
    query(sql, params).catch(err => {
      console.warn(`[service-scheduler] DB write error: ${err.message}`);
    });
  }
}

/** Singleton for access from API routes (manual trigger). */
let _instance = null;

export function setSchedulerInstance(scheduler) {
  _instance = scheduler;
}

export function getSchedulerInstance() {
  return _instance;
}
