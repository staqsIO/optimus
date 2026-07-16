// Pure helpers for /meetings page.
//
// FR-38: Each meeting card on /meetings MUST show "N tasks → Linear" badge
// with a deep-link list of the created Linear issue URLs.
//
// Per ADR-004: keep helpers framework-free so they can be tested under
// node:test without RTL or a bundler. ES module.

/**
 * Format the badge text for a meeting's human-task count.
 *
 * Examples:
 *  - 0 → "No tasks"
 *  - 1 → "1 task → Linear"
 *  - 3 → "3 tasks → Linear"
 *
 * Non-numeric / negative inputs are normalised to 0.
 *
 * @param {number} count
 * @returns {string}
 */
export function formatTaskCountBadge(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return 'No tasks';
  if (n === 1) return '1 task → Linear';
  return `${n} tasks → Linear`;
}

/**
 * Build the /issues deep-link URL that filters to a single meeting's
 * promoted human tasks via the `signal_meeting_id` query param
 * (consumed by BoardFilters per FR-32).
 *
 * @param {string} messageId  inbox.messages.id for the meeting transcript
 * @returns {string}
 */
export function meetingTaskLinkUrl(messageId) {
  const id = messageId == null ? '' : String(messageId);
  return `/issues?signal_meeting_id=${encodeURIComponent(id)}`;
}
