// api-routes/capture-sources.js — OPT-96 (Feature 005 Layer 1): the board-managed
// per-org registry of passive capture sources (content.capture_sources).
//
// This mirrors the 619-A Linear-teams board surface (api-routes/linear.js) VERBATIM:
//   - requireBoardHuman gate on the WRITES (POST create + PATCH) — a control-plane
//     action, never an agent or a bare api_secret.
//   - PATCH-key allowlist: only {enabled, owner_org_id, default_kind, allowlist,
//     label} are editable; source_type / external_id are create-only (any other key
//     -> 400). Ownership/identity is never set from an untrusted body shape.
//   - owner_org_id is validated against tenancy.orgs — an arbitrary UUID is rejected
//     (an unknown org would silently un-tenant captures).
//   - enable-with-org guard: a source enabled with no owner_org_id captures nothing
//     (the watcher fails closed on a null org) -> reject the misleading state up front.
//   - UNIQUE (source_type, external_id) is GLOBAL; a duplicate folder -> 409.
//   - GET list is tenant-scoped via visibleClause(owner_org_id) fail-closed.
//   - PATCH UPDATE carries visibleClause in the WHERE so a caller can never mutate
//     another org's source -> 404 fail-closed if the row is not visible.

import { query as defaultQuery } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

const ALLOWED_DEFAULT_KINDS = new Set([
  'prd', 'proposal', 'spec', 'adr', 'brief', 'deck',
  'transcript', 'summary', 'doc', 'other',
]);
const ALLOWED_SOURCE_TYPES = new Set(['drive_folder', 'gmail_label', 'slack_channel']);
const ALLOWED_PATCH_KEYS = new Set(['enabled', 'owner_org_id', 'default_kind', 'allowlist', 'label']);

// OPT-101: owner_email is the SENSITIVE impersonation target — the workspace email
// the watcher impersonates to READ this source. It is STAMPED server-side from the
// authenticated board_members.email (resolveImpersonationEmail), NEVER from the
// body. A body-supplied owner_email is a hard 400 (mirrors the artifacts.js
// OWNER_PARAMS pattern): we never let a caller choose whose Drive to impersonate.
const FORBIDDEN_BODY_KEYS = ['owner_email', 'ownerEmail'];

// OPT-101: 'access' tells the create handler whether the picked source needs
// impersonation. 'impersonated' (a personal/shared folder) -> stamp the resolver's
// email. 'sa_direct' (a Shared Drive the SA is a member of) -> owner_email = null
// (no impersonation at poll time). Default 'impersonated' (the safe, scoped path).
const ALLOWED_ACCESS = new Set(['impersonated', 'sa_direct']);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Board-human gate (mirrors artifacts.js requireBoardHuman + linear.js requireBoard).
// Managing capture sources is a control-plane action: it sets the org a folder's
// captures attribute to. Rejects a plain viewer AND a bare api_secret (role:'board'
// but no github_username) AND an agent. P1: deny by default.
function requireBoardHuman(req) {
  const auth = req?.auth || null;
  const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
  if (!isBoardHuman) {
    throw httpError('Capture-source management requires a board member', 403);
  }
}

// Validate the allowlist jsonb shape: an object with optional mime[] / ext[] (arrays
// of strings) and max_bytes (a number). Anything else -> 400. Returns a normalized
// allowlist (defaults filled) so the stored shape is always complete.
function validateAllowlist(value) {
  if (value === undefined || value === null) {
    return { mime: [], ext: [], max_bytes: 1_000_000 };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw httpError('allowlist must be an object {mime?:[], ext?:[], max_bytes?:number}', 400);
  }
  const out = { mime: [], ext: [], max_bytes: 1_000_000 };
  if (value.mime !== undefined) {
    if (!Array.isArray(value.mime) || value.mime.some((x) => typeof x !== 'string')) {
      throw httpError('allowlist.mime must be an array of strings', 400);
    }
    out.mime = value.mime;
  }
  if (value.ext !== undefined) {
    if (!Array.isArray(value.ext) || value.ext.some((x) => typeof x !== 'string')) {
      throw httpError('allowlist.ext must be an array of strings', 400);
    }
    out.ext = value.ext;
  }
  if (value.max_bytes !== undefined) {
    if (typeof value.max_bytes !== 'number' || !Number.isFinite(value.max_bytes) || value.max_bytes <= 0) {
      throw httpError('allowlist.max_bytes must be a positive number', 400);
    }
    out.max_bytes = value.max_bytes;
  }
  return out;
}

