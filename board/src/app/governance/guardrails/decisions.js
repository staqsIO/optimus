// Pure helpers backing the Settings → LLM Guardrails "Last 10 decisions" panel
// (FR-22). Side-effect free — no I/O — so they can be unit-tested under
// node:test without a DOM or React harness. ADR-004.
//
// A "decision" is a single push attempt under a specific guardrail revision.
// The backend returns rows shaped:
//   { task_id, title, linear_issue_id, linear_issue_url, outcome, decision, at }
// — see src/api-routes/guardrails.js#getGuardrailDecisions.

/**
 * @typedef {Object} GuardrailDecisionRow
 * @property {string}      [task_id]
 * @property {string}      [title]
 * @property {string|null} [linear_issue_id]
 * @property {string|null} [linear_issue_url]
 * @property {string}      [outcome]
 * @property {*}           [decision]
 * @property {string}      [at]
 */

/**
 * @typedef {Object} FormattedDecision
 * @property {string}      summary  "<title> → <linear_issue_id|'no issue'> (<outcome>)"
 * @property {string|null} link     row.linear_issue_url, or null when absent
 */

const NO_ISSUE = 'no issue';
const NO_TITLE = '(untitled)';
const NO_OUTCOME = 'unknown';

/**
 * Format a single decision row for display in the editor's "Last 10 decisions"
 * panel. Pure — no I/O, no exceptions on missing fields.
 *
 * @param {GuardrailDecisionRow} row
 * @returns {FormattedDecision}
 */
export function formatDecisionForDisplay(row) {
  const r = row || {};

  const title =
    typeof r.title === 'string' && r.title.length > 0 ? r.title : NO_TITLE;

  const linearId =
    typeof r.linear_issue_id === 'string' && r.linear_issue_id.length > 0
      ? r.linear_issue_id
      : NO_ISSUE;

  const outcome =
    typeof r.outcome === 'string' && r.outcome.length > 0
      ? r.outcome
      : NO_OUTCOME;

  const link =
    typeof r.linear_issue_url === 'string' && r.linear_issue_url.length > 0
      ? r.linear_issue_url
      : null;

  return {
    summary: `${title} → ${linearId} (${outcome})`,
    link,
  };
}
