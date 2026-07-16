/**
 * /api/guardrails — Settings → LLM Guardrails surface.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   - FR-20: versioned llm_guardrails store; exactly one is_current per kind.
 *   - FR-22: Settings page reads current, history, edits + "this was wrong"
 *     correction capture.
 *   - FR-23: every push/pull LLM call records guardrail_id in feedback_history.
 *   - AD-6:  rows are append-only; revisions are NEVER mutated in place.
 *
 * Style mirrors src/api-routes/human-tasks.js: pure handler functions exported
 * for unit-test isolation; route registration via registerGuardrailRoutes for
 * production wiring in src/api.js.
 */

import { withTransaction, withBoardScope, setAgentContext } from '../db.js';

// ---- Constants ------------------------------------------------------------

const VALID_KINDS = new Set(['push', 'pull']);
const MAX_PROMPT_CHARS = 2000;        // FR-22 hard cap on prompt_text.
const MAX_DESCRIPTION_CHARS = 1000;   // FR-22 hard cap on correction text.
const HISTORY_LIMIT = 50;             // GET /history window.
const DECISIONS_DEFAULT_LIMIT = 10;   // FR-22 "Last 10 LLM decisions" default.
const DECISIONS_MAX_LIMIT = 50;       // Hard cap so the panel can't be abused.

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

function conflict(msg) {
  const e = new Error(msg);
  e.statusCode = 409;
  return e;
}

function actorOf(req) {
  return req.auth?.github_username || req.auth?.sub || 'unknown';
}

