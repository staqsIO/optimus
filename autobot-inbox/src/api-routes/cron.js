import { runExplorationCycle } from '../runtime/self-improve-scanner.js';
import { getConfig } from '../../../lib/config/loader.js';

let explorerRunning = false;

const CRON_SECRET = process.env.CRON_SECRET;

export function registerCronRoutes(routes) {
  routes.set('POST /api/cron/explorer', async (req, _body) => {
    // Linus: P1 deny-by-default — hard-fail if CRON_SECRET not configured
    if (!CRON_SECRET) {
      const e = new Error('CRON_SECRET not configured — cron endpoints disabled');
      e.statusCode = 503;
      throw e;
    }
    const authHeader = req.headers?.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token !== CRON_SECRET) {
      const e = new Error('Invalid cron secret');
      e.statusCode = 403;
      throw e;
    }
    if (explorerRunning) {
      const err = new Error('Exploration cycle already in progress');
      err.statusCode = 409;
      throw err;
    }

    const agentsConfig = getConfig('agents');
    const explorerConfig = agentsConfig.agents['claw-explorer'];

    if (!explorerConfig?.enabled) {
      return { skipped: true, reason: 'claw-explorer disabled in agents.json' };
    }

    explorerRunning = true;
    try {
      const result = await runExplorationCycle(explorerConfig.exploration || {});
      return { ok: true, result, timestamp: new Date().toISOString() };
    } finally {
      explorerRunning = false;
    }
  });

  routes.set('GET /api/cron/explorer/status', async () => {
    return { running: explorerRunning, timestamp: new Date().toISOString() };
  });

  // POST /api/cron/signatures-sweep — expire overdue signing requests
  // and email reminders to pending signers whose expiry is near. Safe to
  // schedule hourly; reminders rate-limit themselves via last_reminded_at.
  routes.set('POST /api/cron/signatures-sweep', async (req, _body) => {
    if (!CRON_SECRET) {
      const e = new Error('CRON_SECRET not configured — cron endpoints disabled');
      e.statusCode = 503;
      throw e;
    }
    const authHeader = req.headers?.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token !== CRON_SECRET) {
      const e = new Error('Invalid cron secret');
      e.statusCode = 403;
      throw e;
    }

    const { sweepSignatures } = await import('../../../lib/signatures/sweeper.js');
    const result = await sweepSignatures();
    return { ok: true, result, timestamp: new Date().toISOString() };
  });
}
