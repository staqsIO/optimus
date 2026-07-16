/**
 * Preferences API — per-user dashboard preferences.
 *
 * GET  /api/preferences   — returns preferences for authenticated board member
 * POST /api/preferences   — upserts preferences JSONB for authenticated board member
 */

import { query } from '../db.js';

function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

export function registerPreferencesRoutes(routes) {
  // GET /api/preferences — fetch preferences for current user
  routes.set('GET /api/preferences', async (req) => {
    requireBoard(req);

    const username = req.auth.github_username;
    if (!username) return { preferences: {} };

    const result = await query(
      `SELECT up.preferences
       FROM agent_graph.user_preferences up
       JOIN agent_graph.board_members bm ON bm.id = up.board_member_id
       WHERE bm.github_username = $1 AND bm.is_active = true
       LIMIT 1`,
      [username]
    );

    return { preferences: result.rows[0]?.preferences || {} };
  });

  // POST /api/preferences — upsert preferences for current user
  routes.set('POST /api/preferences', async (req, body) => {
    requireBoard(req);

    const username = req.auth.github_username;
    if (!username) {
      const e = new Error('Username required');
      e.statusCode = 400;
      throw e;
    }

    const preferences = body?.preferences;
    if (!preferences || typeof preferences !== 'object') {
      const e = new Error('preferences object required');
      e.statusCode = 400;
      throw e;
    }

    // Look up board member ID
    const memberResult = await query(
      `SELECT id FROM agent_graph.board_members WHERE github_username = $1 AND is_active = true LIMIT 1`,
      [username]
    );

    if (!memberResult.rows.length) {
      const e = new Error('Board member not found');
      e.statusCode = 404;
      throw e;
    }

    const memberId = memberResult.rows[0].id;

    // Upsert — merge new preferences with existing
    await query(
      `INSERT INTO agent_graph.user_preferences (board_member_id, preferences, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (board_member_id) DO UPDATE SET
         preferences = agent_graph.user_preferences.preferences || $2,
         updated_at = now()`,
      [memberId, JSON.stringify(preferences)]
    );

    return { ok: true };
  });
}
