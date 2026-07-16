
import { getDriveClient, getDocsClient, hasServiceAccount } from './service-auth.js';
import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { ingestDocument } from '../rag/ingest.js';
import { extractFromDriveFile } from '../rag/participants/extractors.js';
import { parseGeminiTitleTime } from './gemini-title.js';
import { createArtifact as createArtifactCore } from '../../../lib/content/create-artifact.js';
import { resolveCalendarEventId, cleanMeetingTitle } from '../../../lib/content/calendar-reconciler.js';
import { emitMeetingReceived } from '../../../lib/runtime/emit-meeting-received.js';

const MAX_SNIPPET_LENGTH = 200_000;

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/**
 * Infer the transcript preset from the Drive filename. A capture-source folder
 * holds files from heterogeneous sources (Gemini meeting notes, tldv,
 * occasional manual uploads), and the meetings UI keys off `webhook:<preset>`
 * labels — so getting the per-file preset right is what makes the meeting
 * appear under the correct source on the dashboard.
 *
 * Returns null when nothing matches, so the caller can fall back to its
 * configured preset / 'generic'.
 */
function detectPresetFromFilename(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.includes('notes by gemini') || / - transcript$/.test(lower)) return 'gemini';
  if (lower.startsWith('tldv:') || lower.startsWith('tldv -') || lower.startsWith('tldv ')) return 'tldv';
  return null;
}


/**
 * Walk a Google Docs API document response and return its full plain text,
 * including every tab and child tab. Drive's text/plain Export API only
 * returns the first tab's content — fine for legacy docs but Gemini meeting
 * exports use a Notes + Transcript two-tab layout, so the export silently
 * drops half the meeting. The Docs API with includeTabsContent=true is the
 * only path that surfaces every tab.
 *
 * Tab structure: each Tab has tabProperties (id, title), documentTab (body
 * + lists + headers/footers), and childTabs[] for nested tabs.
 */
function extractTextFromDocument(doc) {
  if (!doc) return '';
  if (Array.isArray(doc.tabs) && doc.tabs.length > 0) {
    return extractTextFromTabs(doc.tabs).trim();
  }
  // Pre-tabs doc, or response without includeTabsContent
  return extractTextFromBody(doc.body).trim();
}

function extractTextFromTabs(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return '';
  return tabs.map((tab) => {
    const title = tab.tabProperties?.title;
    const body = tab.documentTab?.body;
    const tabText = extractTextFromBody(body);
    const childText = extractTextFromTabs(tab.childTabs || []);
    const header = title ? `\n\n=== ${title} ===\n\n` : '\n\n';
    return `${header}${tabText}${childText ? `\n\n${childText}` : ''}`;
  }).join('');
}

function extractTextFromBody(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content.map(extractTextFromStructuralElement).join('');
}

