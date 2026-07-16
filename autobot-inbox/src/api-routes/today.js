/**
 * /api/today — operator-scoped task feeds for the /today page.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   FR-34 (My Tasks), FR-35 (Today in Linear), FR-36 (Quick Wins).
 *
 * Two endpoints:
 *   GET /api/today/tasks  — DB-driven My Tasks + Quick Wins for the operator.
 *   GET /api/today/linear — Live Linear pull of issues assigned to the
 *                           operator that have NO matching human_tasks row
 *                           (i.e. not Optimus-originated). Read-only.
 *
 * The handlers are pure functions of (req, body) so unit tests can build
 * mockReq() objects directly. The Linear client is resolved at the route
 * boundary via an optional getLinearClient injection — defaults to null so
 * /api/today/tasks works in tests/dev without LINEAR_API_KEY.
 */

import { withBoardScope } from '../db.js';

// ---- Constants ------------------------------------------------------------

const MY_TASKS_LIMIT = 8;
const QUICK_WINS_LIMIT = 5;
const QUICK_WIN_SIZES = ['quick', 'small'];

const TASK_COLUMNS = [
  'id', 'signal_id', 'message_id', 'source_quote',
  'title', 'description', 'due_date', 'priority', 'size',
  'assignee_contact_id', 'assignee_label', 'assignee_confidence',
  'status', 'snoozed_until',
  'task_type', 'project_id', 'engagement_id', 'tags',
  'next_action_hint', 'related_contact_ids',
  'relevance_score', 'extraction_confidence',
  'linear_issue_id', 'linear_issue_url',
  'last_feedback', 'last_feedback_at',
  'created_at', 'updated_at',
].join(', ');

// ---- Helpers --------------------------------------------------------------