// Validate owner_org_id exists in the tenancy boundary table. Never accept an
// arbitrary UUID — an unknown org would silently un-tenant captures.
async function assertKnownOrg(query, orgId) {
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    throw httpError('owner_org_id must be a UUID string', 400);
  }
  const org = await query(
    `SELECT id FROM tenancy.orgs WHERE id = $1::uuid LIMIT 1`,
    [orgId],
  ).catch(() => ({ rows: [] }));
  if (org.rows.length === 0) {
    throw httpError('owner_org_id is not a known tenancy org', 400);
  }
}

// OPT-101: assert the calling board member belongs to the chosen owner_org_id.
// assertKnownOrg only checks the org EXISTS; this tightens it so a member cannot
// attribute captures to an org they aren't in (a member shouldn't mis-attribute).
// Board-admins bypass (role:'admin' may register on behalf of any org). The caller's
// board_members.id is resolved from github_username (NOT trusted from the body), then
// checked against an ACTIVE tenancy.memberships row. Fail-closed: no resolvable
// member id, or no active membership -> 403.
async function assertCallerInOrg(query, req, orgId) {
  // Board-admin override: a verified board admin may pick any known org.
  if (req?.auth?.role === 'admin') return;
  const username = req?.auth?.github_username;
  if (!username) {
    // requireBoardHuman already ran, so this is defense-in-depth.
    throw httpError('A board member identity is required to assign an org', 403);
  }
  const member = await query(
    `SELECT id, role FROM agent_graph.board_members
      WHERE github_username = $1 AND is_active = true LIMIT 1`,
    [username],
  ).catch(() => ({ rows: [] }));
  const row = member.rows[0];
  if (!row) throw httpError('No resolvable board member for this caller', 403);
  // A board-tier member whose board_members.role is 'admin' may also pick any org
  // (the JWT role may be the generic 'board'; the DB row is the source of truth).
  if (row.role === 'admin') return;
  const m = await query(
    `SELECT 1 FROM tenancy.memberships
      WHERE user_id = $1::uuid AND org_id = $2::uuid AND is_active = true LIMIT 1`,
    [row.id, orgId],
  ).catch(() => ({ rows: [] }));
  if (m.rows.length === 0) {
    throw httpError('You can only assign a capture source to an org you belong to', 403);
  }
}

