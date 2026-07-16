// lib/content/create-artifact.js — OPT-97: the trusted artifact-registry write core.
//
// SERVER-INTERNAL-ONLY. This function takes ownership (ownerOrgId / ownerId) as an
// EXPLICIT, REQUIRED, TRUSTED argument and performs the privileged registry write:
// content-hash / identity-key derivation, ingestDocument (G8 sanitize + PII
// classification), and the atomic artifact-upsert / version-insert / current_version
// flip / enrichment-enqueue transaction.
//
// >>> NEVER wire this to an HTTP route that derives owner from a request body. <<<
// Caller-supplied ownership is the 588/596 leak class in write form. The HTTP edge
// (POST /api/artifacts) keeps its OWNER_PARAMS → 400 guard and derives the owner
// from the verified token BEFORE calling this core. Trusted in-process callers
// (the Drive capture watcher, the Optimus-authored-artifact register hook) call
// this directly with an owner that came from a BOARD-VALIDATED source row /
// engagement — no token, no loopback HTTP. The leak class only exists where a
// request body sets the owner; this core is never reachable from a body.
//
// Ownership is REQUIRED and TRUSTED: a null/undefined ownerOrgId throws — there is
// NO silent Staqs default. content.artifacts.owner_org_id is NOT NULL with no column
// DEFAULT, so an un-stamped write is a hard error rather than a mis-attribution.

import crypto from 'crypto';
import { withTransaction } from '../db.js';
import { ingestDocument } from '../rag/ingest.js';
import { deriveMeetingIdentity, upsertMeetingTx, recomputePrimariesTx } from './meetings.js';

// The 10 artifact kinds (must match the CHECK in autobot-inbox/sql/154-artifact-registry.sql).
export const ALLOWED_KINDS = new Set([
  'prd', 'proposal', 'spec', 'adr', 'brief', 'deck',
  'transcript', 'summary', 'doc', 'other',
]);

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Create (or version) a registry artifact from raw content with a TRUSTED owner.
 *
 * @param {object} params
 * @param {string} params.raw            - the artifact body text (required, non-empty)
 * @param {string} params.kind           - one of ALLOWED_KINDS (required)
 * @param {string} [params.title]        - artifact title (defaults to '(untitled)')
 * @param {string} [params.source_system]- row metadata only (mcp/drive/optimus/web/…)
 * @param {string} params.ownerOrgId     - TRUSTED tenancy owner (REQUIRED; null → throw)
 * @param {string} [params.ownerId]      - board_members.id of the creator
 * @param {object} [params.metadata]     - passed through to ingestDocument
 * @param {string} [params.format]       - 'markdown' (default) | 'plain' | …
 * @param {string} [params.documentId]   - register over an EXISTING content.documents
 *   row instead of ingesting a new one (Feature 007: the TLDv path already ingested
 *   its transcript — a second ingestDocument would duplicate embeddings, the 602
 *   anti-flood class). raw is still required (it derives content_hash).
 * @param {object} [params.meeting]      - Feature 007: meeting identity inputs. When
 *   supplied (and resolvable), the artifact is attached to its content.meetings row
 *   (upserted within the same txn — the within-scope dedup) and the meeting's
 *   primary pointers are re-picked by D4 source precedence. Shape:
 *   { calendarEventId?, title?, startTime?, participantEmails?, fallbackId?,
 *     participants? (rich normalized [{email,name,role}]),
 *     participantsAreAttendees? (false when emails are doc-owners, not real
 *     attendees — caps confidence at 'weak' so the row never false-merges) }
 * @returns {Promise<object>} the same receipt shape POST /api/artifacts returns
 */
