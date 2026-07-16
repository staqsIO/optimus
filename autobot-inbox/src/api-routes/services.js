/**
 * Scheduled Services API routes.
 *
 * GET  /api/services/status         — all services with status, timing, failures
 * POST /api/services/:name/pause    — soft-pause (rejects critical with 403)
 * POST /api/services/:name/resume   — resume paused service
 * POST /api/services/:name/trigger  — run immediately (rejects critical with 403)
 */

import { query } from '../db.js';
import { getSchedulerInstance } from '../runtime/schedule-service.js';

/** Extract service name from URL: /api/services/:name/action */
function extractName(url) {
  const pathname = new URL(url, 'http://localhost').pathname;
  const parts = pathname.split('/');
  // /api/services/:name/:action => parts = ['', 'api', 'services', name, action]
  return parts[3] || null;
}

function httpError(msg, code) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

export function registerServiceRoutes(routes) {

  // GET /api/services/status — all services
  routes.set('GET /api/services/status', async () => {
    const result = await query(
      `SELECT * FROM agent_graph.scheduled_services ORDER BY name`
    );
    return { services: result.rows };
  });

  // POST /api/services/:name/pause — board only, rejects critical
  routes.set('POST /api/services/:name/pause', async (req) => {
    if (!req.auth || req.auth.role !== 'board') {
      throw httpError('Board authentication required', 401);
    }

    const name = extractName(req.url);
    if (!name) throw httpError('Missing service name', 400);

    const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'unknown';

    const svc = await query(
      `SELECT is_critical FROM agent_graph.scheduled_services WHERE name = $1`,
      [name]
    );
    if (svc.rows.length === 0) throw httpError('Service not found', 404);
    if (svc.rows[0].is_critical) throw httpError('Cannot pause critical service', 403);

    await query(
      `UPDATE agent_graph.scheduled_services
       SET is_paused = true, paused_by = $2, paused_at = now()
       WHERE name = $1`,
      [name, boardUser]
    );

    return { ok: true, name, paused: true };
  });

  // POST /api/services/:name/resume — board only
  routes.set('POST /api/services/:name/resume', async (req) => {
    if (!req.auth || req.auth.role !== 'board') {
      throw httpError('Board authentication required', 401);
    }

    const name = extractName(req.url);
    if (!name) throw httpError('Missing service name', 400);

    const svc = await query(
      `SELECT 1 FROM agent_graph.scheduled_services WHERE name = $1`,
      [name]
    );
    if (svc.rows.length === 0) throw httpError('Service not found', 404);

    await query(
      `UPDATE agent_graph.scheduled_services
       SET is_paused = false, paused_by = NULL, paused_at = NULL
       WHERE name = $1`,
      [name]
    );

    return { ok: true, name, paused: false };
  });

  // POST /api/services/:name/trigger — board only, rejects critical
  routes.set('POST /api/services/:name/trigger', async (req) => {
    if (!req.auth || req.auth.role !== 'board') {
      throw httpError('Board authentication required', 401);
    }

    const name = extractName(req.url);
    if (!name) throw httpError('Missing service name', 400);

    const svc = await query(
      `SELECT is_critical FROM agent_graph.scheduled_services WHERE name = $1`,
      [name]
    );
    if (svc.rows.length === 0) throw httpError('Service not found', 404);
    if (svc.rows[0].is_critical) throw httpError('Cannot manually trigger critical service', 403);

    const scheduler = getSchedulerInstance();
    if (!scheduler) throw httpError('Scheduler not initialized', 503);

    const triggered = await scheduler.trigger(name);
    if (!triggered) throw httpError('Service not found in scheduler', 404);

    return { ok: true, name, triggered: true };
  });
}
