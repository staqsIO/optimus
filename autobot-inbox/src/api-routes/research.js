import { query, withBoardScope } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { publishEvent } from '../runtime/infrastructure.js';

/**
 * Research API routes.
 *
 * POST /api/research         — submit a research analysis task
 * GET  /api/research?id=...  — poll for results
 *
 * The submit endpoint creates a work item assigned to executor-research.
 * The poll endpoint checks if the work item has completed and returns results.
 */
export function registerResearchRoutes(routes) {
  // POST /api/research — submit research content for analysis
  routes.set('POST /api/research', async (_req, body) => {
    const { content, type } = body || {};

    if (!content || typeof content !== 'string' || !content.trim()) {
      throw Object.assign(new Error('content is required'), { statusCode: 400 });
    }

    const researchType = type === 'url' ? 'url' : 'text';

    // Create a work item for the research agent
    const item = await createWorkItem({
      type: 'task',
      title: researchType === 'url'
        ? `Research: ${content.trim().slice(0, 100)}`
        : `Research: ${content.trim().slice(0, 60)}...`,
      description: 'Analyze external research against SPEC.md and produce gap analysis.',
      createdBy: 'board',
      assignedTo: 'executor-research',
      priority: 2,
      routingClass: 'FULL',
      metadata: {
        research_content: content.trim(),
        research_type: researchType,
        source: 'board_workstation',
      },
    });

    // Log event for governance feed visibility
    await publishEvent(
      'board_directive',
      `Research submitted: ${researchType === 'url' ? content.trim().slice(0, 80) : 'text content'}`,
      null,
      item.id,
      { source: 'research', research_type: researchType },
    );

    return { ok: true, id: item.id };
  });

  // GET /api/research?id=... — poll for results
  routes.set('GET /api/research', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (!id) {
      throw Object.assign(new Error('id query parameter is required'), { statusCode: 400 });
    }

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(
        `SELECT status, metadata FROM agent_graph.work_items WHERE id = $1`,
        [id]
      );
    } finally {
      if (boardScope) await boardScope.release();
    }

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Research task not found'), { statusCode: 404 });
    }

    const row = result.rows[0];
    const metadata = row.metadata || {};

    // Check for error result
    if (metadata.research_result?.error) {
      return {
        status: 'failed',
        error: metadata.research_result.error,
      };
    }

    // Task completed with results
    if (row.status === 'completed' && metadata.research_result) {
      return {
        status: 'completed',
        result: metadata.research_result,
      };
    }

    // Task failed without specific error
    if (row.status === 'failed' || row.status === 'timed_out') {
      return {
        status: 'failed',
        error: 'Research analysis failed. The agent may have encountered an error.',
      };
    }

    // Still processing
    return {
      status: 'processing',
    };
  });
}