function urlSearch(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

/**
 * Plain-object check: matches mapping contract from FR-20.
 * Arrays, null, strings, numbers, booleans all rejected.
 */
function isPlainObject(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

const GUARDRAIL_COLUMNS =
  'id, kind, prompt_text, mapping, revision, is_current, created_by, created_at, note';

// ===========================================================================
// GET /api/guardrails — current push + pull rows
// ===========================================================================

export async function getGuardrails(req) {
  requireBoard(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  let r;
  try {
    r = await scopedQuery(
      `SELECT ${GUARDRAIL_COLUMNS}
         FROM inbox.llm_guardrails
        WHERE is_current = true`,
    );
  } finally {
    await scopedQuery.release();
  }

  const out = { push: null, pull: null };
  for (const row of r.rows) {
    if (row.kind === 'push' || row.kind === 'pull') {
      out[row.kind] = row;
    }
  }
  return out;
}

// ===========================================================================
// POST /api/guardrails — create new revision; flips is_current atomically
// ===========================================================================

export async function saveGuardrail(req, body) {
  requireBoard(req);

  const kind = body?.kind;
  if (!VALID_KINDS.has(kind)) {
    throw badRequest(`kind must be one of: push, pull`);
  }

  const promptText = body?.prompt_text;
  if (typeof promptText !== 'string' || promptText.length === 0) {
    throw badRequest('prompt_text required (non-empty string)');
  }
  if (promptText.length > MAX_PROMPT_CHARS) {
    throw badRequest(
      `prompt_text exceeds ${MAX_PROMPT_CHARS} char cap (got ${promptText.length})`,
    );
  }

  // mapping: required by FR-20, but defensively default to {} if omitted.
  // Reject arrays / strings / null — anything that isn't a plain object.
  let mapping = body?.mapping;
  if (mapping === undefined) {
    mapping = {};
  } else if (!isPlainObject(mapping)) {
    throw badRequest('mapping must be a plain object');
  }

  const note = (typeof body?.note === 'string' && body.note.length > 0)
    ? body.note
    : null;

  // Pre-serialise mapping so a non-serialisable value (e.g. BigInt) throws
  // BEFORE we open the transaction — the atomicity test depends on this.
  let mappingJson;
  try {
    mappingJson = JSON.stringify(mapping);
  } catch (err) {
    throw badRequest(`mapping not JSON-serialisable: ${err.message}`);
  }
  if (typeof mappingJson !== 'string') {
    throw badRequest('mapping not JSON-serialisable');
  }

  const actor = actorOf(req);

  // Transaction: flip prior current row to is_current=false, compute next
  // revision, INSERT new row. The partial unique index from migration 120
  // (llm_guardrails_current_per_kind) enforces "at most one current per
  // kind" at the schema level — but doing both ops in one transaction is
  // what guarantees no window with two current rows.
  return withTransaction(async (tx) => {
    // OPT-166 P3-B4: requireBoard() above already throws for any non-board
    // caller, so setting board context on this txn client is INERT (mirrors
    // intents.js's approve-route pattern — withBoardScope can't be used here
    // since it opens its own pooled client, not this transaction's client).
    const boardSub = String(req.auth.sub).toLowerCase();
    await setAgentContext(tx, boardSub, 'board');

    await tx.query(
      `UPDATE inbox.llm_guardrails
          SET is_current = false
        WHERE kind = $1 AND is_current = true`,
      [kind],
    );

    const maxRev = await tx.query(
      `SELECT COALESCE(MAX(revision), 0) AS max_rev
         FROM inbox.llm_guardrails
        WHERE kind = $1`,
      [kind],
    );
    const revision = Number(maxRev.rows[0]?.max_rev || 0) + 1;

    const inserted = await tx.query(
      `INSERT INTO inbox.llm_guardrails
         (kind, prompt_text, mapping, revision, created_by, is_current, note)
       VALUES ($1, $2, $3::jsonb, $4, $5, true, $6)
       RETURNING id, kind, revision`,
      [kind, promptText, mappingJson, revision, actor, note],
    );

    const row = inserted.rows[0];
    return { ok: true, id: row.id, kind: row.kind, revision: row.revision };
  });
}

// ===========================================================================
// GET /api/guardrails/history — last 50 revisions, optional kind filter
// ===========================================================================

export async function getGuardrailHistory(req) {
  requireBoard(req);

  const params = urlSearch(req);
  const kind = params.get('kind');
  if (kind !== null && !VALID_KINDS.has(kind)) {
    throw badRequest(`kind must be one of: push, pull`);
  }

  const args = [];
  let where = '';
  if (kind) {
    args.push(kind);
    where = `WHERE kind = $1`;
  }

  const sql = `
    SELECT ${GUARDRAIL_COLUMNS}
      FROM inbox.llm_guardrails
      ${where}
     ORDER BY kind ASC, revision DESC
     LIMIT ${HISTORY_LIMIT}
  `;
  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {
    const r = await scopedQuery(sql, args);
    return r.rows;
  } finally {
    await scopedQuery.release();
  }
}

// ===========================================================================
// POST /api/guardrails/correction — capture "this was wrong" against current
// ===========================================================================

export async function saveGuardrailCorrection(req, body) {
  requireBoard(req);

  // task_id: non-empty string. AD-6 wants a pointer at the offending row.
  const taskId = body?.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw badRequest('task_id required (non-empty string)');
  }

  // description: trimmed, non-empty, ≤1000 chars (FR-22 cap).
  const rawDesc = body?.description;
  if (typeof rawDesc !== 'string') {
    throw badRequest('description required (non-empty string)');
  }
  const description = rawDesc.trim();
  if (description.length === 0) {
    throw badRequest('description required (non-empty after trim)');
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw badRequest(
      `description exceeds ${MAX_DESCRIPTION_CHARS} char cap (got ${description.length})`,
    );
  }

  // kind: optional, defaults to 'push'.
  const kind = body?.kind === undefined ? 'push' : body.kind;
  if (!VALID_KINDS.has(kind)) {
    throw badRequest(`kind must be one of: push, pull`);
  }

  const actor = actorOf(req);

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {
    // Resolve the guardrail_id AS OF NOW — the AD-6 attribution guarantee.
    // A later revision must never silently re-target older correction rows.
    const current = await scopedQuery(
      `SELECT id FROM inbox.llm_guardrails
        WHERE kind = $1 AND is_current = true
        LIMIT 1`,
      [kind],
    );
    if (current.rows.length === 0) {
      throw conflict(`no current ${kind} guardrail to attribute correction to`);
    }
    const guardrailId = current.rows[0].id;

    const inserted = await scopedQuery(
      `INSERT INTO inbox.llm_guardrail_corrections
         (guardrail_id, task_id, description, captured_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, guardrail_id`,
      [guardrailId, taskId, description, actor],
    );

    return {
      ok: true,
      id: inserted.rows[0].id,
      guardrail_id: inserted.rows[0].guardrail_id,
    };
  } finally {
    await scopedQuery.release();
  }
}

// ===========================================================================
// GET /api/guardrails/decisions — last N push decisions under a guardrail
// ===========================================================================
//
// FR-22 / FR-23. The Settings → LLM Guardrails editor shows the most recent
// LLM push decisions taken under the currently-selected guardrail revision so
// the operator can spot misclassifications and capture corrections.
//
// Data source: inbox.human_task_sync_log (direction='push') joined back to
// inbox.human_tasks for the title and Linear chip metadata. guardrail_id is a
// denormalised pointer (intentionally NOT a FK — see migration 120 note) so
// this query is a single indexed scan.

export async function getGuardrailDecisions(req) {
  requireBoard(req);

  const params = urlSearch(req);
  const guardrailId = params.get('guardrail_id');
  if (typeof guardrailId !== 'string' || guardrailId.length === 0) {
    throw badRequest('guardrail_id required (non-empty string)');
  }

  // limit: optional, default 10, max 50. Reject non-numeric / non-positive.
  let limit = DECISIONS_DEFAULT_LIMIT;
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      throw badRequest('limit must be a positive integer');
    }
    limit = Math.min(parsed, DECISIONS_MAX_LIMIT);
  }

  // OPT-166 P3-B4: requireBoard() above already throws for any non-board
  // caller before this point, so opening the scoped session here is INERT.
  const scopedQuery = await withBoardScope(req.auth);
  try {
    const r = await scopedQuery(
      `SELECT s.task_id,
              s.outcome,
              s.after_snapshot AS decision,
              s.at,
              t.title,
              t.linear_issue_id,
              t.linear_issue_url
         FROM inbox.human_task_sync_log s
         JOIN inbox.human_tasks t ON t.id = s.task_id
        WHERE s.guardrail_id = $1
          AND s.direction = 'push'
        ORDER BY s.at DESC
        LIMIT $2`,
      [guardrailId, limit],
    );

    return r.rows;
  } finally {
    await scopedQuery.release();
  }
}

// ---- Route registration ---------------------------------------------------

export function registerGuardrailRoutes(routes) {
  routes.set('GET /api/guardrails', getGuardrails);
  routes.set('POST /api/guardrails', saveGuardrail);
  routes.set('GET /api/guardrails/history', getGuardrailHistory);
  routes.set('GET /api/guardrails/decisions', getGuardrailDecisions);
  routes.set('POST /api/guardrails/correction', saveGuardrailCorrection);
}
