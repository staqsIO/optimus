import { query } from '../db.js';

/**
 * Spec Proposals API routes.
 *
 * GET  /api/spec-proposals          — list proposals (filter by ?status=pending)
 * GET  /api/spec-proposals/:id      — single proposal with revision chain
 * POST /api/spec-proposals          — create a new proposal (agent-facing)
 * POST /api/spec-proposals/:id      — update status / add board feedback
 */
export function registerSpecProposalRoutes(routes, _cachedQuery) {

  // GET /api/spec-proposals — list, optionally filtered by status
  routes.set('GET /api/spec-proposals', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    let sql, params;
    if (status) {
      sql = `
        SELECT id, agent_tier, agent_name, work_item_id, title, summary,
               sections, status, board_feedback, revision_of,
               created_at, reviewed_at, reviewed_by
        FROM agent_graph.spec_proposals
        WHERE status = $1
        ORDER BY created_at DESC
        LIMIT $2
      `;
      params = [status, limit];
    } else {
      sql = `
        SELECT id, agent_tier, agent_name, work_item_id, title, summary,
               sections, status, board_feedback, revision_of,
               created_at, reviewed_at, reviewed_by
        FROM agent_graph.spec_proposals
        ORDER BY created_at DESC
        LIMIT $1
      `;
      params = [limit];
    }

    const result = await query(sql, params);
    return { proposals: result.rows };
  });

  // GET /api/spec-proposals/:id — single proposal with transition history
  routes.set('GET /api/spec-proposals/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/').pop();

    const proposalResult = await query(
      `SELECT * FROM agent_graph.spec_proposals WHERE id = $1`,
      [id]
    );
    if (proposalResult.rows.length === 0) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }

    const transitionsResult = await query(
      `SELECT * FROM agent_graph.spec_proposal_transitions
       WHERE proposal_id = $1
       ORDER BY transitioned_at ASC`,
      [id]
    );

    // If this is a revision, also fetch the parent
    const proposal = proposalResult.rows[0];
    let parent = null;
    if (proposal.revision_of) {
      const parentResult = await query(
        `SELECT id, title, status, reviewed_at, reviewed_by
         FROM agent_graph.spec_proposals WHERE id = $1`,
        [proposal.revision_of]
      );
      parent = parentResult.rows[0] || null;
    }

    return {
      proposal,
      transitions: transitionsResult.rows,
      parent,
    };
  });

  // POST /api/spec-proposals — create a new proposal
  routes.set('POST /api/spec-proposals', async (_req, body) => {
    const { agent_tier, agent_name, work_item_id, title, summary, sections, revision_of } = body;

    if (!agent_tier || !title || !summary) {
      const err = new Error('agent_tier, title, and summary are required');
      err.statusCode = 400;
      throw err;
    }

    // Validate sections shape
    const sectionsJson = Array.isArray(sections) ? sections : [];
    for (const s of sectionsJson) {
      if (!s.sectionId || !s.proposedContent) {
        const err = new Error('Each section must have sectionId and proposedContent');
        err.statusCode = 400;
        throw err;
      }
    }

    // If this is a revision, mark the parent as superseded
    if (revision_of) {
      await query(
        `UPDATE agent_graph.spec_proposals SET status = 'superseded' WHERE id = $1 AND status = 'pending'`,
        [revision_of]
      );
    }

    const result = await query(
      `INSERT INTO agent_graph.spec_proposals
         (agent_tier, agent_name, work_item_id, title, summary, sections, revision_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [agent_tier, agent_name || null, work_item_id || null, title, summary, JSON.stringify(sectionsJson), revision_of || null]
    );

    const newId = result.rows[0].id;

    // Record transition
    await query(
      `INSERT INTO agent_graph.spec_proposal_transitions
         (proposal_id, from_status, to_status, actor)
       VALUES ($1, NULL, 'pending', $2)`,
      [newId, agent_name || agent_tier]
    );

    return { id: newId, created_at: result.rows[0].created_at };
  });

  // POST /api/spec-proposals/:id — update status (board review action)
  routes.set('POST /api/spec-proposals/:id', async (req, body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/').pop();
    const { status, board_feedback, reviewed_by } = body;

    const validStatuses = ['approved', 'rejected', 'revision-requested'];
    if (!status || !validStatuses.includes(status)) {
      const err = new Error(`status must be one of: ${validStatuses.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }

    // Fetch current state
    const current = await query(
      `SELECT id, status FROM agent_graph.spec_proposals WHERE id = $1`,
      [id]
    );
    if (current.rows.length === 0) {
      const err = new Error('Proposal not found');
      err.statusCode = 404;
      throw err;
    }

    const fromStatus = current.rows[0].status;
    if (fromStatus !== 'pending') {
      const err = new Error(`Cannot transition from '${fromStatus}' — only pending proposals can be reviewed`);
      err.statusCode = 409;
      throw err;
    }

    await query(
      `UPDATE agent_graph.spec_proposals
       SET status = $1, board_feedback = $2, reviewed_at = now(), reviewed_by = $3
       WHERE id = $4`,
      [status, board_feedback || null, reviewed_by || null, id]
    );

    // Record transition
    await query(
      `INSERT INTO agent_graph.spec_proposal_transitions
         (proposal_id, from_status, to_status, actor, feedback)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, fromStatus, status, reviewed_by || 'board', board_feedback || null]
    );

    return { id, status, reviewed_at: new Date().toISOString() };
  });
}
