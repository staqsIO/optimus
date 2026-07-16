/**
 * Sticky-override helper that guards re-enrichment.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md (FR-3, AD-5)
 *
 * A human_tasks row carries an append-only `feedback_history` JSONB array.
 * Entries with `verb === 'edited'` represent operator overrides — those
 * fields must not be silently overwritten by later re-enrichment runs
 * (LLM rescoring, linear_pull, etc.). This helper extracts the distinct
 * set of field names that the operator has explicitly edited.
 *
 * Pure function. Never mutates input. Never throws.
 */

/**
 * @param {Array<{verb?: string, field?: string}> | unknown} feedbackHistory
 * @returns {Set<string>}
 */
export function getStickyFields(feedbackHistory) {
  const sticky = new Set();
  if (!Array.isArray(feedbackHistory)) return sticky;

  for (const entry of feedbackHistory) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.verb !== 'edited') continue;
    if (typeof entry.field !== 'string') continue;
    sticky.add(entry.field);
  }

  return sticky;
}
