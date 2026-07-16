/**
 * Document ingestion pipeline.
 *
 * Orchestrates: dedup → G8 sanitize → normalize → chunk → embed → store.
 * Runs as a governed work item (executor-ingest) via the Postgres task graph.
 *
 * Every ingestion gets: budget tracking (G1), sanitization (G8),
 * audit trail (P3), dashboard visibility, retry on failure.
 */

import { query, withSystemOrgScope } from '../db.js';
import { normalize } from './normalizers/index.js';
import { chunkSegments, chunkByWindow, estimateTokens } from './chunker.js';
import { embedMany, getEmbeddingInfo } from './embedder.js';
import { extractParticipants } from './participants/extractors.js';
import { resolveAndUpsert } from './participants/resolver.js';
import { createLogger } from '../logger.js';
const log = createLogger('rag/ingest');

/**
 * Format the meeting envelope into a one-line header for chunk 0.
 * The line is concatenated to the chunk content before embedding, so the
 * vector carries identity signals (title, date, participants, organization,
 * attendee email domains) the transcript body rarely repeats.
 *
 * Returns null when there's nothing useful to add (no title, no participants,
 * no organization) so we don't pollute non-meeting docs with empty headers.
 */
function buildMeetingHeader({ title, metadata, participants }) {
  const parts = [];
  if (title) parts.push(String(title).trim());

  // Prefer the explicit meeting time when available (set by the TLDv poller
  // and the Gemini title parser); fall back to created_at via the document
  // row downstream if the caller didn't pass metadata.happenedAt.
  const happenedAt = metadata?.happenedAt;
  if (typeof happenedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(happenedAt)) {
    parts.push(happenedAt.slice(0, 10));
  }

  const org = metadata?.organization || metadata?.org || null;
  if (org) parts.push(`org: ${String(org)}`);

  if (Array.isArray(participants) && participants.length > 0) {
    const names = participants
      .map((p) => p?.name || p?.email)
      .filter(Boolean)
      .slice(0, 8);
    if (names.length > 0) parts.push(`participants: ${names.join(', ')}`);

    // Pull distinct email domains so a query like "the formul8 meeting"
    // hits even when no individual participant has "formul8" in their
    // name. Drop common free-mail domains so they don't dilute the signal.
    const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me']);
    const domains = new Set();
    for (const p of participants) {
      const email = p?.email;
      if (typeof email !== 'string') continue;
      const at = email.indexOf('@');
      if (at <= 0) continue;
      const domain = email.slice(at + 1).toLowerCase();
      if (!FREE_MAIL.has(domain)) domains.add(domain);
    }
    if (domains.size > 0) parts.push(`domains: ${[...domains].join(', ')}`);
  }

  if (parts.length === 0) return null;
  return `Meeting — ${parts.join(' · ')}`;
}

// Lazy import to avoid circular deps
let sanitize, countInjectionAttempts, detectPII;
async function loadSanitizer() {
  if (!sanitize) {
    const mod = await import('../runtime/sanitizer.js');
    sanitize = mod.sanitize;
    countInjectionAttempts = mod.countInjectionAttempts;
    detectPII = mod.detectPII;
  }
}

/**
 * Ingest a document into the knowledge base.
 *
 * @param {Object} params
 * @param {string} params.source - Source type: 'drive', 'email', 'upload', 'transcript', 'webhook'
 * @param {string} params.sourceId - Dedup key (file ID, message ID, etc.)
 * @param {string} params.title - Document title
 * @param {string} params.rawText - Raw document text
 * @param {string} [params.format='plain'] - Document format: 'plain', 'tldv', 'markdown'
 * @param {Object} [params.metadata={}] - Source-specific metadata
 * @param {string} [params.ownerId] - Board member UUID
 * @param {string} [params.ownerOrgId] - Writer's org UUID (STAQPRO-593/611 write-path
 *   owner-stamp). Derived from the verified principal by the caller, NEVER from
 *   caller-supplied input. null → the content.documents.owner_org_id column DEFAULT
 *   (Staqs) applies, which is single-org-correct until mig-145 drops the DEFAULT.
 * @param {Array}  [params.rawParticipants] - Pre-extracted RawParticipant[] from the caller
 *   (e.g. email bulk route has the thread; Drive watcher has owners/permissions).
 *   For tl;dv the ingest pipeline extracts speakers from normalized segments automatically.
 * @param {string} [params.accountId] - inbox.accounts.id for signal.contact_accounts junction
 * @returns {Promise<{ documentId: string, chunkCount: number, embedded: boolean } | null>}
 */
