// api-routes/artifacts.js — OPT-92: the artifact registry write/read surface.
//
// The artifact registry is the first-class layer over content.documents (the RAG
// blob store): typed, versioned, status-tracked, tenancy-stamped artifacts that
// the enrichment worker (OPT-93) consumes off content.enrichment_queue. This file
// is the PRODUCER + reader; the worker is OPT-93.
//
// This is a *write* surface on a multi-tenant table, so it mirrors the OPT-90 /
// STAQPRO-611 (api-routes/ingest.js) invariants VERBATIM:
//
//   1. Ownership is DERIVED FROM THE TOKEN, never the request body. Any
//      owner_org_id / owner_user_id / owner_id / owner_scope in the body is a hard
//      400 — caller-supplied ownership is the 588/596 leak class in write form.
//   2. The dedup keys (content_hash, identity_key) are DERIVED SERVER-SIDE from a
//      content hash, so a caller cannot rotate them to bypass dedup and storm the
//      registry (the 602 feed-poller class). Same content in → same version.
//   3. A per-user DAILY CAP is enforced fail-closed before the write runs.
//   4. G8/Model-Armor sanitize + PII classification happen inside ingestDocument(),
//      so every artifact body passes the same gate as every other source.
//   5. Reads use visibleClause() fail-closed — an unresolved principal sees NO rows.
//
// owner_org_id is threaded from writerOrgId(principal); when the principal carries
// no org it falls through to... nothing — content.artifacts.owner_org_id is NOT
// NULL with no DEFAULT (mig-145-ready), so a no-org writer is a hard 400 rather
// than a silent mis-attribution to Staqs. (Unlike content.documents, this is a new
// table with no legacy single-org rows to grandfather.)

import { query, withBoardScope } from '../db.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import { createArtifact, ALLOWED_KINDS } from '../../../lib/content/create-artifact.js';

const ALLOWED_STATUSES = new Set(['active', 'superseded', 'archived']);

const DAILY_ARTIFACT_CAP = Number(process.env.MCP_ARTIFACT_DAILY_CAP || 200);
const MAX_BYTES = Number(process.env.MCP_ARTIFACT_MAX_BYTES || 1_000_000); // 1 MB / artifact

