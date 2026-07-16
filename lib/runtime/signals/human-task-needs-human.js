/**
 * needs_human trigger computation.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban.md §8
 *
 * Pure function of (row, now). The API layer renders this onto every
 * /api/board card as `needs_human: { trigger, since, hint } | null`.
 *
 * Triggers run in priority order; the first to fire wins. Priority
 * mirrors PRD §8 row ordering with "urgent_in_inbox" pulled to the top
 * because an urgent card sitting in inbox is the loudest signal.
 *
 * Thresholds are constants here; PRD §8 calls them configurable. When
 * config/board.json lands, callers can pass overrides via `opts`.
 *
 * Deferred trigger: PRD §8 row 6 ("Speaker said 'you' without naming a
 * person") requires an extraction-time marker on the source signal
 * (we'd need executor-triage to flag unresolved 2nd-person references).
 * That feature is not in inbox.signals today; revisit when the extractor
 * lands the flag.
 */

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;
const TERMINAL_STATUSES = new Set(['done', 'skipped', 'not_for_us']);

const DEFAULT_THRESHOLDS = Object.freeze({
  stalledDefaultDays: 7,
  stalledProposedDays: 2,
  stalledInProgressDays: 5,
  noAssigneeHours: 24,
  dueDaysByPriority: { urgent: 5, high: 3, normal: 3, low: 1 },
  lowConfidence: 0.5,
});

// Used by the board renderer's TS types — kept in sync with the values
// emitted by computeNeedsHuman below.
export const NEEDS_HUMAN_TRIGGERS = Object.freeze([
  'urgent_in_inbox',
  'low_confidence',
  'no_assignee',
  'due_approaching',
  'stalled',
]);

function toDate(s) {
  if (!s) return null;
  const d = s instanceof Date ? s : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fire(trigger, since, hint) {
  return { trigger, since: since instanceof Date ? since.toISOString() : since, hint };
}

/**
 * @param {Object} row - human_tasks row
 * @param {Date} [now=new Date()]
 * @param {Object} [opts]
 * @param {typeof DEFAULT_THRESHOLDS} [opts.thresholds]
 * @returns {{trigger: string, since: string, hint: string} | null}
 */
export function computeNeedsHuman(row, now = new Date(), opts = {}) {
  if (!row) return null;
  if (TERMINAL_STATUSES.has(row.status)) return null;

  const T = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const t = now instanceof Date ? now : new Date(now);

  // 1. urgent in inbox — never let it sit.
  if (row.priority === 'urgent' && row.status === 'inbox') {
    return fire(
      'urgent_in_inbox',
      toDate(row.updated_at) || t,
      'Urgent — confirm and act',
    );
  }

  // 2. low extraction confidence — promote the inline question instead of
  //    trusting autofill.
  if (
    typeof row.extraction_confidence === 'number'
    && row.extraction_confidence < T.lowConfidence
  ) {
    return fire(
      'low_confidence',
      toDate(row.updated_at) || t,
      `Confidence ${row.extraction_confidence.toFixed(2)} — verify`,
    );
  }

  // 3. no assignee for > 24h.
  const created = toDate(row.created_at);
  if (
    !row.assignee_contact_id
    && created
    && t.getTime() - created.getTime() > T.noAssigneeHours * HOURS
  ) {
    return fire('no_assignee', created, 'Who owns this?');
  }

  // 4. due approaching — priority-tuned window.
  const due = toDate(row.due_date);
  if (due) {
    const daysOut = (due.getTime() - t.getTime()) / DAYS;
    const window = T.dueDaysByPriority[row.priority] ?? T.dueDaysByPriority.normal;
    // Negative daysOut = overdue — surface it.
    if (daysOut <= window) {
      return fire(
        'due_approaching',
        due,
        daysOut < 0
          ? `Overdue by ${Math.abs(Math.round(daysOut))}d`
          : `Due in ${Math.max(0, Math.round(daysOut))}d`,
      );
    }
  }

  // 5. stalled — no movement for too long.
  const updated = toDate(row.updated_at);
  if (updated) {
    const ageDays = (t.getTime() - updated.getTime()) / DAYS;
    let limit = T.stalledDefaultDays;
    if (row.status === 'proposed') limit = T.stalledProposedDays;
    else if (row.status === 'in_progress') limit = T.stalledInProgressDays;
    if (ageDays > limit) {
      return fire('stalled', updated, `No movement for ${Math.round(ageDays)}d`);
    }
  }

  return null;
}
