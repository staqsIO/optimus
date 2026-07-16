// lib/rag/share-retrieval-audit.js
//
// ADR-017 #12 — fire-and-forget per-retrieval audit. Called by the retrievers
// (searchChunks / lexicalChunkSearch / wikiPageSearch) with every result whose
// shared_via metadata is populated.
//
// Contract:
//   * Insert is best-effort. A failure logs a warning and is otherwise ignored
//     so retrieval is never blocked by an audit-table outage.
//   * One INSERT per (retrieval_id, document_id, grant_id) triple. Dedupe is
//     enforced by the table's UNIQUE constraint; we use ON CONFLICT DO NOTHING
//     so re-runs are cheap.
//   * Query excerpt is bounded to 200 chars so PII / large prompts don't
//     pollute the audit table.

import { randomUUID } from 'crypto';
import { query as defaultQuery } from '../db.js';
import { createLogger } from '../logger.js';
const log = createLogger('rag/share-retrieval-audit');

const MAX_QUERY_EXCERPT = 200;

/**
 * Generate a stable id for the current retrieval. Callers thread this through
 * their hit-recording loop so all shared-doc hits from the same query share
 * one retrieval_id.
 */
export function newRetrievalId() {
  return randomUUID();
}

/**
 * Record one shared-doc hit. shared_via must include grant_id (added in mig 189 /
 * lexicalChunkSearch / wikiPageSearch). Callers pass the principal triple they
 * already have on hand — caller_user_id and caller_org_ids — for fast filtering
 * in the metrics view.
 *
 * @param {object} params
 * @param {string} params.retrievalId
 * @param {string} params.documentId
 * @param {object} params.sharedVia        {granter_type, granter_id, scope_type, scope_ref, grant_id}
 * @param {string|null} params.callerUserId
 * @param {string[]} [params.callerOrgIds]
 * @param {string} [params.queryText]
 * @param {{query?: Function}} [deps]
 */
export async function recordSharedDocHit({
  retrievalId,
  documentId,
  sharedVia,
  callerUserId,
  callerOrgIds = [],
  queryText = null,
}, deps = {}) {
  if (!sharedVia?.grant_id || !documentId || !retrievalId) return;
  const q = deps.query || defaultQuery;
  const excerpt = typeof queryText === 'string' && queryText.length > 0
    ? queryText.slice(0, MAX_QUERY_EXCERPT)
    : null;
  try {
    await q(
      `INSERT INTO audit.shared_doc_retrievals (
         retrieval_id, document_id, grant_id,
         granter_type, granter_id, target_type, target_id,
         scope_type, scope_ref,
         caller_user_id, caller_org_ids, query_excerpt
       ) VALUES (
         $1, $2, $3, $4, $5,
         -- Resolve target_type / target_id from the matching grant row so the
         -- audit row is self-describing even if the grant is later revoked.
         (SELECT target_type FROM tenancy.share_grants WHERE id = $3),
         (SELECT target_id   FROM tenancy.share_grants WHERE id = $3),
         $6, $7, $8, $9, $10
       )
       ON CONFLICT (retrieval_id, document_id, grant_id) DO NOTHING`,
      [
        retrievalId, documentId, sharedVia.grant_id,
        sharedVia.granter_type, sharedVia.granter_id,
        sharedVia.scope_type, sharedVia.scope_ref ?? null,
        callerUserId, callerOrgIds, excerpt,
      ],
    );
  } catch (err) {
    log.warn(`audit insert failed (non-blocking): ${err.message}`);
  }
}

/**
 * Convenience: record every shared-doc hit in a result set. Use after the
 * retriever has returned its chunks/pages — fire-and-forget (caller does not
 * await). Returns the retrieval_id used so callers can correlate.
 */
export function recordSharedDocHitsAsync({
  retrievalId,
  results,         // [{ documentId, metadata: { shared_via } }] OR [{ id, shared_via }]
  callerUserId,
  callerOrgIds = [],
  queryText = null,
}, deps = {}) {
  if (!Array.isArray(results) || results.length === 0) return retrievalId;
  // Avoid blocking on the audit — schedule each insert and swallow errors.
  for (const r of results) {
    const sharedVia = r?.metadata?.shared_via || r?.shared_via;
    const documentId = r?.documentId || r?.id;
    if (!sharedVia?.grant_id || !documentId) continue;
    void recordSharedDocHit({
      retrievalId, documentId, sharedVia,
      callerUserId, callerOrgIds, queryText,
    }, deps);
  }
  return retrievalId;
}
