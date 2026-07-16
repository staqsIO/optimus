/**
 * Board Build API — allows board members to submit arbitrary tasks
 * directly into the Orchestrator pipeline from the Board Workstation.
 *
 * POST /api/board/build — creates a work_item with metadata.source='board_build'
 *   that the Orchestrator claims and routes through the agent pipeline.
 *
 * GET /api/board/build/:id — returns the work_item status + child tasks
 *
 * Design: P6 (familiar interfaces for humans), P3 (transparency by structure).
 */

import { query, withBoardScope } from '../db.js';
import { createWorkItem } from '../runtime/state-machine.js';
import { publishEvent } from '../runtime/infrastructure.js';

export function registerBoardRoutes(routes) {
  // POST /api/board/build — submit a task to the Orchestrator pipeline
  routes.set('POST /api/board/build', async (_req, body) => {
    const { prompt, title, assignTo, context } = body || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return { error: 'prompt is required', status: 400 };
    }

    if (prompt.length > 50000) {
      return { error: 'prompt exceeds 50KB limit', status: 400 };
    }

    const taskTitle = title || prompt.slice(0, 120);

    const workItem = await createWorkItem({
      type: 'task',
      title: taskTitle,
      description: prompt,
      createdBy: 'board',
      assignedTo: assignTo || 'orchestrator', // orchestrator claims and routes
      priority: 50, // board tasks get mid-high priority
      metadata: {
        source: 'board_build',
        context: context || null,
        submitted_at: new Date().toISOString(),
      },
    });

    // Publish event to wake the orchestrator
    publishEvent(
      'board_task_submitted',
      `Board build task: ${taskTitle.slice(0, 80)}`,
      'board',
      workItem.id,
      { source: 'board_build' }
    ).catch(() => {});

    console.log(`[board] Build task created: ${workItem.id} — "${taskTitle.slice(0, 80)}"`);

    return {
      work_item_id: workItem.id,
      title: taskTitle,
      status: 'created',
    };
  });

  // GET /api/board/build/:id — track a submitted build task
  routes.set('GET /api/board/build', async (req, _body) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (!id) {
      return { error: 'id query parameter is required', status: 400 };
    }

    // OPT-166 P3: route tier is AUTHED_ANY — non-board principals keep the
    // legacy pool (INERT pre-flip; RLS fail-closed post-flip). Board principals
    // (incl. legacy api_secret, which resolves to role 'board') get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    try {
      // Get the work item + any child tasks
      const result = await scopedQuery(
        `SELECT w.id, w.title, w.status, w.assigned_to, w.metadata,
                w.created_at, w.updated_at
         FROM agent_graph.work_items w
         WHERE w.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return { error: 'Work item not found', status: 404 };
      }

      const item = result.rows[0];

      // Get child tasks (subtasks created by orchestrator routing)
      const children = await scopedQuery(
        `SELECT id, title, type, status, assigned_to,
                created_at, updated_at
         FROM agent_graph.work_items
         WHERE parent_id = $1
         ORDER BY created_at ASC`,
        [id]
      );

      // Get activity steps for this task
      const steps = await scopedQuery(
        `SELECT id, description, step_type, status, metadata,
                created_at, completed_at
         FROM agent_graph.agent_activity_steps
         WHERE work_item_id = $1
         ORDER BY created_at ASC
         LIMIT 50`,
        [id]
      );

      return {
        ...item,
        children: children.rows,
        activity_steps: steps.rows,
      };
    } finally {
      if (boardScope) await boardScope.release();
    }
  });
}