function extractTextFromStructuralElement(el) {
  if (el.paragraph) {
    return (el.paragraph.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('');
  }
  if (el.table) {
    return (el.table.tableRows || [])
      .map((row) => (row.tableCells || [])
        .map((cell) => extractTextFromBody(cell))
        .join('\t'))
      .join('\n');
  }
  // sectionBreak, tableOfContents, etc. — no text content
  return '';
}

/**
 * Fetch the plain text body of a Drive file. For Google Docs this uses the
 * Docs API (includeTabsContent) so multi-tab docs are captured fully. For
 * other types (PDF, plain text) the Drive Get-with-alt=media path is
 * unchanged. Falls back to Drive Export if the Docs API errors (e.g. scope
 * mismatch on an old account) so we degrade gracefully rather than dropping
 * the file entirely.
 */
async function fetchDriveFileText(accountEmail, drive, file) {
  if (file.mimeType === GOOGLE_DOC_MIME) {
    try {
      const docs = getDocsClient(accountEmail);
      const doc = await docs.documents.get({
        documentId: file.id,
        includeTabsContent: true,
      });
      const text = extractTextFromDocument(doc.data);
      if (text) return text.slice(0, MAX_SNIPPET_LENGTH);
      // Empty result from Docs API — fall through to Export
    } catch (err) {
      console.warn(`[drive] Docs API failed for ${file.name} (${file.id}); falling back to Export: ${err.message}`);
    }
    const exportRes = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
    return String(exportRes.data || '').slice(0, MAX_SNIPPET_LENGTH);
  }
  const getRes = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
  return String(getRes.data || '').slice(0, MAX_SNIPPET_LENGTH);
}

/**
 * Shared transcript→meeting writer (D4, ADR-016). A `default_kind='transcript'`
 * capture source routes through here to produce /api/meetings output: an
 * inbox.messages webhook row (with webhook:<preset> labels), a triage
 * work_item, and a RAG ingest. Dedup is by (channel='webhook', channel_id=fileId),
 * so a held/retried capture page is idempotent.
 *
 * owner_org_id is stamped ONLY when ctx.ownerOrgId is provided. The legacy path
 * passes null → column DEFAULT (Staqs), preserving prior behavior. Capture
 * sources pass source.owner_org_id — REQUIRED, because /api/meetings is org-
 * scoped (visibleClause on m.owner_org_id); an unstamped transcript would be
 * invisible to its org and silently attributed to Staqs.
 *
 * @returns {Promise<{ deduped: boolean, msgId: string|null }>}
 */
async function processTranscriptIntoMeeting(file, text, ctx, deps = {}) {
  const {
    queryFn = query,
    ingestRagFn = ingestDriveFileToRag,
    createWorkItemFn = null,
  } = deps;
  const createWorkItem = createWorkItemFn
    || (await import('../runtime/state-machine.js')).createWorkItem;

  const preset = ctx.preset || detectPresetFromFilename(file.name) || 'generic';

  // Dedup: this Drive file already has a webhook message → skip (idempotent).
  const existing = await queryFn(
    `SELECT 1 FROM inbox.messages WHERE channel = 'webhook' AND channel_id = $1 LIMIT 1`,
    [file.id]
  );
  if (existing.rows.length > 0) return { deduped: true, msgId: null };

  const labels = [`webhook:${preset}`, `${preset}:transcript`, 'drive:folder'];
  const providerMsgId = `drive_${file.id}`;

  // owner_org_id is stamped ONLY when the caller supplies one (capture sources),
  // so the legacy path keeps the column DEFAULT rather than an explicit NULL.
  // The only tokens interpolated below are STATIC literals (', owner_org_id' /
  // ', $15') — never values — so this stays within the parameterized-SQL rule.
  const orgCol = ctx.ownerOrgId ? ', owner_org_id' : '';
  const orgPlaceholder = ctx.ownerOrgId ? ', $15' : '';
  const vals = [
    providerMsgId, 'webhook', 'webhook',
    `wh_thread_${providerMsgId}`, `<${providerMsgId}@webhook>`,
    preset, ctx.label, ['system@autobot'],
    file.name, text,
    file.createdTime || new Date().toISOString(), labels,
    false, file.id,
  ];
  if (ctx.ownerOrgId) vals.push(ctx.ownerOrgId);

  const msgResult = await queryFn(
    `INSERT INTO inbox.messages
     (provider_msg_id, provider, channel, thread_id, message_id,
      from_address, from_name, to_addresses, subject, snippet,
      received_at, labels, has_attachments, channel_id${orgCol})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14${orgPlaceholder})
     RETURNING id`,
    vals
  );
  const msgId = msgResult.rows[0]?.id;
  if (!msgId) {
    console.warn(`[drive] inbox.messages INSERT returned no id for "${file.name}" (${file.id}) — skipped`);
    return { deduped: false, msgId: null };
  }

  // Triage work item — enters the governed pipeline (same as legacy). The message
  // is already written, and dedup (channel_id) will skip this file on any retry,
  // so a work_item failure must NOT throw: throwing would hold the capture cursor
  // and, on retry, dedup would short-circuit before we ever reach createWorkItem —
  // permanently orphaning the message AND thrashing the cursor. Log and proceed;
  // the message still surfaces in /api/meetings (LEFT JOIN → null status).
  let workItem = null;
  try {
    workItem = await createWorkItem({
      type: 'task',
      title: `Drive: ${file.name}`,
      description: `${preset} transcript from Drive folder`,
      createdBy: 'orchestrator',
      assignedTo: 'executor-triage',
      priority: 0,
      metadata: { email_id: msgId, provider_msg_id: providerMsgId, webhook_source: preset },
    });
  } catch (err) {
    console.warn(`[drive] work_item creation failed for "${file.name}" (msg ${msgId}): ${err.message} — message kept, no triage task`);
  }
  if (workItem) {
    await queryFn(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, msgId]);
  }

  // RAG knowledge base + wiki compile queue. ingestDriveFileToRag catches its
  // own errors and returns null — never throws. documentId is threaded back so
  // the capture path can register the SAME document in the meeting registry
  // (Feature 007) without a second ingest.
  const ragResult = await ingestRagFn(file, text, {
    folder_id: ctx.folderId, label: ctx.label, account_id: ctx.accountId ?? null, preset,
  }, preset);

  return { deduped: false, msgId, documentId: ragResult?.documentId || null };
}

