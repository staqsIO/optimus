import { getFinancialSummary, generateCostDigest, checkDistributionGate, getFinancialMode } from '../finance/financial-script.js';

/**
 * Financial API routes.
 *
 * GET /api/finance/summary           — current financial summary
 * GET /api/finance/cost-digest       — generated cost digest report
 * GET /api/finance/distribution-gate — distribution gate check
 * GET /api/finance/mode              — current financial mode
 */
export function registerFinanceRoutes(routes) {
  // GET /api/finance/summary — current financial summary
  routes.set('GET /api/finance/summary', async () => {
    const summary = await getFinancialSummary();
    return { summary };
  });

  // GET /api/finance/cost-digest — generated cost digest report
  routes.set('GET /api/finance/cost-digest', async () => {
    const digest = await generateCostDigest();
    return { digest };
  });

  // GET /api/finance/distribution-gate — distribution gate check
  routes.set('GET /api/finance/distribution-gate', async () => {
    const gate = await checkDistributionGate();
    return { gate };
  });

  // GET /api/finance/mode — current financial mode
  routes.set('GET /api/finance/mode', async () => {
    const mode = await getFinancialMode();
    return { mode };
  });
}
