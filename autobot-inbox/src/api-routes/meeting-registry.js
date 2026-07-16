// api-routes/meeting-registry.js — Feature 007: the meeting-hierarchy read
// surface + the explicit personal→org promotion action.
//
// Mounted at /api/meeting-registry (NOT /api/meetings — that path is the legacy
// inbox.messages transcript list in api-routes/meetings.js; this surface reads
// the content.meetings IDENTITY layer from migration 157).
//
// READS mirror the artifacts surface: visibleClause() fail-closed, with
// ownerUserCol='owner_id' so a member sees their PERSONAL meetings (Tier 1)
// alongside their orgs' shared meetings (Tier 2). The cross-scope "also captured
// at org level" link is a same-fingerprint EXISTS under the SAME predicate — a
// viewer only ever learns about a peer row they could read anyway (D3: links are
// surfaced only where tenancy already permits; cross-org rows stay invisible).
//
// PROMOTION is consent-by-the-owner: only the personal owner of a meeting (or an
// admin bypass) can promote it into their org's shared record. The org id passed
// to the trusted core is the MEETING ROW's own owner_org_id — never the request
// body (the 588/596 leak class). The core supersedes the personal row with
// lineage (P3); it never deletes.

import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import { writerOrgId } from '../../../lib/tenancy/owner-stamp.js';
import { promoteMeeting } from '../../../lib/content/meetings.js';
import { getPrecedenceLayers, setSourcePrecedence } from '../../../lib/content/meeting-prefs.js';

const ALLOWED_STATUSES = new Set(['active', 'superseded', 'archived']);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Board-human gate for the ORG-LEVEL precedence default (mirrors capture-sources):
// setting the org's canonical source ordering is a control-plane act. A user
// setting their OWN override needs only an authenticated principal.
function requireBoardHuman(req) {
  const auth = req?.auth || null;
  if (!(auth?.role === 'board' && auth?.github_username)) {
    throw httpError('Setting the org-default source precedence requires a board member', 403);
  }
}

