/**
 * /api/linear — operator-facing Linear plumbing endpoints.
 *
 * PRD: docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md §4.1
 *   - POST /api/linear/reconcile           — FR-16 (manual reconcile trigger)
 *   - GET  /api/linear/team-cache          — FR-24 (read cached metadata)
 *   - POST /api/linear/team-cache/refresh  — FR-24 (force cache refresh)
 *   - POST /api/linear/workflow-states     — FR-26 (create Ready-for-Optimus)
 *
 * The Linear client and team id are injected at registration time so unit
 * tests can mock them — see `registerLinearRoutes({ getContext })` at the
 * bottom of this file. Pure handler functions are factory-built; tests can
 * exercise them by constructing handlers directly via the make* exports.
 */

import { query as defaultQuery } from '../db.js';
import { loadCache, refreshCache } from '../../../lib/linear/team-cache.js';
import { runReconciliationPass } from '../../../lib/runtime/linear-reconciliation.js';
import { getTeams as defaultGetTeams, listTeamIssues as defaultListTeamIssues } from '../linear/client.js';
import { importLinearIssue } from '../../../lib/linear/import-issue.js';

// ---- Helpers --------------------------------------------------------------

function requireBoard(req) {
  if (!req?.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function notFound(msg = 'not found') {
  const e = new Error(msg);
  e.statusCode = 404;
  return e;
}

function badGateway(msg) {
  const e = new Error(msg);
  e.statusCode = 502;
  return e;
}

function preconditionFailed(msg) {
  const e = new Error(msg);
  e.statusCode = 412;
  return e;
}

/**
 * Resolve injected context. The factory contract: getContext() returns
 *   { query, linearClient, teamId }
 * where linearClient is the v2-adapter object exposing fetchIssues,
 * createWorkflowState, createIssue, gql, and `client` (an alias for gql,
 * matching the team-cache signature). For back-compat, a plain GraphQL
 * function is still accepted — `gqlClientOf(linearClient)` resolves
 * either shape to the (query, vars) => data callable that refreshCache
 * expects.
 *
 * teamId is the Linear team UUID — null disables team-scoped endpoints.
 */
function resolveContext(getContext, { query: localQuery } = {}) {
  const ctx = typeof getContext === 'function' ? (getContext() || {}) : {};
  return {
    query:        ctx.query || localQuery || defaultQuery,
    linearClient: ctx.linearClient || null,
    teamId:       ctx.teamId || null,
  };
}

/**
 * Extract a (query, vars) => data callable from either a plain function
 * client or the v2-adapter object surface. Returns null when the input
 * cannot be coerced.
 */
function gqlClientOf(linearClient) {
  if (typeof linearClient === 'function') return linearClient;
  if (linearClient && typeof linearClient.gql === 'function') {
    return linearClient.gql.bind(linearClient);
  }
  if (linearClient && typeof linearClient.client === 'function') {
    return linearClient.client.bind(linearClient);
  }
  return null;
}

// ===========================================================================
// POST /api/linear/reconcile
// ===========================================================================

export function makeReconcileLinear({ getContext } = {}) {
  return async function reconcileLinear(req, _body) {
    requireBoard(req);
    const { query, linearClient, teamId } = resolveContext(getContext);

    if (!linearClient || typeof linearClient.fetchIssues !== 'function') {
      throw preconditionFailed('Linear client not configured');
    }

    const result = await runReconciliationPass({ query, linearClient, teamId });
    return {
      ok: true,
      processed_count: result?.processed_count ?? 0,
      divergent_count: result?.divergent_count ?? 0,
    };
  };
}

// ===========================================================================
// GET /api/linear/team-cache
// ===========================================================================

export function makeGetTeamCache({ getContext } = {}) {
  return async function getTeamCache(req) {
    requireBoard(req);
    const { query, teamId } = resolveContext(getContext);
    if (!teamId) throw preconditionFailed('LINEAR_TEAM_ID not configured');

    const cache = await loadCache({ teamId, query });
    if (!cache) throw notFound('team cache not yet populated');

    return {
      workflow_states: cache.workflow_states,
      projects:        cache.projects,
      members:         cache.members,
      labels:          cache.labels,
      refreshed_at:    cache.refreshed_at,
    };
  };
}

// ===========================================================================
// POST /api/linear/team-cache/refresh
// ===========================================================================

export function makeRefreshTeamCache({ getContext } = {}) {
  return async function refreshTeamCache(req, _body) {
    requireBoard(req);
    const { query, linearClient, teamId } = resolveContext(getContext);
    if (!teamId) throw preconditionFailed('LINEAR_TEAM_ID not configured');

    const gqlClient = gqlClientOf(linearClient);
    if (!gqlClient) {
      throw preconditionFailed('Linear GraphQL client not configured');
    }

    let cache;
    try {
      cache = await refreshCache({ teamId, client: gqlClient, query });
    } catch (err) {
      throw badGateway(`team-cache refresh failed: ${err.message}`);
    }
    return {
      workflow_states: cache.workflow_states,
      projects:        cache.projects,
      members:         cache.members,
      labels:          cache.labels,
      refreshed_at:    cache.refreshed_at,
    };
  };
}

// ===========================================================================
// POST /api/linear/workflow-states
// ===========================================================================
//
// Body: { name: string, color?: string }
// Creates a workflow state in Linear via linearClient.createWorkflowState
// (the operator-facing one-click "Create Ready for Optimus" button). After
// creation we refresh the team cache so callers immediately see the new
// state in the mapping editor (FR-26).

export function makeCreateWorkflowState({ getContext } = {}) {
  return async function createWorkflowState(req, body) {
    requireBoard(req);
    const { query, linearClient, teamId } = resolveContext(getContext);

    if (!linearClient || typeof linearClient.createWorkflowState !== 'function') {
      throw preconditionFailed('Linear createWorkflowState not configured');
    }
    if (!teamId) throw preconditionFailed('LINEAR_TEAM_ID not configured');

    const name = body?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw badRequest('name required (non-empty string)');
    }
    const color = body?.color;
    if (color !== undefined && color !== null && typeof color !== 'string') {
      throw badRequest('color must be a string');
    }

    let state;
    try {
      state = await linearClient.createWorkflowState({
        name: name.trim(),
        color: color || undefined,
        teamId,
      });
    } catch (err) {
      throw badGateway(`workflow state create failed: ${err.message}`);
    }

    // Refresh the cache so the new state shows up immediately. Refresh
    // failures are swallowed — the state was created successfully and the
    // hourly cache cron will pick it up if this one-off refresh blew up.
    try {
      const gqlClient = gqlClientOf(linearClient);
      if (gqlClient) {
        await refreshCache({ teamId, client: gqlClient, query });
      }
    } catch {
      // best-effort
    }

    return { ok: true, state };
  };
}

// ===========================================================================
// GET /api/linear/teams  (STAQPRO-619-A — board-managed team selection)
// ===========================================================================
//
// Lists every Linear team the API key can see, LEFT-JOINed onto the local
// inbox.linear_sync_teams config so the board sees enabled/owner_org_id for
// each. Board-only (requireBoard). getTeams is injectable for tests.

export function makeListLinearTeams({ getTeams = defaultGetTeams } = {}) {
  return async function listLinearTeams(req) {
    requireBoard(req);
    const { query } = resolveContext(undefined, {});

    let teams = [];
    try {
      teams = await getTeams();
    } catch (err) {
      throw badGateway(`Linear getTeams failed: ${err.message}`);
    }

    const cfg = await query(
      `SELECT team_id, team_name, enabled, owner_org_id, import_filter
         FROM inbox.linear_sync_teams`,
    );
    const byId = new Map(cfg.rows.map((r) => [r.team_id, r]));

    const merged = (teams || []).map((t) => {
      const c = byId.get(t.id);
      return {
        team_id:       t.id,
        team_key:      t.key,
        team_name:     t.name,
        enabled:       c?.enabled ?? false,
        owner_org_id:  c?.owner_org_id ?? null,
        import_filter: c?.import_filter ?? 'all_open',
      };
    });

    return { teams: merged };
  };
}

// ===========================================================================
// PATCH /api/linear/teams/:id  (STAQPRO-619-A — enable/disable + map org)
// ===========================================================================
//
// Body: { enabled?: boolean, owner_org_id?: string|null }. ONLY those two
// fields are accepted; any other key → 400 (the body never sets team_id from
// the request beyond the URL, and never sets tenancy from untrusted shapes).
// Upserts the inbox.linear_sync_teams row. Board-only.

const ALLOWED_TEAM_PATCH_KEYS = new Set(['enabled', 'owner_org_id']);

export function makeUpdateLinearTeam() {
  return async function updateLinearTeam(req, body) {
    requireBoard(req);
    const { query } = resolveContext(undefined, {});

    const m = new URL(req.url, 'http://localhost').pathname
      .match(/^\/api\/linear\/teams\/([^/]+)$/);
    const teamId = m ? decodeURIComponent(m[1]) : null;
    if (!teamId) throw badRequest('Invalid team id');

    const payload = body && typeof body === 'object' ? body : {};
    for (const k of Object.keys(payload)) {
      if (!ALLOWED_TEAM_PATCH_KEYS.has(k)) {
        throw badRequest(`Field not editable: ${k}`);
      }
    }

    const hasEnabled = Object.prototype.hasOwnProperty.call(payload, 'enabled');
    const hasOrg = Object.prototype.hasOwnProperty.call(payload, 'owner_org_id');
    if (!hasEnabled && !hasOrg) {
      throw badRequest('Provide enabled and/or owner_org_id');
    }

    let enabled = null;
    if (hasEnabled) {
      if (typeof payload.enabled !== 'boolean') {
        throw badRequest('enabled must be a boolean');
      }
      enabled = payload.enabled;
    }

    let ownerOrgId; // undefined = leave unchanged; null/string = set
    if (hasOrg) {
      const v = payload.owner_org_id;
      if (v !== null && typeof v !== 'string') {
        throw badRequest('owner_org_id must be a UUID string or null');
      }
      if (typeof v === 'string') {
        // Validate the org exists in the tenancy boundary table. Never accept an
        // arbitrary UUID — an unknown org would silently un-tenant imports.
        const org = await query(
          `SELECT id FROM tenancy.orgs WHERE id = $1::uuid LIMIT 1`,
          [v],
        ).catch(() => ({ rows: [] }));
        if (org.rows.length === 0) {
          throw badRequest('owner_org_id is not a known tenancy org');
        }
      }
      ownerOrgId = v;
    }

    // Guard (Linus): a team enabled with no owner_org_id imports nothing
    // (importLinearIssue fails closed on a null org). Reject that misleading state
    // up front instead of silently creating an enabled-but-inert row. Compute the
    // effective post-upsert values against any existing row.
    const existing = await query(
      `SELECT enabled, owner_org_id FROM inbox.linear_sync_teams WHERE team_id = $1`,
      [teamId],
    ).catch(() => ({ rows: [] }));
    const cur = existing.rows[0] || null;
    const effEnabled = hasEnabled ? enabled : (cur?.enabled ?? false);
    const effOrg = hasOrg ? ownerOrgId : (cur?.owner_org_id ?? null);
    if (effEnabled === true && !effOrg) {
      throw badRequest('Cannot enable a team without an owner_org_id mapping — imports would be skipped');
    }

    // Upsert. COALESCE keeps the existing value when a field is omitted.
    const r = await query(
      `INSERT INTO inbox.linear_sync_teams (team_id, enabled, owner_org_id)
       VALUES ($1, COALESCE($2, false), $3::uuid)
       ON CONFLICT (team_id) DO UPDATE SET
         enabled      = COALESCE($2, inbox.linear_sync_teams.enabled),
         owner_org_id = CASE WHEN $4 THEN $3::uuid ELSE inbox.linear_sync_teams.owner_org_id END,
         updated_at   = now()
       RETURNING team_id, team_name, enabled, owner_org_id, import_filter`,
      [teamId, enabled, ownerOrgId ?? null, hasOrg],
    );

    return { ok: true, team: r.rows[0] };
  };
}

// ===========================================================================
// POST /api/linear/backfill  (STAQPRO-619-A — import all open issues)
// ===========================================================================
//
// Imports every open (non-archived, non-terminal) issue for board-enabled
// teams onto the /issues kanban. Paginated + batched (no 602-style storm):
// pulls one page at a time, imports each row idempotently via the partial
// unique index, and stops at a per-request safety cap. owner_org_id is stamped
// from each team's map — never the payload. Board-only.
//
// Body (optional): { team_id?: string, page_size?: number, max_pages?: number }
//   - team_id: restrict to one enabled team (default: all enabled teams)

const BACKFILL_DEFAULT_PAGE_SIZE = 50;
const BACKFILL_MAX_PAGE_SIZE = 100;
const BACKFILL_DEFAULT_MAX_PAGES = 40; // 40 * 50 = 2000 issues/team ceiling

export function makeBackfillLinear({
  listTeamIssues = defaultListTeamIssues,
  importIssue = importLinearIssue,
} = {}) {
  return async function backfillLinear(req, body) {
    requireBoard(req);
    const { query } = resolveContext(undefined, {});

    const payload = body && typeof body === 'object' ? body : {};
    const onlyTeamId = typeof payload.team_id === 'string' ? payload.team_id : null;
    const pageSize = Math.min(
      Math.max(Number(payload.page_size) || BACKFILL_DEFAULT_PAGE_SIZE, 1),
      BACKFILL_MAX_PAGE_SIZE,
    );
    const maxPages = Math.min(
      Math.max(Number(payload.max_pages) || BACKFILL_DEFAULT_MAX_PAGES, 1),
      BACKFILL_DEFAULT_MAX_PAGES,
    );

    // Resolve enabled teams (optionally filtered to one).
    const teamRows = await query(
      onlyTeamId
        ? `SELECT team_id, owner_org_id, import_filter FROM inbox.linear_sync_teams
            WHERE enabled = true AND team_id = $1`
        : `SELECT team_id, owner_org_id, import_filter FROM inbox.linear_sync_teams
            WHERE enabled = true`,
      onlyTeamId ? [onlyTeamId] : [],
    );
    if (teamRows.rows.length === 0) {
      return { ok: true, teams: [], imported: 0, updated: 0, scanned: 0, note: 'no enabled teams' };
    }

    let totalScanned = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    const perTeam = [];

    for (const team of teamRows.rows) {
      let scanned = 0;
      let inserted = 0;
      let updated = 0;
      let after = null;
      let pages = 0;

      try {
        // eslint-disable-next-line no-constant-condition
        while (pages < maxPages) {
          const { nodes, pageInfo } = await listTeamIssues(team.team_id, {
            includeArchived: false,
            after,
            first: pageSize,
          });
          pages += 1;
          for (const issue of nodes) {
            scanned += 1;
            const res = await importIssue(issue, { query, teamOrg: team });
            if (res?.imported) {
              if (res.action === 'insert') inserted += 1;
              else if (res.action === 'update') updated += 1;
            }
          }
          if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
          after = pageInfo.endCursor;
        }
      } catch (err) {
        console.error(`[linear-backfill] team ${team.team_id} failed: ${err.message}`);
        perTeam.push({ team_id: team.team_id, scanned, inserted, updated, error: err.message });
        totalScanned += scanned; totalInserted += inserted; totalUpdated += updated;
        continue;
      }

      perTeam.push({ team_id: team.team_id, scanned, inserted, updated, pages });
      totalScanned += scanned; totalInserted += inserted; totalUpdated += updated;
    }

    return {
      ok: true,
      teams: perTeam,
      imported: totalInserted,
      updated: totalUpdated,
      scanned: totalScanned,
    };
  };
}

// ---- Route registration ---------------------------------------------------

export function registerLinearRoutes(routes, { getContext } = {}) {
  routes.set('POST /api/linear/reconcile',            makeReconcileLinear({ getContext }));
  routes.set('GET /api/linear/team-cache',            makeGetTeamCache({ getContext }));
  routes.set('POST /api/linear/team-cache/refresh',   makeRefreshTeamCache({ getContext }));
  routes.set('POST /api/linear/workflow-states',      makeCreateWorkflowState({ getContext }));
  // STAQPRO-619-A: board-managed team selection + Linear-native import backfill.
  routes.set('GET /api/linear/teams',                 makeListLinearTeams({}));
  routes.set('PATCH /api/linear/teams/:id',           makeUpdateLinearTeam());
  routes.set('POST /api/linear/backfill',             makeBackfillLinear({}));
}
