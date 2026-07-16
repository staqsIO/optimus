// api-routes/drive-picker.js — OPT-101 (Feature 006): Drive folder/shared-drive
// picker backend. Two board-human-gated GET endpoints that let a board member
// browse THEIR OWN Google Drive structure (Shared Drives + My-Drive folders) so
// they can self-serve register content.capture_sources.
//
// THE IMPERSONATION SECURITY MODEL (the crux — see spec/features/006-*.md §1):
//   Domain-wide delegation lets the service account impersonate ANY workspace
//   user. The impersonated email is therefore DERIVED SERVER-SIDE from the
//   authenticated identity (resolveImpersonationEmail, injected) — it is NEVER
//   read from a request param, header, or body. A bare api_secret board caller
//   (no github_username) is rejected 403 (no Drive to browse, no SA-direct
//   fallback for picking). A non-domain board email (e.g. a personal Gmail) is
//   rejected 400 impersonation_unavailable; we never silently widen scope by
//   falling back to SA-direct.
//
// Google errors map to 4xx/503 — NEVER a raw 500 with a Google stack
// (mapGoogleError). DWD not configured / no SA key -> 503 drive_unavailable.
// Google's own unauthorized_client (a domain in the allow-set the SA was never
// authorized for) -> 400 impersonation_unavailable (the runtime backstop to the
// deterministic domain check in resolveImpersonationEmail).

import {
  getDriveClient as defaultGetDriveClient,
  hasServiceAccount as defaultHasServiceAccount,
} from '../drive/service-auth.js';

function httpError(message, statusCode, errorCode) {
  const e = Object.assign(new Error(message), { statusCode });
  if (errorCode) e.errorCode = errorCode;
  return e;
}

// Board-human gate (mirrors capture-sources.js requireBoardHuman). Browsing
// Drive structure is a privileged, human-only action — never an agent or a bare
// api_secret. P1: deny by default.
function requireBoardHuman(req) {
  const auth = req?.auth || null;
  const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
  if (!isBoardHuman) {
    throw httpError('Drive browsing requires a board member', 403);
  }
}

// Central Google-error mapper: a googleapis throw must never escape as a raw 500
// with a Google stack. Map the known shapes to clean 4xx/503; everything else to
// a generic 502 (upstream Drive failure), never a 500.
function mapGoogleError(err) {
  // Already a deliberate http error (e.g. from resolveImpersonationEmail) — pass through.
  if (err && typeof err.statusCode === 'number') return err;
  const msg = String(err?.message || err || '');
  const status = err?.code || err?.response?.status;
  // DWD impersonation rejected for a non-delegated / unauthorized subject.
  if (/unauthorized_client|invalid_grant|delegation|not authorized/i.test(msg)) {
    return httpError('Impersonation is not available for this workspace identity', 400, 'impersonation_unavailable');
  }
  if (status === 401 || status === 403 || /insufficient.*scope|permission/i.test(msg)) {
    return httpError('Drive access denied for this identity', 403, 'drive_forbidden');
  }
  if (status === 404) return httpError('Drive resource not found', 404, 'drive_not_found');
  // Anything else (network, 5xx from Google) -> 502, never a raw 500.
  return httpError('Drive is temporarily unavailable', 502, 'drive_error');
}

function clampPageSize(raw, fallback, max) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * @param {Map} routes
 * @param {object} deps
 * @param {(req)=>Promise<string>} deps.resolveImpersonationEmail - server-side email derivation (injected from api.js)
 * @param {(userEmail:string|null)=>object} [deps.getDriveClient] - Drive client factory (injected for tests)
 * @param {()=>boolean} [deps.hasServiceAccount]
 */
