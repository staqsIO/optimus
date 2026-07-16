/**
 * Issue Triage API routes.
 *
 * GET  /api/triage          — paginated triage log
 * GET  /api/triage/stats    — summary counts by decision
 * POST /api/triage/override — board overrides a triage decision
 */

import { query } from '../db.js';

export function registerTriageRoutes(routes) {

  // GET /api/triage — paginated triage log
  routes.set('GET /api/triage', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const decision = url.searchParams.get('decision'); // filter by decision type

    let sql = `SELECT * FROM agent_graph.issue_triage_log`;
    const params = [];

    if (decision && ['auto_assigned', 'needs_clarification', 'board_review', 'skipped'].includes(decision)) {
      params.push(decision);
      sql += ` WHERE decision = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    const countSql = decision
      ? `SELECT count(*) FROM agent_graph.issue_triage_log WHERE decision = $1`
      : `SELECT count(*) FROM agent_graph.issue_triage_log`;
    const countResult = await query(countSql, decision ? [decision] : []);

    return {
      entries: result.rows,
      total: parseInt(countResult.rows[0]?.count || '0'),
      limit,
      offset,
    };
  });

  // GET /api/triage/stats — counts by decision type
  routes.set('GET /api/triage/stats', async () => {
    const result = await query(`
      SELECT decision, count(*) AS count,
             max(created_at) AS last_triaged
      FROM agent_graph.issue_triage_log
      GROUP BY decision
    `);

    const total = await query(`SELECT count(*) FROM agent_graph.issue_triage_log`);
    const today = await query(`
      SELECT count(*) FROM agent_graph.issue_triage_log
      WHERE created_at > now() - interval '24 hours'
    `);

    return {
      byDecision: Object.fromEntries(
        result.rows.map(r => [r.decision, { count: parseInt(r.count), lastTriaged: r.last_triaged }])
      ),
      total: parseInt(total.rows[0]?.count || '0'),
      last24h: parseInt(today.rows[0]?.count || '0'),
    };
  });

  // POST /api/triage/override — board overrides a triage decision
  routes.set('POST /api/triage/override', async (req, body) => {
    if (!body?.id || !body?.decision) {
      const e = new Error('id and decision required');
      e.statusCode = 400;
      throw e;
    }

    const validDecisions = ['auto_assigned', 'skipped'];
    if (!validDecisions.includes(body.decision)) {
      const e = new Error(`decision must be one of: ${validDecisions.join(', ')}`);
      e.statusCode = 400;
      throw e;
    }

    const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'unknown';

    // Fetch the triage entry
    const entry = await query(
      `SELECT * FROM agent_graph.issue_triage_log WHERE id = $1`, [body.id]
    );
    if (entry.rows.length === 0) {
      const e = new Error('Triage entry not found');
      e.statusCode = 404;
      throw e;
    }

    const row = entry.rows[0];

    // If overriding to auto_assigned, create a campaign
    if (body.decision === 'auto_assigned' && row.decision !== 'auto_assigned') {
      const { autoAssignIssue } = await import('../../../agents/issue-triage/auto-assigner.js');
      const issue = {
        source: row.source,
        sourceIssueId: row.source_issue_id,
        sourceIssueUrl: row.source_issue_url,
        title: row.title,
        description: row.raw_issue?.description || row.title,
        priority: 3,
      };
      const evaluation = {
        campaign_mode: 'workshop',
        scope_estimate: row.scope_estimate || 'M',
        target_repo: row.target_repos?.[0] || null,
        playbook_id: row.playbook_id,
        classification: row.classification,
        reasoning: `Board override by ${boardUser}`,
      };
      await autoAssignIssue(issue, evaluation, body.id);
    }

    // Update the triage log
    await query(
      `UPDATE agent_graph.issue_triage_log
       SET decision = $1, decision_overridden_by = $2, decision_overridden_at = now()
       WHERE id = $3`,
      [body.decision, boardUser, body.id]
    );

    return { ok: true, decision: body.decision, overriddenBy: boardUser };
  });
}