function requireBoard(req) {
  if (!req?.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

function urlSearch(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

/**
 * Resolve the operator's contact id. Per FR-34 we want "the logged-in user".
 * Three sources, in order of preference:
 *   1. `?assignee=<contact_id>` — explicit override (used by tests + the
 *      board's `?as=` operator-switching).
 *   2. `req.auth.github_username` — board JWT identity.
 *   3. `req.auth.sub` — agent-JWT fallback.
 * Returns null when no identity is available (the handler falls back to
 * the unassigned-quick-wins path).
 */
function resolveOperatorId(req) {
  const params = urlSearch(req);
  const explicit = params.get('assignee');
  if (explicit) return explicit;
  return req.auth?.github_username || req.auth?.sub || null;
}

// ===========================================================================
// GET /api/today/tasks
// ===========================================================================
//
// Returns { my_tasks: [...], quick_wins: [...] }.
//
// My Tasks (FR-34): assignee = operator, non-terminal, ordered:
//   1. overdue → due today → later
//   2. priority desc (urgent > high > normal > low)
//   3. in_progress first within same priority
//   4. created_at asc (older first)
// Capped at 8.
//
// Quick Wins (FR-36): size IN (quick,small), non-terminal,
//   (assignee = me OR (unassigned AND relevance >= 0.6)).
//   Ordered by priority desc, due_date asc nulls last, created_at desc.
// Capped at 5.
//
// Both lists are server-sorted so the board doesn't have to re-sort.

export async function getTodayTasks(req) {
  requireBoard(req);
  const operatorId = resolveOperatorId(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT —
  // board-caller behavior is unchanged (same rows, scoped connection), and
  // no other principal ever reaches this line today.
  const scopedQuery = await withBoardScope(req.auth);
  try {
    // My Tasks — assignee filter is required (returns [] when no operator).
    let myTasks = [];
    if (operatorId) {
      const r = await scopedQuery(
        `SELECT ${TASK_COLUMNS}
           FROM inbox.human_tasks
          WHERE deleted_at IS NULL
            AND assignee_contact_id = $1
            AND status NOT IN ('done', 'skipped', 'not_for_us')
          ORDER BY
            CASE
              WHEN due_date IS NULL THEN 2
              WHEN due_date < CURRENT_DATE THEN 0
              WHEN due_date = CURRENT_DATE THEN 1
              ELSE 2
            END,
            CASE priority
              WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
              WHEN 'normal' THEN 2 WHEN 'low' THEN 3
              ELSE 4
            END,
            CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
            created_at ASC
          LIMIT $2`,
        [operatorId, MY_TASKS_LIMIT],
      );
      myTasks = r.rows;
    }

    // Quick Wins — assignee = me OR unassigned + relevance >= 0.6.
    const quickWinParams = [QUICK_WIN_SIZES, QUICK_WINS_LIMIT];
    let assigneePredicate;
    if (operatorId) {
      quickWinParams.push(operatorId);
      assigneePredicate = `(assignee_contact_id = $3 OR (assignee_contact_id IS NULL AND COALESCE(relevance_score, 0) >= 0.6))`;
    } else {
      assigneePredicate = `(assignee_contact_id IS NULL AND COALESCE(relevance_score, 0) >= 0.6)`;
    }
    const quickWinsRes = await scopedQuery(
      `SELECT ${TASK_COLUMNS}
         FROM inbox.human_tasks
        WHERE deleted_at IS NULL
          AND size = ANY($1::text[])
          AND status NOT IN ('done', 'skipped', 'not_for_us')
          AND ${assigneePredicate}
        ORDER BY
          CASE priority
            WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
            WHEN 'normal' THEN 2 WHEN 'low' THEN 3
            ELSE 4
          END,
          due_date ASC NULLS LAST,
          created_at DESC
        LIMIT $2`,
      quickWinParams,
    );

    return { my_tasks: myTasks, quick_wins: quickWinsRes.rows };
  } finally {
    await scopedQuery.release();
  }
}

// ===========================================================================
// GET /api/today/linear
// ===========================================================================
//
// Read-only live Linear pull. Returns `[{identifier, title, url, state,
// priority, dueDate}, ...]` filtered to:
//   - assignee = operator
//   - NOT in inbox.human_tasks.linear_issue_id (Optimus-originated rows are
//     surfaced via /api/today/tasks)
//
// The linearClient is injected via a factory at registration time. When
// LINEAR_API_KEY isn't configured (tests, dev), the handler returns [].

export function makeGetTodayLinear({ getLinearClient } = {}) {
  return async function getTodayLinear(req) {
    requireBoard(req);
    const operatorId = resolveOperatorId(req);
    if (!operatorId) return [];

    const client = typeof getLinearClient === 'function' ? getLinearClient() : null;
    if (!client || typeof client.fetchIssues !== 'function') {
      // No Linear client configured — return empty (NFR-15 backwards-compat:
      // /today must not break when Linear isn't wired in).
      return [];
    }

    let issues;
    try {
      issues = await client.fetchIssues({ assigneeId: operatorId });
    } catch (err) {
      // Read-only path — degrade to empty rather than 500. The operator's
      // My Tasks + Quick Wins still render.
      const e = new Error(`Linear fetch failed: ${err.message}`);
      e.statusCode = 502;
      throw e;
    }

    // Filter out Optimus-originated issues (those already mirrored in
    // inbox.human_tasks). One id list, one SELECT. Cheap.
    const issueIds = (issues || [])
      .map((i) => i && i.id)
      .filter((id) => typeof id === 'string');
    if (issueIds.length === 0) return [];

    // OPT-166 P3-B4: requireBoard() above already throws for any non-board
    // caller, so opening the scoped session here is INERT.
    const scopedQuery = await withBoardScope(req.auth);
    let optimusOwned;
    try {
      const r = await scopedQuery(
        `SELECT linear_issue_id
           FROM inbox.human_tasks
          WHERE linear_issue_id = ANY($1::text[])
            AND deleted_at IS NULL`,
        [issueIds],
      );
      optimusOwned = new Set(r.rows.map((row) => row.linear_issue_id));
    } finally {
      await scopedQuery.release();
    }

    return (issues || [])
      .filter((i) => i && typeof i.id === 'string' && !optimusOwned.has(i.id))
      .map((i) => ({
        identifier: i.identifier ?? null,
        title:      i.title ?? null,
        url:        i.url ?? null,
        state:      i.state ?? i.stateName ?? null,
        priority:   i.priority ?? null,
        dueDate:    i.dueDate ?? null,
      }));
  };
}

// ---- Route registration ---------------------------------------------------

export function registerTodayRoutes(routes, { getLinearClient } = {}) {
  routes.set('GET /api/today/tasks', getTodayTasks);
  routes.set('GET /api/today/linear', makeGetTodayLinear({ getLinearClient }));
}
