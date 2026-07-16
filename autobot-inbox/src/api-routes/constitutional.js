import { getEnforcementMode } from '../runtime/constitutional-engine.js';
import { query } from '../db.js';

/**
 * Constitutional engine API routes.
 *
 * GET /api/constitutional/mode           — current enforcement mode
 * GET /api/constitutional/evaluations    — recent constitutional evaluations from DB
 * GET /api/constitutional/interventions  — recent board interventions from DB
 */
export function registerConstitutionalRoutes(routes) {
  // GET /api/constitutional/mode — current enforcement mode
  routes.set('GET /api/constitutional/mode', async () => {
    const mode = await getEnforcementMode();
    return { mode };
  });

  // GET /api/constitutional/evaluations — recent constitutional evaluations
  routes.set('GET /api/constitutional/evaluations', async () => {
    try {
      const result = await query(
        `SELECT * FROM agent_graph.constitutional_evaluations
         ORDER BY created_at DESC
         LIMIT 50`
      );
      return { evaluations: result.rows };
    } catch (err) {
      if (err.message?.includes('does not exist')) return { evaluations: [], note: 'Table not yet created' };
      throw err;
    }
  });

  // GET /api/constitutional/interventions — recent board interventions
  routes.set('GET /api/constitutional/interventions', async () => {
    try {
      const result = await query(
        `SELECT * FROM agent_graph.board_interventions
         ORDER BY created_at DESC
         LIMIT 50`
      );
      return { interventions: result.rows };
    } catch (err) {
      if (err.message?.includes('does not exist')) return { interventions: [], note: 'Table not yet created' };
      throw err;
    }
  });
}