/**
 * Ingest a Drive file into the RAG pipeline. Used by both poll (for new
 * files) and backfill (for everything in the folder). RAG's own dedup on
 * (source='drive', source_id=fileId) keeps re-runs idempotent.
 *
 * @param {string} [presetOverride] - per-file preset detected from filename;
 *   falls back to watch.preset when not provided (legacy backfill path).
 */
async function ingestDriveFileToRag(file, text, watch, presetOverride) {
  const preset = presetOverride || watch.preset || 'generic';
  const format = preset === 'tldv'
    ? 'tldv'
    : preset === 'gemini'
      ? 'gemini'
      : 'plain';
  // Gemini Notes embed the actual meeting time in the title:
  //   "<Meeting Name> - YYYY/MM/DD HH:MM <TZ> - Notes by Gemini"
  // The file's createdTime/modifiedTime reflects when Gemini saved the Notes
  // doc (often hours after the meeting), so we extract from the title and
  // store it in metadata.happenedAt for downstream consumers (calendar,
  // /today/meetings, etc).
  const happenedAt = preset === 'gemini' ? parseGeminiTitleTime(file.name) : null;
  const metadata = { preset, folderId: watch.folder_id, label: watch.label };
  if (happenedAt) metadata.happenedAt = happenedAt;
  try {
    const docResult = await ingestDocument({
      source: 'drive',
      sourceId: file.id,
      title: file.name,
      rawText: text,
      format,
      metadata,
      ownerId: null,
      accountId: watch.account_id,
      rawParticipants: extractFromDriveFile(file),
    });
    if (docResult?.documentId) {
      await query(
        `UPDATE content.documents SET compile_status = 'pending' WHERE id = $1`,
        [docResult.documentId]
      );
    }
    return docResult;
  } catch (err) {
    console.warn(`[drive] RAG ingest failed for ${file.name}: ${err.message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OPT-98 — multi-folder capture-source watcher → typed artifacts
//
// Routes each newly-changed file to the artifact registry (content.artifacts
// via createArtifact) — or, for transcript sources, the shared meeting writer.
// Each row in content.capture_sources is a board-managed, per-org passive
// capture point (a Drive folder now; Gmail labels / Slack later).
//
// Tenancy invariant (the Linus follow-up that gates this surface): the
// ownerOrgId / ownerId handed to createArtifact ALWAYS comes from the
// capture_sources ROW (board-validated at PATCH-time), NEVER from a Drive file's
// metadata or any other external value. createArtifact trusts what it is handed,
// so the trust boundary is the source row — see lib/content/create-artifact.js.
//
// Change-detection: Drive `changes` API + per-source `cursor` (a changes-API
// pageToken). O(Δ) per poll, not a full-folder list. On first enable (cursor
// IS NULL) we capture the CURRENT startPageToken and persist it WITHOUT
// processing — i.e. capture starts fresh from the moment of enable and does NOT
// backfill pre-existing files. (Backfill of historical files is a deliberate,
// separate operation kept out of the steady-state poller so enabling a
// long-lived folder can't flood the KB.)
// ───────────────────────────────────────────────────────────────────────────

// Empty-allowlist default = ACCEPT NONE (deny-by-default, P1). A source with no
// mime AND no ext allow rules captures nothing until an operator declares at
// least one allow rule. This is the SAFE default: a freshly-enabled source can
// never silently ingest arbitrary file types. max_bytes still caps size.
const CAPTURE_MAX_BYTES_DEFAULT = 1_000_000;

/**
 * Derive a lowercase file extension (without the dot) from a Drive file name.
 * Returns '' when there is no extension.
 */
function fileExt(name) {
  if (!name || typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Allowlist gate. Returns { ok, reason }.
 *
 * Rules (deny-by-default): a file passes the type check if its mime is in
 * allowlist.mime (when that list is non-empty) OR its extension is in
 * allowlist.ext (when that list is non-empty). If BOTH lists are empty the file
 * is REJECTED (accept-none default). Size must be <= allowlist.max_bytes.
 *
 * @param {object} file - { mimeType, name, size } (size in bytes, string or number)
 * @param {object} allowlist - { mime?: string[], ext?: string[], max_bytes?: number }
 */
function passesAllowlist(file, allowlist) {
  const mimeList = Array.isArray(allowlist?.mime) ? allowlist.mime : [];
  const extList = Array.isArray(allowlist?.ext) ? allowlist.ext : [];
  const maxBytes = Number.isFinite(allowlist?.max_bytes)
    ? allowlist.max_bytes
    : CAPTURE_MAX_BYTES_DEFAULT;

  if (mimeList.length === 0 && extList.length === 0) {
    return { ok: false, reason: 'empty allowlist (accept-none default)' };
  }

  const mimeOk = mimeList.length > 0 && mimeList.includes(file.mimeType);
  const extOk = extList.length > 0 && extList.includes(fileExt(file.name));
  if (!mimeOk && !extOk) {
    return { ok: false, reason: `type not allowed (mime=${file.mimeType}, ext=${fileExt(file.name)})` };
  }

  const size = file.size != null ? Number(file.size) : null;
  if (size != null && Number.isFinite(size) && size > maxBytes) {
    return { ok: false, reason: `over max_bytes (${size} > ${maxBytes})` };
  }

  return { ok: true };
}

/**
 * Process ONE enabled capture source: advance its Drive `changes` cursor and
 * route each newly-changed, allowlist-passing file to createArtifact under the
 * SOURCE ROW's owner. Throws on a source-level failure so the caller can stamp
 * last_error and isolate it from sibling sources.
 *
 * Injectable deps (default to the real Drive/createArtifact/query) so tests
 * never hit Drive, an LLM, or a DB.
 *
 * @returns {Promise<{ captured: number, skipped: number }>}
 */

/**
 * D1 (ADR-016): resolve which Drive access path to use for a source, PREFERRING
 * SA-direct membership over DWD impersonation (the narrowest correct access).
 *
 *   - 'sa_direct' source (no owner_email)  -> read as the SA (email = null).
 *   - 'impersonated' source (owner_email set) -> probe whether the SA itself can
 *       see the watched folder via files.get. SA can see it -> read as the SA
 *       (email = null, no impersonation). 404/403 -> fall back to impersonation
 *       (email = owner_email).
 *
 * The probe is an EXPLICIT membership check, not inference from the changes feed:
 * a non-member SA-direct changes.list returns 200 + an EMPTY feed (no throw),
 * indistinguishable from "no new files" — so a "fall back only on throw against
 * the changes feed" approach would SILENTLY DROP every file on an impersonated
 * folder. files.get returns a hard 404/403 instead, which is a reliable signal.
 *
 * A transient probe error (5xx/network) RE-THROWS so the per-source caller stamps
 * last_error and retries next tick, rather than silently flipping access.
 *
 * @returns {Promise<{ email: string|null, access: 'sa_direct'|'impersonated' }>}
 */
async function resolveDriveAccess(source, driveClientFactory) {
  if (!source.owner_email) {
    return { email: null, access: 'sa_direct' };
  }
  try {
    const saDrive = driveClientFactory(null);
    await saDrive.files.get({ fileId: source.external_id, fields: 'id', supportsAllDrives: true });
    return { email: null, access: 'sa_direct' };
  } catch (err) {
    // googleapis throws GaxiosError: err.response.status is the NUMERIC HTTP
    // status, while err.code is the same status as a STRING ("404"). A bare
    // `err.code === 404` silently fails ("404" !== 404), so prefer
    // response.status and fall back to Number(err.code). Getting this wrong
    // means a real 404 re-throws as "transient" and the source never falls back
    // to impersonation — it retries forever, capturing nothing.
    const status = err?.response?.status ?? Number(err?.code);
    if (status === 404 || status === 403) {
      return { email: source.owner_email, access: 'impersonated' };
    }
    throw err;
  }
}

async function pollCaptureSource(source, deps) {
  const {
    driveClientFactory = (email) => getDriveClient(email || null),
    createArtifactFn = createArtifactCore,
    queryFn = query,
    // D4 (ADR-016): transcript sources feed the meeting pipeline (inbox.messages
    // + triage work_item + RAG); Feature 007 additionally registers the SAME RAG
    // document in the meeting registry (createArtifact documentId reuse — no
    // second ingest). Injectable so tests never hit the DB / state-machine / RAG.
    createWorkItemFn = null,
    ingestRagFn = ingestDriveFileToRag,
    emitMeetingReceivedFn = emitMeetingReceived,
  } = deps || {};

  // D1 (ADR-016): prefer SA-direct over DWD impersonation. resolveDriveAccess
  // probes SA membership for 'impersonated' sources and falls back to
  // impersonation only on a hard 404/403 — never on an empty changes feed. The
  // resolved email drives BOTH the changes-feed client AND fetchDriveFileText
  // below, so listing and byte-fetch always use the same identity.
  const resolved = await resolveDriveAccess(source, driveClientFactory);
  const drive = driveClientFactory(resolved.email);
  const allowlist = (source.allowlist && typeof source.allowlist === 'object') ? source.allowlist : {};
  const stats = { captured: 0, skipped: 0 };

  // Footgun guard (Linus MINOR): allowlist is deny-by-default — an empty mime AND
  // ext list captures NOTHING. A transcript source with the factory-default
  // allowlist would silently no-op, so surface it rather than fail quietly.
  if (source.default_kind === 'transcript' && !(allowlist.mime?.length) && !(allowlist.ext?.length)) {
    console.warn(`[capture] ${source.label || source.id}: transcript source has an empty allowlist (no mime/ext) — deny-by-default means it captures NOTHING. Set e.g. mime application/vnd.google-apps.document + text/plain.`);
  }

  // First enable: persist a fresh startPageToken and process nothing. Capture
  // begins from the moment of enable (documented above — no historical backfill).
  if (!source.cursor) {
    const startRes = await drive.changes.getStartPageToken({ supportsAllDrives: true });
    const startToken = startRes?.data?.startPageToken;
    await queryFn(
      `UPDATE content.capture_sources SET cursor = $1, last_poll_at = now(), last_error = NULL, access_resolved = $3 WHERE id = $2`,
      [startToken || null, source.id, resolved.access]
    );
    console.log(`[capture] ${source.label || source.id}: first enable — cursor primed (${startToken}), no backfill`);
    return stats;
  }

  // Steady state: walk the changes feed from the persisted cursor, page through,
  // and advance the cursor. We scope to the watched folder by inspecting each
  // changed file's parents (the changes feed is account-wide, not folder-scoped,
  // so folder membership is filtered client-side).
  let pageToken = source.cursor;
  let newStartPageToken = null;

  // CURSOR-HOLD-ON-ERROR (Linus BLOCKER): the end-of-poll cursor write must NOT
  // advance past a file that was skipped due to a TRANSIENT error (fetch failure,
  // createArtifact throw) — the changes API never re-emits that change, so an
  // advanced cursor loses it permanently. We distinguish:
  //   - INTENTIONAL skips (allowlist reject, over-max_bytes, empty text): the
  //     file is permanently uninteresting → the cursor MAY advance past it.
  //   - ERROR skips (any exception while processing a file): set hadErrorSkip →
  //     after the page loop we HOLD the cursor (leave it at the prior pageToken)
  //     so the whole page re-runs next tick. Re-processing is safe — createArtifact
  //     content-hash dedup collapses the files that already succeeded.
  let hadErrorSkip = false;

  while (pageToken) {
    const res = await drive.changes.list({
      pageToken,
      fields: 'newStartPageToken, nextPageToken, changes(fileId, removed, file(id, name, mimeType, size, parents, trashed))',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 100,
    });
    const changes = res?.data?.changes || [];

    for (const change of changes) {
      const file = change.file;
      // Skip removals/trashes and changes that aren't in our watched folder.
      if (change.removed || !file || file.trashed) continue;
      const parents = Array.isArray(file.parents) ? file.parents : [];
      if (!parents.includes(source.external_id)) continue;

      // Type/declared-size allowlist gate. Reject here is an INTENTIONAL skip
      // (the file is permanently uninteresting) → does NOT hold the cursor.
      const gate = passesAllowlist(file, allowlist);
      if (!gate.ok) {
        console.log(`[capture] ${source.label || source.id}: skip "${file.name}" — ${gate.reason}`);
        stats.skipped++;
        continue;
      }

      // Per-file processing wrapped so ANY throw (fetch or createArtifact) is an
      // ERROR skip that holds the cursor — never a silent permanent loss.
      try {
        const text = await fetchDriveFileText(resolved.email, drive, file);
        if (!text || text.trim().length === 0) {
          // Empty after extraction = INTENTIONAL skip (nothing to capture).
          stats.skipped++;
          continue;
        }

        // Post-fetch byte-size enforcement (Linus MAJOR): native Google Docs
        // report size absent/0, so passesAllowlist's declared-size gate is a
        // no-op for the most common capture type. Enforce the real UTF-8 byte
        // length of the extracted text here. Over-limit is an INTENTIONAL skip
        // (the content is too big by policy), so it does NOT hold the cursor.
        const maxBytes = Number.isFinite(allowlist?.max_bytes) ? allowlist.max_bytes : null;
        if (maxBytes != null) {
          const byteLen = Buffer.byteLength(text, 'utf8');
          if (byteLen > maxBytes) {
            console.log(`[capture] ${source.label || source.id}: skip "${file.name}" — over max_bytes (${byteLen} > ${maxBytes}, extracted text)`);
            stats.skipped++;
            continue;
          }
        }

        // Feature 007 (meeting hierarchy): meeting identity for transcript/summary
        // captures. The changes feed carries no attendee roster (and Drive file
        // owners are NOT meeting attendees), so identity rests on the filename's
        // time + title — run the calendar reconciler to try to recover the
        // calendar_event_id (the only cross-source bridge to TLDv). No match →
        // the meeting lands 'weak' and never false-merges; a later sweep upgrades.
        const kind = source.default_kind || 'doc';
        let meetingArg = null;
        if (kind === 'transcript' || kind === 'summary') {
          const startTime = parseGeminiTitleTime(file.name);
          const meetingTitle = cleanMeetingTitle(file.name);
          let calendarEventId = null;
          if (startTime) {
            try {
              const rec = await resolveCalendarEventId({
                startTime, title: meetingTitle, attendeeEmails: [], queryFn,
              });
              if (rec) calendarEventId = rec.calendarEventId;
            } catch (err) {
              console.warn(`[capture] reconciler failed for "${file.name}": ${err.message}`);
            }
          }
          meetingArg = {
            calendarEventId,
            title: meetingTitle,
            startTime,
            participantEmails: [],
            fallbackId: file.id,
            participantsAreAttendees: false, // no real roster → confidence caps at 'weak'
          };
        }

        if (kind === 'transcript') {
          // D4 (ADR-016): transcript sources reach /api/meetings parity via the
          // shared meeting writer (inbox.messages webhook row + triage work_item
          // + RAG). owner_org_id MUST be stamped from the source row —
          // /api/meetings is org-scoped (visibleClause), so an unstamped
          // transcript would be invisible to its org. Dedup is by
          // channel_id=fileId, so a held/retried page stays idempotent.
          const result = await processTranscriptIntoMeeting(file, text, {
            label: source.label,
            folderId: source.external_id,
            ownerOrgId: source.owner_org_id,
            ownerId: source.owner_id || null,
            accountId: null,
          }, { queryFn, createWorkItemFn, ingestRagFn });
          if (result.deduped) { stats.skipped++; }
          else {
            stats.captured++;
            console.log(`[capture] ${source.label || source.id}: transcript → meeting "${file.name}" (${file.id})`);

            // Feature 007 (3c): register the SAME RAG document in the meeting
            // registry (createArtifact documentId reuse — no second ingest) and
            // fire meeting.received so the meeting→work classifier runs for
            // org-captured notes. BEST-EFFORT, mirroring the work_item handling
            // above: the message row is already written and channel_id dedup
            // would skip this file on a cursor-held retry, so throwing here
            // would orphan the registry write permanently AND thrash the cursor.
            if (result.documentId) {
              try {
                await createArtifactFn({
                  raw: text,
                  kind,
                  title: file.name,
                  source_system: 'drive',
                  ownerOrgId: source.owner_org_id,
                  ownerId: source.owner_id || null,
                  metadata: { drive_file_id: file.id, capture_source_id: source.id },
                  documentId: result.documentId,
                  meeting: meetingArg,
                });
              } catch (err) {
                console.warn(`[capture] meeting-registry registration failed for "${file.name}": ${err.message} — message/work-item kept`);
              }
              try {
                await emitMeetingReceivedFn({
                  documentId: result.documentId,
                  transcriptSource: 'gemini-drive',
                  title: meetingArg?.title || file.name,
                  calendarEventId: meetingArg?.calendarEventId || null,
                  startTime: meetingArg?.startTime || null,
                  participantEmails: [],
                  fallbackId: file.id,
                  ownerOrgId: source.owner_org_id,
                });
              } catch (err) {
                console.warn(`[capture] meeting.received emit failed for "${file.name}": ${err.message}`);
              }
            }
          }
        } else {
          // OWNER comes from the SOURCE ROW only — never the file. createArtifact's
          // content-hash dedup makes re-detection idempotent (no extra guard here).
          // Summary kinds carry the meeting envelope so they group under their
          // meeting in the registry (Feature 007).
          await createArtifactFn({
            raw: text,
            kind,
            title: file.name,
            source_system: 'drive',
            ownerOrgId: source.owner_org_id,
            ownerId: source.owner_id || null,
            metadata: { drive_file_id: file.id, capture_source_id: source.id },
            meeting: meetingArg,
          });
          stats.captured++;
          console.log(`[capture] ${source.label || source.id}: captured "${file.name}" (${file.id})`);
        }
      } catch (err) {
        // Transient processing failure → ERROR skip. Hold the cursor so this
        // page (incl. this file) retries next tick; dedup keeps it idempotent.
        console.warn(`[capture] ${source.label || source.id}: processing failed for "${file.name}" (${file.id}): ${err.message} — holding cursor`);
        hadErrorSkip = true;
        stats.skipped++;
        continue;
      }
    }

    if (res?.data?.nextPageToken) {
      pageToken = res.data.nextPageToken;
    } else {
      // newStartPageToken is Drive's authoritative next cursor. Fall back to the
      // current pageToken only if Drive returns NEITHER token — that re-processes
      // this page next tick (idempotent via createArtifact content-hash dedup).
      newStartPageToken = res?.data?.newStartPageToken || pageToken;
      pageToken = null;
    }
  }

  if (hadErrorSkip) {
    // HOLD the cursor: leave it at the prior pageToken (source.cursor) so the
    // page retries next tick. Stamp last_error; still bump last_poll_at.
    // NB: do NOT stamp access_resolved here. A partial-error hold is not a
    // completed poll; access_resolved means "path used on the last SUCCESSFUL
    // poll" (the DWD-demotion gate query depends on that semantics).
    await queryFn(
      `UPDATE content.capture_sources SET last_poll_at = now(), last_error = $1 WHERE id = $2`,
      ['partial: read error, cursor held', source.id]
    );
    return stats;
  }

  // No error skips → advance + persist the cursor so the next poll is a true delta.
  await queryFn(
    `UPDATE content.capture_sources SET cursor = $1, last_poll_at = now(), last_error = NULL, access_resolved = $3 WHERE id = $2`,
    [newStartPageToken, source.id, resolved.access]
  );
  return stats;
}

/**
 * Poll all enabled Drive-folder capture sources. Wired into the drive scheduler
 * tick (see src/index.js).
 *
 * Per-source try/catch: one bad source or file must not wedge the others or
 * throw out of the tick. last_poll_at is always updated; last_error is stamped
 * on failure.
 *
 * MULTI-FOLDER / MULTI-ORG (INTENDED): a single Drive file can live in the
 * folders of two enabled sources owned by DIFFERENT orgs (Drive files can have
 * multiple parents). Each source processes that file independently and captures
 * it into ITS OWN org — the file is legitimately owned in each folder it sits in,
 * and owner-threading stays correct because ownerOrgId/ownerId come from each
 * source's own row. This is by design, not a leak: two orgs each filed the same
 * doc in their own folder, so each gets its own artifact.
 *
 * @param {object} [deps] - injectable { driveClientFactory, createArtifactFn, queryFn } for tests
 * @returns {Promise<number>} total artifacts captured across all sources
 */
export async function pollCaptureSources(deps = {}) {
  const queryFn = deps.queryFn || query;

  if (!hasServiceAccount()) {
    console.warn('[capture] GOOGLE_SERVICE_ACCOUNT_KEY not configured — capture-source polling skipped');
    return 0;
  }

  const sources = await queryFn(
    `SELECT id, source_type, external_id, label, owner_org_id, owner_id,
            owner_email, default_kind, allowlist, enabled, cursor
       FROM content.capture_sources
      WHERE source_type = 'drive_folder' AND enabled = true`
  );

  let total = 0;
  for (const source of sources.rows) {
    try {
      const stats = await pollCaptureSource(source, deps);
      total += stats.captured;
    } catch (err) {
      console.error(`[capture] Error polling source ${source.label || source.id} (folder ${source.external_id}): ${err.message}`);
      await queryFn(
        `UPDATE content.capture_sources SET last_poll_at = now(), last_error = $1 WHERE id = $2`,
        [String(err.message || err).slice(0, 500), source.id]
      ).catch(() => {});
      await publishEvent(
        'infrastructure_error',
        `Capture-source watcher error: ${err.message}`,
        null,
        null,
        { capture_source_id: source.id, external_id: source.external_id, error: err.message },
      ).catch(() => {}); // non-fatal
    }
  }
  return total;
}
