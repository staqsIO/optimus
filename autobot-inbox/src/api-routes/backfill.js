/**
 * /api/linear/backfill — operator-driven bulk push to Linear (FR-B1–B7).
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *   §FR-B1–B7, §3.1 (linear_backfill_batches), §4.1.
 *
 * Endpoints:
 *   GET  /api/linear/backfill/preview     — count + first 50 candidates
 *   POST /api/linear/backfill             — body {filters, dry_run?}
 *   POST /api/linear/backfill/:id/cancel  — flip pending rows back to NULL
 *   GET  /api/linear/backfill/:id         — batch row + push_status progress
 *
 * Style mirrors src/api-routes/human-tasks.js + guardrails.js: pure handler
 * functions exported for unit-test isolation; route registration via
 * registerBackfillRoutes for production wiring in src/api.js.
 *
 * Terminal rows (done/skipped/not_for_us) are hard-excluded server-side per
 * FR-B3, regardless of filter input. The cancel + progress endpoints rely
 * on the task_ids JSONB snapshot column added in migration 122 — that's the
 * batch-membership ledger.
 */

import { query, withBoardScope } from '../db.js';

// ---- Constants ------------------------------------------------------------

const TERMINAL_STATUSES = ['done', 'skipped', 'not_for_us'];
const VALID_STATUSES = new Set([
  'inbox', 'proposed', 'todo', 'in_progress', 'blocked',
  'later', 'review', 'done', 'skipped', 'not_for_us',
]);
const PREVIEW_LIMIT = 50;
const DRY_RUN_SAMPLE = 10;

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

/**
 * Parse {status, min_relevance, max_age_days} from query params or a body's
 * `filters` object. Returns a normalised shape; throws 400 on malformed input.
 */
function normaliseFilters(src) {
  const out = { status: [], min_relevance: 0, max_age_days: null };

  // status: comma-separated string OR array.
  if (src && src.status !== undefined && src.status !== null && src.status !== '') {
    let arr;
    if (Array.isArray(src.status)) {
      arr = src.status;
    } else if (typeof src.status === 'string') {
      arr = src.status.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      throw badRequest('status must be a comma-separated string or array');
    }
    for (const s of arr) {
      if (!VALID_STATUSES.has(s)) {
        throw badRequest(`invalid status: ${s}`);
      }
    }
    out.status = arr;
  }

  // min_relevance: float, default 0.
  if (src && src.min_relevance !== undefined && src.min_relevance !== null && src.min_relevance !== '') {
    const n = Number(src.min_relevance);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw badRequest('min_relevance must be a number in [0, 1]');
    }
    out.min_relevance = n;
  }

  // max_age_days: positive integer (in days), default null.
  if (src && src.max_age_days !== undefined && src.max_age_days !== null && src.max_age_days !== '') {
    const n = Number(src.max_age_days);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw badRequest('max_age_days must be a positive integer');
    }
    out.max_age_days = n;
  }

  return out;
}

/**
 * Build the WHERE clause + parameter list for a backfill selection.
 *
 * Hard rules (server-side, regardless of filter input):
 *   - deleted_at IS NULL
 *   - status NOT IN ('done','skipped','not_for_us')  (FR-B3)
 *
 * Soft filters:
 *   - status IN (...)  — intersection with non-terminal set
 *   - COALESCE(relevance_score, 0) >= min_relevance
 *   - created_at > now() - interval (max_age_days days)
 *
 * Returns { where, params } where `where` is a SQL fragment beginning with
 * "WHERE " and `params` is the positional argument array for $1..$N.
 */