export async function ingestDocument({
  source,
  sourceId,
  title,
  rawText,
  format = 'plain',
  metadata = {},
  ownerId = null,
  ownerOrgId = null,
  skipEmbedding = false,
  classification = null, // Explicit override, otherwise auto-detected
  forceUpdate = false,   // Re-ingest even if sourceId exists (for vault sync)
  rawParticipants = null,
  accountId = null,
  writerOrgScope = null, // OPT-166 P2e-E2: { actorId, orgId } → org-scope content.documents writes
}) {
  if (!rawText || rawText.trim().length === 0) {
    log.info(`Skipped empty document: ${title}`);
    return null;
  }

  // OPT-166 P2e-E2: optional writer org-scope. When the caller supplies
  // { actorId, orgId }, every content.documents statement (dedup SELECT,
  // forceUpdate DELETEs, INSERT, compile_status UPDATE) runs inside its own
  // short-lived withAgentScope bracket (app.org_ids=[orgId]) so the writes
  // survive the RLS pool-flip; `owner_org_id` is force-stamped to orgId so the
  // row is visible + write-eligible under the same scope. OPT-166 P2e-E4 also
  // routes the participant `resolveAndUpsert` (signal.contacts reads + writes)
  // through `runScoped`; the sanitize/normalize step and the no-RLS chunks loop
  // deliberately stay OUTSIDE the scope — unchanged. When writerOrgScope is
  // null, `runScoped` is a byte-identical passthrough to bare `query`, so every
  // other caller of ingestDocument is inert.
  let effectiveOwnerOrgId = ownerOrgId;
  let openWriterScope = null;
  if (writerOrgScope) {
    const { actorId, orgId } = writerOrgScope;
    if (!actorId || !orgId) {
      throw new Error('ingestDocument: writerOrgScope requires both actorId and orgId');
    }
    if (ownerOrgId && ownerOrgId !== orgId) {
      throw new Error(
        `ingestDocument: ownerOrgId (${ownerOrgId}) conflicts with writerOrgScope.orgId (${orgId})`
      );
    }
    effectiveOwnerOrgId = orgId; // force-stamp so the row is write-eligible under the scope
    // OPT-166 P2g: open the org scope via withSystemOrgScope — reachable under
    // REQUIRE_AGENT_JWT=true (these ingest daemons hold no JWT principal), unlike
    // the old withAgentScope path which THREW for a plain-string actorId under
    // enforcement and silently fell back to unscoped writes → 42501 post-flip
    // (the defect that rolled the pool flip back three times). FAIL CLOSED: a
    // scope that cannot open must never degrade to an unscoped content.documents
    // write. actorId is a frozen SYSTEM_ORG_WRITERS constant, so this only throws
    // on genuine misconfiguration — the caller's poll-iteration try/catch contains
    // it and skips the item, rather than corrupting/black-holing the write.
    openWriterScope = () => withSystemOrgScope(actorId, orgId);
  }

  // Run a content.documents statement group under the writer org-scope (or bare
  // `query` when no scope was requested). Each call opens a fresh short-lived
  // scope and releases it in `finally` — no scope ever spans a network await.
  async function runScoped(fn) {
    if (!openWriterScope) return fn(query);
    const scoped = await openWriterScope();
    try {
      return await fn(scoped);
    } finally {
      await scoped.release();
    }
  }

  // 1. Dedup check (forceUpdate skips for vault re-sync)
  const existing = await runScoped(exec => exec(
    `SELECT id FROM content.documents WHERE source = $1 AND source_id = $2 LIMIT 1`,
    [source, sourceId]
  ));
  if (existing.rows.length > 0) {
    if (!forceUpdate) {
      return { documentId: existing.rows[0].id, chunkCount: 0, embedded: false };
    }
    // Force update: delete old chunks, re-ingest
    await runScoped(async exec => {
      await exec(`DELETE FROM content.chunks WHERE document_id = $1`, [existing.rows[0].id]);
      await exec(`DELETE FROM content.documents WHERE id = $1`, [existing.rows[0].id]);
    });
  }

  // 2. G8 Sanitize + PII Detection (Linus: detectPII was dead code — now wired in)
  await loadSanitizer();
  let sanitizedText = rawText;
  let threatCount = 0;
  let isSanitized = true;
  let autoClassification = classification || 'INTERNAL';

  if (sanitize && countInjectionAttempts) {
    threatCount = countInjectionAttempts(rawText);
    if (threatCount > 0) {
      log.warn(`G8: ${threatCount} injection attempts detected in "${title}"`);
      sanitizedText = sanitize(rawText);
    }
  }

  // PII detection — auto-classify as CONFIDENTIAL if PII found
  if (detectPII && !classification) {
    const piiResult = detectPII(rawText);
    if (piiResult.hasPII) {
      autoClassification = 'CONFIDENTIAL';
      log.warn(`PII detected in "${title}": ${piiResult.detections.map(d => d.type).join(', ')} → CONFIDENTIAL`);
    }
  }

  // 3. Normalize
  const segments = normalize(sanitizedText, format);
  if (segments.length === 0) {
    log.info(`No segments after normalization: ${title}`);
    return null;
  }

  const totalTokens = estimateTokens(sanitizedText);
  const embeddingInfo = getEmbeddingInfo();

  // 3b. Extract + resolve participants (P3: transparency by structure).
  // Callers may pass a pre-extracted `rawParticipants` when the source payload
  // is only available before ingest (email thread messages, Drive file metadata).
  // For tl;dv the normalized segments already carry speaker info.
  let resolvedParticipants = [];
  try {
    const extracted = Array.isArray(rawParticipants) && rawParticipants.length > 0
      ? rawParticipants
      : extractParticipants({ source, format, segments });
    if (extracted.length > 0) {
      // OPT-166 P2e-E4: thread the writer org-scope into participant resolution
      // so signal.contacts reads (else black-hole → all-unresolved) and writes
      // (else 42501) survive the flip. runScoped opens a fresh short-lived
      // withAgentScope (or bare `query` when no writerOrgScope → inert); the
      // resolveAndUpsert internals are pure DB + JS (no network await), so the
      // whole resolve+upsert safely shares that one scoped txn.
      resolvedParticipants = await runScoped(exec => resolveAndUpsert(extracted, { accountId }, exec));
    }
  } catch (err) {
    // Participant resolution must not block ingestion — embeddings are the primary
    // artifact. Fail open with an empty list.
    log.warn(`Participant resolution failed for "${title}": ${err.message}`);
  }

  // 4. Store document (with classification + participants).
  // Owner-stamp (STAQPRO-593/611): include owner_org_id ONLY when the caller
  // resolved one from the writer principal. Omitting it lets the column DEFAULT
  // (Staqs) apply — single-org-correct for agent-runtime callers that pass null,
  // and the only safe behavior until mig-145 drops that DEFAULT. Column names are
  // static identifiers (not user input); values stay parameterized.
  const docCols = [
    'source', 'source_id', 'title', 'raw_text', 'format', 'metadata', 'owner_id',
    'sanitized', 'threat_count', 'token_count', 'embedding_model',
    'embedding_dimensions', 'classification', 'participants',
  ];
  const docVals = [
    source, sourceId, title, sanitizedText, format, JSON.stringify(metadata),
    ownerId, isSanitized, threatCount, totalTokens,
    embeddingInfo?.model || null, embeddingInfo?.dimensions || null, autoClassification,
    JSON.stringify(resolvedParticipants),
  ];
  if (effectiveOwnerOrgId) {
    docCols.push('owner_org_id');
    docVals.push(effectiveOwnerOrgId);
  }
  const docPlaceholders = docVals.map((_, i) => `$${i + 1}`).join(', ');
  const docResult = await runScoped(exec => exec(
    `INSERT INTO content.documents (${docCols.join(', ')})
     VALUES (${docPlaceholders})
     RETURNING id`,
    docVals
  ));
  const documentId = docResult.rows[0].id;

  // 5. Chunk.
  // Build a one-line envelope header for meeting-like documents and prepend
  // it to chunk 0 before embedding. The header carries identity signals
  // (title, date, participant names, attendee email domains) that the
  // transcript body rarely repeats — without it a query like "what
  // happened on the formul8 meeting" never reaches the right chunks
  // because "formul8" appears nowhere in the spoken transcript.
  const isMeetingLike =
    source === 'tldv' ||
    source === 'gemini' ||
    format === 'tldv' ||
    format === 'gemini' ||
    (source === 'drive' && (format === 'tldv' || format === 'gemini'));
  const headerText = isMeetingLike
    ? buildMeetingHeader({ title, metadata, participants: resolvedParticipants })
    : null;

  let chunks;
  if (format === 'tldv' || format === 'gemini' || segments.some(s => s.metadata?.speaker)) {
    chunks = chunkSegments(segments, headerText ? { headerText } : {});
  } else {
    chunks = chunkByWindow(segments.map(s => s.content), headerText ? { headerText } : {});
  }

  // Short documents below minimum chunk size: create a single chunk with full text
  if (chunks.length === 0 && sanitizedText.trim().length > 0) {
    chunks = [{
      content: sanitizedText.trim(),
      metadata: {},
      tokenCount: totalTokens,
    }];
  }

  if (chunks.length === 0) {
    log.info(`No chunks produced for "${title}"`);
    return { documentId, chunkCount: 0, embedded: false };
  }

  // 6. Embed (skip during bulk ingestion for speed — embed later via reembed)
  const chunkTexts = chunks.map(c => c.content);
  const embeddings = skipEmbedding ? chunkTexts.map(() => null) : await embedMany(chunkTexts);
  const hasEmbeddings = embeddings.some(e => e !== null);

  // 7. Store chunks with embeddings
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    await query(
      `INSERT INTO content.chunks
       (document_id, chunk_index, text, token_count, embedding, metadata, classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        documentId,
        i,
        chunk.content,
        chunk.tokenCount,
        embedding ? `[${embedding.join(',')}]` : null,
        JSON.stringify(chunk.metadata || {}),
        autoClassification,
      ]
    );
  }

  // Set compile_status for wiki pipeline:
  // - structured source docs (vault + transcripts) → 'pending' for compilation
  // - project-scoped uploads → 'pending' so project wiki updates automatically
  // - wiki-compiled docs → 'skip' (anti-circular-ingestion)
  const isTranscriptLike = source === 'tldv' || format === 'tldv' || source === 'gemini' || format === 'gemini';
  const isProjectUpload = source === 'upload' && !!metadata?.project_slug;
  const isResearchFeed = source === 'feed';
  const compileStatus = source === 'wiki-compiled'
    ? 'skip'
    : (source === 'vault' || isTranscriptLike || isProjectUpload || isResearchFeed)
      ? 'pending'
      : null;
  if (compileStatus) {
    await runScoped(exec => exec(
      `UPDATE content.documents SET compile_status = $1 WHERE id = $2`,
      [compileStatus, documentId]
    ));
  }

  log.info(`Ingested "${title}": ${chunks.length} chunks, embedded=${hasEmbeddings}`);

  return { documentId, chunkCount: chunks.length, embedded: hasEmbeddings };
}

/**
 * Re-embed all chunks for a document (e.g., after model change).
 * @param {string} documentId
 */
export async function reembedDocument(documentId) {
  const chunks = await query(
    `SELECT id, text FROM content.chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId]
  );
  if (chunks.rows.length === 0) return;

  const texts = chunks.rows.map(c => c.text);
  const embeddings = await embedMany(texts);
  const info = getEmbeddingInfo();

  for (let i = 0; i < chunks.rows.length; i++) {
    const embedding = embeddings[i];
    if (embedding) {
      await query(
        `UPDATE content.chunks SET embedding = $1 WHERE id = $2`,
        [`[${embedding.join(',')}]`, chunks.rows[i].id]
      );
    }
  }

  // Update document's embedding metadata
  if (info) {
    await query(
      `UPDATE content.documents SET embedding_model = $1, embedding_dimensions = $2, updated_at = now() WHERE id = $3`,
      [info.model, info.dimensions, documentId]
    );
  }

  log.info(`Re-embedded ${documentId}: ${chunks.rows.length} chunks`);
}