export function registerCaptureSourceRoutes(routes, _q, { withViewer, resolveImpersonationEmail } = {}) {
  // Resolve the tenancy principal for reads. null (withViewer absent or a resolution
  // throw) -> visibleClause 'FALSE' -> zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // POST /api/capture-sources — create a capture source. Board-human only.
  // Body: { source_type, external_id, label?, owner_org_id, default_kind?,
  //         allowlist?, access? }  (access ∈ {'impersonated','sa_direct'})
  // owner_email is NEVER from the body — it is stamped server-side (OPT-101).
  routes.set('POST /api/capture-sources', async (req, body) => {
    requireBoardHuman(req);
    const payload = body && typeof body === 'object' ? body : {};

    // (OPT-101) Reject any caller-supplied impersonation target. owner_email is the
    // SENSITIVE DWD subject; it is derived server-side, never chosen by the client.
    for (const k of FORBIDDEN_BODY_KEYS) {
      if (payload[k] !== undefined) {
        throw httpError(`${k} is not accepted; the impersonation identity is derived server-side from your board member email`, 400);
      }
    }

    const sourceType = payload.source_type;
    if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
      throw httpError(`source_type must be one of: ${[...ALLOWED_SOURCE_TYPES].join(', ')}`, 400);
    }
    const externalId = typeof payload.external_id === 'string' ? payload.external_id.trim() : '';
    if (!externalId) throw httpError('external_id is required', 400);

    // owner_org_id is REQUIRED on create (the whole point — per-org attribution).
    await assertKnownOrg(defaultQuery, payload.owner_org_id);
    const ownerOrgId = payload.owner_org_id;
    // (OPT-101) The caller must BELONG to the org they attribute captures to
    // (board-admin may pick any org). Tightens the existence-only assertKnownOrg.
    await assertCallerInOrg(defaultQuery, req, ownerOrgId);

    const defaultKind = payload.default_kind === undefined ? 'doc' : payload.default_kind;
    if (!ALLOWED_DEFAULT_KINDS.has(defaultKind)) {
      throw httpError(`default_kind must be one of: ${[...ALLOWED_DEFAULT_KINDS].join(', ')}`, 400);
    }

    const allowlist = validateAllowlist(payload.allowlist);
    const label = typeof payload.label === 'string' ? payload.label : null;
    const createdBy = req?.auth?.github_username || null;

    // (OPT-101) Derive owner_email (the watcher's impersonation subject) server-side.
    //   access:'sa_direct'    -> owner_email = null (Shared Drive the SA is a member
    //                            of; no impersonation at poll time).
    //   access:'impersonated' -> owner_email = resolveImpersonationEmail(req) (the
    //                            authenticated picker's OWN workspace email).
    // Default 'impersonated' (the scoped path). If the resolver fails for an
    // impersonated source (e.g. non-domain email -> 400 impersonation_unavailable),
    // the create fails closed — the user may instead register an sa_direct source.
    const access = payload.access === undefined ? 'impersonated' : payload.access;
    if (!ALLOWED_ACCESS.has(access)) {
      throw httpError(`access must be one of: ${[...ALLOWED_ACCESS].join(', ')}`, 400);
    }
    let ownerEmail = null;
    if (access === 'impersonated') {
      if (typeof resolveImpersonationEmail !== 'function') {
        throw httpError('impersonation is not available on this server', 503);
      }
      ownerEmail = await resolveImpersonationEmail(req); // throws 403 / 400 impersonation_unavailable
    }

    // GLOBAL UNIQUE (source_type, external_id): a duplicate folder -> 409.
    let r;
    try {
      r = await defaultQuery(
        `INSERT INTO content.capture_sources
           (source_type, external_id, label, owner_org_id, owner_email, default_kind, allowlist, created_by)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8)
         RETURNING id, source_type, external_id, label, owner_org_id, owner_id, owner_email,
                   default_kind, allowlist, enabled, created_at, updated_at`,
        [sourceType, externalId, label, ownerOrgId, ownerEmail, defaultKind, JSON.stringify(allowlist), createdBy],
      );
    } catch (err) {
      // Unique-violation (Postgres 23505 / PGlite duplicate key) -> 409.
      const msg = String(err?.message || err);
      if (err?.code === '23505' || /duplicate key|unique/i.test(msg)) {
        throw httpError('a capture source with this (source_type, external_id) already exists', 409);
      }
      throw err;
    }

    return { ok: true, source: r.rows[0] };
  });

  // GET /api/capture-sources — list, tenant-scoped via visibleClause fail-closed.
  routes.set('GET /api/capture-sources', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const v = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    const r = await defaultQuery(
      `SELECT id, source_type, external_id, label, owner_org_id, owner_id, owner_email,
              default_kind, allowlist, enabled, cursor, last_poll_at, last_error,
              created_at, updated_at
         FROM content.capture_sources
        WHERE ${v.sql}
        ORDER BY created_at DESC`,
      v.params,
    );
    return { ok: true, sources: r.rows };
  });

  // PATCH /api/capture-sources/:id — edit a capture source. Board-human only.
  // Editable keys: {enabled, owner_org_id, default_kind, allowlist, label}. Any other
  // key (incl. source_type / external_id) -> 400. Org-scoped UPDATE (visibleClause in
  // the WHERE) -> 404 if the row is not visible to the caller.
  routes.set('PATCH /api/capture-sources/:id', async (req, body) => {
    const principal = await resolvePrincipalFor(req);
    requireBoardHuman(req);
    const payload = body && typeof body === 'object' ? body : {};

    for (const k of Object.keys(payload)) {
      if (!ALLOWED_PATCH_KEYS.has(k)) {
        throw httpError(`Field not editable: ${k}`, 400);
      }
    }

    const url = new URL(req.url, 'http://localhost');
    const id = url.pathname.split('/').filter(Boolean).pop();
    if (!id) throw httpError('capture source id required', 400);

    const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
    if (!has('enabled') && !has('owner_org_id') && !has('default_kind') && !has('allowlist') && !has('label')) {
      throw httpError('Provide at least one editable field', 400);
    }

    // Validate each provided field.
    let enabled; // undefined = leave unchanged
    if (has('enabled')) {
      if (typeof payload.enabled !== 'boolean') throw httpError('enabled must be a boolean', 400);
      enabled = payload.enabled;
    }

    let ownerOrgId; // undefined = leave unchanged; string = set (null not allowed)
    if (has('owner_org_id')) {
      await assertKnownOrg(defaultQuery, payload.owner_org_id);
      // STAQPRO-623: re-attribution must be membership-gated, exactly like create
      // (assertCallerInOrg on POST). Without this a member could PATCH a visible
      // source's owner_org_id to an org they don't belong to (one-way mis-attribution
      // out of their own scope). Board-admins bypass inside the helper.
      await assertCallerInOrg(defaultQuery, req, payload.owner_org_id);
      ownerOrgId = payload.owner_org_id;
    }

    let defaultKind;
    if (has('default_kind')) {
      if (!ALLOWED_DEFAULT_KINDS.has(payload.default_kind)) {
        throw httpError(`default_kind must be one of: ${[...ALLOWED_DEFAULT_KINDS].join(', ')}`, 400);
      }
      defaultKind = payload.default_kind;
    }

    let allowlist; // undefined = leave unchanged
    if (has('allowlist')) {
      allowlist = validateAllowlist(payload.allowlist);
    }

    let label;
    if (has('label')) {
      if (payload.label !== null && typeof payload.label !== 'string') {
        throw httpError('label must be a string or null', 400);
      }
      label = payload.label;
    }

    // enable-with-org guard: compute the effective post-update state against the
    // current row (org-scoped read so we never disclose another org's row). A source
    // that would end up enabled with no owner_org_id captures nothing -> reject.
    const cv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 2 });
    const existing = await defaultQuery(
      `SELECT enabled, owner_org_id FROM content.capture_sources
        WHERE id = $1 AND ${cv.sql}`,
      [id, ...cv.params],
    );
    if (existing.rows.length === 0) throw httpError('capture source not found', 404);
    const cur = existing.rows[0];
    const effEnabled = has('enabled') ? enabled : cur.enabled;
    const effOrg = has('owner_org_id') ? ownerOrgId : cur.owner_org_id;
    if (effEnabled === true && !effOrg) {
      throw httpError('Cannot enable a capture source without an owner_org_id mapping — captures would be skipped', 400);
    }

    // Org-scoped UPDATE. COALESCE keeps the existing value where a field is omitted.
    // visibleClause in the WHERE -> a row the caller cannot see matches zero -> 404.
    const params = [
      has('enabled') ? enabled : null,            // $1
      has('owner_org_id') ? ownerOrgId : null,    // $2
      has('default_kind') ? defaultKind : null,   // $3
      has('allowlist') ? JSON.stringify(allowlist) : null, // $4
      has('label'),                               // $5 (label set flag — label may be null)
      has('label') ? label : null,                // $6
      id,                                          // $7
    ];
    const uv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: params.length + 1 });
    const r = await defaultQuery(
      `UPDATE content.capture_sources SET
         enabled      = COALESCE($1, enabled),
         owner_org_id = COALESCE($2::uuid, owner_org_id),
         default_kind = COALESCE($3, default_kind),
         allowlist    = COALESCE($4::jsonb, allowlist),
         label        = CASE WHEN $5 THEN $6 ELSE label END,
         updated_at   = now()
        WHERE id = $7 AND ${uv.sql}
        RETURNING id, source_type, external_id, label, owner_org_id, owner_id, owner_email,
                  default_kind, allowlist, enabled, cursor, last_poll_at, last_error,
                  created_at, updated_at`,
      [...params, ...uv.params],
    );
    if (r.rows.length === 0) throw httpError('capture source not found', 404);
    return { ok: true, source: r.rows[0] };
  });
}