export function registerMeetingRegistryRoutes(routes, { withViewer } = {}) {
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // GET /api/meeting-registry — tenant-scoped list. ?status= (default active), ?limit=.
  routes.set('GET /api/meeting-registry', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || 'active';
    if (!ALLOWED_STATUSES.has(status)) {
      throw httpError(`status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`, 400);
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

    const params = [];
    const vm = visibleClause(principal, {
      ownerUserCol: 'm.owner_id', ownerOrgCol: 'm.owner_org_id', startIndex: 1,
    });
    params.push(...vm.params);
    const vp = visibleClause(principal, {
      ownerUserCol: 'p.owner_id', ownerOrgCol: 'p.owner_org_id', startIndex: vm.nextIndex,
    });
    params.push(...vp.params);

    params.push(status);
    const pStatus = params.length;
    params.push(limit);
    const pLimit = params.length;

    const result = await query(
      `SELECT m.id, m.meeting_fingerprint, m.fingerprint_confidence, m.title,
              m.started_at, m.participants, m.calendar_event_id, m.owner_org_id,
              m.owner_id, m.primary_transcript_id, m.primary_summary_id, m.status,
              m.superseded_by, m.created_at, m.updated_at,
              (SELECT count(*)::int FROM content.artifacts a WHERE a.meeting_id = m.id) AS artifact_count,
              -- Cross-scope link (D3): a DIFFERENT visible row with the same
              -- fingerprint. Same predicate as the outer read — never leaks a
              -- row the viewer couldn't already read on its own.
              EXISTS (
                SELECT 1 FROM content.meetings p
                 WHERE p.meeting_fingerprint = m.meeting_fingerprint
                   AND p.id != m.id AND p.status = 'active' AND (${vp.sql})
              ) AS has_visible_peer
         FROM content.meetings m
        WHERE (${vm.sql}) AND m.status = $${pStatus}
        ORDER BY m.started_at DESC NULLS LAST, m.created_at DESC
        LIMIT $${pLimit}`,
      params
    );
    return { meetings: result.rows };
  });

  // GET /api/meeting-registry/:id — meeting + child artifacts + visible peers.
  routes.set('GET /api/meeting-registry/:id', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const id = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.split('/').pop() || '');

    const params = [id];
    const vm = visibleClause(principal, {
      ownerUserCol: 'm.owner_id', ownerOrgCol: 'm.owner_org_id', startIndex: 2,
    });
    params.push(...vm.params);

    const mRes = await query(
      `SELECT m.* FROM content.meetings m WHERE m.id = $1 AND (${vm.sql})`,
      params
    );
    const meeting = mRes.rows[0];
    if (!meeting) throw httpError('meeting not found', 404);

    const arts = await query(
      `SELECT a.id, a.kind, a.title, a.source_system, a.status,
              a.current_version_id, a.created_at, a.updated_at
         FROM content.artifacts a
        WHERE a.meeting_id = $1
        ORDER BY a.kind, a.updated_at DESC`,
      [meeting.id]
    );

    const peerParams = [meeting.meeting_fingerprint, meeting.id];
    const vp = visibleClause(principal, {
      ownerUserCol: 'p.owner_id', ownerOrgCol: 'p.owner_org_id', startIndex: 3,
    });
    peerParams.push(...vp.params);
    const peers = await query(
      `SELECT p.id, p.owner_org_id, p.owner_id, p.status, p.fingerprint_confidence
         FROM content.meetings p
        WHERE p.meeting_fingerprint = $1 AND p.id != $2 AND (${vp.sql})`,
      peerParams
    );

    return { meeting, artifacts: arts.rows, peers: peers.rows };
  });

  // POST /api/meeting-registry/:id/promote — explicit personal→org promotion (D3).
  routes.set('POST /api/meeting-registry/:id/promote', async (req) => {
    if (!withViewer) throw httpError('auth unavailable', 500);
    let principal;
    try {
      ({ principal } = await withViewer(req));
    } catch (err) {
      if (err?.statusCode && err.statusCode >= 500) throw err;
      principal = null;
    }
    if (!principal?.userId) throw httpError('authentication required', 401);

    const segs = new URL(req.url, 'http://localhost').pathname.split('/');
    const id = decodeURIComponent(segs[segs.length - 2] || '');
    const mRes = await query(`SELECT * FROM content.meetings WHERE id = $1`, [id]);
    const meeting = mRes.rows[0];
    if (!meeting) throw httpError('meeting not found', 404);
    if (!meeting.owner_id) throw httpError('meeting is already org-shared', 409);

    // Consent boundary: only the personal owner shares their own note.
    if (String(meeting.owner_id) !== String(principal.userId) && !principal.adminBypass) {
      throw httpError('only the owner can promote their personal meeting', 403);
    }

    // toOrgId comes from the MEETING ROW (board-validated at capture), never the
    // body — promotion shares into the meeting's own org by definition.
    const result = await promoteMeeting({
      meetingId: meeting.id,
      toOrgId: meeting.owner_org_id,
      actorId: principal.userId,
    });
    if (!result.ok) {
      const codes = { not_found: 404, already_org_shared: 409, already_superseded: 409, org_mismatch: 400 };
      throw httpError(result.reason || 'promotion failed', codes[result.reason] || 400);
    }
    return result;
  });

  // GET /api/meeting-registry/source-precedence — the three layers (system / org
  // default / this user's override) + the effective ordering, for the UI editor.
  // EXACT key — routeKeyFor's routes.has() check resolves it before the
  // /:id matcher, so "source-precedence" is never read as a meeting id.
  routes.set('GET /api/meeting-registry/source-precedence', async (req) => {
    const principal = await resolvePrincipalFor(req);
    if (!principal?.userId) throw httpError('authentication required', 401);
    const ownerOrgId = writerOrgId(principal);
    if (!ownerOrgId) throw httpError('your token has no org membership', 400);
    const layers = await getPrecedenceLayers(query, ownerOrgId, principal.userId);
    return { ok: true, owner_org_id: ownerOrgId, ...layers };
  });

  // PATCH /api/meeting-registry/source-precedence — set or clear a precedence.
  // Body: { scope: 'user'|'org', precedence: string[]|null }. precedence omitted
  // or null clears that level (reverts to the next in the chain). Owner is always
  // token-derived (never the body); org-level writes additionally require a board
  // human. On success, primaries are re-picked across the affected scope.
  routes.set('PATCH /api/meeting-registry/source-precedence', async (req, body) => {
    if (!withViewer) throw httpError('auth unavailable', 500);
    let principal;
    try {
      ({ principal } = await withViewer(req));
    } catch (err) {
      if (err?.statusCode && err.statusCode >= 500) throw err;
      principal = null;
    }
    if (!principal?.userId) throw httpError('authentication required', 401);
    const ownerOrgId = writerOrgId(principal);
    if (!ownerOrgId) throw httpError('your token has no org membership', 400);

    body = body || {};
    const scope = body.scope === 'org' ? 'org' : body.scope === 'user' ? 'user' : null;
    if (!scope) throw httpError("scope must be 'user' or 'org'", 400);
    if (scope === 'org') requireBoardHuman(req); // control-plane: org-wide default

    // precedence null/absent → clear. validatePrecedence (in the core) rejects
    // unknown kinds / dupes with a 400.
    const precedence = (body.precedence === undefined || body.precedence === null)
      ? null
      : body.precedence;

    const result = await setSourcePrecedence({
      ownerOrgId,
      ownerId: scope === 'org' ? null : principal.userId,
      precedence,
      updatedBy: principal.userId,
    });
    return { ok: true, scope, ...result };
  });
}
