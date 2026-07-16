import { query } from '../db.js';

/**
 * Signal extractor: pull signals from inbox.signals and maintain relationship graph.
 * Signals: commitments, deadlines, action items, questions, decisions.
 */

/**
 * Get unresolved signals, optionally filtered.
 */
export async function getUnresolvedSignals({ type = null, days = null } = {}) {
  let sql = `SELECT s.*, m.from_address, m.subject, m.received_at
     FROM inbox.signals s
     JOIN inbox.messages m ON s.message_id = m.id
     WHERE s.resolved = false`;
  const params = [];

  if (type) {
    params.push(type);
    sql += ` AND s.signal_type = $${params.length}`;
  }
  if (days) {
    params.push(days);
    sql += ` AND s.created_at >= CURRENT_DATE - $${params.length} * interval '1 day'`;
  }

  sql += ` ORDER BY s.due_date ASC NULLS LAST, s.created_at DESC`;

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Get upcoming deadlines within N days.
 */
export async function getUpcomingDeadlines(days = 7) {
  const result = await query(
    `SELECT s.*, m.from_address, m.subject
     FROM inbox.signals s
     JOIN inbox.messages m ON s.message_id = m.id
     WHERE s.resolved = false
       AND s.due_date IS NOT NULL
       AND s.due_date <= CURRENT_DATE + $1 * interval '1 day'
     ORDER BY s.due_date ASC`,
    [days]
  );
  return result.rows;
}

/**
 * Resolve a single signal by ID.
 */
export async function resolveSignal(signalId, reason = 'manual') {
  await query(
    `UPDATE inbox.signals SET resolved = true, resolved_at = now(), metadata = COALESCE(metadata, '{}'::jsonb) || $2 WHERE id = $1`,
    [signalId, JSON.stringify({ resolution_reason: reason })]
  );
}

/**
 * Batch-resolve all unresolved signals on a message.
 * @param {string} messageId - inbox.messages.id
 * @param {string} reason - resolution reason tag
 * @param {object} [opts]
 * @param {string[]} [opts.excludeTypes] - signal types to skip
 * @param {string[]} [opts.onlyTypes] - if set, only resolve these types
 * @param {Function} [opts.exec] - scoped query executor (STAQPRO-263 / OPT-166 P2d).
 *   Defaults to the bare pooled `query`, keeping every existing caller byte-identical
 *   and inert. inbox.signals' write policy is org-only (sql/200, allow_system=false),
 *   so post pool-flip this UPDATE black-holes to 0 rows unless run under a scope whose
 *   app.org_ids contains the signal's owner_org_id — cross-org sweepers (the gmail
 *   poller) inject an org-scoped executor via withAgentScope. INERT until the flip.
 * @returns {Promise<number>} count of resolved signals
 */
export async function resolveSignalsByMessage(messageId, reason, { excludeTypes = [], onlyTypes = [], exec = query } = {}) {
  let sql = `UPDATE inbox.signals
     SET resolved = true, resolved_at = now(), metadata = COALESCE(metadata, '{}'::jsonb) || $2
     WHERE message_id = $1 AND resolved = false`;
  const params = [messageId, JSON.stringify({ resolution_reason: reason })];
  if (onlyTypes.length > 0) {
    params.push(onlyTypes);
    sql += ` AND signal_type = ANY($${params.length})`;
  }
  if (excludeTypes.length > 0) {
    params.push(excludeTypes);
    sql += ` AND signal_type != ALL($${params.length})`;
  }
  const result = await exec(sql, params);
  return result.rowCount;
}
