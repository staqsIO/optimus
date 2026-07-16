import { randomUUID, timingSafeEqual } from 'crypto';
import { query, withTransaction } from '../db.js';
import { withSystemScope, withSystemOrgScope } from '../../../lib/db.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';
import {
  requestTranscript,
  fetchTranscript,
  formatWithSpeakers,
} from '../../../lib/transcription/assemblyai.js';
import { ingestDocument } from '../../../lib/rag/ingest.js';
import { resolveAssemblyAISpeakers } from '../../../lib/voice/speaker-resolver.js';
import { uploadBuffer, voiceMemoKey } from '../../../lib/storage/r2.js';

// OPT-166 P3-B5 — this webhook writes to two RLS-governed tables (same shape as
// the tldv-poller precedent, PR #574 / OPT-166 P2e-E3):
//   • inbox.messages   — INSERT policy system_insert_messages is
//     WITH CHECK (tenancy.is_system()) (sql/200); unscoped INSERT hard-fails
//     42501 post-flip. SELECT/UPDATE on this table are bare-permissive
//     (USING true), so only the INSERT itself needs a scope. → system scope.
//   • content.documents — SELECT/UPDATE are org-scoped (tenancy.visible /
//     allow_system=FALSE, E2); an unscoped write hard-fails, an unscoped read
//     black-holes. Single-tenant → CURRENT_ORG_ID (Staqs internal), matching
//     the DB DEFAULT stamped by mig 134. → org scope (withAgentScope).
// INERT today: the pool connects as a BYPASSRLS superuser, so RLS is inert
// until the flip; the wiring runs live now.
const VOICE_MEMO_AGENT_ID = 'voice-memo-intake';

