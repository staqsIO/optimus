// api-routes/ingest.js — MCP capture write surface (STAQPRO-611, extends 581).
//
// POST /api/ingest — push a document/transcript/daily-summary into the knowledge
// base from an external Claude (MCP). This is a *write* surface on a multi-tenant
// table, so it follows the rules the Liotta/Linus/Neo review set before any code:
//
//   1. Ownership is DERIVED FROM THE TOKEN, never from the request body. Any
//      owner_org_id / owner_user_id / owner_id / owner_scope in the body is a hard
//      400 — caller-supplied ownership is the 588/596 leak class in write form.
//   2. The dedup key (source_id) is DERIVED SERVER-SIDE from a content hash, so a
//      caller cannot rotate it to bypass dedup and storm the KB (the 602 feed-poller
//      class). Same content in → same row.
//   3. A per-user DAILY DOCUMENT CAP is enforced fail-closed before ingest runs.
//   4. G8/Model-Armor sanitize + PII classification happen inside ingestDocument(),
//      so every MCP-submitted doc passes the same gate as every other source.
//
// owner_org_id is threaded into ingestDocument from writerOrgId(principal); when the
// principal carries no org it falls through to the column DEFAULT (single-org-correct
// until mig-145 drops it). UMB members must have a tenancy.memberships row for their
// org or their pushes default to Staqs — that is a provisioning precondition, not a
// code path.

import crypto from 'crypto';
import { query, withBoardScope } from '../db.js';
import { ingestDocument } from '../../../lib/rag/ingest.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';

// Sources an external caller may write. Kept tight on purpose — these map to the
// three MCP capture tools (document, transcript, daily-summary).
const ALLOWED_SOURCES = new Set(['mcp-upload', 'transcript', 'daily-summary']);

// Formats we accept; transcripts use the meeting normalizers (tldv/gemini).
const ALLOWED_FORMATS = new Set(['plain', 'markdown', 'tldv', 'gemini']);

const DAILY_DOC_CAP = Number(process.env.MCP_INGEST_DAILY_CAP || 200);
const MAX_BYTES = Number(process.env.MCP_INGEST_MAX_BYTES || 1_000_000); // 1 MB / doc

