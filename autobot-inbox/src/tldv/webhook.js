/**
 * TLDv webhook handler.
 * Receives "Transcript Ready" events from TLDv and feeds transcripts
 * into the document ingestion pipeline.
 *
 * Auth: send the shared secret in a request header, matched timing-safely
 * against TLDV_WEBHOOK_SECRET:
 *   Authorization: Bearer YOUR_SECRET      (preferred)
 *   X-Tldv-Secret: YOUR_SECRET             (alternative)
 * URL to configure in TLDv: https://preview.staqs.io/api/webhooks/tldv
 *
 * SECURITY (Plan 021): secrets must NOT live in the URL query string — reverse
 * proxies, access logs, and APM capture query strings and they leak via Referer.
 * The legacy `?secret=` query param is still accepted as a DEPRECATED fallback
 * for the cutover window only and emits a warning; remove it once TLDv is
 * reconfigured to send the header AND TLDV_WEBHOOK_SECRET has been rotated.
 *
 * Env vars:
 *   TLDV_WEBHOOK_SECRET — Required for webhook auth
 */

import { timingSafeEqual } from 'crypto';
import { createHash } from 'crypto';
import { withSystemOrgScope } from '../db.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';
import { ingestDocument } from '../rag/ingest.js';
import { emitMeetingReceived } from '../../../lib/runtime/emit-meeting-received.js';
import { extractFromTldvMeeting } from '../rag/participants/extractors.js';
import { normalize } from '../rag/normalizers/index.js';

// OPT-166 P2e-E3: the webhook ingest path writes only content.documents (no
// inbox.messages INSERT here — that's the poller). Its SELECT policy is
// tenancy.visible(NULL, owner_org_id) and the write policy is org-scoped
// (allow_system=FALSE), so both the dedup read and the ingestDocument writes
// need an org scope or they black-hole/fail post-flip. tl;dv is single-tenant →
// CURRENT_ORG_ID (Staqs internal). INERT today (superuser bypasses RLS). No
// system scope → this file is not a withSystemScope caller (ratchet unaffected).
const TLDV_WEBHOOK_AGENT_ID = 'tldv-webhook';