export async function createArtifact({
  raw,
  kind,
  title,
  source_system,
  ownerOrgId,
  ownerId,
  metadata,
  format,
  meeting,
  documentId: existingDocumentId,
} = {}) {
  // Ownership is trusted but REQUIRED — no silent Staqs default (P1 deny-by-default).
  if (!ownerOrgId) {
    throw new Error('createArtifact: ownerOrgId is required (no silent default; the caller must pass a trusted, board-validated org)');
  }
  if (!ALLOWED_KINDS.has(kind)) {
    throw new Error(`createArtifact: kind must be one of: ${[...ALLOWED_KINDS].join(', ')}`);
  }

  const body = typeof raw === 'string' ? raw : '';
  if (!body.trim()) {
    throw new Error('createArtifact: raw text is required');
  }

  const resolvedTitle = (typeof title === 'string' && title.trim()) ? title.trim() : '(untitled)';
  const sourceSystem = typeof source_system === 'string' ? source_system : 'mcp';
  const resolvedFormat = format || 'markdown';
  const resolvedMetadata = (metadata && typeof metadata === 'object') ? metadata : {};
  const resolvedOwnerId = ownerId || null;

  // Server-derived dedup keys.
  //
  // content_hash is the VERSION key: sha256(owner | body-prefix). It deliberately
  // DROPS source_system (OPT-97) so the SAME bytes from the same owner collapse to
  // ONE version regardless of which door they came through (generate vs Drive vs
  // MCP) — source_system is pure row metadata, not a dedup axis. owner is folded in
  // so two orgs' identical bytes do NOT collide into one version.
  //
  // identity_key is the ARTIFACT key: sha256(owner | title) when a title is present,
  // so the SAME doc captured via DIFFERENT doors (generate vs Drive vs MCP) collapses
  // to ONE artifact — source_system is DROPPED from the key (it is pure row metadata,
  // not a dedup axis). The versions then track each door's content under that one
  // artifact (a same-title push with changed bytes mints version_no+1 and flips
  // current). owner stays in the key (Linus M1) so two different users' same-titled
  // docs do NOT collapse into one artifact and clobber each other's current_version.
  // No title → fall back to content_hash (the bytes ARE the identity).
  const contentHash = sha256Hex(`${resolvedOwnerId}|${body.slice(0, 4096)}`);
  const hasExplicitIdentity = !!(typeof title === 'string' && title.trim());
  const identityKey = hasExplicitIdentity
    ? sha256Hex(`${resolvedOwnerId}|${resolvedTitle}`)
    : contentHash;

  // Feature 007: resolve the meeting identity (pure, offline) before the txn.
  // Unresolvable identity (nothing identifying supplied) skips linkage — the
  // artifact write itself is never blocked by missing meeting envelope.
  const meetingIdentity = (meeting && typeof meeting === 'object')
    ? deriveMeetingIdentity(meeting)
    : null;

  // ingestDocument runs G8 sanitize + PII classification internally. It is its own
  // write unit (pooled query) — call it first to obtain the documentId, then run the
  // artifact/version/queue writes in ONE transaction (the part that must be atomic
  // for the version flip). When the caller already ingested the content (TLDv path),
  // it passes documentId and we register over that row instead of re-ingesting.
  let documentId = existingDocumentId || null;
  if (!documentId) {
    const source = 'mcp-upload';
    const sourceId = 'artifact-' + contentHash.slice(0, 40);
    const ingestResult = await ingestDocument({
      source,
      sourceId,
      title: resolvedTitle,
      rawText: body,
      format: resolvedFormat,
      metadata: resolvedMetadata,
      ownerId: resolvedOwnerId,
      ownerOrgId,
    });
    if (!ingestResult) {
      return { ok: false, reason: 'empty_after_normalization' };
    }
    documentId = ingestResult.documentId;
  }

  // Atomic registry write: upsert artifact, insert version (dedup-guarded), flip
  // current_version_id, enqueue enrichment — all or nothing.
  return withTransaction(async (client) => {
    const artRes = await client.query(
      `INSERT INTO content.artifacts
         (kind, title, source_system, identity_key, owner_org_id, owner_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (owner_org_id, identity_key)
         DO UPDATE SET updated_at = now()
       RETURNING id, current_version_id`,
      [kind, resolvedTitle, sourceSystem, identityKey, ownerOrgId, resolvedOwnerId]
    );
    const artifactId = artRes.rows[0].id;
    const priorCurrentVersionId = artRes.rows[0].current_version_id;

    // Serialize the version-number computation for this artifact (Linus B1).
    await client.query('SELECT 1 FROM content.artifacts WHERE id = $1 FOR UPDATE', [artifactId]);

    // Feature 007: attach the artifact to its meeting (within-scope upsert) in the
    // SAME txn. Runs on dedup re-pushes too — a second source pushing identical
    // bytes still links the meeting it knows about.
    let meetingId = null;
    if (meetingIdentity) {
      const m = await upsertMeetingTx(client, {
        fingerprint: meetingIdentity.fingerprint,
        confidence: meetingIdentity.confidence,
        title: meeting.title || resolvedTitle,
        startedAt: meeting.startTime || null,
        participants: Array.isArray(meeting.participants) ? meeting.participants : [],
        calendarEventId: meeting.calendarEventId || null,
        ownerOrgId,
        ownerId: resolvedOwnerId,
        createdBy: resolvedOwnerId,
      });
      meetingId = m.id;
      await client.query(
        `UPDATE content.artifacts SET meeting_id = $1, updated_at = now()
          WHERE id = $2 AND meeting_id IS DISTINCT FROM $1`,
        [meetingId, artifactId]
      );
    }

    const verIns = await client.query(
      `INSERT INTO content.artifact_versions
         (artifact_id, version_no, document_id, content_hash, supersedes_id, created_by, owner_org_id)
       SELECT $1,
              COALESCE(MAX(av.version_no), 0) + 1,
              $2, $3, $4, $5, $6
         FROM content.artifact_versions av
        WHERE av.artifact_id = $1
       ON CONFLICT (artifact_id, content_hash) DO NOTHING
       RETURNING id, version_no`,
      [artifactId, documentId, contentHash, priorCurrentVersionId || null, resolvedOwnerId, ownerOrgId]
    );

    if (verIns.rows.length === 0) {
      // Idempotent re-push: the version already exists. Fetch it; do NOT enqueue
      // enrichment again (the content is unchanged).
      const existing = await client.query(
        `SELECT id, version_no FROM content.artifact_versions
          WHERE artifact_id = $1 AND content_hash = $2`,
        [artifactId, contentHash]
      );
      const ev = existing.rows[0];
      if (meetingId) await recomputePrimariesTx(client, meetingId);
      return {
        ok: true,
        artifactId,
        versionId: ev?.id || null,
        versionNo: ev?.version_no ?? null,
        documentId,
        deduped: true,
        enrichment: 'skipped',
        owner_org_id: ownerOrgId,
        meetingId,
        meetingFingerprint: meetingIdentity?.fingerprint || null,
      };
    }

    // New version → flip the artifact's current pointer.
    const versionId = verIns.rows[0].id;
    const versionNo = verIns.rows[0].version_no;
    await client.query(
      `UPDATE content.artifacts SET current_version_id = $1, updated_at = now() WHERE id = $2`,
      [versionId, artifactId]
    );

    // Enqueue enrichment (producer side; the AFTER-INSERT trigger pg_notifies).
    await client.query(
      `INSERT INTO content.enrichment_queue (document_id, artifact_id, owner_org_id)
       VALUES ($1, $2, $3)`,
      [documentId, artifactId, ownerOrgId]
    );

    if (meetingId) await recomputePrimariesTx(client, meetingId);

    return {
      ok: true,
      artifactId,
      versionId,
      versionNo,
      documentId,
      deduped: false,
      enrichment: 'pending',
      owner_org_id: ownerOrgId,
      meetingId,
      meetingFingerprint: meetingIdentity?.fingerprint || null,
    };
  });
}
