import { getGateStatus, measureAllGates, getPhaseTransitionReadiness } from '../runtime/capability-gates.js';

/**
 * Capability Gates API routes.
 *
 * Follows the same pattern as api.js: exports a function that registers
 * route handlers on the provided routes Map.
 *
 * GET /api/gates         — current status of all capability gates
 * GET /api/gates/measure — trigger a fresh measurement of all gates
 * GET /api/gates/readiness — Phase 2 -> 3 transition readiness check
 */
export function registerGateRoutes(routes) {
  // GET /api/gates — current status of all capability gates
  routes.set('GET /api/gates', async () => {
    const status = await getGateStatus();
    const total = Object.keys(status).length;
    const passingCount = Object.values(status).filter(g => g.passing === true).length;

    return {
      gates: status,
      summary: {
        passing: passingCount,
        total,
        allPassing: passingCount === total,
      },
    };
  });

  // GET /api/gates/measure — trigger fresh measurement of all gates
  routes.set('GET /api/gates/measure', async () => {
    const result = await measureAllGates();
    return result;
  });

  // GET /api/gates/readiness — Phase 2 -> 3 transition readiness
  routes.set('GET /api/gates/readiness', async () => {
    const readiness = await getPhaseTransitionReadiness();
    return readiness;
  });
}
