/**
 * lib/signal/entity-resolver.js — OPT-81 multi-identity entity resolution.
 *
 * Two exported functions for production use:
 *
 *   resolveContactId(identifier, channel, query)
 *     → canonical contact TEXT id (follows merged_into chain), or null if
 *       no match found. Resolving through the merged_into chain means callers
 *       always receive the living canonical id regardless of which email the
 *       message arrived from.
 *
 *   aggregateAcrossIdentities(canonicalId, query)
 *     → { emails_received, emails_sent, last_received_at, last_sent_at,
 *          signal_count, identities } — unified counters across all
 *       contacts that have been soft-merged into this canonical.
 *
 * Design principles: P2 (infrastructure enforces), P4 (boring SQL).
 * No ORM. Parameterized queries only.
 */

import { createLogger } from '../logger.js';

const log = createLogger('signal/entity-resolver');

/**
 * Follow the merged_into chain to the canonical contact.
 * Guards against cycles with a depth cap (should never happen in practice
 * since auto_merge_contacts rejects self-merges and the graph is a DAG,
 * but defensive depth cap is cheap).
 *
 * tenancy:allow-unscoped — signal.contacts is org-shared (no per-row owner_org_id
 * at the contact level; tenancy is enforced at the org level by the artifact/API
 * caller). This resolver is a low-level utility consumed by scoped callers.
 *
 * @param {string} id  — starting contact id
 * @param {Function} query — pg-style parameterized query function
 * @returns {Promise<string>} — canonical contact id
 */
export async function followMergeChain(id, query) {
  const MAX_DEPTH = 10;
  let current = id;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const { rows } = await query(
      `SELECT merged_into FROM signal.contacts WHERE id = $1`,
      [current],
    );
    if (rows.length === 0) return current; // id doesn't exist — return as-is
    const next = rows[0].merged_into;
    if (!next) return current; // this IS the canonical
    current = next;
  }
  log.warn({ id, current }, 'followMergeChain: depth cap reached, returning current');
  return current;
}

/**
 * Resolve a contact identifier (e.g. an email address) to a canonical
 * contact id, following any merged_into chain to its end.
 *
 * Returns null if no contact_identity row matches — caller decides whether
 * to create a new contact.
 *
 * tenancy:allow-unscoped — contact_identities is indexed by (channel, identifier)
 * and has no per-row org scope; signal.contacts is org-shared. Callers enforce
 * org scope at the HTTP/artifact layer.
 *
 * @param {string}   identifier — the raw identifier (e.g. 'dustin@umbadvisors.com')
 * @param {string}   channel    — identity channel (default 'email')
 * @param {Function} query      — pg query function
 * @returns {Promise<string|null>}
 */
export async function resolveContactId(identifier, channel = 'email', query) {
  const { rows } = await query(
    `SELECT contact_id
       FROM signal.contact_identities
      WHERE channel = $1 AND lower(identifier) = lower($2)
      LIMIT 1`,
    [channel, identifier],
  );
  if (rows.length === 0) return null;
  return followMergeChain(rows[0].contact_id, query);
}

/**
 * Aggregate signal data across all contacts merged into canonicalId (including
 * the canonical itself). Returns unified counters and identity list.
 *
 * This is the function to call for the "Dustin Powers" unified view — it sums
 * emails_received/sent across all merged-away aliases and the canonical.
 *
 * tenancy:allow-unscoped — signal.contacts is org-shared; tenancy enforced by
 * the caller (HTTP layer passes a single canonical id already authorized). The
 * aggregation over merged rows is an internal read within an already-scoped entity.
 *
 * @param {string}   canonicalId — the canonical contact's id
 * @param {Function} query
 * @returns {Promise<{
 *   emails_received: number,
 *   emails_sent: number,
 *   last_received_at: string|null,
 *   last_sent_at: string|null,
 *   signal_count: number,
 *   identities: Array<{channel:string, identifier:string, contact_id:string}>
 * }>}
 */
export async function aggregateAcrossIdentities(canonicalId, query) {
  // All contacts in this merge cluster = canonical + anything merged into it.
  const { rows: cluster } = await query(
    `SELECT id FROM signal.contacts
      WHERE id = $1 OR merged_into = $1`,
    [canonicalId],
  );
  const ids = cluster.map((r) => r.id);
  if (ids.length === 0) {
    return { emails_received: 0, emails_sent: 0, last_received_at: null, last_sent_at: null, signal_count: 0, identities: [] };
  }

  // Aggregate counters across the cluster.
  // tenancy:allow-unscoped — reads are keyed by ids already resolved from an
  // authorized canonical contact; signal.contacts is org-shared (no owner_org_id).
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: [agg] } = await query(
    `SELECT
       COALESCE(SUM(emails_received), 0)::int  AS emails_received,
       COALESCE(SUM(emails_sent),     0)::int  AS emails_sent,
       MAX(last_received_at)                    AS last_received_at,
       MAX(last_sent_at)                        AS last_sent_at
     FROM signal.contacts
    WHERE id IN (${placeholders})`,
    ids,
  );

  // All identities for the cluster.
  const { rows: identities } = await query(
    `SELECT ci.channel, ci.identifier, ci.contact_id
       FROM signal.contact_identities ci
      WHERE ci.contact_id IN (${placeholders})
      ORDER BY ci.channel, ci.identifier`,
    ids,
  );

  // Signal count: signals linked to ANY email identity in the cluster.
  // tenancy:allow-unscoped — inbox.signals/messages joined via already-authorized
  // identity set; no broader tenant table scan.
  const emailIdentifiers = identities
    .filter((r) => r.channel === 'email')
    .map((r) => r.identifier.toLowerCase());

  let signal_count = 0;
  if (emailIdentifiers.length > 0) {
    const sigPlaceholders = emailIdentifiers.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: [sc] } = await query(
      `SELECT COUNT(*)::int AS cnt
         FROM inbox.signals s
         JOIN inbox.messages m ON m.id = s.message_id
        WHERE lower(m.from_address) IN (${sigPlaceholders})`,
      emailIdentifiers,
    );
    signal_count = sc?.cnt ?? 0;
  }

  return {
    emails_received: agg.emails_received,
    emails_sent: agg.emails_sent,
    last_received_at: agg.last_received_at,
    last_sent_at: agg.last_sent_at,
    signal_count,
    identities,
  };
}