// System-scoped (app.role=system) query for the inbox.messages INSERT. Runs in
// its OWN transaction, deliberately outside the caller's withTransaction block
// (setAgentContext refuses role='system' without the module-private
// SYSTEM_ROLE_GUARD symbol, which only withSystemScope holds — there is no way
// to fold this into the surrounding client transaction). This is safe here
// specifically because the existing ON CONFLICT + orphan-recovery logic below
// already tolerates the messages row committing independently of the work-item
// creation (a crash-recovery path that predates this change) — see the
// "Recovering orphan messages row" branch.
// OPT-166 P3-B6: fail-closed. This guards a WRITE (inbox.messages INSERT) —
// no catch-and-fallback to an unscoped query. If withSystemScope throws, the
// error propagates and the route layer returns 500.
async function withVoiceMemoSystemScope(fn) {
  const scoped = await withSystemScope(VOICE_MEMO_AGENT_ID, { reason: 'voice-memo-webhook-ingest' });
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

// Org-scoped (app.org_ids=[CURRENT_ORG_ID]) query for the post-ingest
// content.documents compile_status write. Uses withSystemOrgScope so it is
// reachable under REQUIRE_AGENT_JWT=true (this webhook holds no JWT principal) —
// withAgentScope would throw on the plain-string id under enforcement.
// OPT-166 P3-B6: fail-closed. This guards a WRITE (content.documents
// compile_status UPDATE) — no catch-and-fallback to an unscoped query.
async function withVoiceMemoOrgScope(fn) {
  const scoped = await withSystemOrgScope(VOICE_MEMO_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Voice memo ingest routes.
 *
 *   POST /api/voice-memo/upload     — Apple Shortcut posts base64 audio + metadata.
 *                                     We upload to AssemblyAI, kick off transcription,
 *                                     return 202 with a tracking id. Auth: Bearer
 *                                     WEBHOOK_BEARER_VOICE_MEMO.
 *
 *   POST /api/webhooks/assemblyai   — AssemblyAI calls us back when transcription
 *                                     finishes. We fetch the transcript, format with
 *                                     speaker labels, and drop into the standard
 *                                     inbox/executor-triage pipeline. Auth: per-request
 *                                     X-Optimus-Webhook-Auth header configured on the
 *                                     AssemblyAI side.
 *
 * Pipeline shape mirrors the existing webhook ingest (api.js POST /api/webhooks/:source):
 * insert into inbox.messages with channel='webhook' + label 'webhook:voice_memo',
 * then createWorkItem assigned to executor-triage.
 */

const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB raw audio

function sourceBearerAuthed(req) {
  const expected = process.env.WEBHOOK_BEARER_VOICE_MEMO;
  if (!expected) return false; // P1: deny by default
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const presented = Buffer.from(authHeader.slice(7));
  const expectedBuf = Buffer.from(expected);
  if (presented.length !== expectedBuf.length) return false;
  return timingSafeEqual(presented, expectedBuf);
}

function callbackAuthed(req) {
  const expected = process.env.WEBHOOK_AUTH_ASSEMBLYAI_VALUE;
  if (!expected) return false; // P1: deny by default
  const presented = req.headers['x-optimus-webhook-auth'] || '';
  if (!presented) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function apiBaseUrl() {
  return process.env.OPTIMUS_API_BASE_URL || 'https://preview.staqs.io';
}

export function registerVoiceMemoRoutes(routes) {
  routes.set('POST /api/voice-memo/upload', async (req, _body) => {
    if (!sourceBearerAuthed(req)) {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }

    // Body is raw audio bytes (Apple Shortcut sends with WFHTTPBodyType=File).
    // parseBody captured them on req.rawBody.
    const audioBuffer = req.rawBody;
    if (!audioBuffer || audioBuffer.length === 0) {
      throw Object.assign(new Error('request body must be raw audio bytes'), { statusCode: 400 });
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error(`audio exceeds ${MAX_AUDIO_BYTES} bytes`), { statusCode: 413 });
    }

    // Metadata travels in URL query params.
    const url = new URL(req.url, 'http://localhost');
    const name = String(url.searchParams.get('name') || 'Voice Memo').slice(0, 255);
    const recordedAt = String(url.searchParams.get('recordedAt') || new Date().toISOString()).slice(0, 64);
    const device = String(url.searchParams.get('device') || 'unknown').slice(0, 100);
    // The Shortcut may pass an uploader hint; we ignore it for speaker
    // labeling (only enrolled voiceprints can name a speaker), but keep it
    // in metadata for audit. Stored column kept for schema compatibility.
    const uploaderHint = String(url.searchParams.get('uploaderHint') || '').slice(0, 100);

    const trackingId = randomUUID();
    // Store audio in our own R2 bucket so the AssemblyAI webhook handler
    // can re-fetch it for voiceprint matching. AssemblyAI's own
    // cdn.assemblyai.com upload URLs fail TLS validation
    // (ERR_TLS_CERT_ALTNAME_INVALID) when fetched from outside their
    // pipeline, which broke the speaker resolver.
    const audioUrl = await uploadBuffer({
      buffer: audioBuffer,
      key: voiceMemoKey('m4a'),
      contentType: 'audio/m4a',
    });

    const transcriptId = await requestTranscript({
      audioUrl,
      webhookUrl: `${apiBaseUrl()}/api/webhooks/assemblyai`,
      webhookAuthHeader: process.env.WEBHOOK_AUTH_ASSEMBLYAI_VALUE
        ? { name: 'X-Optimus-Webhook-Auth', value: process.env.WEBHOOK_AUTH_ASSEMBLYAI_VALUE }
        : undefined,
      speakerLabels: true,
    });

    await query(
      `INSERT INTO inbox.voice_memo_pending
        (tracking_id, transcript_id, audio_url, uploaded_by, primary_speaker, metadata, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [
        trackingId,
        transcriptId,
        audioUrl,
        uploaderHint,
        uploaderHint,
        JSON.stringify({ name, recordedAt, device, audioBytes: audioBuffer.length }),
      ]
    );

    console.log(`[voice-memo] Upload accepted: tracking=${trackingId} transcript=${transcriptId} bytes=${audioBuffer.length}`);
    return { trackingId, transcriptId, status: 'pending' };
  });

  routes.set('POST /api/webhooks/assemblyai', async (req, body) => {
    if (!callbackAuthed(req)) {
      console.warn('[voice-memo] AssemblyAI callback auth failed');
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }

    const { createWorkItem } = await import('../runtime/state-machine.js');
    const { notify } = await import('../runtime/event-bus.js');

    const transcriptId = String(body.transcript_id || '');
    const status = String(body.status || '');
    if (!transcriptId) {
      throw Object.assign(new Error('transcript_id is required'), { statusCode: 400 });
    }

    // Atomic ingest. Claim → fetch transcript → INSERT messages → createWorkItem
    // → UPDATE messages.work_item_id → UPDATE pending complete. Any throw rolls
    // back the claim AND the messages row AND the work item, so the next
    // AssemblyAI retry callback can re-claim cleanly. RAG ingest stays outside
    // (idempotent on its own dedup key; failure must not unwind ingest state).
    const result = await withTransaction(async (client) => {
      // Atomic claim: WHERE status='pending' guarantees one concurrent callback wins.
      const claimResult = await client.query(
        `UPDATE inbox.voice_memo_pending
            SET status = 'processing'
          WHERE transcript_id = $1 AND status = 'pending'
          RETURNING id, tracking_id, primary_speaker, audio_url, metadata`,
        [transcriptId]
      );
      const pending = claimResult.rows[0];
      if (!pending) {
        console.warn(`[voice-memo] AssemblyAI callback skipped (unknown or already claimed): ${transcriptId}`);
        return { skipped: true, reason: 'unknown or already processed' };
      }

      if (status === 'error') {
        const errorMsg = String(body.error || 'unknown AssemblyAI error').slice(0, 500);
        await client.query(
          `UPDATE inbox.voice_memo_pending
              SET status = 'failed', failure_reason = $1, completed_at = now()
            WHERE id = $2`,
          [errorMsg, pending.id]
        );
        console.error(`[voice-memo] AssemblyAI transcription failed for ${transcriptId}: ${errorMsg}`);
        return { failed: true };
      }

      const transcript = await fetchTranscript(transcriptId);

      // Resolve AssemblyAI speaker labels (A/B/C) to enrolled voiceprints
      // when we have any. Cheap fast-path: if no one is enrolled, the
      // resolver returns an empty Map without touching audio.
      //
      // We re-fetch from our own R2 audio_url, not transcript.audio_url —
      // AssemblyAI's CDN URLs fail TLS validation when fetched outside their
      // pipeline (ERR_TLS_CERT_ALTNAME_INVALID).
      let speakerOverrides = new Map();
      try {
        if (pending.audio_url && Array.isArray(transcript.utterances) && transcript.utterances.length > 0) {
          const audioRes = await fetch(pending.audio_url);
          if (audioRes.ok) {
            const audioBuf = Buffer.from(await audioRes.arrayBuffer());
            speakerOverrides = await resolveAssemblyAISpeakers(
              (sql, params) => client.query(sql, params),
              audioBuf,
              transcript.utterances,
              { memoId: pending.id, captureUnmatched: true },
            );
            if (speakerOverrides.size > 0) {
              const matched = [...speakerOverrides.entries()]
                .map(([label, m]) => `${label}=${m.displayName}(${m.score})`)
                .join(', ');
              console.log(`[voice-memo] Speaker matches: ${matched}`);
            } else {
              console.log(`[voice-memo] No voiceprint match for transcript ${transcriptId}; speakers will be labeled A/B/C`);
            }
          } else {
            console.warn(`[voice-memo] R2 audio fetch returned ${audioRes.status} for ${pending.audio_url}`);
          }
        }
      } catch (e) {
        console.warn(`[voice-memo] Speaker resolution failed (non-fatal): ${e.message}`);
      }

      // No primarySpeaker fallback — speaker names come exclusively from
      // matched voiceprints. Unmatched labels stay as "Speaker A/B/C".
      const { text: formattedText, speakers } = formatWithSpeakers(
        transcript.utterances || [],
        null,
        speakerOverrides,
      );

      const pendingMetadata = pending.metadata || {};
      const title = String(pendingMetadata.name || 'Voice Memo').slice(0, 500);
      const snippet = (formattedText || transcript.text || '').slice(0, 4000);
      const recordedAt = pendingMetadata.recordedAt || new Date().toISOString();

      // OPT-166 P3-B5: system-scoped — see withVoiceMemoSystemScope above.
      // Runs in its own transaction, separate from `client`'s. If a later step
      // in this withTransaction block throws, `client`'s claim UPDATE rolls
      // back but this INSERT (already committed) survives — the next
      // AssemblyAI retry callback re-claims, hits ON CONFLICT here, and takes
      // the "recover orphan messages row" branch below, which was already
      // designed to handle exactly this partial-completion shape.
      const msgResult = await withVoiceMemoSystemScope(exec => exec(
        `INSERT INTO inbox.messages
          (provider_msg_id, provider, channel, thread_id, message_id,
           from_address, from_name, to_addresses, subject, snippet,
           received_at, labels, has_attachments, channel_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (provider_msg_id) WHERE provider_msg_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          transcriptId,
          'webhook',
          'webhook',
          `wh_thread_${transcriptId}`,
          `<${transcriptId}@assemblyai>`,
          pending.primary_speaker,
          'voice_memo',
          ['system@autobot'],
          title,
          snippet,
          recordedAt,
          ['webhook:voice_memo'],
          false,
          transcriptId,
        ]
      ));

      let msgId = msgResult.rows[0]?.id;
      if (!msgId) {
        // ON CONFLICT fired. Either (a) a prior crashed attempt already INSERTed
        // this messages row but never created the work item — recover by reusing
        // the row, or (b) the work item already exists — clean-skip.
        const existingMsg = await client.query(
          `SELECT id, work_item_id FROM inbox.messages WHERE provider_msg_id = $1`,
          [transcriptId]
        );
        const existingRow = existingMsg.rows[0];
        if (!existingRow) {
          throw new Error(`provider_msg_id ${transcriptId} hit ON CONFLICT but row not found`);
        }
        if (existingRow.work_item_id) {
          await client.query(
            `UPDATE inbox.voice_memo_pending
                SET status = 'completed', work_item_id = $1, message_id = $2, completed_at = now()
              WHERE id = $3`,
            [existingRow.work_item_id, existingRow.id, pending.id]
          );
          console.log(`[voice-memo] Duplicate transcript ${transcriptId} — work_item ${existingRow.work_item_id} already exists, pending reconciled`);
          return { skipped: true, reason: 'duplicate, work_item already exists' };
        }
        msgId = existingRow.id;
        console.warn(`[voice-memo] Recovering orphan messages row for ${transcriptId} — creating missing work item`);
      }

      const workItem = await createWorkItem({
        type: 'task',
        title: `Voice Memo: ${title}`,
        description: `In-person meeting transcribed via AssemblyAI (${Object.keys(speakers).length} speaker${Object.keys(speakers).length === 1 ? '' : 's'})`,
        createdBy: 'orchestrator',
        assignedTo: 'executor-triage',
        priority: 0,
        metadata: {
          email_id: msgId,
          provider_msg_id: transcriptId,
          webhook_source: 'voice_memo',
          tracking_id: pending.tracking_id,
          transcript_id: transcriptId,
          speakers,
          primary_speaker: pending.primary_speaker,
          audio_duration_sec: transcript.audio_duration || null,
          recorded_at: recordedAt,
        },
        client,
      });

      if (workItem) {
        await client.query(
          `UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`,
          [workItem.id, msgId]
        );
      }

      await client.query(
        `UPDATE inbox.voice_memo_pending
            SET status = 'completed', work_item_id = $1, message_id = $2, completed_at = now()
          WHERE id = $3`,
        [workItem?.id || null, msgId, pending.id]
      );

      console.log(`[voice-memo] Ingested transcript ${transcriptId} -> msg=${msgId} workItem=${workItem?.id} speakers=${JSON.stringify(speakers)}`);
      return {
        id: msgId,
        workItemId: workItem?.id,
        transcriptId,
        title,
        formattedText,
        textFallback: transcript.text || '',
        speakers,
        primarySpeaker: pending.primary_speaker,
        audioDurationSec: transcript.audio_duration || null,
        recordedAt,
        trackingId: pending.tracking_id,
      };
    });

    if (result.failed) return { ok: true, status: 'failed' };
    if (result.skipped) return { skipped: true, reason: result.reason };

    // Post-commit: fire the executor-triage wake-up that createWorkItem deferred
    // because we owned the transaction. Non-critical; agents fall back to polling.
    if (result.workItemId) {
      notify({ eventType: 'task_assigned', workItemId: result.workItemId, targetAgentId: 'executor-triage' })
        .catch(() => {});
    }

    // Post-commit RAG ingest. ingestDocument dedupes on (source, sourceId), so
    // retries are idempotent. Failure here must not unwind ingest state.
    try {
      const ragResult = await ingestDocument({
        source: 'voice_memo',
        sourceId: result.transcriptId,
        title: result.title,
        rawText: result.formattedText || result.textFallback,
        format: 'plain',
        metadata: {
          tracking_id: result.trackingId,
          transcript_id: result.transcriptId,
          primary_speaker: result.primarySpeaker,
          speakers: result.speakers,
          audio_duration_sec: result.audioDurationSec,
          recorded_at: result.recordedAt,
          message_id: result.id,
          work_item_id: result.workItemId || null,
        },
        // OPT-166 P3-B5: content.documents writes are org-scoped (E2,
        // allow_system=FALSE) — an unscoped write hard-fails post-flip.
        // Single-tenant, matching the tldv-poller precedent (PR #574).
        writerOrgScope: { actorId: VOICE_MEMO_AGENT_ID, orgId: CURRENT_ORG_ID },
      });
      if (ragResult?.documentId) {
        await withVoiceMemoOrgScope(exec => exec(
          `UPDATE content.documents SET compile_status = 'pending' WHERE id = $1`,
          [ragResult.documentId]
        ));
      }
    } catch (err) {
      console.warn(`[voice-memo] RAG ingest failed for transcript ${result.transcriptId}: ${err.message}`);
    }

    return { id: result.id, workItemId: result.workItemId, source: 'voice_memo' };
  });
}
