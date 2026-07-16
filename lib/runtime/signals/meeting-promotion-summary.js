/**
 * Per-meeting promotion summary for the /meetings page.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban.md §11.2
 *
 *   "X actions promoted to board, Y actions filtered out (expand)."
 *
 * Returns three buckets:
 *   - promoted:       signals that produced a human_tasks row
 *   - filtered:       signals stamped relevance_skipped=true
 *   - not_applicable: any other signal (info, deadline, etc., or a
 *                     promotable type that has not yet been promoted)
 *
 * The UI renders `promoted.count` as the headline, `filtered.signals` as
 * the expandable list, and `not_applicable.count` as a small footer
 * ("N additional signals weren't actionable").
 */

/**
 * @param {Object} opts
 * @param {Function} opts.query - pg-style query fn
 * @param {string} opts.messageId - inbox.messages.id
 * @returns {Promise<{
 *   promoted: { count: number, task_ids: string[] },
 *   filtered: { count: number, signals: {id: string, content: string, relevance_score: number|null}[] },
 *   not_applicable: { count: number }
 * }>}
 */
export async function getMeetingPromotionSummary({ query, messageId }) {
  if (!query || !messageId) {
    throw new Error('getMeetingPromotionSummary requires { query, messageId }');
  }

  // Promoted: every human_tasks row whose signal points at this message.
  // We join on signal_id rather than message_id directly because the
  // message_id is denormalised onto human_tasks but may be NULL if the
  // signal was deleted afterwards (FK ON DELETE SET NULL).
  const promoted = await query(
    `SELECT ht.id AS task_id, ht.signal_id
       FROM inbox.human_tasks ht
      WHERE ht.message_id = $1
        AND ht.deleted_at IS NULL`,
    [messageId],
  );

  // Filtered: signals stamped by the promoter's skip branch.
  const filtered = await query(
    `SELECT id, content,
            (metadata->>'relevance_score')::numeric AS relevance_score
       FROM inbox.signals
      WHERE message_id = $1
        AND (metadata->>'relevance_skipped')::boolean = true
      ORDER BY created_at ASC`,
    [messageId],
  );

  // Not applicable: every remaining signal on this message that we didn't
  // count above.
  const promotedSignalIds = new Set(
    promoted.rows.map((r) => r.signal_id).filter(Boolean),
  );
  const filteredSignalIds = new Set(filtered.rows.map((r) => r.id));

  const allSignals = await query(
    `SELECT id FROM inbox.signals WHERE message_id = $1`,
    [messageId],
  );

  let notApplicable = 0;
  for (const row of allSignals.rows) {
    if (!promotedSignalIds.has(row.id) && !filteredSignalIds.has(row.id)) {
      notApplicable++;
    }
  }

  return {
    promoted: {
      count: promoted.rows.length,
      task_ids: promoted.rows.map((r) => r.task_id),
    },
    filtered: {
      count: filtered.rows.length,
      signals: filtered.rows.map((r) => ({
        id: r.id,
        content: r.content,
        relevance_score: r.relevance_score === null ? null : Number(r.relevance_score),
      })),
    },
    not_applicable: { count: notApplicable },
  };
}
