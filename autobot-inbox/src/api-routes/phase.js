import { getCurrentPhase, getPhaseConfig, activatePhase } from '../runtime/phase-manager.js';
import { getDeadManSwitchStatus, renewDeadManSwitch } from '../runtime/dead-man-switch.js';
import { getExplorationReport } from '../runtime/exploration-monitor.js';

/**
 * Phase management API routes.
 *
 * GET  /api/phase/current                — current phase info
 * GET  /api/phase/config?phase=N         — configuration for a specific phase
 * POST /api/phase/activate               — activate a phase (body: {phase, activatedBy})
 * GET  /api/phase/dead-man-switch        — dead-man switch status
 * POST /api/phase/dead-man-switch/renew  — renew dead-man switch (body: {renewedBy})
 * GET  /api/phase/exploration            — exploration ratio report
 */
export function registerPhaseRoutes(routes) {
  // GET /api/phase/current — current phase info
  routes.set('GET /api/phase/current', async () => {
    const phase = await getCurrentPhase();
    return { phase };
  });

  // GET /api/phase/config — configuration for a specific phase
  routes.set('GET /api/phase/config', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const phaseParam = url.searchParams.get('phase');
    if (!phaseParam) return { error: 'Missing ?phase=N parameter' };
    const phaseNumber = parseInt(phaseParam, 10);
    if (isNaN(phaseNumber)) return { error: 'phase must be a number' };
    const config = await getPhaseConfig(phaseNumber);
    return { config };
  });

  // POST /api/phase/activate — activate a phase
  routes.set('POST /api/phase/activate', async (_req, body) => {
    const { phase, activatedBy } = body;
    if (phase == null || !activatedBy) return { error: 'Missing required fields: phase, activatedBy' };
    const phaseNumber = parseInt(phase, 10);
    if (isNaN(phaseNumber)) return { error: 'phase must be a number' };
    const result = await activatePhase(phaseNumber, activatedBy);
    return { result };
  });

  // GET /api/phase/dead-man-switch — dead-man switch status
  routes.set('GET /api/phase/dead-man-switch', async () => {
    const status = await getDeadManSwitchStatus();
    return { status };
  });

  // POST /api/phase/dead-man-switch/renew — renew dead-man switch
  routes.set('POST /api/phase/dead-man-switch/renew', async (_req, body) => {
    const { renewedBy } = body;
    if (!renewedBy) return { error: 'Missing required field: renewedBy' };
    const result = await renewDeadManSwitch(renewedBy);
    return { result };
  });

  // GET /api/phase/exploration — exploration ratio report
  routes.set('GET /api/phase/exploration', async () => {
    const report = await getExplorationReport();
    return { report };
  });
}
