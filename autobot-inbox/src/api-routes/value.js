import { getValueDashboard, checkLaw1Compliance } from '../value/value-measurement.js';

/**
 * Value measurement API routes.
 *
 * GET /api/value/dashboard  — value measurement dashboard
 * GET /api/value/compliance — Law 1 compliance check
 */
export function registerValueRoutes(routes) {
  // GET /api/value/dashboard — value measurement dashboard
  routes.set('GET /api/value/dashboard', async () => {
    const dashboard = await getValueDashboard();
    return { dashboard };
  });

  // GET /api/value/compliance — Law 1 compliance check
  routes.set('GET /api/value/compliance', async () => {
    const compliance = await checkLaw1Compliance();
    return { compliance };
  });
}
