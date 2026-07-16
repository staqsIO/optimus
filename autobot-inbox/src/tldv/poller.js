/**
 * TLDv transcript poller.
 * Ported from brain-rag src/lib/tldv-poll-sync.ts, adapted for Optimus.
 *
 * Polls TLDv API for latest meetings, fetches transcripts, and feeds them
 * into the document ingestion pipeline. Runs via scheduleService().
 *
 * Replaces brain-rag's BullMQ cron job (Railway 5-min minimum) with
 * Optimus's scheduleService (configurable interval, no external deps).
 *
 * Env vars:
 *   TLDV_API_KEY           — Required
 *   TLDV_POLL_INTERVAL_MS  — Poll interval (default: 5 min)
 */

import { createHash } from 'crypto';
import { query, withSystemOrgScope } from '../db.js';
import { withSystemScope } from '../../../lib/db.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';
import { fetchMeetingsPage, fetchTranscript } from './api.js';
import { ingestDocument } from '../rag/ingest.js';
import { emitMeetingReceived } from '../../../lib/runtime/emit-meeting-received.js';
import { extractFromTldvMeeting } from '../rag/participants/extractors.js';
import { normalize } from '../rag/normalizers/index.js';
import { createArtifact } from '../../../lib/content/create-artifact.js';
import { resolveCalendarEventId } from '../../../lib/content/calendar-reconciler.js';
import { stripNoteTakerBots, attendeeEmailsOf } from '../../../lib/rag/participants/normalize.js';

const TLDV_API_KEY = process.env.TLDV_API_KEY || '';
const MAX_PAGES = Math.max(1, Math.min(20, Number(process.env.TLDV_SYNC_MAX_PAGES || 6)));
const PAGE_SIZE = Math.max(5, Math.min(100, Number(process.env.TLDV_SYNC_PAGE_SIZE || 25)));
const LOOKBACK_DAYS = Math.max(1, Math.min(120, Number(process.env.TLDV_SYNC_LOOKBACK_DAYS || 30)));

// Hard ceiling for backfill jobs — keeps a runaway sync from sweeping the
// entire history into RAG in one click. Override per-call via maxPages.
const BACKFILL_MAX_PAGES = 200;

// OPT-166 P2e-E3: this poller writes to two RLS-governed tables. Under the pool
// flip (autobot_agent = NOBYPASSRLS) each needs a scope, or it silently breaks:
//   • content.documents — SELECT policy is tenancy.visible(NULL, owner_org_id)
//     and the write policy is org-scoped (allow_system=FALSE, E2). An unscoped
//     read black-holes to 0 rows (dedup misfires → duplicate ingest); an
//     unscoped write hard-fails. → org scope (withSystemOrgScope, app.org_ids).
//   • inbox.messages — INSERT policy system_insert_messages is
//     WITH CHECK (tenancy.is_system()) (sql/200); an unscoped INSERT hard-fails
//     42501. The SELECT/UPDATE policies are bare-permissive (USING true), so
//     only the INSERT needs a scope. → system scope (withSystemScope).
// tl;dv is single-tenant → CURRENT_ORG_ID (Staqs internal), matching the DB
// DEFAULT stamped on both tables by mig 134. LIVE: the pool runs as autobot_agent
// (NOBYPASSRLS) since the 2026-07-16 flip, so these scopes are load-bearing.
const TLDV_AGENT_ID = 'tldv-poller';