const OWNER_PARAMS = ['owner_org_id', 'owner_user_id', 'owner_id', 'owner_scope', 'ownerOrgId', 'ownerId'];

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Note: the 2nd arg (cachedQuery) is intentionally unused — the daily-cap count
// must read fresh (uncached) data, so it bypasses any pooled/cached query path
// (OPT-166 P3: board callers get a scoped session below; non-board keeps the
// legacy pool).
export function registerIngestRoutes(routes, _cachedQuery, { withViewer } = {}) {
  routes.set('POST /api/ingest', async (req, body) => {
    if (!withViewer) throw httpError('auth unavailable', 500);
    body = body || {};

    // (1) Reject any caller-supplied ownership — ownership is token-derived only.
    for (const k of OWNER_PARAMS) {
      if (body[k] !== undefined) {
        throw httpError(`${k} is not accepted; ownership is derived from your token`, 400);
      }
    }

    // Resolve the writer principal from the verified token.
    let principal;
    try {
      ({ principal } = await withViewer(req));
    } catch (err) {
      // Distinguish a bad/expired token (→ 401 below) from an infra failure of the
      // auth system (DB down, misconfig) — the latter must surface as 5xx, not be
      // masked as "unauthenticated".
      if (err?.statusCode && err.statusCode >= 500) throw err;
      console.warn(`[ingest] auth resolution failed: ${err?.message || err}`);
      principal = null;
    }
    // OPT-37: an external customer principal has no per-user owner — content.
    // documents.owner_id FKs agent_graph.board_members, so a customer can never
    // own a row. Its contributions ingest ORG-SHARED (owner_id NULL) into its
    // single bound org. Ownership, the daily cap, and the dedup key all key on
    // the org for a customer; on the board user otherwise.
    const isCustomer = req.auth?.source === 'customer_jwt';
    let ownerId, ownerOrgId;
    if (isCustomer) {
      if (!req.auth.org_id) throw httpError('authentication required', 401);
      ownerId = null;                       // org-shared (FK-safe)
      ownerOrgId = String(req.auth.org_id); // verified + immutable (verifyCustomerToken)
    } else {
      if (!principal?.userId) throw httpError('authentication required', 401);
      ownerId = principal.userId;
      ownerOrgId = writerOrgId(principal); // null → column DEFAULT (single-org)
    }

    // Validate inputs.
    const raw = typeof body.raw === 'string' ? body.raw : '';
    if (!raw.trim()) throw httpError('raw text is required', 400);
    const source = body.source || 'mcp-upload';
    if (!ALLOWED_SOURCES.has(source)) {
      throw httpError(`source must be one of: ${[...ALLOWED_SOURCES].join(', ')}`, 400);
    }
    const format = body.format || 'plain';
    if (!ALLOWED_FORMATS.has(format)) {
      throw httpError(`format must be one of: ${[...ALLOWED_FORMATS].join(', ')}`, 400);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw httpError(`raw exceeds ${MAX_BYTES} bytes`, 413);
    }
    const title = (typeof body.title === 'string' && body.title.trim()) ? body.title.trim() : '(untitled)';
    const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};

    // (3) Daily cap, fail-closed (mirrors lib/llm/record-spend dailySpendUsd).
    // Board: per-user (owner_id). Customer: per-org over the org-shared corpus
    // (owner_id IS NULL) — a customer has no owner_id to count, and this bounds
    // a customer storming its org's KB.
    // OPT-166 P3: authed-any route — this endpoint's primary caller is an
    // external MCP/customer token, which withAgentScope/withBoardScope would
    // 500 (or mis-scope) if forced through a scoped session. Non-board keeps
    // the legacy pool (INERT pre-flip; RLS fail-closed post-flip); a board
    // caller (incl legacy api_secret → role 'board') gets a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let usedToday;
    try {
      const r = isCustomer
        ? await scopedQuery(
            `SELECT count(*)::int AS n FROM content.documents
              WHERE owner_org_id = $1 AND owner_id IS NULL AND created_at >= CURRENT_DATE`,
            [ownerOrgId]
          )
        : await scopedQuery(
            `SELECT count(*)::int AS n FROM content.documents
              WHERE owner_id = $1 AND created_at >= CURRENT_DATE`,
            [ownerId]
          );
      usedToday = r.rows[0].n;
    } catch {
      throw httpError('ingest cap check failed', 503); // fail-closed: do not ingest
    } finally {
      if (boardScope) await boardScope.release();
    }
    if (usedToday >= DAILY_DOC_CAP) {
      throw httpError(`daily ingest cap of ${DAILY_DOC_CAP} documents reached`, 429);
    }

    // (2) Server-derived dedup key — caller cannot control it. The key is the
    // CONTENT (owner + source + body prefix), NOT the title: the 602 storm came
    // from deduping on a mutable LLM-generated label, so the same transcript with a
    // tweaked title must not create a second row. Same content → one row.
    // Namespace the dedup key by the OWNER. For a customer (owner_id NULL) that
    // is the org id — otherwise two customers in different orgs pushing identical
    // content would collapse to one cross-tenant row.
    const dedupOwner = isCustomer ? `org:${ownerOrgId}` : `${ownerId}`;
    const sourceId = 'mcp-' + crypto
      .createHash('sha256')
      .update(`${dedupOwner}|${source}|${raw.slice(0, 4096)}`)
      .digest('hex')
      .slice(0, 40);

    // (4) ingestDocument runs G8 sanitize + PII classification internally.
    const result = await ingestDocument({
      source,
      sourceId,
      title,
      rawText: raw,
      format,
      metadata,
      ownerId,
      ownerOrgId,
    });

    if (!result) return { ok: false, reason: 'empty_after_normalization' };
    return {
      ok: true,
      documentId: result.documentId,
      chunkCount: result.chunkCount,
      embedded: result.embedded,
      deduped: result.chunkCount === 0,
      owner_org_id: ownerOrgId,
    };
  });
}
