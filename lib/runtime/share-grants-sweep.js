// lib/runtime/share-grants-sweep.js
//
// ADR-017 D10: background sweep that flips active share_grants past their
// expires_at to status='expired'. Pattern mirrors lib/runtime/state/reaper.js
// — no framework, just a setInterval and a SQL update wrapped in expireDueGrants.
//
// Default cadence: every 5 minutes. The sweep is idempotent and cheap (single
// UPDATE filtered by the share_grants_expires_idx). It runs once on start so
// the first effect is not delayed by the interval.

import { expireDueGrants } from '../sharing/grants.js';
import { createLogger } from '../logger.js';
const log = createLogger('runtime/share-grants-sweep');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ShareGrantsSweep {
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.timer = null;
  }

  start() {
    log.info(`Starting (interval: ${this.intervalMs}ms)`);
    this.timer = setInterval(() => this.tick().catch((err) => {
      log.error(`tick error: ${err.message}`);
    }), this.intervalMs);
    // Run immediately on start so the first expiry is not delayed by the interval.
    this.tick().catch((err) => log.error(`initial tick error: ${err.message}`));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Stopped');
  }

  async tick() {
    const n = await expireDueGrants();
    if (n > 0) log.info(`tick: expired ${n} grant(s)`);
    return n;
  }
}
