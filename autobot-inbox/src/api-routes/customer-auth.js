/**
 * Customer (external, non-board) token administration — OPT-37.
 *
 * The control plane for the third token class (lib/runtime/agents/customer-jwt.js):
 * a board admin mints a customer principal bound to ONE org and issues it a JWT.
 * That token lets a customer's own agent system (Cursor, bespoke) reach the
 * org-shared surface (KB ingest/search, artifact registry, enrichment) scoped to
 * exactly that org — and nothing else (the customer ceiling in api.js enforces it).
 *
 * Security model (mirrors capture-sources.js / artifacts.js):
 *   - requireBoardHuman on every write — minting external credentials is a
 *     control-plane act; a viewer, a bare api_secret, or an agent is rejected.
 *   - assertKnownOrg — org_id MUST exist in tenancy.orgs (no arbitrary UUID).
 *   - assertCallerInOrg — a board member can only mint for an org they belong to
 *     (board-admins may mint for any org). The caller's identity is resolved from
 *     github_username, never trusted from the body.
 *   - The issued token NEVER carries adminBypass and is structurally barred from
 *     admin / ops-control / viewer-scoped tiers (see api.js customer ceiling).
 *
 * Routes are classified `admin` (board-only) in route-tiers.js — they sit OUT of
 * any broad prefix rule because they mint credentials.
 */

import { query as defaultQuery } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';
import { issueCustomerToken, revokeCustomerToken } from '../runtime/customer-jwt.js';

