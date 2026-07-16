// graph/meeting-sync.js — :Meeting knowledge-graph node upserts (Plan 041)
//
// Closes the last link in the capture→enrich→graph chain: Calendar/TLDv
// meetings are ingested and classified (lib/runtime/meeting-classifier.js) but
// never became first-class graph nodes, so agent context injection from
// meetings had nothing to read. This module makes a meeting a `:Meeting` node.
//
// Merge key (idempotency): the node id IS the `source_meeting_id` produced by
// lib/runtime/meeting-identity.js#computeSourceMeetingId — a stable,
// content-derived key (`cal:<calendarEventId>` when a calendar id is present,
// else `mtg:<hash(window+participants+title)>`, else `src:<fallbackId>`). The
// same logical meeting collapses to the same id no matter how many times — or
// from how many sources — it is re-ingested (TLDv can re-deliver). So
// `MERGE (m:Meeting {id: $id})` updates rather than duplicates. This is the
// exact key the classifier already stamps on derived cards
// (`human_tasks.signal_meeting_id`), so the node aligns with task provenance.
//
// Federation (ADR-007 §2): writes go through runCypherCreate, which injects
// `origin_org` and stamps it ON CREATE so nodes are partitionable per-org.
//
// Best-effort: a failure here must NEVER break ingestion. Returns null when the
// graph is unavailable or no stable key is supplied (a missing key is a STOP —
// we refuse to create an un-mergeable node that would pollute the graph).
import { runCypherCreate, runCypher, isGraphAvailable } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('graph/meeting-sync');

/** Coerce a Date | epoch-ms | ISO string to an ISO string, or null. */
function toIsoOrNull(startTime) {
  if (startTime == null) return null;
  const ms = startTime instanceof Date ? startTime.getTime() : Date.parse(String(startTime));
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Coerce a Neo4j Integer | number | null to a plain number. */
function toPlainNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v) || 0;
}

/**
 * Upsert a `:Meeting` node keyed on its stable source_meeting_id, and link
 * participant `:Person` nodes (by email) that already exist via ATTENDED edges.
 *
 * @param {Object} m
 * @param {string} m.sourceMeetingId           - stable merge key (REQUIRED).
 * @param {string} [m.title]
 * @param {string} [m.source]                   - 'tldv' | 'gemini' | ...
 * @param {string} [m.documentId]               - content.documents id of transcript.
 * @param {string|Date|number} [m.startTime]
 * @param {string[]} [m.participantEmails]      - link to existing :Person by email.
 * @param {string} [m.ownerOrgId]
 * @returns {Promise<{id: string, participantsLinked: number}|null>}
 */
export async function mergeMeeting({
  sourceMeetingId,
  title = '',
  source = null,
  documentId = null,
  startTime = null,
  participantEmails = [],
  ownerOrgId = null,
} = {}) {
  // STOP condition (plan §STOP): no stable identifier → refuse. A node without
  // a merge key would duplicate on every re-ingest and pollute the graph.
  if (!sourceMeetingId || !String(sourceMeetingId).trim()) {
    log.warn('mergeMeeting: sourceMeetingId is required — skipping (no stable merge key)');
    return null;
  }
  if (!isGraphAvailable()) return null;

  const id = String(sourceMeetingId).trim();
  const startIso = toIsoOrNull(startTime);

  // ON CREATE SET origin_org (federation) + created_at; SET the mutable envelope
  // on every merge so a re-ingest (e.g. an edited TLDv transcript) refreshes it.
  const records = await runCypherCreate(
    `MERGE (m:Meeting {id: $id})
     ON CREATE SET m.origin_org = $origin_org, m.created_at = datetime()
     SET m.title = $title,
         m.source = $source,
         m.document_id = $documentId,
         m.start_time = $startTime,
         m.owner_org_id = $ownerOrgId,
         m.updated_at = datetime()
     RETURN m.id AS id`,
    {
      id,
      title: title || null,
      source: source || null,
      documentId: documentId || null,
      startTime: startIso,
      ownerOrgId: ownerOrgId || null,
    },
    { caller: 'mergeMeeting' },
  );

  if (records === null) return null; // graph write failed (best-effort)

  // Participant edges — best-effort, only to :Person nodes that already exist
  // (resolved by email). Non-resolvable participants are silently skipped; the
  // classifier does not create Person nodes (that is the contact-sync loop's job).
  let participantsLinked = 0;
  const emails = (Array.isArray(participantEmails) ? participantEmails : [])
    .map((e) => String(e || '').toLowerCase().trim())
    .filter(Boolean);
  if (emails.length > 0) {
    const edgeRecords = await runCypher(
      `UNWIND $emails AS email
       MATCH (p:Person {email: email})
       MATCH (m:Meeting {id: $id})
       MERGE (p)-[r:ATTENDED]->(m)
       ON CREATE SET r.created_at = datetime()
       RETURN count(r) AS linked`,
      { emails, id },
      { caller: 'mergeMeeting.participants' },
    );
    participantsLinked = edgeRecords?.[0] ? toPlainNumber(edgeRecords[0].get('linked')) : 0;
  }

  return { id, participantsLinked };
}