// Run `fn(exec)` with `exec` bound to an org-scoped (app.org_ids=[CURRENT_ORG_ID])
// query. FAIL CLOSED: withSystemOrgScope works identically with REQUIRE_AGENT_JWT
// on or off (no plain-string withAgentScope, no bare-`query` fallback) — an
// unscoped read here black-holes to 0 rows under RLS and misfires the dedup.
async function withTldvOrgScope(fn) {
  const scoped = await withSystemOrgScope(TLDV_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

// Run `fn(exec)` with `exec` bound to a system-scoped (app.role=system) query so
// the inbox.messages INSERT satisfies tenancy.is_system() post-flip. FAIL CLOSED:
// no bare-`query` fallback — an unscoped INSERT hard-fails 42501 anyway.
async function withTldvSystemScope(fn) {
  const scoped = await withSystemScope(TLDV_AGENT_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Hash transcript content for change detection.
 * Skip re-ingestion if transcript hasn't changed.
 */
function hashTranscript(segments) {
  const content = segments.map(s => `${s.speaker || ''}:${s.text || ''}`).join('|');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Poll TLDv for the latest meeting and ingest its transcript.
 * Called by scheduleService in index.js.
 *
 * @returns {Promise<{ scanned: number, ingested: number, skipped: number, errors: number }>}
 */
export async function pollTldvTranscripts() {
  if (!TLDV_API_KEY) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };

  try {
    const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    let page = 1;
    let keepPaging = true;

    while (keepPaging && page <= MAX_PAGES) {
      const list = await fetchMeetingsPage(TLDV_API_KEY, page, PAGE_SIZE);
      if (!list.ok) {
        console.warn(`[tldv] Failed to fetch meetings page=${page}: ${list.status} ${list.body?.slice(0, 100)}`);
        stats.errors++;
        break;
      }

      const meetings = list.page?.results || [];
      if (meetings.length === 0) break;
      stats.scanned += meetings.length;

      for (const meeting of meetings) {
        const meetingId = meeting.id;
        if (!meetingId) continue;
        const happenedAtMs = meeting.happenedAt ? Date.parse(meeting.happenedAt) : Number.NaN;
        if (Number.isFinite(happenedAtMs) && happenedAtMs < cutoffMs) {
          keepPaging = false;
          break;
        }

        const outcome = await ingestTldvMeeting(meeting, { apiKey: TLDV_API_KEY });
        stats[outcome.status] = (stats[outcome.status] || 0) + 1;
      }
      page += 1;
    }
  } catch (err) {
    console.error(`[tldv] Poll error: ${err.message}`);
    stats.errors++;
  }

  if (stats.ingested > 0 || stats.errors > 0) {
    console.log(`[tldv] Poll complete: scanned=${stats.scanned} ingested=${stats.ingested} skipped=${stats.skipped} errors=${stats.errors}`);
  }

  return stats;
}

/**
 * Ingest a single tl;dv meeting. Shared between the periodic poller and the
 * one-shot backfill endpoint so they stay byte-for-byte consistent on
 * dedup, hashing, participant merging, and forceUpdate behaviour.
 *
 * @param {Object} meeting - tl;dv meeting object (id, name, happenedAt, …)
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @returns {Promise<{ status: 'ingested' | 'skipped' | 'errors', reason?: string }>}
 */
/**
 * @param {Object} meeting - TLDv meeting payload
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {boolean} [opts.skipWorkItem=false] - When true, do not create the
 *   `inbox.messages` row or the triage `agent_graph.work_items` row for this
 *   meeting. Used by historic backfills (STAQPRO-325) so the agent queue
 *   doesn't get flooded with year-old "action items" while we just want the
 *   transcript in the RAG corpus for context.
 */
export async function ingestTldvMeeting(meeting, { apiKey, skipWorkItem = false }) {
  const meetingId = meeting?.id;
  if (!meetingId) return { status: 'skipped', reason: 'no_meeting_id' };

  const existing = await withTldvOrgScope(exec => exec(
    `SELECT id, metadata FROM content.documents WHERE source = 'tldv' AND source_id = $1`,
    [meetingId]
  ));

  const tr = await fetchTranscript(apiKey, meetingId);
  if (!tr.ok) {
    if (tr.status === 404) return { status: 'skipped', reason: 'transcript_not_ready' };
    // 204 No Content = TLDv has nothing to transcribe (silent meeting, no-show, etc).
    // Terminal: no retry will conjure speech that wasn't there. (STAQPRO-283)
    if (tr.status === 204) return { status: 'skipped', reason: 'no_transcript_content' };
    console.warn(`[tldv] Transcript failed for ${meetingId}: ${tr.status}`);
    return { status: 'errors', reason: `http_${tr.status}` };
  }

  const segments = tr.transcript?.data || [];
  if (segments.length === 0) return { status: 'skipped', reason: 'empty_transcript' };

  const rawText = segments.map(s => {
    const speaker = s.speaker || 'Unknown';
    const time = s.startTime != null ? formatTime(s.startTime) : '00:00';
    return `[${time}](https://tldv.io/e/${meetingId}) ${speaker}: ${s.text}`;
  }).join('\n');

  const contentHash = hashTranscript(segments);
  const title = meeting.name || `TLDv meeting ${meetingId}`;
  const existingHash = existing.rows[0]?.metadata?.contentHash || null;
  const shouldForceUpdate = existing.rows.length > 0 && existingHash && existingHash !== contentHash;
  const unchanged = existing.rows.length > 0 && existingHash && existingHash === contentHash;

  // Ensure inbox.messages + triage work-item exist before deciding whether to
  // skip on unchanged-hash. Without this row, /api/today/meetings can't reach
  // the meeting (its LEFT JOIN misses) and the signal pipeline never runs, so
  // action_items always come back empty. Idempotent — no-op once present.
  // The Drive watcher path already does this; this is the equivalent for the
  // poller, including for meetings ingested before this code existed.
  //
  // Backfill jobs (STAQPRO-325) opt out via skipWorkItem so we don't flood
  // the orchestrator with year-old meetings that would otherwise surface as
  // fresh action items. For meetings that are ingested or updated below, this
  // only gates inbox/triage creation; the document still lands in
  // `content.documents` and participant/contact updates still happen during
  // ingest. Unchanged meetings still return early below before that work runs.
  if (!skipWorkItem) {
    await ensureTldvMessageAndWorkItem({
      meetingId,
      title,
      rawText,
      happenedAtIso: toIsoDate(meeting.happenedAt) || new Date().toISOString(),
      fromName: meeting.organizer?.name || meeting.organizer?.email || 'tl;dv',
      provenance: 'poll',
    });
  }

  if (unchanged) return { status: 'skipped', reason: 'unchanged' };

  const normalizedSegments = normalize(rawText, 'tldv');
  const rawParticipants = extractFromTldvMeeting({
    segments: normalizedSegments,
    invitees: Array.isArray(meeting.invitees) ? meeting.invitees : undefined,
    organizer: meeting.organizer || undefined,
  });

  const result = await ingestDocument({
    source: 'tldv',
    sourceId: meetingId,
    title,
    rawText,
    format: 'tldv',
    metadata: {
      tldvMeetingId: meetingId,
      happenedAt: toIsoDate(meeting.happenedAt),
      url: meeting.url,
      contentHash,
      segmentCount: segments.length,
    },
    rawParticipants,
    forceUpdate: shouldForceUpdate,
    writerOrgScope: { actorId: TLDV_AGENT_ID, orgId: CURRENT_ORG_ID },
  });

  if (result && result.chunkCount > 0) {
    console.log(
      `[tldv] ${shouldForceUpdate ? 'Updated' : 'Ingested'}: "${title}" (${result.chunkCount} chunks, embedded=${result.embedded})`
    );

    // Feature 007: meeting identity for the artifact + signal, computed ONCE so
    // the content.meetings fingerprint and the signal's source_meeting_id agree
    // (they are the hub join key). Bots stripped from the roster; when TLDv
    // doesn't carry a calendarEventId, the reconciler tries to recover one from
    // inbox.calendar_events — the cross-source bridge to Gemini-on-Drive.
    const humanParticipants = stripNoteTakerBots(rawParticipants);
    const participantEmails = attendeeEmailsOf(humanParticipants);
    let calendarEventId = meeting.calendarEventId || meeting.calendar_event_id || null;
    if (!calendarEventId && meeting.happenedAt) {
      try {
        const rec = await resolveCalendarEventId({
          startTime: meeting.happenedAt,
          title,
          attendeeEmails: participantEmails,
        });
        if (rec) calendarEventId = rec.calendarEventId;
      } catch (err) {
        console.warn(`[tldv] reconciler failed for ${meetingId}: ${err.message}`);
      }
    }

    // Feature 007 (3d): register the transcript in the artifact registry under
    // the meeting hierarchy. OPT-IN via TLDV_OWNER_ORG_ID (the TLDv workspace has
    // exactly one board-validated owning org; unset = no artifact write — P1, no
    // silent Staqs). documentId reuses the ingest above (no double-embedding).
    // Live path only: backfills (skipWorkItem) would flood the enrichment queue
    // with year-old meetings — same flood logic as the work-item opt-out.
    const tldvOwnerOrgId = (process.env.TLDV_OWNER_ORG_ID || '').trim();
    if (!skipWorkItem && tldvOwnerOrgId) {
      try {
        await createArtifact({
          raw: rawText,
          kind: 'transcript',
          title,
          source_system: 'tldv',
          ownerOrgId: tldvOwnerOrgId,
          metadata: { tldvMeetingId: meetingId, happenedAt: toIsoDate(meeting.happenedAt), url: meeting.url },
          documentId: result.documentId,
          meeting: {
            calendarEventId,
            title,
            startTime: meeting.happenedAt || null,
            participantEmails,
            participants: humanParticipants,
            fallbackId: meetingId,
          },
        });
      } catch (err) {
        console.warn(`[tldv] artifact registration failed for ${meetingId}: ${err.message}`);
      }
    }

    // STAQPRO-612: fire meeting.received → meeting→work classifier. Best-effort.
    // Skip for backfill sweeps (skipWorkItem) so year-old meetings don't surface
    // as fresh tasks — mirrors the inbox/triage opt-out above.
    if (!skipWorkItem) {
      // Best-effort + isolated (Linus): a failure anywhere in the emit path must
      // never abort this meeting's ingestion iteration.
      try {
        await emitMeetingReceived({
          documentId: result.documentId,
          transcriptSource: 'tldv',
          title,
          calendarEventId,
          startTime: meeting.happenedAt || null,
          participantEmails,
          fallbackId: meetingId,
        });
      } catch (err) {
        console.warn(`[tldv-poller] meeting.received emit failed for ${meetingId}: ${err.message}`);
      }
    }

    return { status: 'ingested' };
  }
  return { status: 'skipped', reason: 'no_chunks' };
}

let backfillRunning = false;

/**
 * Backfill tl;dv transcripts across the entire history (or a custom window).
 * One job at a time — concurrent calls return immediately with an "already
 * running" signal so the UI can poll instead of stacking duplicate sweeps.
 *
 * @param {Object} [opts]
 * @param {number}  [opts.lookbackDays] - Cap on how far back to scan. Omit to go all the way.
 * @param {number}  [opts.maxPages]     - Cap on pages walked (defaults to BACKFILL_MAX_PAGES).
 * @param {number}  [opts.pageSize]     - Per-page meeting count (defaults to PAGE_SIZE).
 * @param {boolean} [opts.skipWorkItem] - When true, ingest transcripts into the
 *   RAG corpus without creating inbox.messages / agent_graph.work_items rows.
 *   Used for historic backfills (STAQPRO-325) where we want context but not
 *   fresh action items.
 * @returns {Promise<{ ok: boolean, stats: Object } | { ok: false, error: string }>}
 */
export async function backfillTldvTranscripts(opts = {}) {
  if (!TLDV_API_KEY) return { ok: false, error: 'TLDV_API_KEY not set' };
  if (backfillRunning) return { ok: false, error: 'backfill_already_running' };

  const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  const cap = Math.max(1, Math.min(BACKFILL_MAX_PAGES, Number(opts.maxPages) || BACKFILL_MAX_PAGES));
  const pageSize = Math.max(5, Math.min(100, Number(opts.pageSize) || PAGE_SIZE));
  const cutoffMs = Number.isFinite(Number(opts.lookbackDays))
    ? Date.now() - Number(opts.lookbackDays) * 24 * 60 * 60 * 1000
    : null;

  const skipWorkItem = !!opts.skipWorkItem;

  backfillRunning = true;
  try {
    let page = 1;
    let keepPaging = true;
    while (keepPaging && page <= cap) {
      const list = await fetchMeetingsPage(TLDV_API_KEY, page, pageSize);
      if (!list.ok) {
        console.warn(`[tldv-backfill] page ${page} failed: ${list.status}`);
        stats.errors++;
        break;
      }
      const meetings = list.page?.results || [];
      if (meetings.length === 0) break;
      stats.scanned += meetings.length;

      for (const meeting of meetings) {
        if (cutoffMs !== null) {
          const ts = meeting.happenedAt ? Date.parse(meeting.happenedAt) : Number.NaN;
          if (Number.isFinite(ts) && ts < cutoffMs) {
            keepPaging = false;
            break;
          }
        }
        // STAQPRO-325: defense-in-depth — one meeting's unexpected error
        // (Postgres timeout, ingest pipeline blow-up, etc.) shouldn't kill
        // the full historic backfill. tldvFetch already wraps network/abort
        // errors; this catches everything else and treats it like the
        // existing `errors` bucket.
        let outcome;
        try {
          outcome = await ingestTldvMeeting(meeting, {
            apiKey: TLDV_API_KEY,
            skipWorkItem,
          });
        } catch (err) {
          console.warn(`[tldv-backfill] ingest crashed for meeting=${meeting?.id}: ${err?.message || err}`);
          outcome = { status: 'errors', reason: 'ingest_threw' };
        }
        stats[outcome.status] = (stats[outcome.status] || 0) + 1;
      }
      page += 1;
    }
    console.log(`[tldv-backfill] complete: scanned=${stats.scanned} ingested=${stats.ingested} skipped=${stats.skipped} errors=${stats.errors} skipWorkItem=${skipWorkItem}`);
    return { ok: true, stats };
  } finally {
    backfillRunning = false;
  }
}

export function isTldvBackfillRunning() {
  return backfillRunning;
}

/**
 * Idempotent: ensure an inbox.messages row + triage work-item exist for a
 * tl;dv meeting, so signal extraction runs and /api/today/meetings can find
 * the meeting via its LEFT JOIN. Returns the message id; no-op when already
 * present. `provenance` is appended as a label tag ('poll' or 'backfill') so
 * we can tell from the row how it got created.
 */
async function ensureTldvMessageAndWorkItem({
  meetingId,
  title,
  rawText,
  happenedAtIso,
  fromName,
  provenance,
}) {
  const existing = await query(
    `SELECT id, length(snippet) AS snippet_len FROM inbox.messages
     WHERE channel = 'webhook' AND channel_id = $1 LIMIT 1`,
    [meetingId]
  );
  const snippet = (rawText || '').slice(0, 200_000);

  if (existing.rows.length > 0) {
    // Refresh snippet if the stored copy is materially shorter than what we
    // have now. Older messages were ingested under a 15K truncation; without
    // the refresh, triage sees only the first ~20 minutes of long meetings.
    const storedLen = existing.rows[0].snippet_len || 0;
    if (snippet.length > storedLen + 1000) {
      await query(
        `UPDATE inbox.messages SET snippet = $1 WHERE id = $2`,
        [snippet, existing.rows[0].id]
      );
    }
    return existing.rows[0].id;
  }

  const providerMsgId = `tldv_${meetingId}`;
  const labels = ['webhook:tldv', 'tldv:transcript', `tldv:${provenance}`];

  // System-scoped: inbox.messages INSERT policy is WITH CHECK (tenancy.is_system())
  // (sql/200). owner_org_id is intentionally omitted — the role-gated policy lands
  // the DB DEFAULT (Staqs internal, mig 138). INERT pre-flip. (OPT-166 P2e-E3)
  const inserted = await withTldvSystemScope(exec => exec(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      providerMsgId, 'webhook', 'webhook',
      `wh_thread_${providerMsgId}`, `<${providerMsgId}@webhook>`,
      'tldv', fromName || 'tl;dv', ['system@autobot'],
      title, snippet,
      happenedAtIso, labels,
      false, meetingId,
    ]
  ));
  const msgId = inserted.rows[0]?.id;
  if (!msgId) return null;

  // Live poll → priority 0 (preempts re-extraction). Backfill → priority -10
  // so it sinks below any newly-arriving meeting work.
  const { createWorkItem } = await import('../runtime/state-machine.js');
  const workItem = await createWorkItem({
    type: 'task',
    title: `tl;dv: ${title}`,
    description: `tldv transcript (${provenance})`,
    createdBy: 'orchestrator',
    assignedTo: 'executor-triage',
    priority: provenance === 'backfill' ? -10 : 0,
    metadata: { email_id: msgId, provider_msg_id: providerMsgId, webhook_source: 'tldv' },
  });
  if (workItem) {
    await query(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, msgId]);
  }
  return msgId;
}

let messagesBackfillRunning = false;

/**
 * Backfill inbox.messages rows for tl;dv documents that landed in
 * content.documents before the poller wrote message rows. For each missing
 * one, re-fetch the transcript from the tl;dv API, then insert the message
 * and enqueue triage. RAG already has the document, so no re-ingest.
 *
 * Re-runnable: the dedup SELECT inside the helper makes it a no-op once a
 * row exists. tl;dv-side deletes are tolerated — fetchTranscript 4xx → skip.
 */
export async function backfillTldvMessages({ apiKey = TLDV_API_KEY } = {}) {
  if (!apiKey) return { ok: false, error: 'TLDV_API_KEY not set' };
  if (messagesBackfillRunning) return { ok: false, error: 'backfill_already_running' };

  const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  messagesBackfillRunning = true;
  try {
    // Org-scoped: the content.documents SELECT policy is tenancy.visible(NULL,
    // owner_org_id); unscoped it black-holes post-flip → backfill would see 0
    // rows and silently do nothing. The NOT EXISTS on inbox.messages resolves
    // under its bare-permissive SELECT policy (USING true). INERT pre-flip.
    const { rows } = await withTldvOrgScope(exec => exec(
      `SELECT d.source_id              AS meeting_id,
              d.title                  AS title,
              d.metadata->>'happenedAt' AS happened_at_raw
       FROM content.documents d
       WHERE d.source = 'tldv'
         AND d.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM inbox.messages m
           WHERE m.channel = 'webhook' AND m.channel_id = d.source_id
         )`
    ));
    stats.scanned = rows.length;

    for (const row of rows) {
      const meetingId = row.meeting_id;
      try {
        const tr = await fetchTranscript(apiKey, meetingId);
        if (!tr.ok) { stats.skipped++; continue; }
        const segments = tr.transcript?.data || [];
        if (segments.length === 0) { stats.skipped++; continue; }

        const rawText = segments.map(s => {
          const speaker = s.speaker || 'Unknown';
          const time = s.startTime != null ? formatTime(s.startTime) : '00:00';
          return `[${time}](https://tldv.io/e/${meetingId}) ${speaker}: ${s.text}`;
        }).join('\n');

        const msgId = await ensureTldvMessageAndWorkItem({
          meetingId,
          title: row.title || `TLDv meeting ${meetingId}`,
          rawText,
          happenedAtIso: toIsoDate(row.happened_at_raw) || new Date().toISOString(),
          fromName: 'tl;dv',
          provenance: 'backfill',
        });
        if (msgId) stats.ingested++;
        else stats.errors++;
      } catch (err) {
        console.warn(`[tldv-msg-backfill] ${meetingId} failed: ${err.message}`);
        stats.errors++;
      }
    }
    console.log(`[tldv-msg-backfill] complete: scanned=${stats.scanned} ingested=${stats.ingested} skipped=${stats.skipped} errors=${stats.errors}`);
    return { ok: true, stats };
  } finally {
    messagesBackfillRunning = false;
  }
}

export function isTldvMessagesBackfillRunning() {
  return messagesBackfillRunning;
}

/**
 * tl;dv sends `happenedAt` as JavaScript Date.toString() output, which
 * Postgres can't cast to timestamptz. Normalize to ISO on ingest. Returns
 * null for unparseable input so downstream code falls back to created_at.
 */
function toIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Format seconds to MM:SS */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