function httpError(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

// Minting external credentials requires a real board human (not a viewer, not a
// bare api_secret with no identity, not an agent). P1: deny by default.
function requireBoardHuman(req) {
  const auth = req?.auth || null;
  const isBoardHuman = auth?.role === 'board' && !!auth?.github_username;
  if (!isBoardHuman) {
    throw httpError('Customer-token administration requires a board member', 403);
  }
}

// org_id must exist in the tenancy boundary table — never accept an arbitrary UUID.
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

// Operator convenience: resolve { owner_org_id } | { org_slug } → a known org UUID.
// org_slug is looked up against tenancy.orgs.slug (active orgs only). Returns the
// canonical UUID. Throws 400 if neither is given or the slug is unknown.
async function resolveOrgId(query, payload) {
  if (payload.owner_org_id) {
    await assertKnownOrg(query, payload.owner_org_id);
    return payload.owner_org_id;
  }
  const slug = typeof payload.org_slug === 'string' ? payload.org_slug.trim() : '';
  if (!slug) throw httpError('owner_org_id or org_slug is required', 400);
  const r = await query(
    `SELECT id FROM tenancy.orgs WHERE slug = $1 AND is_active = true LIMIT 1`,
    [slug],
  ).catch(() => ({ rows: [] }));
  if (r.rows.length === 0) throw httpError(`org_slug '${slug}' is not a known active org`, 400);
  return r.rows[0].id;
}

// A board member may only mint a customer token for an org they belong to.
// Board-admins (DB role 'admin') may mint for any org. Identity resolved from
// github_username, never the body. Fail-closed.
async function assertCallerInOrg(query, req, orgId) {
  if (req?.auth?.role === 'admin') return;
  const username = req?.auth?.github_username;
  if (!username) throw httpError('A board member identity is required', 403);
  const member = await query(
    `SELECT id, role FROM agent_graph.board_members
      WHERE github_username = $1 AND is_active = true LIMIT 1`,
    [username],
  ).catch(() => ({ rows: [] }));
  const row = member.rows[0];
  if (!row) throw httpError('No resolvable board member for this caller', 403);
  if (row.role === 'admin') return;
  const m = await query(
    `SELECT 1 FROM tenancy.memberships
      WHERE user_id = $1::uuid AND org_id = $2::uuid AND is_active = true LIMIT 1`,
    [row.id, orgId],
  ).catch(() => ({ rows: [] }));
  if (m.rows.length === 0) {
    throw httpError('You can only mint a customer token for an org you belong to', 403);
  }
}

// Whitelisted scopes a customer token may carry. '*' is never customer-grantable.
const ALLOWED_CUSTOMER_SCOPES = [
  'kb:read', 'kb:write',
  'artifacts:read', 'artifacts:write',
];

export function registerCustomerAuthRoutes(routes, q, { withViewer } = {}) {
  const query = q || defaultQuery;

  // POST /api/auth/customer-token — mint a customer principal + issue its JWT.
  // Body: { owner_org_id, label, scope?: string[] }
  routes.set('POST /api/auth/customer-token', async (req, body) => {
    requireBoardHuman(req);
    const payload = body || {};
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    if (!label) throw httpError('label is required', 400);
    const ownerOrgId = await resolveOrgId(query, payload);
    await assertCallerInOrg(query, req, ownerOrgId);

    const scope = Array.isArray(payload.scope) && payload.scope.length
      ? payload.scope.filter((s) => ALLOWED_CUSTOMER_SCOPES.includes(s))
      : ALLOWED_CUSTOMER_SCOPES;
    if (scope.length === 0) throw httpError('No valid scopes requested', 400);

    // org_id IS this table's tenancy binding, set explicitly here from a
    // validated, caller-authorized org (resolveOrgId + assertCallerInOrg). A
    // customer principal is definitionally bound to exactly one org, so there is
    // no separate owner_org_id to stamp. (customer_principals is not in the M-D
    // audit's TENANT_TABLES list, so this INSERT is not ratchet-counted.)
    const created = await query(
      `INSERT INTO agent_graph.customer_principals (org_id, label, scope, created_by)
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING id, org_id, label, scope, created_at`,
      [ownerOrgId, label, scope, req.auth.github_username],
    );
    const principal = created.rows[0];
    const { token, expiresAt, jti } = issueCustomerToken(principal.id, principal.org_id, principal.scope);

    return {
      token,
      expiresAt,
      jti,
      principal: {
        id: principal.id,
        org_id: principal.org_id,
        label: principal.label,
        scope: principal.scope,
        created_at: principal.created_at,
      },
    };
  });

  // POST /api/auth/customer-token/issue — re-issue a token for an EXISTING active
  // principal (rotation), without creating a new principal. Body: { principal_id }
  routes.set('POST /api/auth/customer-token/issue', async (req, body) => {
    requireBoardHuman(req);
    const principalId = body?.principal_id;
    if (typeof principalId !== 'string' || !principalId.trim()) {
      throw httpError('principal_id is required', 400);
    }
    const r = await query(
      `SELECT id, org_id, scope, is_active FROM agent_graph.customer_principals WHERE id = $1::uuid LIMIT 1`,
      [principalId],
    ).catch(() => ({ rows: [] }));
    const p = r.rows[0];
    if (!p) throw httpError('Customer principal not found', 404);
    if (p.is_active !== true) throw httpError('Customer principal is inactive', 409);
    await assertCallerInOrg(query, req, p.org_id);
    const { token, expiresAt, jti } = issueCustomerToken(p.id, p.org_id, p.scope);
    return { token, expiresAt, jti, principal: { id: p.id, org_id: p.org_id, scope: p.scope } };
  });

  // POST /api/auth/customer-token/revoke — kill a token (jti) or a whole principal.
  // Body: { jti } revokes ONE token; { principal_id } deactivates the principal
  // (kills ALL its tokens — the verifier checks is_active every request).
  routes.set('POST /api/auth/customer-token/revoke', async (req, body) => {
    requireBoardHuman(req);
    const { jti, principal_id: principalId } = body || {};
    if (!jti && !principalId) throw httpError('jti or principal_id is required', 400);

    if (principalId) {
      const r = await query(
        `SELECT id, org_id FROM agent_graph.customer_principals WHERE id = $1::uuid LIMIT 1`,
        [principalId],
      ).catch(() => ({ rows: [] }));
      const p = r.rows[0];
      if (!p) throw httpError('Customer principal not found', 404);
      await assertCallerInOrg(query, req, p.org_id);
      await query(
        `UPDATE agent_graph.customer_principals
            SET is_active = false, revoked_at = now()
          WHERE id = $1::uuid`,
        [principalId],
      );
      return { revoked: true, principal_id: principalId, scope: 'all-tokens' };
    }

    await revokeCustomerToken(jti, null, body?.reason || 'manual revocation');
    return { revoked: true, jti, scope: 'single-token' };
  });

  // GET /api/customer-principals — list customer principals, org-scoped to the
  // caller's readable orgs via visibleClause (fail-closed). Never returns tokens.
  routes.set('GET /api/customer-principals', async (req) => {
    requireBoardHuman(req);
    const { principal } = withViewer ? await withViewer(req) : { principal: req.principal };
    const v = visibleClause(principal, { ownerOrgCol: 'org_id', startIndex: 1 });
    const rows = await query(
      `SELECT id, org_id, label, scope, created_by, is_active, created_at, revoked_at
         FROM agent_graph.customer_principals
        WHERE ${v.sql}
        ORDER BY created_at DESC
        LIMIT 200`,
      v.params,
    );
    return { principals: rows.rows };
  });
}
