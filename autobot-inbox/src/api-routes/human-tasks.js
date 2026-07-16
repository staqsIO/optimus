/**
 * /api/human-tasks — list, action, inline-answer, lifecycle, patch fields.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban.md §7 (UX) and §11 (API).
 * Tech spec: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   FR-3, FR-18, FR-27, FR-28, FR-29 — lifecycle + sticky-aware PATCH.
 *
 * Style mirrors src/api-routes/board.js: pure handler functions exported
 * for unit-test isolation; route registration via registerHumanTaskRoutes
 * for production wiring in src/api.js.
 */

import { withBoardScope } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

// ---- Constants ------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['done', 'skipped', 'not_for_us']);
const VALID_STATUSES = new Set([
  'inbox', 'proposed', 'todo', 'in_progress', 'blocked',
  'later', 'review', 'done', 'skipped', 'not_for_us',
]);
const VALID_VERBS = new Set(['done', 'skip', 'later', 'not_for_me']);
const VERB_TO_STATUS = {
  done: 'done',
  skip: 'skipped',
  later: 'later',
  not_for_me: 'not_for_us',
};
const VERB_TO_FEEDBACK = {
  done: 'done',
  skip: 'skip',
  later: 'later',
  not_for_me: 'not_for_me',
};
const VALID_SIZE = new Set(['quick', 'small', 'medium', 'large']);
const VALID_PRIORITY = new Set(['urgent', 'high', 'normal', 'low']);
const DEFAULT_SNOOZE_DAYS = 7;

/**
 * Canonical lifecycle transitions per the tech-spec §1 "Lifecycle transition
 * table" near FR-27. `proposed` rows must answer `is_this_ours` via the
 * inline-answer endpoint first — they have no lifecycle verbs. Terminal rows
 * (`done`, `skipped`, `not_for_us`) have no transitions and reject 409.
 */
const TRANSITIONS = {
  inbox:       { start: 'todo',         to_in_progress: 'in_progress' },
  todo:        { start: 'in_progress',  to_inbox: 'inbox' },
  later:       { start: 'in_progress',  to_inbox: 'inbox' },
  in_progress: { block: 'blocked',      to_review: 'review', to_todo: 'todo' },
  blocked:     { unblock: 'in_progress', to_todo: 'todo' },
  review:      { to_in_progress: 'in_progress' },
  // proposed: no lifecycle verbs — must answer is_this_ours first.
  // terminal (done/skipped/not_for_us): no transitions.
};

/**
 * Allow-list of fields editable via PATCH /api/human-tasks/:id/fields.
 * Per FR-18: status is owned by the lifecycle endpoint, provenance and
 * scoring fields (linear_*, relevance_score, extraction_confidence,
 * signal_id) are system-owned and never operator-editable.
 */
const PATCHABLE_FIELDS = new Set([
  'title', 'description', 'due_date', 'priority', 'size', 'tags',
  'project_id', 'engagement_id', 'next_action_hint', 'assignee_contact_id',
]);

// ---- Helpers --------------------------------------------------------------

