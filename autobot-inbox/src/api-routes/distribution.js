import { getDistributionStatus, getDistributionHistory } from '../distrib/distribution-mechanism.js';

/**
 * Distribution API routes.
 *
 * GET /api/distribution/status  — current distribution status
 * GET /api/distribution/history — distribution history
 */
export function registerDistributionRoutes(routes) {
  // GET /api/distribution/status — current distribution status
  routes.set('GET /api/distribution/status', async () => {
    const status = await getDistributionStatus();
    return { status };
  });

  // GET /api/distribution/history — distribution history
  routes.set('GET /api/distribution/history', async () => {
    const history = await getDistributionHistory();
    return { history };
  });
}
