/**
 * Emit a `meeting.received` signal after a transcript finishes ingestion
 * (STAQPRO-612).
 *
 * Best-effort: a failure here must NEVER break ingestion (the embeddings are the
 * primary artifact). Returns the created signal row or null. When no flow engine
 * is wired (tests, CLI one-shots) the emit is a graceful no-op.
 *
 * The emitted payload carries the full provenance the classifier needs
 * (document_id + source_meeting_id + transcript_source + title + owner_org_id);
 * FlowEngine.createSignal also lifts source_meeting_id/origin into dedicated
 * columns (migration 151).
 */

import { emitAdapterSignal } from '../adapters/registry.js';
import { computeSourceMeetingId } from './meeting-identity.js';
import { createLogger } from '../logger.js';

const log = createLogger('runtime/emit-meeting-received');

/**
 * @param {Object} args
 * @param {string} args.documentId         - content.documents id of the transcript.
 * @param {string} args.transcriptSource   - 'tldv' | 'gemini' | ...
 * @param {string} [args.title]
 * @param {string} [args.calendarEventId]  - calendar event id when known (wins).
 * @param {string|Date|number} [args.startTime]
 * @param {string[]} [args.participantEmails]
 * @param {string} [args.fallbackId]       - source meeting/doc id, last-resort stable key.
 * @param {string} [args.ownerOrgId]
 * @param {string} [args.projectId]
 * @returns {Promise<object|null>}
 */
export async function emitMeetingReceived({
  documentId,
  transcriptSource,
  title = '',
  calendarEventId = null,
  startTime = null,
  participantEmails = [],
  fallbackId = null,
  ownerOrgId = null,
} = {}) {
  if (!documentId) {
    log.warn('emitMeetingReceived: documentId is required — skipping');
    return null;
  }

  const sourceMeetingId = computeSourceMeetingId({
    calendarEventId,
    title,
    startTime,
    participantEmails,
    fallbackId: fallbackId || documentId,
  });

  const payload = {
    document_id: documentId,
    source_meeting_id: sourceMeetingId,
    transcript_source: transcriptSource || null,
    title,
    origin: 'meeting',
    owner_org_id: ownerOrgId || null,
  };

  try {
    return await emitAdapterSignal('meeting.received', payload, 'transcript_ingester');
  } catch (err) {
    // Isolated: never break ingestion on a signal-emit failure.
    log.warn(`meeting.received emit failed for document ${documentId}: ${err.message}`);
    return null;
  }
}