function requireBoard(req) {
  if (!req?.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function notFound(msg = 'not found') {
  const e = new Error(msg);
  e.statusCode = 404;
  return e;
}
function conflict(msg) {
  const e = new Error(msg);
  e.statusCode = 409;
  return e;
}

function actorOf(req) {
  return req.auth?.github_username || req.auth?.sub || 'unknown';
}

function urlPath(req) {
  return new URL(req.url, 'http://localhost').pathname;
}

function urlSearch(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

/** Match `/api/human-tasks/:id/<tail>`. */
function parseHumanTaskId(req, tail) {
  const re = new RegExp(`^/api/human-tasks/([^/]+)/${tail}$`);
  const m = urlPath(req).match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

// ---- GET /api/human-tasks -------------------------------------------------

const LIST_COLUMNS = [
  'id', 'signal_id', 'message_id', 'source_quote', 'source_ts',
  'title', 'description', 'due_date', 'priority', 'size',
  'assignee_contact_id', 'assignee_label', 'assignee_confidence',
  'status', 'snoozed_until',
  'task_type', 'project_id', 'engagement_id', 'tags',
  'next_action_hint', 'related_contact_ids',
  'relevance_score', 'extraction_confidence',
  'last_feedback', 'last_feedback_at',
  'created_at', 'updated_at',
  // STAQPRO-619-A: Linear-origin provenance so the kanban can render an
  // origin:'linear' badge + deep-link for imported Linear-native cards.
  'linear_issue_id', 'linear_issue_url', 'linear_state_name', 'origin',
].join(', ');

const VALID_SIZE_FILTER = VALID_SIZE;
const VALID_PUSH_STATUS = new Set([
  'pending', 'running', 'succeeded', 'skipped', 'failed',
]);

export async function listHumanTasks(req, principal = null) {
  requireBoard(req);
  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {
  const params = urlSearch(req);
  const status = params.get('status');
  const assignee = params.get('assignee');
  const project = params.get('project');
  const size = params.get('size');
  const signalMeetingId = params.get('signal_meeting_id');
  const pushStatus = params.get('push_status');

  const where = ['deleted_at IS NULL'];
  const args = [];

  // STAQPRO-608 (596-class): inbox.human_tasks carries owner_org_id (migration
  // 134). Scope fail-closed so one org's tasks never enumerate to another. The
  // principal is injected by registerHumanTaskRoutes via withViewer; when this
  // function is called directly (unit tests) principal is null → visibleClause
  // emits FALSE → zero rows, never an unscoped read.
  const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: args.length + 1 });
  where.push(v.sql);
  args.push(...v.params);

  if (status) {
    if (!VALID_STATUSES.has(status)) {
      throw badRequest(`Unknown status: ${status}`);
    }
    args.push(status);
    where.push(`status = $${args.length}`);
  } else {
    // Default: hide terminal rows. Pass ?status=skipped|done|not_for_us
    // to opt back in.
    where.push(`status NOT IN ('skipped', 'not_for_us', 'done')`);
  }
  if (assignee) {
    args.push(assignee);
    where.push(`assignee_contact_id = $${args.length}`);
  }
  if (project) {
    args.push(project);
    where.push(`project_id = $${args.length}`);
  }
  if (size) {
    if (!VALID_SIZE_FILTER.has(size)) {
      throw badRequest(`Unknown size: ${size}`);
    }
    args.push(size);
    where.push(`size = $${args.length}`);
  }
  if (signalMeetingId) {
    // Provenance: signal_id is the meeting-signal FK on inbox.human_tasks
    // (see migration 119). The board calls this filter "signal_meeting_id"
    // because that's the operator-facing concept. Same column on disk.
    args.push(signalMeetingId);
    where.push(`signal_id = $${args.length}`);
  }
  if (pushStatus) {
    if (!VALID_PUSH_STATUS.has(pushStatus)) {
      throw badRequest(`Unknown push_status: ${pushStatus}`);
    }
    args.push(pushStatus);
    where.push(`push_status = $${args.length}`);
  }

  const sql = `
    SELECT ${LIST_COLUMNS}
      FROM inbox.human_tasks
     WHERE ${where.join(' AND ')}
     ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                     WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
       due_date NULLS LAST,
       created_at DESC
     LIMIT 200
  `;
  const r = await scopedQuery(sql, args);
  return { tasks: r.rows };
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/action -------------------------------------

export async function actHumanTask(req, body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'action');
  if (!id) throw badRequest('Invalid id');

  const verb = body?.verb;
  if (!VALID_VERBS.has(verb)) {
    throw badRequest(`Unknown verb: ${verb}`);
  }

  const existing = await scopedQuery(
    `SELECT id, status, feedback_history FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');
  const cur = existing.rows[0];
  if (TERMINAL_STATUSES.has(cur.status)) {
    throw conflict(`Task already terminal (${cur.status})`);
  }

  const newStatus = VERB_TO_STATUS[verb];
  const feedback = VERB_TO_FEEDBACK[verb];
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : null;

  // 'later' snooze: ISO date passed in body.until, else default ~7 days.
  let snoozedUntil = null;
  if (verb === 'later') {
    if (body.until) {
      const d = new Date(body.until);
      if (Number.isNaN(d.getTime())) {
        throw badRequest('Invalid `until` date');
      }
      snoozedUntil = d.toISOString();
    } else {
      snoozedUntil = new Date(
        Date.now() + DEFAULT_SNOOZE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
  }

  const entry = {
    verb,
    reason,
    by: actorOf(req),
    at: new Date().toISOString(),
  };

  const updated = await scopedQuery(
    `UPDATE inbox.human_tasks
        SET status = $2,
            snoozed_until = COALESCE($3::timestamptz, snoozed_until),
            last_feedback = $4,
            last_feedback_at = now(),
            feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                               || $5::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id, status, last_feedback, snoozed_until`,
    [id, newStatus, snoozedUntil, feedback, JSON.stringify(entry)],
  );

  return {
    ok: true,
    id,
    status: updated.rows[0].status,
    last_feedback: updated.rows[0].last_feedback,
    snoozed_until: updated.rows[0].snoozed_until,
  };
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/inline-answer ------------------------------

const INLINE_FIELDS = new Set(['assignee', 'size', 'is_this_ours', 'when']);

/**
 * Build a feedback_history `edited` entry. Every edit must carry
 * `verb: 'edited'` so getStickyFields() (FR-3, AD-5) can mark the field
 * as operator-owned and skip it on re-enrichment.
 */
function editedEntry(field, value, req, extras = {}) {
  return {
    verb: 'edited',
    field,
    value,
    by: actorOf(req),
    at: new Date().toISOString(),
    ...extras,
  };
}

export async function inlineAnswerHumanTask(req, body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'inline-answer');
  if (!id) throw badRequest('Invalid id');

  const field = body?.field;
  if (!INLINE_FIELDS.has(field)) {
    throw badRequest(`Unknown field: ${field}`);
  }
  const value = body?.value;

  const existing = await scopedQuery(
    `SELECT id, status FROM inbox.human_tasks WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');
  // Terminal rows are immutable — match the action handler's invariant.
  if (TERMINAL_STATUSES.has(existing.rows[0].status)) {
    throw conflict(`Task already terminal (${existing.rows[0].status})`);
  }

  switch (field) {
    case 'assignee': {
      if (!value || typeof value !== 'string') {
        throw badRequest('assignee requires { value: <contact_id> }');
      }
      const label = typeof body.label === 'string' ? body.label : null;
      const entry = editedEntry('assignee', value, req, label ? { label } : {});
      await scopedQuery(
        `UPDATE inbox.human_tasks
            SET assignee_contact_id = $2,
                assignee_label      = COALESCE($3, assignee_label),
                assignee_confidence = 1,
                last_feedback       = 'edited',
                last_feedback_at    = now(),
                feedback_history    = COALESCE(feedback_history, '[]'::jsonb)
                                      || $4::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [id, value, label, JSON.stringify(entry)],
      );
      return { ok: true, id, field };
    }

    case 'size': {
      if (!VALID_SIZE.has(value)) {
        throw badRequest('size must be one of: quick, small, medium, large');
      }
      const entry = editedEntry('size', value, req);
      await scopedQuery(
        `UPDATE inbox.human_tasks
            SET size = $2,
                last_feedback = 'edited',
                last_feedback_at = now(),
                feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                   || $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [id, value, JSON.stringify(entry)],
      );
      return { ok: true, id, field };
    }

    case 'is_this_ours': {
      const v = String(value || '').toLowerCase();
      if (!['yes', 'no', 'defer'].includes(v)) {
        throw badRequest('is_this_ours value must be yes|no|defer');
      }
      let newStatus = null;
      if (v === 'no') newStatus = 'not_for_us';
      else if (v === 'yes') newStatus = 'inbox'; // promote out of "proposed"
      // 'defer' leaves status untouched.

      const entry = editedEntry('is_this_ours', v, req);
      await scopedQuery(
        `UPDATE inbox.human_tasks
            SET status = COALESCE($2, status),
                last_feedback = 'edited',
                last_feedback_at = now(),
                feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                   || $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [id, newStatus, JSON.stringify(entry)],
      );
      return { ok: true, id, field, status: newStatus };
    }

    case 'when': {
      if (!value) {
        throw badRequest('when requires { value: <ISO date> }');
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw badRequest('Invalid date');
      const iso = d.toISOString().slice(0, 10);
      const entry = editedEntry('when', iso, req);
      await scopedQuery(
        `UPDATE inbox.human_tasks
            SET due_date = $2::date,
                last_feedback = 'edited',
                last_feedback_at = now(),
                feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                                   || $3::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [id, iso, JSON.stringify(entry)],
      );
      return { ok: true, id, field };
    }

    default:
      throw badRequest(`Unknown field: ${field}`);
  }
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/lifecycle ----------------------------------

/**
 * Lifecycle transition per FR-27, FR-29 and the canonical transition table
 * in the v0.2 tech spec (§1, near FR-27). Validates the (status, verb) pair
 * against TRANSITIONS; rejects terminal/proposed rows and invalid verbs.
 */
export async function lifecycleHumanTask(req, body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'lifecycle');
  if (!id) throw badRequest('Invalid id');

  const verb = body?.verb;
  if (!verb || typeof verb !== 'string') {
    throw badRequest('verb required');
  }

  const existing = await scopedQuery(
    `SELECT id, status, feedback_history
       FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');

  const fromStatus = existing.rows[0].status;
  // Terminal and `proposed` rows have no entries in TRANSITIONS — any verb
  // attempted against them falls through to 409 below.
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed || !Object.prototype.hasOwnProperty.call(allowed, verb)) {
    throw conflict(
      `Verb '${verb}' is not valid for status '${fromStatus}'`,
    );
  }
  const toStatus = allowed[verb];

  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : null;

  const entry = {
    verb: 'transition',
    from_status: fromStatus,
    to_status: toStatus,
    reason,
    by: actorOf(req),
    at: new Date().toISOString(),
  };

  const updated = await scopedQuery(
    `UPDATE inbox.human_tasks
        SET status = $2,
            last_feedback = 'transition',
            last_feedback_at = now(),
            feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                               || $3::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id, status, last_feedback`,
    [id, toStatus, JSON.stringify(entry)],
  );

  return {
    ok: true,
    id,
    status: updated.rows[0].status,
    last_feedback: updated.rows[0].last_feedback,
  };
  } finally {
    await scopedQuery.release();
  }
}

// ---- PATCH /api/human-tasks/:id/fields ------------------------------------

/**
 * Validate a single PATCH field/value pair against the allow-list and the
 * per-field type/enum rules. Returns the normalised value to write.
 * Throws badRequest on any disallowed field, wrong type, or invalid enum.
 *
 * Per FR-2 / AD-5: PATCH does NOT existence-check `project_id`,
 * `engagement_id`, or `assignee_contact_id` — those are operator overrides
 * trusted as-is; validation against `engagements`/`projects` happens at
 * enrichment time only.
 */
function validatePatch(field, value) {
  if (!PATCHABLE_FIELDS.has(field)) {
    throw badRequest(`Field not patchable: ${field}`);
  }

  switch (field) {
    case 'title': {
      if (typeof value !== 'string' || value.trim() === '') {
        throw badRequest('title must be a non-empty string');
      }
      return value;
    }
    case 'description': {
      if (value !== null && typeof value !== 'string') {
        throw badRequest('description must be a string or null');
      }
      return value;
    }
    case 'due_date': {
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw badRequest('due_date must be an ISO date string or null');
      }
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw badRequest('due_date must be a valid ISO date');
      }
      return d.toISOString().slice(0, 10);
    }
    case 'priority': {
      if (!VALID_PRIORITY.has(value)) {
        throw badRequest('priority must be one of: urgent, high, normal, low');
      }
      return value;
    }
    case 'size': {
      if (value === null) return null;
      if (!VALID_SIZE.has(value)) {
        throw badRequest('size must be one of: quick, small, medium, large');
      }
      return value;
    }
    case 'tags': {
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
        throw badRequest('tags must be an array of strings');
      }
      return value;
    }
    case 'project_id':
    case 'engagement_id':
    case 'assignee_contact_id': {
      if (value !== null && typeof value !== 'string') {
        throw badRequest(`${field} must be a string or null`);
      }
      return value;
    }
    case 'next_action_hint': {
      if (value !== null && typeof value !== 'string') {
        throw badRequest('next_action_hint must be a string or null');
      }
      return value;
    }
    default:
      throw badRequest(`Field not patchable: ${field}`);
  }
}

/**
 * Per-field SQL fragment for the UPDATE. Most columns are plain assignments;
 * `engagement_id` casts to UUID (per migration 119), `due_date` casts to DATE,
 * `tags` to TEXT[].
 */
const PATCH_COLUMN_SQL = {
  title:               '$2::text',
  description:         '$2::text',
  due_date:            '$2::date',
  priority:            '$2::text',
  size:                '$2::text',
  tags:                '$2::text[]',
  project_id:          '$2::text',
  engagement_id:       '$2::uuid',
  next_action_hint:    '$2::text',
  assignee_contact_id: '$2::text',
};

/**
 * Patch a single allow-listed field per FR-18. Refuses on terminal rows
 * (409), missing/soft-deleted rows (404), disallowed fields (400),
 * invalid types/enums (400), unauthenticated callers (403).
 */
export async function patchHumanTaskFields(req, body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'fields');
  if (!id) throw badRequest('Invalid id');

  const field = body?.field;
  if (typeof field !== 'string') throw badRequest('field required');

  const normalised = validatePatch(field, body?.value);

  const existing = await scopedQuery(
    `SELECT id, status FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');
  if (TERMINAL_STATUSES.has(existing.rows[0].status)) {
    throw conflict(`Task already terminal (${existing.rows[0].status})`);
  }

  const entry = editedEntry(field, normalised, req);
  const columnExpr = PATCH_COLUMN_SQL[field];

  await scopedQuery(
    `UPDATE inbox.human_tasks
        SET ${field} = ${columnExpr},
            last_feedback = 'edited',
            last_feedback_at = now(),
            feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                               || $3::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [id, normalised, JSON.stringify(entry)],
  );

  return { ok: true, id, field, value: normalised };
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/push (force-push) --------------------------

/**
 * Force-push a row into the Linear push queue.
 *
 * Tech-spec FR-6, FR-9, FR-10:
 *   - confirm-push gate (FR-6): operator approves a proposed-band row
 *     (relevance 0.6–0.8) for Linear.
 *   - retry (FR-10): operator clicks "Retry" on a push_status='failed' row.
 *   - resync: operator forces a re-push of a 'succeeded' row.
 *
 * Behaviour:
 *   1. requireBoard(req).
 *   2. SELECT row → 404 if missing/soft-deleted.
 *   3. push_status='running'  → 409 (never interrupt in-flight pushes).
 *   4. status terminal         → 409 (done/skipped/not_for_us cannot push).
 *   5. UPDATE: push_status='pending', push_attempts=0,
 *      push_skip_reason=NULL, push_last_error=NULL, updated_at=now().
 *   6. pg_notify('human_task_push_pending', <id>) to wake the push worker.
 *   7. Return { ok, id, push_status: 'pending' }.
 */
export async function forcePushHumanTask(req, _body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'push');
  if (!id) throw badRequest('Invalid id');

  const existing = await scopedQuery(
    `SELECT id, status, push_status
       FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');

  const cur = existing.rows[0];
  if (cur.push_status === 'running') {
    throw conflict('push already in flight');
  }
  if (TERMINAL_STATUSES.has(cur.status)) {
    throw conflict(`Task terminal (${cur.status}) cannot be pushed`);
  }

  const entry = {
    verb: 'force_push',
    by: actorOf(req),
    at: new Date().toISOString(),
  };

  await scopedQuery(
    `UPDATE inbox.human_tasks
        SET push_status      = 'pending',
            push_attempts    = 0,
            push_skip_reason = NULL,
            push_last_error  = NULL,
            feedback_history = COALESCE(feedback_history, '[]'::jsonb)
                               || $2::jsonb,
            updated_at       = now()
      WHERE id = $1`,
    [id, JSON.stringify(entry)],
  );

  await scopedQuery(`SELECT pg_notify('human_task_push_pending', $1)`, [id]);

  return { ok: true, id, push_status: 'pending' };
  } finally {
    await scopedQuery.release();
  }
}

// ---- GET /api/human-tasks/:id ---------------------------------------------

/**
 * Single-row fetch with full feedback_history + last 20 sync-log entries.
 * Powers the card-details panel (FR-31, FR-33).
 *
 * Matches `/api/human-tasks/:id` directly — the regex is anchored to the
 * exact path so it doesn't collide with any of the verb sub-routes
 * (`/action`, `/lifecycle`, `/push`, etc.).
 */
function parseHumanTaskRootId(req) {
  const m = urlPath(req).match(/^\/api\/human-tasks\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getHumanTask(req) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskRootId(req);
  if (!id) throw badRequest('Invalid id');

  const taskRes = await scopedQuery(
    `SELECT *
       FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (taskRes.rows.length === 0) throw notFound('human_task not found');
  const task = taskRes.rows[0];

  const logRes = await scopedQuery(
    `SELECT id, direction, outcome, before_snapshot, after_snapshot,
            guardrail_id, backfill_batch_id, error_text, duration_ms, at
       FROM inbox.human_task_sync_log
      WHERE task_id = $1
      ORDER BY at DESC
      LIMIT 20`,
    [id],
  );

  return { task, sync_log: logRes.rows };
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/enrich -------------------------------------

/**
 * Force re-enrichment (FR-3). Resets enrichment_status='pending' and
 * clears enrichment_at so the worker picks it up. Rejects 409 if the
 * row is already 'running' (don't interrupt in-flight enrichment).
 * Appends a feedback_history `verb='force_enrich'` entry (P3 audit).
 */
export async function forceEnrichHumanTask(req, _body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'enrich');
  if (!id) throw badRequest('Invalid id');

  const existing = await scopedQuery(
    `SELECT id, status, enrichment_status
       FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');

  const cur = existing.rows[0];
  if (cur.enrichment_status === 'running') {
    throw conflict('enrichment already in flight');
  }

  const entry = {
    verb: 'force_enrich',
    by: actorOf(req),
    at: new Date().toISOString(),
  };

  await scopedQuery(
    `UPDATE inbox.human_tasks
        SET enrichment_status = 'pending',
            enrichment_at     = NULL,
            feedback_history  = COALESCE(feedback_history, '[]'::jsonb)
                                || $2::jsonb,
            updated_at        = now()
      WHERE id = $1`,
    [id, JSON.stringify(entry)],
  );

  await scopedQuery(`SELECT pg_notify('human_task_enrichment_pending', $1)`, [id]);

  return { ok: true, id, enrichment_status: 'pending' };
  } finally {
    await scopedQuery.release();
  }
}

// ---- POST /api/human-tasks/:id/resync -------------------------------------

/**
 * Force pull from Linear (FR-31). Marks linear_last_event_at=NULL so the
 * next reconciliation pass picks the row up, and emits a
 * `human_task_resync` notify for any active listener. Appends a
 * feedback_history `verb='force_resync'` entry.
 */
export async function forceResyncHumanTask(req, _body) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {

  const id = parseHumanTaskId(req, 'resync');
  if (!id) throw badRequest('Invalid id');

  const existing = await scopedQuery(
    `SELECT id, linear_issue_id
       FROM inbox.human_tasks
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (existing.rows.length === 0) throw notFound('human_task not found');

  const entry = {
    verb: 'force_resync',
    by: actorOf(req),
    at: new Date().toISOString(),
  };

  await scopedQuery(
    `UPDATE inbox.human_tasks
        SET linear_last_event_at = NULL,
            feedback_history     = COALESCE(feedback_history, '[]'::jsonb)
                                    || $2::jsonb,
            updated_at           = now()
      WHERE id = $1`,
    [id, JSON.stringify(entry)],
  );

  await scopedQuery(`SELECT pg_notify('human_task_resync', $1)`, [id]);

  return { ok: true, id };
  } finally {
    await scopedQuery.release();
  }
}

// ---- Route registration ---------------------------------------------------

export function registerHumanTaskRoutes(routes, { withViewer } = {}) {
  // STAQPRO-608: resolve the tenancy principal and pass it to listHumanTasks so
  // the list read is org-scoped fail-closed. null (withViewer absent or a
  // resolution throw) → visibleClause 'FALSE' → zero rows, never unscoped.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  routes.set('GET /api/human-tasks', async (req) => {
    const principal = await resolvePrincipalFor(req);
    return listHumanTasks(req, principal);
  });
  routes.set('GET /api/human-tasks/:id', getHumanTask);
  routes.set('POST /api/human-tasks/:id/action', actHumanTask);
  routes.set('POST /api/human-tasks/:id/inline-answer', inlineAnswerHumanTask);
  routes.set('POST /api/human-tasks/:id/lifecycle', lifecycleHumanTask);
  routes.set('PATCH /api/human-tasks/:id/fields', patchHumanTaskFields);
  routes.set('POST /api/human-tasks/:id/push', forcePushHumanTask);
  routes.set('POST /api/human-tasks/:id/enrich', forceEnrichHumanTask);
  routes.set('POST /api/human-tasks/:id/resync', forceResyncHumanTask);
}
