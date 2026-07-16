// Pure helpers for the BackfillPanel UI under /governance/backfill.
// FR-B2 + ADR-004: keep filtering, bucketing, and badge formatting as pure
// functions so the React wrapper stays thin and the logic is unit-testable
// without a DOM.

// Terminal statuses an operator can never re-queue into a backfill — these
// are explicitly stripped from statusInclude in buildBackfillFilters.
const TERMINAL_STATUSES = new Set(['done', 'skipped', 'not_for_us']);

/**
 * Normalise raw form inputs from the BackfillPanel into the API filter shape
 * consumed by POST /api/governance/backfill.
 *
 * @param {{
 *   statusInclude?: string[],
 *   minRelevance?: number|string|null,
 *   maxAgeDays?: number|string|null,
 * }} [input]
 * @returns {{ status: string[], min_relevance: number, max_age_days: number|null }}
 */
export function buildBackfillFilters(input = {}) {
  const {
    statusInclude = [],
    minRelevance = 0.0,
    maxAgeDays = null,
  } = input || {};

  // Status: lowercase, dedup, strip terminal statuses.
  const seen = new Set();
  const status = [];
  for (const raw of Array.isArray(statusInclude) ? statusInclude : []) {
    if (typeof raw !== 'string') continue;
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    if (TERMINAL_STATUSES.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    status.push(norm);
  }

  // minRelevance: parse float, clamp [0,1], default 0.0 on invalid.
  let min_relevance = 0.0;
  if (minRelevance !== null && minRelevance !== undefined && minRelevance !== '') {
    const n = typeof minRelevance === 'number' ? minRelevance : parseFloat(minRelevance);
    if (Number.isFinite(n)) {
      min_relevance = Math.max(0, Math.min(1, n));
    }
  }

  // maxAgeDays: positive int or null.
  let max_age_days = null;
  if (maxAgeDays !== null && maxAgeDays !== undefined && maxAgeDays !== '') {
    const n = typeof maxAgeDays === 'number' ? maxAgeDays : parseInt(maxAgeDays, 10);
    if (Number.isFinite(n) && n > 0) {
      max_age_days = Math.trunc(n);
    }
  }

  return { status, min_relevance, max_age_days };
}

/**
 * Summarise candidate rows into three bucket dictionaries used by the panel's
 * preview chips ("X high / Y mid / Z low", age distribution, status mix).
 *
 * Bands:
 *   high  : relevance_score >= 0.8
 *   mid   : 0.6 <= relevance_score < 0.8
 *   low   : relevance_score < 0.6
 *
 * Age buckets:
 *   <7d   : age_days < 7
 *   7-30d : 7 <= age_days <= 30
 *   >30d  : age_days > 30
 *
 * @param {Array<{status: string, relevance_score: number, age_days: number}>} rows
 * @returns {{
 *   byStatus: Record<string, number>,
 *   byRelevanceBand: { high: number, mid: number, low: number },
 *   byAgeBucket: { '<7d': number, '7-30d': number, '>30d': number },
 * }}
 */
export function summarizeBackfillBuckets(rows) {
  const byStatus = {};
  const byRelevanceBand = { high: 0, mid: 0, low: 0 };
  const byAgeBucket = { '<7d': 0, '7-30d': 0, '>30d': 0 };

  if (!Array.isArray(rows)) {
    return { byStatus, byRelevanceBand, byAgeBucket };
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    if (typeof row.status === 'string' && row.status) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    }

    const r = Number(row.relevance_score);
    if (Number.isFinite(r)) {
      if (r >= 0.8) byRelevanceBand.high++;
      else if (r >= 0.6) byRelevanceBand.mid++;
      else byRelevanceBand.low++;
    }

    const a = Number(row.age_days);
    if (Number.isFinite(a)) {
      if (a < 7) byAgeBucket['<7d']++;
      else if (a <= 30) byAgeBucket['7-30d']++;
      else byAgeBucket['>30d']++;
    }
  }

  return { byStatus, byRelevanceBand, byAgeBucket };
}

/**
 * Format the status badge shown next to a backfill batch row.
 *
 * @param {{ state?: string, task_count?: number }} batch
 * @returns {string}
 */
export function formatBackfillBadge(batch) {
  if (!batch || typeof batch !== 'object') return 'Unknown';
  const n = Number.isFinite(Number(batch.task_count)) ? Number(batch.task_count) : 0;
  switch (batch.state) {
    case 'pending':
      return `Pending: ${n} tasks queued`;
    case 'in_progress':
      return `In progress: ${n} tasks`;
    case 'completed':
      return `Completed: ${n} tasks pushed`;
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Unknown';
  }
}