// Mirror ingest.js: reject any caller-supplied ownership param outright.
const OWNER_PARAMS = ['owner_org_id', 'owner_user_id', 'owner_id', 'owner_scope', 'ownerOrgId', 'ownerId'];

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Note: the 2nd arg (cachedQuery) is intentionally unused — the daily-cap count
// must read fresh (uncached) data, so it uses the directly-imported `query`
// (mirrors api-routes/ingest.js).
export function registerArtifactRoutes(routes, _cachedQuery, { withViewer } = {}) {
  // Resolve the tenancy principal for reads. null (withViewer absent or a
  // resolution throw) → visibleClause 'FALSE' → zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // POST /api/artifacts — capture a typed, versioned artifact (+ KB document).
  routes.set('POST /api/artifacts', async (req, body) => {
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
      // A 5xx from the auth system (DB down, misconfig) must surface as 5xx, not
      // be masked as "unauthenticated".
      if (err?.statusCode && err.statusCode >= 500) throw err;
      console.warn(`[artifacts] auth resolution failed: ${err?.message || err}`);
      principal = null;
    }
    // OPT-37: external customer principal. createArtifact also writes a
    // content.documents row, whose owner_id FKs agent_graph.board_members — so a
    // customer (not a board member) ingests ORG-SHARED: owner_id NULL,
    // owner_org_id = its verified bound org. Dedup is UNIQUE(owner_org_id,
    // identity_key) — already per-tenant.
    const isCustomer = req.auth?.source === 'customer_jwt';
    let ownerId, ownerOrgId;
    if (isCustomer) {
      // Fail fast on a malformed token (no org) BEFORE the cap query — a null
      // ownerOrgId would make `WHERE owner_org_id = NULL` match nothing and
      // silently pass the cap. (mirrors ingest.js)
      if (!req.auth.org_id) throw httpError('authentication required', 401);
      ownerId = null;                       // org-shared (FK-safe)
      ownerOrgId = String(req.auth.org_id); // verified + immutable
    } else {
      if (!principal?.userId) throw httpError('authentication required', 401);
      ownerId = principal.userId;
      ownerOrgId = writerOrgId(principal);
    }
    // content.artifacts.owner_org_id is NOT NULL with no DEFAULT — a writer with no
    // org cannot be stamped, so fail clearly rather than mis-attribute (no Staqs
    // grandfather on this new table).
    if (!ownerOrgId) {
      throw httpError('your token has no org membership; cannot write an artifact', 400);
    }

    // Validate kind (required) + optional status.
    const kind = body.kind;
    if (!ALLOWED_KINDS.has(kind)) {
      throw httpError(`kind must be one of: ${[...ALLOWED_KINDS].join(', ')}`, 400);
    }

    // Resolve the raw text. Either `raw` is supplied directly, OR a `url` is
    // fetched + normalized via lib/rag/normalizers/url.js (source_system='web').
    let raw = typeof body.raw === 'string' ? body.raw : '';
    let title = (typeof body.title === 'string' && body.title.trim()) ? body.title.trim() : '';
    let sourceSystem = typeof body.source_system === 'string' ? body.source_system : 'mcp';
    let format = body.format || 'markdown';
    let metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};

    if (typeof body.url === 'string' && body.url.trim()) {
      let doc;
      try {
        const { normalizeUrl } = await import('../../../lib/rag/normalizers/url.js');
        doc = await normalizeUrl(body.url.trim());
      } catch (err) {
        // Auth-walled / unreachable URL → fail clearly (do not silently ingest a
        // login page). normalizeUrl throws on a non-2xx fetch.
        throw httpError(`could not fetch url: ${err?.message || err}`, 400);
      }
      raw = doc.content || '';
      title = title || doc.title || body.url.trim();
      sourceSystem = 'web';
      format = 'plain';
      metadata = { ...doc.metadata, ...metadata };
    }

    if (!raw.trim()) throw httpError('raw text (or a fetchable url) is required', 400);
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw httpError(`raw exceeds ${MAX_BYTES} bytes`, 413);
    }
    // Note: title is passed through to createArtifact AS-IS (possibly '') — the core
    // decides identity (a non-empty title → identity_key keyed on title; empty →
    // content_hash) and defaults the stored title to '(untitled)'. This preserves
    // the OPT-92 HTTP behavior: identity was keyed on a present title, not on the
    // '(untitled)' placeholder.

    // (3) Per-user daily cap, fail-closed (mirrors ingest.js). Count artifacts the
    // caller created today.
    let usedToday;
    try {
      const r = isCustomer
        ? await query(
            `SELECT count(*)::int AS n FROM content.artifacts
              WHERE owner_org_id = $1 AND owner_id IS NULL AND created_at >= CURRENT_DATE`,
            [ownerOrgId]
          )
        : await query(
            `SELECT count(*)::int AS n FROM content.artifacts
              WHERE owner_id = $1 AND created_at >= CURRENT_DATE`,
            [ownerId]
          );
      usedToday = r.rows[0].n;
    } catch {
      throw httpError('artifact cap check failed', 503); // fail-closed: do not write
    }
    if (usedToday >= DAILY_ARTIFACT_CAP) {
      throw httpError(`daily artifact cap of ${DAILY_ARTIFACT_CAP} reached`, 429);
    }

    // Feature 007: optional meeting identity envelope (MCP/CLI path). This is
    // IDENTITY data (when/what/who the meeting was), not ownership — safe from a
    // body. Field-allowlisted; documentId is NEVER accepted from a body (attaching
    // to an arbitrary existing document would be a cross-tenant read/link leak).
    let meeting = null;
    if (body.meeting && typeof body.meeting === 'object') {
      const m = body.meeting;
      meeting = {
        calendarEventId: typeof m.calendarEventId === 'string' ? m.calendarEventId : null,
        title: typeof m.title === 'string' ? m.title : title,
        startTime: (typeof m.startTime === 'string' || typeof m.startTime === 'number') ? m.startTime : null,
        participantEmails: Array.isArray(m.participantEmails)
          ? m.participantEmails.filter((e) => typeof e === 'string').slice(0, 200)
          : [],
        participants: Array.isArray(m.participants) ? m.participants.slice(0, 200) : [],
        fallbackId: typeof m.fallbackId === 'string' ? m.fallbackId : null,
        participantsAreAttendees: m.participantsAreAttendees !== false,
      };
    }

    // (2)(4) The dedup-key derivation (server-side, content-only hash), G8/PII
    // sanitize via ingestDocument, and the atomic artifact/version/queue write all
    // live in the trusted core (lib/content/create-artifact.js). Ownership is the
    // token-derived ownerOrgId/ownerId computed above — NEVER the request body
    // (the OWNER_PARAMS → 400 guard at the top is the edge that enforces that).
    // TODO(opt-166-p3): createArtifact() writes content.documents (RLS-enforced)
    // via its own unscoped `query()` import in lib/content/create-artifact.js —
    // out of scope for this route-file batch (OPT-166 P3-B3 touches only the 5
    // named api-routes/*.js files). Needs a withAgentScope wrap inside that
    // module (or a scoped-connection param threaded through) in a
    // lib/content-scoped follow-up.
    return createArtifact({
      raw,
      kind,
      title,
      source_system: sourceSystem,
      ownerOrgId,
      ownerId,
      metadata,
      format,
      meeting,
    });
  });

  // GET /api/artifacts — list, tenant-scoped fail-closed. Optional kind/status.
  routes.set('GET /api/artifacts', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const url = new URL(req.url, 'http://localhost');
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

    const params = [];
    const where = [];
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: params.length + 1 });
    where.push(v.sql);
    params.push(...v.params);
    if (kind) {
      if (!ALLOWED_KINDS.has(kind)) throw httpError(`unknown kind: ${kind}`, 400);
      params.push(kind);
      where.push(`kind = $${params.length}`);
    }
    if (status) {
      if (!ALLOWED_STATUSES.has(status)) throw httpError(`unknown status: ${status}`, 400);
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    params.push(limit);
    const sql = `
      SELECT id, kind, title, status, source_system, current_version_id,
             owner_org_id, owner_id, created_at, updated_at
        FROM content.artifacts
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`;
    const result = await query(sql, params);
    return { ok: true, artifacts: result.rows };
  });

  // GET /api/artifacts/:id — one artifact + its versions, fail-closed (404 if not
  // visible to the principal). The artifact row is org-gated by visibleClause; the
  // versions read inherits that gate (a version cannot belong to a different org
  // than its artifact — both stamped in the same write txn).
  routes.set('GET /api/artifacts/:id', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/').filter(Boolean).pop();

    const params = [id];
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
    const artRes = await query(
      `SELECT id, kind, title, status, source_system, identity_key, current_version_id,
              owner_org_id, owner_id, created_at, updated_at
         FROM content.artifacts
        WHERE id = $1 AND ${v.sql}`,
      [...params, ...v.params]
    );
    if (artRes.rows.length === 0) throw httpError('artifact not found', 404);

    const versions = await query(
      `SELECT id, version_no, document_id, content_hash, supersedes_id, created_at
         FROM content.artifact_versions
        WHERE artifact_id = $1
        ORDER BY version_no DESC`,
      [id]
    );
    return { ok: true, artifact: artRes.rows[0], versions: versions.rows };
  });

  // ── OPT-93 on-demand enrichment reads ──────────────────────────────────────
  // "Pull everything captured into this entity now." The READ of links + facts
  // is the must-have (a re-enqueue is optional); these endpoints back the MCP
  // tools optimus_enrich_contact / optimus_enrich_project. Tenant-scoped via
  // visibleClause(owner_org_id) fail-closed on BOTH content.artifact_entity_links
  // and content.derived_facts — an unresolved principal sees zero rows, and a
  // Staqs viewer can never read a UMB entity's links/facts.
  async function entityEnrichment(req, entityType) {
    const principal = await resolvePrincipalFor(req);
    const url = new URL(req.url, 'http://localhost');
    const entityId = url.pathname.split('/').filter(Boolean).pop();
    if (!entityId) throw httpError('entity id required', 400);

    const lv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 3 });
    const links = await query(
      `SELECT id, artifact_id, entity_type, entity_id, confidence, link_status,
              resolved_by, resolved_at, created_at
         FROM content.artifact_entity_links
        WHERE entity_type = $1 AND entity_id = $2 AND ${lv.sql}
        ORDER BY created_at DESC`,
      [entityType, entityId, ...lv.params]
    );

    const fv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 3 });
    const facts = await query(
      `SELECT id, fact, artifact_id, document_id, confidence, created_at
         FROM content.derived_facts
        WHERE entity_type = $1 AND entity_id = $2 AND ${fv.sql}
        ORDER BY created_at DESC`,
      [entityType, entityId, ...fv.params]
    );

    return {
      ok: true,
      entity_type: entityType,
      entity_id: entityId,
      links: links.rows,
      facts: facts.rows,
    };
  }

  // GET /api/artifacts/enrich/contact/:id — links + derived facts for a contact.
  routes.set('GET /api/artifacts/enrich/contact/:id', (req) => entityEnrichment(req, 'contact'));

  // GET /api/artifacts/enrich/project/:id — links + derived facts for a project.
  routes.set('GET /api/artifacts/enrich/project/:id', (req) => entityEnrichment(req, 'project'));

  // ── OPT-94: link-management surface (board review queue + mutate + SLO) ─────
  // The enrichment worker writes 'auto'/'pending' links into
  // content.artifact_entity_links; the board confirms/rejects the 'pending' band.
  // These three routes back the board UI (PR B). All are tenancy-scoped via
  // visibleClause(owner_org_id) fail-closed — a Staqs caller can never see or
  // mutate a UMB link. The PATCH additionally requires a board human: confirming/
  // rejecting a link is a control-plane review action.

  // Board-human-only gate (Linus / spec D3). The pending queue exists for HUMAN
  // adjudication of matches the auto-linker couldn't decide — letting a machine
  // grade its own queue is circular and would corrupt the precision SLO (machine
  // verdicts absorbed as human ground truth). An adminBypass agent also resolves
  // visibleClause=TRUE (org-unrestricted), so excluding agents keeps every reviewer
  // org-scoped and guarantees resolved_by is always a real board member. Rejects a
  // plain viewer AND a bare api_secret (role:'board' but no github_username). If an
  // agent-confirm use case ever appears, reintroduce it deliberately with a machine
  // identity in resolved_by and exclude it from the precision proxy (P1: deny by default).
  const requireBoardHuman = (req) => {
    const auth = req.auth || null;
    const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
    if (!isBoardHuman) {
      throw httpError('Link review requires a board member', 403);
    }
  };

  // Best-effort display label for the linked entity. entity_id is TEXT (it holds a
  // contact/project/org TEXT id OR an engagement UUID-as-text); every comparison is
  // TEXT↔TEXT (engagements.id::text) so an arbitrary entity_id can never be cast to
  // a UUID and crash the query. CASE keys the subquery on entity_type so only the
  // matching lookup runs. A contact resolves to "name <email>".
  const ENTITY_LABEL_SQL = `
    CASE el.entity_type
      WHEN 'contact' THEN (
        SELECT COALESCE(c.name, '') ||
               CASE WHEN c.email_address IS NOT NULL AND c.email_address <> ''
                    THEN ' <' || c.email_address || '>' ELSE '' END
          FROM signal.contacts c WHERE c.id = el.entity_id)
      WHEN 'project' THEN (
        SELECT p.name FROM agent_graph.projects p WHERE p.id = el.entity_id)
      WHEN 'org' THEN (
        SELECT o.name FROM signal.organizations o WHERE o.id = el.entity_id)
      WHEN 'engagement' THEN (
        SELECT e.name FROM engagements.engagements e WHERE e.id::text = el.entity_id)
      ELSE NULL
    END`;

  const ALLOWED_LINK_ENTITY_TYPES = new Set(['contact', 'project', 'engagement', 'org']);
  const RESOLVABLE_LINK_STATUSES = new Set(['confirmed', 'rejected']);

  // GET /api/artifacts/links/pending — org-wide pending-review queue, fail-closed.
  // Each pending link is joined to its artifact (title, kind) plus a best-effort
  // entity display label. Optional ?entity_type= filter and ?limit= (default 100,
  // cap 500). Tenant-scoped via visibleClause on the LINK row — the artifact JOIN
  // inherits the link's org (both stamped in the same enrichment write).
  routes.set('GET /api/artifacts/links/pending', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const url = new URL(req.url, 'http://localhost');
    const entityType = url.searchParams.get('entity_type');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);

    const params = [];
    const where = [`el.link_status = 'pending'`];
    const v = visibleClause(principal, { ownerOrgCol: 'el.owner_org_id', startIndex: params.length + 1 });
    where.push(v.sql);
    params.push(...v.params);
    if (entityType) {
      if (!ALLOWED_LINK_ENTITY_TYPES.has(entityType)) {
        throw httpError(`unknown entity_type: ${entityType}`, 400);
      }
      params.push(entityType);
      where.push(`el.entity_type = $${params.length}`);
    }
    params.push(limit);
    const sql = `
      SELECT el.id, el.artifact_id, a.title AS artifact_title, a.kind,
             el.entity_type, el.entity_id, (${ENTITY_LABEL_SQL}) AS entity_label,
             el.confidence, el.created_at
        FROM content.artifact_entity_links el
        JOIN content.artifacts a ON a.id = el.artifact_id
       WHERE ${where.join(' AND ')}
       ORDER BY el.created_at DESC
       LIMIT $${params.length}`;

    // OPT-166 P3: authed-any route — signal.contacts + signal.organizations
    // (enforced) are touched via the ENTITY_LABEL_SQL subquery embedded above.
    // Non-board principals keep the legacy pool (INERT pre-flip; RLS
    // fail-closed post-flip); board callers get a scoped session.
    const boardScope = req.auth?.role === 'board' ? await withBoardScope(req.auth) : null;
    const scopedQuery = boardScope ?? query;
    let result;
    try {
      result = await scopedQuery(sql, params);
    } finally {
      if (boardScope) await boardScope.release();
    }
    return { ok: true, links: result.rows };
  });

  // GET /api/artifacts/links/stats — the auto-link precision SLO. Tenant-scoped
  // counts by link_status + a precision proxy = confirmed / (confirmed + rejected)
  // over REVIEWED links (NULL when nothing has been reviewed yet).
  routes.set('GET /api/artifacts/links/stats', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    const result = await query(
      `SELECT
         count(*) FILTER (WHERE link_status = 'auto')::int      AS auto,
         count(*) FILTER (WHERE link_status = 'pending')::int   AS pending,
         count(*) FILTER (WHERE link_status = 'confirmed')::int AS confirmed,
         count(*) FILTER (WHERE link_status = 'rejected')::int  AS rejected
        FROM content.artifact_entity_links
       WHERE ${v.sql}`,
      v.params
    );
    const c = result.rows[0] || { auto: 0, pending: 0, confirmed: 0, rejected: 0 };
    const counts = {
      auto: c.auto || 0,
      pending: c.pending || 0,
      confirmed: c.confirmed || 0,
      rejected: c.rejected || 0,
    };
    const reviewed = counts.confirmed + counts.rejected;
    const precision = reviewed > 0 ? counts.confirmed / reviewed : null;
    return { ok: true, counts, reviewed, precision };
  });

  // PATCH /api/artifacts/links/:id — confirm/reject a link. Privileged writers
  // only. Org-scoped UPDATE (visibleClause IN THE WHERE) so a caller can never
  // mutate another org's link — 404 fail-closed if the row is not visible. Works
  // on a currently-'pending' OR 'auto' link (rejecting an 'auto' = flagging a false
  // auto-link, which feeds the precision SLO). resolved_by / resolved_at stamped.
  routes.set('PATCH /api/artifacts/links/:id', async (req, body) => {
    const principal = await resolvePrincipalFor(req);
    requireBoardHuman(req);
    body = body || {};

    const newStatus = body.link_status;
    if (!RESOLVABLE_LINK_STATUSES.has(newStatus)) {
      throw httpError(`link_status must be one of: ${[...RESOLVABLE_LINK_STATUSES].join(', ')}`, 400);
    }

    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/').filter(Boolean).pop();
    if (!id) throw httpError('link id required', 400);

    // Org-scoped UPDATE: the visibleClause is in the WHERE, so an UPDATE on a link
    // the caller cannot see matches zero rows → 404 (never another org's link).
    // resolved_by is the reviewing board member's userId (the gate guarantees a
    // board human, so this is always a real person — never NULL/agent).
    const params = [newStatus, principal?.userId || null, id];
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: params.length + 1 });
    const result = await query(
      `UPDATE content.artifact_entity_links
          SET link_status = $1, resolved_by = $2, resolved_at = now()
        WHERE id = $3 AND link_status IN ('pending','auto') AND ${v.sql}
        RETURNING id, artifact_id, entity_type, entity_id, confidence,
                  link_status, resolved_by, resolved_at, owner_org_id, created_at`,
      [...params, ...v.params]
    );
    if (result.rows.length === 0) throw httpError('link not found', 404);
    return { ok: true, link: result.rows[0] };
  });
}