// Run `fn(exec)` with `exec` org-scoped (app.org_ids=[CURRENT_ORG_ID]) via
// withSystemOrgScope — reachable under REQUIRE_AGENT_JWT=true (this webhook
// holds no JWT principal), unlike the old withAgentScope path which threw for a
// plain-string id under enforcement and fell back to an unscoped read (which
// black-holes the dedup SELECT post-flip). FAIL CLOSED: no bare-`query`
// fallback.
async function withWebhookOrgScope(fn) {
  const scoped = await withSystemOrgScope(TLDV_WEBHOOK_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Handle incoming TLDv webhook.
 * @param {import('http').IncomingMessage} req
 * @param {Object} body - Parsed JSON body
 * @param {URL} url - Parsed request URL
 * @returns {Promise<Object>}
 */
export async function handleTldvWebhook(req, body, url) {
  // Auth: prefer a header the TLDv config can set (Authorization: Bearer <secret>
  // or X-Tldv-Secret). The legacy ?secret= query param is a DEPRECATED fallback
  // kept only for the cutover window (Plan 021).
  const expected = process.env.TLDV_WEBHOOK_SECRET || '';
  if (!expected) {
    console.error('[tldv-webhook] TLDV_WEBHOOK_SECRET not configured');
    throw Object.assign(new Error('Webhook not configured'), { statusCode: 500 });
  }

  const headerSecret = extractHeaderSecret(req);
  let authed = false;
  let via = 'none';
  if (headerSecret !== null) {
    via = 'header';
    authed = constantTimeEq(headerSecret, expected);
  } else {
    // DEPRECATED: legacy query-param auth. Retained only so already-configured
    // TLDv webhooks keep working until the operator reconfigures the header and
    // rotates the secret. Never log any part of the secret itself.
    const querySecret = url.searchParams.get('secret');
    if (querySecret !== null) {
      via = 'query';
      authed = constantTimeEq(querySecret, expected);
      if (authed) {
        console.warn('[tldv-webhook] DEPRECATED query-param auth accepted — reconfigure TLDv to send the Authorization header and rotate TLDV_WEBHOOK_SECRET (Plan 021)');
      }
    }
  }

  if (!authed) {
    // Log ONLY the received side, as presence/length booleans. Never derive any
    // log output from `expected` (the server secret) — that would hand an
    // attacker a preview of the live credential on demand.
    const received = via === 'header' ? headerSecret : (via === 'query' ? url.searchParams.get('secret') : null);
    console.warn(`[tldv-webhook] Invalid secret — auth failed (via=${via} received_present=${received !== null} received_len=${received?.length || 0})`);
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }

  // Extract transcript from payload
  // TLDv sends: { event: "TranscriptReady", data: { meetingId, ... } }
  const event = body?.event || body?.type;
  const data = body?.data || body;

  if (!event?.includes?.('Transcript') && !event?.includes?.('transcript')) {
    // Not a transcript event — acknowledge silently
    return { ok: true, message: 'Event ignored', event };
  }

  const meetingId = data?.meetingId || data?.meeting_id || data?.id;
  if (!meetingId) {
    console.warn('[tldv-webhook] No meetingId in payload');
    return { ok: false, error: 'Missing meetingId' };
  }

  // Extract segments from various payload shapes
  const segments = extractSegments(data);
  if (segments.length === 0) {
    console.warn(`[tldv-webhook] No transcript segments for meeting ${meetingId}`);
    return { ok: false, error: 'No transcript segments' };
  }

  // Build raw text in TLDv format for the normalizer
  const rawText = segments.map(s => {
    const speaker = s.speaker || 'Unknown';
    const time = s.startTime != null ? formatTime(s.startTime) : '00:00';
    return `[${time}](https://tldv.io/e/${meetingId}) ${speaker}: ${s.text}`;
  }).join('\n');

  const title = data?.name || data?.meetingName || `TLDv meeting ${meetingId}`;
  const contentHash = createHash('sha256')
    .update(segments.map(s => `${s.speaker || ''}:${s.text || ''}`).join('|'))
    .digest('hex')
    .slice(0, 16);
  const existing = await withWebhookOrgScope(exec => exec(
    `SELECT id, metadata FROM content.documents WHERE source = 'tldv' AND source_id = $1 LIMIT 1`,
    [meetingId]
  ));
  const existingHash = existing.rows[0]?.metadata?.contentHash || null;
  const forceUpdate = existing.rows.length > 0 && existingHash && existingHash !== contentHash;
  if (existing.rows.length > 0 && existingHash && existingHash === contentHash) {
    return { ok: true, meetingId, chunks: 0, embedded: false, skipped: 'unchanged' };
  }

  // Build structured participants from the invitees/organizer on the webhook
  // payload. This is the canonical attendee list — silent or phone-joined
  // participants (whose speaker labels get redacted like "+1 678-***-**47")
  // only appear here. Fall back to segments-only if the payload lacks it.
  const invitees = Array.isArray(data?.invitees) ? data.invitees : undefined;
  const organizer = data?.organizer || undefined;
  const normalizedSegments = normalize(rawText, 'tldv');
  const rawParticipants = extractFromTldvMeeting({
    segments: normalizedSegments,
    invitees,
    organizer,
  });

  // Ingest into document pipeline
  const result = await ingestDocument({
    source: 'tldv',
    sourceId: meetingId,
    title,
    rawText,
    format: 'tldv',
    metadata: {
      tldvMeetingId: meetingId,
      happenedAt: toIsoDate(data?.happenedAt || data?.created_at),
      url: data?.url,
      contentHash,
      segmentCount: segments.length,
      ingestSource: 'webhook',
    },
    rawParticipants,
    forceUpdate,
    writerOrgScope: { actorId: TLDV_WEBHOOK_AGENT_ID, orgId: CURRENT_ORG_ID },
  });

  if (result) {
    console.log(`[tldv-webhook] Ingested "${title}": ${result.chunkCount} chunks`);

    // STAQPRO-612: fire meeting.received → meeting→work classifier. Best-effort;
    // emit failure must not affect the webhook response.
    await emitMeetingReceived({
      documentId: result.documentId,
      transcriptSource: 'tldv',
      title,
      calendarEventId: data?.calendarEventId || data?.calendar_event_id || null,
      startTime: data?.happenedAt || data?.created_at || null,
      participantEmails: (rawParticipants || []).map((p) => p?.email).filter(Boolean),
      fallbackId: meetingId,
    });
  }

  return { ok: true, meetingId, chunks: result?.chunkCount || 0, embedded: result?.embedded || false };
}

/**
 * Extract segments from various TLDv payload shapes.
 * Brain-rag handled 4 shapes — we do the same.
 */
function extractSegments(data) {
  // Shape 1: data.data = array of segments
  if (Array.isArray(data?.data)) {
    return data.data.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 2: data.data.segments = array
  if (Array.isArray(data?.data?.segments)) {
    return data.data.segments.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 3: data.segments = array
  if (Array.isArray(data?.segments)) {
    return data.segments.filter(s => s?.text?.trim()).map(mapSegment);
  }
  // Shape 4: data.transcript = string (full text, no segments)
  if (typeof data?.transcript === 'string' && data.transcript.trim()) {
    return [{ speaker: undefined, text: data.transcript, startTime: undefined }];
  }
  return [];
}

function mapSegment(s) {
  return {
    speaker: s.speaker || s.speakerName,
    text: s.text || s.content || '',
    startTime: s.startTime ?? s.start_time,
    endTime: s.endTime ?? s.end_time,
  };
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * tl;dv sends `happenedAt` as JavaScript Date.toString() output, which
 * Postgres can't cast to timestamptz. Normalize to ISO. Returns null for
 * unparseable input so downstream code falls back to created_at.
 */
function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Extract the presented secret from a request header.
 * Prefers `Authorization: Bearer <secret>`, falls back to `X-Tldv-Secret`.
 * Node lowercases header names. Returns null when no auth header is present so
 * the caller can distinguish "no header" from "empty header".
 */
function extractHeaderSecret(req) {
  const headers = req?.headers || {};
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  const custom = headers['x-tldv-secret'];
  if (typeof custom === 'string') {
    return custom;
  }
  return null;
}

function constantTimeEq(a, b) {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