function buildSelection(filters) {
  const params = [];
  const clauses = ['deleted_at IS NULL'];

  // Hard terminal exclusion.
  const terminalPlaceholders = TERMINAL_STATUSES.map((s) => {
    params.push(s);
    return `$${params.length}`;
  });
  clauses.push(`status NOT IN (${terminalPlaceholders.join(', ')})`);

  // Status intersection.
  if (filters.status.length > 0) {
    const ph = filters.status.map((s) => {
      params.push(s);
      return `$${params.length}`;
    });
    clauses.push(`status IN (${ph.join(', ')})`);
  }

  // min_relevance — NULL relevance_score treated as 0.
  params.push(filters.min_relevance);
  clauses.push(`COALESCE(relevance_score, 0) >= $${params.length}`);

  // max_age_days — only rows created more recently than the window.
  if (filters.max_age_days !== null) {
    // Postgres can't parameterise the unit; multiply at call time via a
    // numeric param against now() - ($n || ' days')::interval, OR just
    // interpolate the integer after validation. We validated it's a
    // positive integer above, so direct interpolation is safe.
    clauses.push(`created_at > now() - interval '${filters.max_age_days} days'`);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// ===========================================================================
// GET /api/linear/backfill/preview
// ===========================================================================

export async function previewBackfill(req) {
  requireBoard(req);

  const params = urlSearch(req);
  const filters = normaliseFilters({
    status: params.get('status'),
    min_relevance: params.get('min_relevance'),
    max_age_days: params.get('max_age_days'),
  });

  const { where, params: args } = buildSelection(filters);

  // OPT-166 P3-B5: requireBoard above gates this handler — board-scoped.
  // Two queries: total count + first 50 preview rows. The COUNT(*) is
  // unavoidable — the operator wants to see the full impact before pulling
  // the trigger. Tables are small (<10k rows in practice); the partial
  // indexes on push_status / status carry the load.
  const scopedQuery = await withBoardScope(req.auth);
  let count, previewRes;
  try {
    const countRes = await scopedQuery(
      `SELECT count(*)::int AS n FROM inbox.human_tasks ${where}`,
      args,
    );
    count = countRes.rows[0].n;

    previewRes = await scopedQuery(
      `SELECT id, title, status, relevance_score,
              CAST(EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS INTEGER) AS age_days
         FROM inbox.human_tasks
         ${where}
        ORDER BY created_at DESC
        LIMIT ${PREVIEW_LIMIT}`,
      args,
    );
  } finally {
    await scopedQuery.release();
  }

  return { count, preview: previewRes.rows };
}

// ===========================================================================
// POST /api/linear/backfill
// ===========================================================================
//
// Body: { filters: {status?, min_relevance?, max_age_days?}, dry_run?: bool }
//
// dry_run=true returns { would_push, sample } without writing.
// otherwise: insert a batch row + flip push_status='pending' on matches
// + emit per-task pg_notify('human_task_push_pending', task_id).

export async function startBackfill(req, body) {
  requireBoard(req);

  const dryRun = body?.dry_run === true;
  const filters = normaliseFilters(body?.filters || {});
  const { where, params: args } = buildSelection(filters);

  // OPT-166 P3-B5: requireBoard above gates this handler — board-scoped.
  // Resolve matching ids first. Used for both dry-run + the real write so
  // the batch row + the UPDATE see the same snapshot.
  const matchScope = await withBoardScope(req.auth);
  let ids;
  try {
    const matched = await matchScope(
      `SELECT id FROM inbox.human_tasks ${where} ORDER BY created_at DESC`,
      args,
    );
    ids = matched.rows.map((r) => r.id);
  } finally {
    await matchScope.release();
  }

  if (dryRun) {
    return {
      would_push: ids.length,
      sample: ids.slice(0, DRY_RUN_SAMPLE),
    };
  }

  const actor = actorOf(req);

  // Board-scoped transaction: insert batch row, flip push_status='pending' on
  // the exact set of ids we just selected (use the id list, not the WHERE
  // clause again — the set is stable across both writes that way).
  const txScope = await withBoardScope(req.auth);
  let batchId;
  try {
    const inserted = await txScope(
      `INSERT INTO inbox.linear_backfill_batches
         (created_by, filter_json, task_count, state, task_ids)
       VALUES ($1, $2::jsonb, $3, 'pending', $4::jsonb)
       RETURNING id`,
      [actor, JSON.stringify(body?.filters || {}), ids.length, JSON.stringify(ids)],
    );
    batchId = inserted.rows[0].id;

    if (ids.length > 0) {
      await txScope(
        `UPDATE inbox.human_tasks
            SET push_status = 'pending'
          WHERE id = ANY($1::text[])
            AND deleted_at IS NULL
            AND status NOT IN ('done', 'skipped', 'not_for_us')`,
        [ids],
      );
    }
  } finally {
    await txScope.release();
  }

  // Per-task pg_notify mirrors the normal force-push flow (human-tasks.js).
  // Outside the transaction — notifies only fire on commit anyway, and the
  // push worker's poll fallback recovers if a notify is dropped.
  for (const id of ids) {
    try {
      await query(`SELECT pg_notify('human_task_push_pending', $1)`, [id]);
    } catch {
      // Best-effort; the worker's poll will pick it up.
    }
  }

  return {
    ok: true,
    batch_id: batchId,
    task_count: ids.length,
  };
}

// ===========================================================================
// POST /api/linear/backfill/:id/cancel
// ===========================================================================

function parseBackfillId(req, tail) {
  const re = tail
    ? new RegExp(`^/api/linear/backfill/([^/]+)/${tail}$`)
    : /^\/api\/linear\/backfill\/([^/]+)$/;
  const m = urlPath(req).match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function cancelBackfill(req) {
  requireBoard(req);

  const id = parseBackfillId(req, 'cancel');
  if (!id) throw badRequest('Invalid batch id');

  // OPT-166 P3-B5: requireBoard above gates this handler — board-scoped.
  const scopedQuery = await withBoardScope(req.auth);
  try {
    const existing = await scopedQuery(
      `SELECT id, state, task_ids
         FROM inbox.linear_backfill_batches
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    if (existing.rows.length === 0) {
      throw notFound('backfill batch not found');
    }
    const batch = existing.rows[0];
    if (batch.state === 'cancelled' || batch.state === 'completed') {
      throw conflict(`batch already ${batch.state}`);
    }

    // Parse task_ids — JSONB roundtrip may come back as array or string
    // depending on driver.
    const taskIds = Array.isArray(batch.task_ids)
      ? batch.task_ids
      : (typeof batch.task_ids === 'string'
          ? JSON.parse(batch.task_ids)
          : []);

    let cancelledCount = 0;
    if (taskIds.length > 0) {
      // Only flip rows that are STILL pending — running/succeeded/failed are
      // outside the operator's right-to-cancel (the worker owns those).
      const updated = await scopedQuery(
        `UPDATE inbox.human_tasks
            SET push_status = NULL
          WHERE id = ANY($1::text[])
            AND push_status = 'pending'
          RETURNING id`,
        [taskIds],
      );
      cancelledCount = updated.rows.length;
    }

    await scopedQuery(
      `UPDATE inbox.linear_backfill_batches
          SET state = 'cancelled',
              completed_at = now()
        WHERE id = $1`,
      [id],
    );

    return {
      ok: true,
      batch_id: id,
      cancelled_count: cancelledCount,
    };
  } finally {
    await scopedQuery.release();
  }
}

// ===========================================================================
// GET /api/linear/backfill/:id
// ===========================================================================

export async function getBackfillBatch(req) {
  requireBoard(req);

  const id = parseBackfillId(req);
  if (!id) throw badRequest('Invalid batch id');

  // OPT-166 P3-B5: requireBoard above gates this handler — board-scoped.
  const scopedQuery = await withBoardScope(req.auth);
  let batch, progress;
  try {
    const batchRes = await scopedQuery(
      `SELECT id, created_by, created_at, filter_json, task_count, state,
              completed_at, task_ids
         FROM inbox.linear_backfill_batches
        WHERE id = $1`,
      [id],
    );
    if (batchRes.rows.length === 0) {
      throw notFound('backfill batch not found');
    }
    batch = batchRes.rows[0];

    const taskIds = Array.isArray(batch.task_ids)
      ? batch.task_ids
      : (typeof batch.task_ids === 'string'
          ? JSON.parse(batch.task_ids)
          : []);

    // Progress: count rows in each push_status bucket, including NULL
    // (which we surface as "cancelled_or_unset").
    progress = {
      pending: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      cancelled_or_unset: 0,
    };

    if (taskIds.length > 0) {
      const r = await scopedQuery(
        `SELECT push_status, count(*)::int AS n
           FROM inbox.human_tasks
          WHERE id = ANY($1::text[])
          GROUP BY push_status`,
        [taskIds],
      );
      for (const row of r.rows) {
        const key = row.push_status === null ? 'cancelled_or_unset' : row.push_status;
        if (key in progress) progress[key] = row.n;
      }
    }
  } finally {
    await scopedQuery.release();
  }

  return { batch, progress };
}

// ---- Route registration ---------------------------------------------------

export function registerBackfillRoutes(routes) {
  routes.set('GET /api/linear/backfill/preview', previewBackfill);
  routes.set('POST /api/linear/backfill', startBackfill);
  routes.set('POST /api/linear/backfill/:id/cancel', cancelBackfill);
  routes.set('GET /api/linear/backfill/:id', getBackfillBatch);
}