export function registerDrivePickerRoutes(routes, {
  resolveImpersonationEmail,
  getDriveClient = defaultGetDriveClient,
  hasServiceAccount = defaultHasServiceAccount,
} = {}) {
  if (typeof resolveImpersonationEmail !== 'function') {
    throw new Error('registerDrivePickerRoutes requires resolveImpersonationEmail');
  }

  function assertServiceAccount() {
    if (!hasServiceAccount()) {
      throw httpError('Drive service account is not configured', 503, 'drive_unavailable');
    }
  }

  // GET /api/drive/shared-drives — Shared Drives the caller can register.
  // Two-source merge: drives the impersonated user is a member of (access:
  // 'impersonated') AND drives the SA itself is a member of (access:'sa_direct',
  // registrable with owner_email=null — no impersonation at poll time). De-dup by
  // id; an impersonated hit wins the tag (the user sees it as theirs).
  routes.set('GET /api/drive/shared-drives', async (req) => {
    requireBoardHuman(req);
    assertServiceAccount();
    const url = new URL(req.url, 'http://localhost');
    const pageToken = url.searchParams.get('pageToken') || undefined;
    const pageSize = clampPageSize(url.searchParams.get('pageSize'), 100, 100);

    // Server-derived impersonation identity (NEVER from the request). Throws
    // 403 (bare secret / no identity) or 400 impersonation_unavailable (non-domain).
    const email = await resolveImpersonationEmail(req);

    const listDrives = async (userEmail) => {
      const drive = getDriveClient(userEmail);
      const r = await drive.drives.list({
        pageSize,
        pageToken,
        fields: 'nextPageToken,drives(id,name)',
      });
      return r?.data || {};
    };

    let impersonated;
    let saDirect;
    try {
      // Impersonated view first (the user's own Shared Drives).
      impersonated = await listDrives(email);
      // SA-direct view (drives the SA is a member of). A failure here is
      // non-fatal — the SA may simply not be a member of any Shared Drive.
      try {
        saDirect = await listDrives(null);
      } catch {
        saDirect = { drives: [] };
      }
    } catch (err) {
      throw mapGoogleError(err);
    }

    const byId = new Map();
    for (const d of saDirect?.drives || []) {
      if (d?.id) byId.set(d.id, { id: d.id, name: d.name || null, access: 'sa_direct' });
    }
    // Impersonated wins the tag on collision (the user owns the relationship).
    for (const d of impersonated?.drives || []) {
      if (d?.id) byId.set(d.id, { id: d.id, name: d.name || null, access: 'impersonated' });
    }

    return {
      ok: true,
      drives: [...byId.values()],
      // nextPageToken only paginates the impersonated view (the user's primary
      // surface); the SA-direct merge is best-effort and unpaginated.
      nextPageToken: impersonated?.nextPageToken || null,
    };
  });

  // GET /api/drive/folders?parent=<id|'root'>&driveId=<optional> — child folders.
  // parent='root' -> the impersonated user's My-Drive root. Impersonates the
  // resolved email (Google's ACL does the scoping). Shared-Drive traversal is
  // supported via supportsAllDrives + includeItemsFromAllDrives + driveId/corpora.
  routes.set('GET /api/drive/folders', async (req) => {
    requireBoardHuman(req);
    assertServiceAccount();
    const url = new URL(req.url, 'http://localhost');
    const parent = (url.searchParams.get('parent') || 'root').trim() || 'root';
    const driveId = url.searchParams.get('driveId') || undefined;
    const pageToken = url.searchParams.get('pageToken') || undefined;
    const pageSize = clampPageSize(url.searchParams.get('pageSize'), 200, 1000);

    const email = await resolveImpersonationEmail(req);

    // Build a parameter-free q from a sanitized parent id. The parent is an
    // opaque Drive id ('root' or a file id); reject characters that could break
    // out of the quoted q clause (Drive ids are [A-Za-z0-9_-], plus the literal
    // 'root'). This is the Drive-query analogue of parameterized SQL.
    if (!/^[A-Za-z0-9_-]+$/.test(parent)) {
      throw httpError('parent must be a Drive folder id or "root"', 400);
    }
    if (driveId !== undefined && !/^[A-Za-z0-9_-]+$/.test(driveId)) {
      throw httpError('driveId must be a Drive id', 400);
    }
    const q = `mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`;

    let data;
    try {
      const drive = getDriveClient(email);
      const params = {
        q,
        pageSize,
        pageToken,
        fields: 'nextPageToken,files(id,name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: 'name',
      };
      // Scope to a single Shared Drive when driveId is supplied; else search the
      // user's own (My Drive) corpus.
      if (driveId) {
        params.corpora = 'drive';
        params.driveId = driveId;
      } else {
        params.corpora = 'user';
      }
      const r = await drive.files.list(params);
      data = r?.data || {};
    } catch (err) {
      throw mapGoogleError(err);
    }

    return {
      ok: true,
      parent,
      folders: (data.files || []).map((f) => ({ id: f.id, name: f.name || null })),
      nextPageToken: data.nextPageToken || null,
    };
  });
}
