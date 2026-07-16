import { createServer } from 'http';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { query } from './db.js';
import { withSystemScope } from '../../lib/db.js';
import { emitHalt, clearHalt, isHalted, onAnyEvent } from './runtime/event-bus.js';
import { getAuthUrl, clearAuthCache, getAuthForAccount } from './gmail/auth.js';
import { approveDraft as approveViaDispatcher, sendDraft as sendViaDispatcher } from './comms/sender.js';
import { encryptCredentials } from './runtime/credentials.js';
import { google } from 'googleapis';
import { publishEvent } from './runtime/infrastructure.js';
import { appendHumanTasksToLanes } from '../../lib/runtime/board-human-tasks.js';
import { resolvePrincipal, syntheticPrincipal, visibleClause } from '../../lib/tenancy/scope.js';
import {
  unionSourceEnabled,
  obligViewerFilter,
  oweQuery as obligOweQuery,
  waitingQuery as obligWaitingQuery,
  statsQuery as obligStatsQuery,
} from './api-routes/obligations-today.js';
import { classify as classifyRoute, identityGate } from './route-tiers.js';
import { registerHumanTaskRoutes } from './api-routes/human-tasks.js';
import { registerGateRoutes } from './api-routes/gates.js';
import { registerFinanceRoutes } from './api-routes/finance.js';
import { registerAuditRoutes } from './api-routes/audit.js';
import { registerConstitutionalRoutes } from './api-routes/constitutional.js';
import { registerPhaseRoutes } from './api-routes/phase.js';
import { registerRunnerRoutes } from './api-routes/runners.js';
import { registerDistributionRoutes } from './api-routes/distribution.js';
import { registerValueRoutes } from './api-routes/value.js';
import { registerGovernanceRoutes } from './api-routes/governance.js';
import { registerPublicArchiveRoutes } from './api-routes/public-archive.js';
import { registerResearchRoutes } from './api-routes/research.js';
import { registerRedesignRoutes } from './api-routes/redesign.js';
import { registerFrontDoorRoutes } from './api-routes/front-door-api.js';
import { registerIntentRoutes } from './api-routes/intents.js';
import { registerDecisionRoutes } from './api-routes/decisions.js';
import { registerBlueprintRoutes } from './api-routes/blueprint.js';
import { registerSpecGraphRoutes } from './api-routes/spec-graph.js';
import { registerCampaignRoutes } from './api-routes/campaigns.js';
import { registerProjectRoutes } from './api-routes/projects.js';
import { registerEngagementsRoutes } from './api-routes/engagements.js';
import { registerTriageRoutes } from './api-routes/triage.js';
import { registerActivityRoutes } from './api-routes/activity.js';
import { registerTraceRoutes } from './api-routes/traces.js';
import { registerPipelineRoutes } from './api-routes/pipeline.js';
import { registerTrustRoutes } from './api-routes/trust.js';
import { registerCronRoutes } from './api-routes/cron.js';
import { registerAgentRoutes } from './api-routes/agents.js';
import { registerRunRoutes } from './api-routes/runs.js';
import { registerDocumentRoutes } from './api-routes/documents.js';
import { registerVoiceMemoRoutes } from './api-routes/voice-memo.js';
import { registerTranscriptRoutes } from './api-routes/transcripts.js';
import { registerMeetingsRoutes } from './api-routes/meetings.js';
import { registerMeetingRegistryRoutes } from './api-routes/meeting-registry.js'; // Feature 007: content.meetings identity layer
import { registerCalendarRoutes } from './api-routes/calendar.js';
import { registerVoicePrintsRoutes } from './api-routes/voice-prints.js';
import { registerOrganizationsRoutes } from './api-routes/organizations.js';
import { registerTenancyOrgsRoutes } from './api-routes/tenancy-orgs.js'; // owning-org picker: the caller's own tenancy.orgs (NOT the signal.organizations CRM)
import { registerDealsRoutes } from './api-routes/deals.js';
import { registerRelationshipsRoutes } from './api-routes/relationships.js';
import { registerProvenanceRoutes } from './api-routes/provenance.js';
import { registerSearchRoutes } from './api-routes/search.js';
import { registerIngestRoutes } from './api-routes/ingest.js'; // STAQPRO-611: MCP capture write surface
import { registerArtifactRoutes } from './api-routes/artifacts.js'; // OPT-92: artifact registry write/read surface
import { registerCaptureSourceRoutes } from './api-routes/capture-sources.js'; // OPT-96: board-managed per-org capture sources
import { registerDrivePickerRoutes } from './api-routes/drive-picker.js'; // OPT-101: Drive folder/shared-drive picker (board-human, server-derived impersonation)
import { registerSlackProjectMapRoutes } from './api-routes/slack-project-map.js'; // OPT-46: Slack channel↔project mapping
import { registerBoardAuthRoutes } from './api-routes/board-auth.js';
import { registerCustomerAuthRoutes } from './api-routes/customer-auth.js'; // OPT-37: external customer token admin
import { registerBoardRoutes } from './api-routes/board.js';
import { registerActionRoutes } from './api-routes/actions.js';
import { registerServiceRoutes } from './api-routes/services.js';
import { registerResearchSourceRoutes } from './api-routes/research-sources.js';
import { registerPreferencesRoutes } from './api-routes/preferences.js';
import { registerSharingRoutes } from './api-routes/sharing.js'; // ADR-017: knowledge share grants
import { registerNeedsAttentionRoutes } from './api-routes/needs-attention.js';
import { registerFlowRoutes } from './api-routes/flows.js';
import { registerContentRoutes } from './api-routes/content.js';
import { registerSigningRoutes } from './api-routes/signing.js';
import { registerContractRoutes } from './api-routes/contracts.js';
import { registerCounterpartyRoutes } from './api-routes/counterparties.js';
import { registerBrandProfileRoutes } from './api-routes/brand-profiles.js';
import { registerWeeklyRecapRoutes } from './api-routes/weekly-recap.js';
import { registerGuardrailRoutes } from './api-routes/guardrails.js';
import { registerBackfillRoutes } from './api-routes/backfill.js';
import { registerTodayRoutes } from './api-routes/today.js';
import { registerLinearRoutes } from './api-routes/linear.js';
import { registerFederationRoutes } from './api-routes/federation.js';
import { registerTelegramRoutes } from './api-routes/telegram.js'; // OPT-74: Telegram observability
import { registerSignalsRoutes } from './api-routes/signals.js'; // OPT-139
import { collectPhase1Metrics } from './runtime/phase1-metrics.js';
import { bootstrapSentEmails } from './gmail/sent-analyzer.js';
import { syncGoogleContacts } from './gmail/contacts-sync.js';
import { buildGlobalProfile, buildRecipientProfiles, rebuildAllProfiles } from './voice/profile-builder.js';
import { generateEmbeddings, hasEmbeddingProvider } from './voice/embeddings.js';
import { recordEditDelta, getEditRate } from './voice/edit-tracker.js';

const webhookSources = JSON.parse(
  readFileSync(new URL('../config/webhook-sources.json', import.meta.url), 'utf-8')
);

// CORS: localhost defaults + optional ALLOWED_ORIGINS env var (comma-separated)
const ALLOWED_ORIGINS = new Set([
  'http://localhost', 'http://localhost:3100', 'http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1', 'http://127.0.0.1:3100', 'http://127.0.0.1:3000',
  'https://staqs.io', 'https://www.staqs.io', 'https://inbox.staqs.io', 'https://board.staqs.io', 'https://preview.staqs.io',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : []),
]);

// In-memory cache to avoid PGlite contention on dashboard page loads.
// PGlite is single-connection WASM — agent loop queries block API queries.
// Cache dashboard reads for a short TTL so pages load instantly.
// When PGlite is busy (agents processing emails), queries queue indefinitely.
// The timeout races PGlite against a deadline and serves stale data on timeout.
const _cache = new Map();
const CACHE_TTL_MS = 300_000; // 5 minutes — PGlite single-thread means frequent cache misses hang
const QUERY_TIMEOUT_MS = 5_000; // 5s — first-load timeout (before stale data exists)
const BG_REFRESH_TIMEOUT_MS = 15_000; // 15s — background refresh has more time (stale data shown while waiting)

function cachedQuery(key, queryFn, ttlMs = CACHE_TTL_MS) {
  const entry = _cache.get(key);
  const now = Date.now();

  // Fresh cache hit — serve immediately
  if (entry?.data && now - entry.ts < ttlMs) {
    return Promise.resolve(entry.data);
  }

  // Stale-while-revalidate: if we have stale data, serve it instantly
  // and kick off a background refresh. User never waits for PGlite.
  if (entry?.data) {
    if (!entry.pending) {
      _refreshInBackground(key, queryFn);
    }
    return Promise.resolve(entry.data);
  }

  // No cached data at all (first load) — must wait for PGlite
  if (entry?.pending) return entry.pending;
  return _refreshAndWait(key, queryFn);
}

/** Background refresh: fire-and-forget with timeout. Updates cache on success. */
function _refreshInBackground(key, queryFn) {
  const queryPromise = queryFn();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('query_timeout')), BG_REFRESH_TIMEOUT_MS)
  );
  const pending = Promise.race([queryPromise, timeoutPromise]).then(data => {
    _cache.set(key, { data, ts: Date.now(), pending: null });
  }).catch(() => {
    // Background refresh failed — stale data persists, no user impact
    const stale = _cache.get(key);
    if (stale) stale.pending = null;
  });
  const existing = _cache.get(key);
  _cache.set(key, { ...(existing || {}), pending });
}

/** First-load wait: block until PGlite responds or timeout. */
function _refreshAndWait(key, queryFn) {
  const queryPromise = queryFn();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('query_timeout')), QUERY_TIMEOUT_MS)
  );
  const pending = Promise.race([queryPromise, timeoutPromise]).then(data => {
    _cache.set(key, { data, ts: Date.now(), pending: null });
    return data;
  }).catch(() => {
    const stale = _cache.get(key);
    if (stale) stale.pending = null;
    return null;
  });
  _cache.set(key, { pending });
  return pending;
}

function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  // Only set Allow-Origin for known origins; omit for unknown (browser blocks)
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// Legacy Bearer token auth (timing-safe to prevent oracle attacks)
function requireLegacyAuth(req) {
  const secret = process.env.API_SECRET;
  if (!secret) return false; // P1: deny by default — require API_SECRET to be configured
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Unified auth resolver — supports board JWT, agent JWT, and legacy Bearer.
 * Attaches req.auth = { sub, role, source, scope, github_username } on success.
 * Returns true if authenticated, false otherwise.
 *
 * Three modes (no fallthrough between JWT and legacy to prevent timing oracle):
 *   1. JWT with iss: 'optimus-board' → board member
 *   2. JWT with iss: 'optimus-agent' → internal agent
 *   3. Legacy Bearer API_SECRET → backward compat
 *
 * TODO(STAQPRO-tenancy-RLS, WT2→WT3 followup): every request handler in
 * this file that issues a query against agent-keyed tables (agent_graph.*,
 * inbox.messages) on behalf of a board user MUST wrap its queries in
 * withBoardScope(req.auth, { principal }) from lib/db.js once 126-force-rls
 * + PR-B-2 (pool role flip to autobot_agent) land. Without that wrapping,
 * those queries will return 0 rows under FORCE because `app.role` defaults
 * to unset → policies of the form `current_agent_id() OR app.role='board'`
 * fail both branches. The helper is shipped; the route-level wrapping is
 * intentionally deferred so this PR stays focused on the identity/auth half
 * (WT2's scope). Routes to audit:
 *   /api/governance/*           /api/spec-graph
 *   /api/spec-proposals         /api/strategic-decisions
 *   /api/briefing               /api/workstation/llm
 *   /api/intents                /api/decisions
 *   /api/voice-prints/enroll    /api/redesign/preview, /api/blueprint/view
 *   /api/governance/command     /api/agents/config
 *
 * Updated call pattern (post tenancy-GUC plumbing): resolve the principal
 * via withViewer(req) as before, then pass it to withBoardScope as the
 * second-arg option — `await withBoardScope(req.auth, { principal })`.
 * That sets app.user + app.org_ids GUCs inside the scoped transaction,
 * which is what the tenancy.visible(row_owner_user, row_owner_org)
 * predicate (ADR-012 §5.2) reads. The board path already sets
 * app.role='board' and app.agent_id; `principal` adds the tenancy half
 * so policies USING (tenancy.visible(...)) can backstop the app-layer
 * visibleClause() that lib/tenancy/scope.js emits today. Existing routes
 * that call query() directly are unchanged — see test/tenancy-gucs.test.js
 * for the contract pinned by this PR.
 */
export async function resolveAuth(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return false;

  const token = auth.slice(7);

  // Detect JWT format (three dot-separated parts) vs opaque Bearer
  const isJwt = token.split('.').length === 3;

  if (isJwt) {
    // Try board JWT first (separate keypair, iss: 'optimus-board')
    try {
      const { verifyBoardToken } = await import('./runtime/board-jwt.js');
      const claims = await verifyBoardToken(token);
      req.auth = {
        sub: claims.sub,
        role: 'board',
        source: 'jwt',
        scope: claims.scope || ['*'],
        github_username: claims.github_username,
        jti: claims.jti,
      };
      return true;
    } catch {
      // Not a valid board token — try agent token
    }

    try {
      const { verifyAgentToken } = await import('./runtime/agent-jwt.js');
      const claims = verifyAgentToken(token);
      req.auth = {
        sub: claims.sub,
        role: claims.tier || 'agent',
        source: 'agent_jwt',
        scope: ['*'], // internal agents have full scope
        github_username: null,
      };
      return true;
    } catch {
      // Not a valid agent token — try customer token
    }

    // OPT-37: external customer token (iss 'optimus-customer'). NOT board, NOT an
    // internal agent → never gets adminBypass. Bound to ONE org via org_id; the
    // principal becomes syntheticPrincipal(org_id) in withViewer(), so reads
    // fail-close to that single org. The customer authorization ceiling in the
    // dispatch middleware further restricts these to org-shared (+ public) tiers.
    try {
      const { verifyCustomerToken } = await import('./runtime/customer-jwt.js');
      const claims = await verifyCustomerToken(token);
      req.auth = {
        sub: claims.sub,
        role: 'customer',
        source: 'customer_jwt',
        scope: claims.scope || [],
        github_username: null,
        org_id: claims.org_id,
        jti: claims.jti,
      };
      return true;
    } catch {
      // Not a valid customer token either
      return false;
    }
  }

  // Opaque Bearer — legacy API_SECRET
  if (requireLegacyAuth(req)) {
    req.auth = {
      sub: 'legacy',
      role: 'board',
      source: 'api_secret',
      scope: ['*'],
      // OPT-148 / ADR-019: an api_secret principal is ops-only and carries NO
      // board-human identity. NEVER adopt an identity from the client-supplied
      // x-board-user header — doing so let a secret holder pass board write-gates
      // and impersonate a member's Drive via DWD. Identity comes only from a
      // signature-verified board JWT (the isJwt branch above).
      github_username: null,
    };
    return true;
  }

  return false;
}

// Backward compat wrapper — existing code calls requireAuth(req)
function requireAuth(req) {
  // Sync check for legacy Bearer only (resolveAuth is async and used in the main handler)
  return requireLegacyAuth(req);
}

/**
 * Require the caller to be a board-tier user with DB role='admin'.
 * Resolves the caller's identity from req.auth.github_username (set on board
 * JWT) or the X-Board-User header (set by the board's ops proxy when using
 * legacy API_SECRET). Throws 403 when the caller is not authorized;
 * returns the caller's board_members row id on success (used for self-guards).
 *
 * Legacy bearer callers without an identity header (raw CLI tools) are admitted
 * with no row id — they cannot be self-guarded but are trusted by virtue of
 * holding API_SECRET.
 */
async function requireBoardAdmin(req) {
  if (!req.auth || req.auth.role !== 'board') {
    throw Object.assign(new Error('Board role required'), { statusCode: 403 });
  }
  const username = req.auth.github_username;
  if (!username) {
    if (req.auth.source === 'api_secret') return null;
    throw Object.assign(new Error('Admin role required'), { statusCode: 403 });
  }
  const r = await query(
    `SELECT id, role FROM agent_graph.board_members
     WHERE github_username = $1 AND is_active = true LIMIT 1`,
    [username]
  );
  const row = r.rows[0];
  if (!row || row.role !== 'admin') {
    throw Object.assign(new Error('Admin role required'), { statusCode: 403 });
  }
  return row.id;
}

/**
 * OPT-101 (Feature 007) — the impersonation security model (the crux).
 *
 * Domain-wide delegation (service-auth.js buildAuth sets opts.subject = userEmail)
 * lets the service account impersonate ANY workspace user. If the impersonated email
 * came from a request param/header/body, a board user could browse — and later
 * register a sync of — another user's private Drive. That is the 588/596 leak class
 * in impersonation form. The rule is absolute:
 *
 *   The impersonated workspace email is DERIVED SERVER-SIDE from the authenticated
 *   identity. It is NEVER read from a request param, header, or body.
 *
 * Mapping reuses the existing board_members.email (keyed on the same
 * github_username requireBoardAdmin resolves). Returns the email. Throws:
 *   - 403 if the caller is not a board human (no github_username) — a bare
 *     api_secret board caller has no Drive to browse, so there is NO SA-direct
 *     fallback for picking (contrast requireBoardAdmin, which admits api_secret).
 *   - 403 if the board_members row is missing / email is null (no resolvable
 *     workspace identity).
 *   - 400 { error:'impersonation_unavailable' } if the email's domain is NOT a
 *     delegated Workspace domain. DWD only works for users in the SA's delegated
 *     domain; impersonating a non-domain email (e.g. Dustin's personal
 *     dustin@example.com) returns Google `unauthorized_client`. We
 *     FAIL CLOSED with a clear 4xx and NEVER fall back to SA-direct.
 *
 * Non-domain detection (deterministic, no live Google call needed to fail closed):
 * the email's domain is checked against WORKSPACE_DELEGATED_DOMAINS (comma-separated;
 * defaults to 'staqs.io'). This catches the personal-Gmail case up front. Google's
 * own unauthorized_client is the runtime backstop (mapped to the same 400 by the
 * Drive-listing handlers' central error mapper) for the case where a domain is in
 * the allow-set but the SA was never actually authorized for it.
 */
function workspaceDelegatedDomains() {
  const raw = process.env.WORKSPACE_DELEGATED_DOMAINS || process.env.WORKSPACE_DOMAIN || 'staqs.io';
  return new Set(
    raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  );
}

export async function resolveImpersonationEmail(req) {
  // P1 deny-by-default: a human board identity is required. NO SA-direct fallback.
  // OPT-148 / ADR-019 defense-in-depth: DWD Drive impersonation is JWT-ONLY. A
  // non-jwt principal (e.g. api_secret ops tooling) can never resolve a Drive to
  // browse — reject it even if a github_username were somehow attached.
  if (!req.auth || req.auth.role !== 'board' || req.auth.source !== 'jwt' || !req.auth.github_username) {
    throw Object.assign(new Error('A board member identity is required to browse Drive'), { statusCode: 403 });
  }
  const r = await query(
    `SELECT email FROM agent_graph.board_members
     WHERE github_username = $1 AND is_active = true LIMIT 1`,
    [req.auth.github_username],
  );
  const row = r.rows[0];
  const email = row?.email ? String(row.email).trim() : '';
  if (!email) {
    throw Object.assign(new Error('No resolvable workspace identity for this board member'), { statusCode: 403 });
  }
  const domain = email.includes('@') ? email.split('@').pop().toLowerCase() : '';
  if (!domain || !workspaceDelegatedDomains().has(domain)) {
    throw Object.assign(
      new Error(`${email} is not a delegated Workspace user`),
      { statusCode: 400, errorCode: 'impersonation_unavailable' },
    );
  }
  return email;
}

/**
 * Resolve the calling viewer's email identifiers for recipient-based filtering.
 *
 * Returns one of:
 *   { ownerId, emails, adminBypass: false } — identified board member; filter by `emails` (lowercased)
 *   { ownerId: null, emails: [], adminBypass: true } — explicit internal caller (agent JWT); no filter
 *   { ownerId: null, emails: [], adminBypass: false } — identified-but-unresolved viewer; EMPTY result
 *   null — caller is not a viewer (no auth); return empty result
 *
 * STAQPRO-531: the bare shared INBOX_API_SECRET carries NO identity, so it must NOT grant
 * adminBypass. A board-tier caller using `api_secret` without an x-board-user header is
 * treated as an unidentified viewer → EMPTY result (never global). adminBypass is reserved
 * for explicit internal callers (agent JWTs), which alone hold the trusted org-wide scope.
 *
 * Identifiers = `board_members.email` UNION connected `inbox.accounts.identifier`
 * where `owner_id = board_member.id` and `channel = 'email'`.
 */
/**
 * Look up an active board member's email identities by github_username —
 * WITHOUT constructing a synthetic req.auth principal. Returns
 * { ownerId, emails } or null (no such active member).
 *
 * #508: this exists so no code path has to build a fake
 * `{ source:'api_secret', github_username, role:'board' }` auth object just to
 * reuse resolveViewerEmails' lookup. Constructing auth objects with arbitrary
 * identity fields is the exact anti-pattern behind the #507 CVE; a plain
 * username→emails lookup can't be mistaken for an authenticated principal.
 */
async function lookupEmailsByUsername(username) {
  if (!username) return null;
  const r = await query(
    `SELECT bm.id AS owner_id,
            ARRAY(
              SELECT DISTINCT lower(e) FROM (
                SELECT bm.email AS e WHERE bm.email IS NOT NULL
                UNION ALL
                SELECT a.identifier AS e
                  FROM inbox.accounts a
                 WHERE a.owner_id = bm.id AND a.channel = 'email' AND a.identifier IS NOT NULL
              ) ids
              WHERE e IS NOT NULL
            ) AS emails
       FROM agent_graph.board_members bm
      WHERE bm.github_username = $1 AND bm.is_active = true
      LIMIT 1`,
    [username]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ownerId: row.owner_id, emails: row.emails || [] };
}

async function resolveViewerEmails(req) {
  if (!req.auth) return null;
  // Explicit internal caller: agent-JWT-authenticated org agents hold trusted org-wide scope.
  if (req.auth.source === 'agent_jwt') {
    return { ownerId: null, emails: [], adminBypass: true };
  }
  if (req.auth.role !== 'board') return null;
  const username = req.auth.github_username;
  if (!username) {
    // STAQPRO-531: shared secret with no viewer identity → EMPTY result, NOT bypass.
    if (req.auth.source === 'api_secret') {
      return { ownerId: null, emails: [], adminBypass: false };
    }
    return null;
  }
  const found = await lookupEmailsByUsername(username);
  if (!found) return null;
  return { ownerId: found.ownerId, emails: found.emails, adminBypass: false };
}

// --------------------------------------------------------------------------
// Connected-accounts scoping (STAQPRO-531 family, applied to inbox.accounts).
//
// A board member must only see + manage their OWN accounts plus org-SHARED
// infra (Slack/Telegram bots owned by nobody). Mirrors the /api/today and
// /api/emails viewer pattern: scope is SERVER-DERIVED from the authed viewer,
// the raw client `?owner=` is IGNORED for non-bypass viewers, and the read
// cache key folds in the viewer so one member can never read another's list
// out of a shared cache bucket.
//
// Ownership model (inbox.accounts):
//   - "mine"   = owner_id = $ownerId OR owner = $githubUsername
//                (covers both the uuid FK and text-handle-only rows, e.g.
//                 owner='isaias' with owner_id=NULL)
//   - "shared" = owner_id IS NULL AND owner IS NULL (org infra, any member may manage)
// --------------------------------------------------------------------------

/** Per-viewer cache key for the accounts list — folds the viewer in so buckets
 *  never cross. adminBypass (agent JWT / internal) keeps a stable admin bucket. */
export function accountsCacheKey(viewer, githubUsername) {
  if (viewer?.adminBypass) return '__admin__';
  return viewer?.ownerId ?? githubUsername ?? '__none__';
}

/** Clear every per-viewer accounts cache bucket. The keyspace is now
 *  `accounts:<viewer>`, so a single `_cache.delete('accounts')` no longer
 *  suffices — loop and drop anything in the `accounts` namespace. */
function clearAccountsCache() {
  for (const k of _cache.keys()) {
    if (k === 'accounts' || k.startsWith('accounts:')) _cache.delete(k);
  }
}

/** True iff this viewer may manage (disconnect/delete/resync/activate) the
 *  given account. adminBypass → always; otherwise the account must be the
 *  viewer's own or org-shared. `account` is a row with { owner, owner_id }. */
export function mayManageAccount(viewer, githubUsername, account) {
  if (!account) return false;
  if (viewer?.adminBypass) return true;
  if (!viewer || (!viewer.ownerId && !githubUsername)) return false; // unidentified → deny
  const isMine =
    (account.owner_id != null && account.owner_id === viewer.ownerId) ||
    (account.owner != null && account.owner === githubUsername);
  const isShared = account.owner_id == null && account.owner == null;
  return isMine || isShared;
}

/**
 * STAQPRO-531: shared predicate for "is this an authorized, resolved viewer that may
 * read org-shared (non-recipient-scoped) data?". True for explicit internal callers
 * (agent JWT, adminBypass) and identified board members (have an ownerId). False for
 * unidentified/unresolved callers (bare shared secret, no x-board-user) and non-viewers.
 * Used by /api/contacts, /api/signals (contacts block), and /api/today.
 */
function mayReadOrgShared(viewer) {
  return !!viewer && (viewer.adminBypass || !!viewer.ownerId);
}

/**
 * STAQPRO-588 (ADR-012 M-C): resolve a request into a tenancy read principal.
 * Bridges the existing viewer model (board_members.id + agent-JWT adminBypass)
 * to lib/tenancy/scope.js so tenant-scoped reads can append visibleClause() to
 * their WHERE. Returns { principal, viewer }:
 *   - viewer===null            → caller is not a viewer (no auth)
 *   - principal.adminBypass    → verified agent JWT (trusted org-wide → 'TRUE')
 *   - identified board member   → principal scoped to that user's own ∪ org-shared rows
 *   - unidentified/unresolved   → principal with empty scope (visibleClause → 'FALSE')
 * Fail-closed: never returns a principal that widens beyond the resolved viewer.
 */
async function withViewer(req) {
  // OPT-37: external customer token → a single-org synthetic principal. NOT
  // adminBypass (genuinely org-scoped, never org-wide), so every visibleClause()
  // read fail-closes to this one org. No board_members / membership lookup: the
  // org binding lives on the token (verified, immutable) and is re-checked
  // against the active customer_principals row on every request by verifyCustomerToken.
  if (req.auth?.source === 'customer_jwt' && req.auth.org_id) {
    return {
      principal: syntheticPrincipal(req.auth.org_id),
      viewer: { ownerId: null, emails: [], adminBypass: false, orgId: req.auth.org_id, customer: true },
    };
  }
  const viewer = await resolveViewerEmails(req);
  if (!viewer) return { principal: null, viewer: null };
  const principal = await resolvePrincipal({ userId: viewer.ownerId, adminBypass: viewer.adminBypass });
  return { principal, viewer };
}

// ── STAQPRO-542 (ADR-014 M5): per-tier rollout mode (observe | enforce) ───────
// DB-backed + cached ~30s so it is hot-flippable without a redeploy. Defaults
// EVERY tier to 'observe' (Phase 0) and fail-safes to 'observe' if the table or
// a row is absent (PGlite tests / pre-migration prod) — the gate can never
// accidentally start enforcing. Nothing in this PR flips a tier to 'enforce'.
const TIER_MODE_TTL_MS = 30_000;
let _tierModeCache = { at: 0, modes: null };
const TIER_MODE_DEFAULT = 'observe';

async function getTierModes() {
  const now = Date.now();
  if (_tierModeCache.modes && now - _tierModeCache.at < TIER_MODE_TTL_MS) {
    return _tierModeCache.modes;
  }
  const modes = {};
  try {
    const r = await query('SELECT tier, mode FROM agent_graph.route_tier_modes');
    for (const row of r.rows) modes[row.tier] = row.mode;
  } catch {
    // Table absent (not yet migrated) → fail-safe to observe for all tiers.
  }
  _tierModeCache = { at: now, modes };
  return modes;
}

// Resolve a single tier's mode, defaulting to 'observe'.
async function getTierMode(tier) {
  const modes = await getTierModes();
  return modes[tier] || TIER_MODE_DEFAULT;
}

// Routes that are explicitly public (no auth required) — P1 inverted: opt-in exemption
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/auth/github',
  'GET /api/auth/github/callback',
  'GET /api/auth/gmail-url',       // OAuth flow start — can't be authed yet
  'GET /api/auth/gmail-callback',  // OAuth callback from Google
  'POST /api/webhooks/tldv',       // TLDv webhook uses its own header secret auth (Authorization: Bearer; query-param deprecated)
  'GET /api/board-member',         // Called during NextAuth OAuth before JWT exists
  // Cron endpoints gate themselves with Bearer CRON_SECRET inside the handler.
  // Exempting them from the global board/agent JWT + API_SECRET check here lets
  // external schedulers (Railway cron, GitHub Actions) call with a purpose-specific
  // secret that doesn't need to equal API_SECRET.
  'POST /api/cron/explorer',
  'GET /api/cron/explorer/status',
  'POST /api/cron/signatures-sweep',
]);

/**
 * Lightweight HTTP API that bridges PGlite → dashboard.
 * Replaces Supabase client calls with direct PGlite queries.
 * No Express — just http.createServer (P4: boring infrastructure).
 */

// STAQPRO-542: exported so the route-tier classifier (route-tiers.js) and the
// coverage test enumerate the SAME populated Map the dispatcher consults (M3).
export const routes = new Map();

// GET /api/health — agent-liveness probe for Railway healthcheck (STAQPRO-351).
// Returns 503 when any AGENTS_ENABLED agent has no heartbeat newer than 90s,
// so Railway auto-restarts on silent agent death instead of waiting for a human
// to notice stale drafts. AGENTS_ENABLED is the source of truth for "what should
// be running on this Railway instance" — runners that disable all agents (M1
// CLI runners) return 200 trivially.
routes.set('GET /api/health', async () => {
  const enabled = process.env.AGENTS_ENABLED
    ? process.env.AGENTS_ENABLED.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const respond = (status, body) => ({
    __raw_response: true,
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!enabled.length) {
    return { ok: true, agents_enabled: 0 };
  }

  let rows;
  try {
    const result = await query(
      `SELECT agent_id,
              EXTRACT(EPOCH FROM (now() - MAX(heartbeat_at)))::int AS age_seconds
         FROM agent_graph.agent_heartbeats
        WHERE agent_id = ANY($1::text[])
        GROUP BY agent_id`,
      [enabled]
    );
    rows = result.rows;
  } catch (err) {
    // P1 fail-closed: if we can't verify liveness, report unhealthy so Railway
    // restarts (recovers from broken DB pool / pg_notify listener).
    return respond(503, {
      ok: false,
      error: 'heartbeat_query_failed',
      message: err.message,
    });
  }

  const heartbeats = new Map(rows.map(r => [r.agent_id, Number(r.age_seconds)]));
  const stale = enabled
    .map(id => ({ agent_id: id, age_seconds: heartbeats.has(id) ? heartbeats.get(id) : null }))
    .filter(h => h.age_seconds === null || h.age_seconds > 90);

  if (stale.length) {
    return respond(503, {
      ok: false,
      stale_agents: stale,
      agents_enabled: enabled.length,
    });
  }
  return { ok: true, agents_enabled: enabled.length, agents_alive: enabled.length };
});

// GET /api/board-member?username=X — public (called during NextAuth OAuth before JWT exists)
// Returns role + display_name + email for JWT enrichment. No auth required per P1 exemption.
export async function getBoardMember(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const username = url.searchParams.get('username');
  if (!username) return { error: 'username parameter required' };
  const result = await query(
    `SELECT id, role, display_name, email FROM agent_graph.board_members
     WHERE github_username = $1 AND is_active = true LIMIT 1`,
    [username]
  );
  if (!result.rows.length) return { error: 'not_found' };
  const row = result.rows[0];
  // STAQPRO-550: return the canonical work email so the NextAuth jwt callback can
  // backfill session.user.email for GitHub accounts whose primary email is private
  // (profile.email === null). /today meeting-attendee matching keys on this email.
  return { id: row.id, role: row.role, display_name: row.display_name, email: row.email };
}
routes.set('GET /api/board-member', getBoardMember);

// GET /api/briefing — daily briefing + latest briefing content
// Single query with all counts to minimize PGlite connection time.
//
// STAQPRO-589 (ADR-012, Commit B — cache-poisoning audit, Linus blocker 3):
// this route shared the bare `'briefing'` cache bucket. The SSE heartbeat (this
// commit) now keys its briefing cache per-principal (`briefing:${scopeKey}`), so
// the shared-bucket poisoning vector between SSE and this route is severed. This
// route is itself reachable by any authenticated board member (incl. a non-Staqs
// principal like Dustin), so its per-principal bucket + org-scoped `signal.briefings`
// read close the residual leak: a foreign principal no longer reads the latest
// Staqs briefing row, nor reads a Staqs-populated bucket. The content-bearing
// message reads (pendingDrafts, actionEmails) are deny-by-default scoped below
// (OPT-166 P3 [codex-4b]) — inbox.messages carries owner_org_id (migration 138)
// but has permissive RLS (read_messages USING(true)), so the STAQPRO-263 flip
// does NOT filter it and the app-layer visibleClause is the only tenant boundary
// for those reads. The operational COUNT aggregates below (inbox.messages volume,
// action_proposals pipeline health, llm_invocations cost, budgets) are
// intentionally org-wide operational metrics on this board briefing — they return
// aggregate numbers, not tenant-content rows — the same intentional operational-
// exception posture migration 200 documents for these tables.
routes.set('GET /api/briefing', async (req) => {
  const { principal } = await withViewer(req);
  const scopeKey = !principal
    ? 'none'
    : principal.adminBypass
      ? 'admin'
      : `u:${principal.userId ?? '_'}|o:${(principal.readOrgIds || []).slice().sort().join(',')}`;
  const result = await cachedQuery(`briefing:${scopeKey}`, async () => {
    const stats = await query(`
      SELECT
        CURRENT_DATE AS briefing_date,
        (SELECT COUNT(*) FROM inbox.messages WHERE received_at >= CURRENT_DATE) AS emails_received_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE processed_at >= CURRENT_DATE) AS emails_triaged_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'action_required' AND processed_at >= CURRENT_DATE) AS action_required_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'needs_response' AND processed_at >= CURRENT_DATE) AS needs_response_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'pending') AS emails_awaiting_triage,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at >= CURRENT_DATE) AS drafts_created_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'approved' AND acted_at >= CURRENT_DATE) AS drafts_approved_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'edited' AND acted_at >= CURRENT_DATE) AS drafts_edited_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'rejected' AND acted_at >= CURRENT_DATE) AS drafts_rejected_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NULL AND reviewer_verdict IS NOT NULL) AS drafts_awaiting_review,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NOT NULL AND acted_at >= CURRENT_DATE - interval '14 days') AS drafts_reviewed_14d,
        0 AS edit_rate_14d_pct,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE) AS cost_today_usd,
        (SELECT allocated_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start <= CURRENT_DATE AND period_end >= CURRENT_DATE LIMIT 1) AS budget_today_usd,
        0 AS upcoming_deadlines
    `);
    // Latest briefing from signal.briefings — org-scoped (signal.briefings carries
    // owner_org_id per migration 134; tenancy-leak.e2e treats it as a leak surface).
    // adminBypass → 'TRUE'; unresolved principal → 'FALSE' → no row (fail-closed).
    const bvf = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
    const briefingResult = await query(
      `SELECT * FROM signal.briefings WHERE ${bvf.sql} ORDER BY briefing_date DESC LIMIT 1`,
      bvf.params
    );

    // Recent drafts awaiting review (with summary/intent for quick overview).
    // Deny-by-default tenant scoping on the message content: bare secret →
    // principal null → 'FALSE' → 0 rows; agent-JWT adminBypass → 'TRUE'; board
    // viewer → own + org rows. Same visibleClause pattern as /api/inbox.
    const msgScope = visibleClause(principal, { ownerOrgCol: 'm.owner_org_id', startIndex: 1 });
    const pendingDrafts = await query(
      `SELECT d.id, d.email_summary, d.draft_intent, d.reviewer_verdict, d.tone_score, d.created_at,
              m.from_address, m.from_name, m.subject, m.channel, a.label AS account_label
       FROM agent_graph.action_proposals d
       JOIN inbox.messages m ON m.id = d.message_id
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE d.action_type = 'email_draft' AND d.board_action IS NULL AND d.reviewer_verdict IS NOT NULL
         AND ${msgScope.sql}
       ORDER BY d.created_at ASC LIMIT 5`,
      msgScope.params
    );

    // Recent action-required emails (not yet drafted) — same tenant scoping.
    const actionEmails = await query(
      `SELECT m.id, m.from_address, m.from_name, m.subject, m.snippet, m.received_at, m.priority_score,
              m.channel, a.label AS account_label
       FROM inbox.messages m
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE m.triage_category = 'action_required'
         AND ${msgScope.sql}
         AND NOT EXISTS (SELECT 1 FROM agent_graph.action_proposals d WHERE d.message_id = m.id AND d.action_type = 'email_draft')
       ORDER BY m.received_at DESC LIMIT 5`,
      msgScope.params
    );

    return {
      stats: stats.rows[0] || null,
      briefing: briefingResult.rows[0] || null,
      pendingDrafts: pendingDrafts.rows,
      actionEmails: actionEmails.rows,
    };
  }, 15_000);
  return result || { stats: null, briefing: null, pendingDrafts: [], actionEmails: [] };
});

// GET /api/drafts — pending drafts with email join
// STAQPRO-317: scoped to viewer recipients. Returns only drafts where the
// caller's email appears in inbox.messages.to_addresses or .cc_addresses,
// so cross-mailbox ingestion (e.g. UMB partnership threads polled via one
// partner's Gmail) doesn't leak to non-recipients.
routes.set('GET /api/drafts', async (req) => {
  const viewer = await resolveViewerEmails(req);
  if (!viewer) return { drafts: [] };

  // TODO(opt-166-p3): mixed principal — resolveViewerEmails() maps verified
  // agent-JWT callers (req.auth.source === 'agent_jwt') to adminBypass: true
  // (a currently-working, non-board caller; see api.js resolveViewerEmails).
  // withBoardScope() THROWS for any req.auth.role !== 'board', so wrapping this
  // handler would break that caller pre-flip (INERT-rule violation). Left
  // unscoped intentionally; owner-scoping is enforced in the WHERE clause
  // below; an unidentified api_secret caller resolves to emails:[] → EMPTY
  // result (STAQPRO-531). action_proposals RLS-flip coverage for the
  // agent-JWT path must come from a different mechanism than withBoardScope.
  const cacheKey = viewer.adminBypass ? 'drafts:__admin__' : `drafts:${viewer.ownerId ?? '__empty__'}`;
  const result = await cachedQuery(cacheKey, async () => {
    const params = [];
    let viewerFilter = '';
    if (!viewer.adminBypass) {
      params.push(viewer.emails);
      viewerFilter = ` AND EXISTS (
        SELECT 1 FROM unnest(
          COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
        ) AS addr
        WHERE lower(addr) = ANY($1::text[])
      )`;
    }
    const r = await query(
      `SELECT d.id, d.action_type, d.work_item_id, d.body, d.subject, d.to_addresses,
              d.message_id, d.email_summary, d.draft_intent, d.tone_score,
              d.reviewer_verdict, d.reviewer_notes, d.gate_results,
              d.board_action, d.board_edited_body, d.board_notes,
              d.acted_at, d.acted_by, d.send_state, d.version,
              d.previous_proposal_id, d.provider_draft_id, d.created_at, d.viewed_at,
              CASE
                WHEN d.reviewer_verdict = 'approved'
                  AND d.tone_score >= 0.85
                  AND (d.gate_results IS NULL OR NOT EXISTS (
                    SELECT 1 FROM jsonb_each(d.gate_results) AS g(key, val)
                    WHERE (val->>'passed')::boolean = false
                  ))
                THEN 'high'
                ELSE 'review'
              END AS confidence_tier,
              json_build_object(
                'from_address', m.from_address,
                'from_name', m.from_name,
                'subject', m.subject,
                'triage_category', m.triage_category,
                'snippet', m.snippet,
                'received_at', m.received_at,
                'priority_score', m.priority_score,
                'channel', m.channel,
                'account_label', a.label
              ) AS emails
       FROM agent_graph.action_proposals d
       JOIN inbox.messages m ON m.id = d.message_id
       LEFT JOIN inbox.accounts a ON a.id = m.account_id
       WHERE d.action_type = 'email_draft' AND d.board_action IS NULL${viewerFilter}
       ORDER BY confidence_tier ASC, d.created_at DESC`,
      params
    );
    return { drafts: r.rows };
  }, 15_000);
  const out = result || { drafts: [] };
  // sql/115-drafts-viewed-gate.sql: stamp viewed_at so the auto-archive
  // sweep (src/gmail/auto-archive-sweep.js) waits for a human to have
  // actually seen the draft before reaping it. Idempotent — first viewing
  // is the one that sticks. Fire-and-forget to keep the response snappy.
  if (out.drafts?.length > 0) {
    const ids = out.drafts.map((d) => d.id).filter(Boolean);
    if (ids.length > 0) {
      query(
        `UPDATE agent_graph.action_proposals
            SET viewed_at = now()
          WHERE id = ANY($1::text[]) AND viewed_at IS NULL`,
        [ids],
      ).catch((err) => console.warn(`[drafts] viewed_at stamp failed: ${err.message}`));
    }
  }

  // STAQPRO-552: "No drafts pending" alongside "N received" reads like a pipeline
  // outage when it is usually by design — the responder's tier opt-in gate skips
  // drafting for non-draftable senders (tier='unknown'/newsletter/automated/...),
  // and drafts that ARE created get auto-actioned (board_action set) so they fall
  // out of the pending list. Surface a cheap pipeline summary so an empty list is
  // self-explanatory: how many drafts were produced in the last 7d and what
  // happened to them. Best-effort — never block the drafts response.
  try {
    const summary = await query(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '7 days') AS produced_7d,
         count(*) FILTER (WHERE board_action IS NULL) AS pending,
         count(*) FILTER (WHERE board_action = 'archived_no_reply'
                          AND created_at > now() - interval '7 days') AS auto_archived_7d,
         count(*) FILTER (WHERE board_action = 'rejected'
                          AND created_at > now() - interval '7 days') AS rejected_7d
       FROM agent_graph.action_proposals
       WHERE action_type = 'email_draft'`
    );
    const responderSkips = await query(
      `SELECT count(*) AS skipped_7d
         FROM agent_graph.work_items wi
        WHERE wi.assigned_to = 'executor-responder'
          AND wi.status = 'completed'
          AND wi.created_at > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM agent_graph.action_proposals ap WHERE ap.work_item_id = wi.id
          )`
    );
    const s = summary.rows[0] || {};
    out.pipelineSummary = {
      producedLast7d: parseInt(s.produced_7d || '0', 10),
      pending: parseInt(s.pending || '0', 10),
      autoArchivedLast7d: parseInt(s.auto_archived_7d || '0', 10),
      rejectedLast7d: parseInt(s.rejected_7d || '0', 10),
      // Responder tasks that completed without producing a draft (tier opt-in /
      // no-reply-history skips). High skip count + low produced = working as designed.
      responderSkippedLast7d: parseInt(responderSkips.rows[0]?.skipped_7d || '0', 10),
    };
  } catch (err) {
    console.warn(`[drafts] pipelineSummary failed: ${err.message}`);
  }

  return out;
});

// Log board member actions to activity feed (shared activity stream)
async function logBoardAction(action, draftId, actedBy, metadata = {}) {
  try {
    await query(
      `INSERT INTO agent_graph.agent_activity_steps
       (agent_id, step_type, description, status, completed_at, metadata)
       VALUES ($1, 'decision', $2, 'completed', now(), $3)`,
      [
        actedBy || 'board',
        `Board ${action}: draft ${draftId}`,
        JSON.stringify({ draft_id: draftId, action, acted_by: actedBy, ...metadata }),
      ]
    );
  } catch { /* non-critical — don't block approval */ }
}

// Self-approval prevention (Linus): external agents cannot approve their own proposals
async function checkSelfApproval(req, proposalId) {
  if (req.auth?.role === 'external_agent' || req.auth?.sub?.startsWith('nemoclaw-')) {
    const proposal = await query(
      'SELECT created_by FROM agent_graph.action_proposals WHERE id = $1', [proposalId]
    );
    const createdBy = proposal.rows[0]?.created_by;
    if (createdBy && (createdBy === req.auth.sub || createdBy === req.auth.github_username)) {
      throw Object.assign(new Error('Cannot approve your own proposal'), { statusCode: 403 });
    }
  }
}

// POST /api/drafts/:id/approve
routes.set('POST /api/drafts/approve', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  await checkSelfApproval(req, id);
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || null;
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2, send_state = 'approved' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };

  await logBoardAction('approved', id, acted_by);
  await publishEvent('draft_approved', `Draft ${id} approved by board`, null, null, { draft_id: id });

  // Create platform draft via channel-aware dispatcher (email→Gmail draft, Slack→no-op)
  try {
    const result = await approveViaDispatcher(id);
    return { ok: true, platformDraftId: result.platformDraftId, channel: result.channel, note: result.channel === 'slack' ? 'Approved. Send to deliver Slack message.' : 'Draft created in Gmail — open Gmail to review and send.' };
  } catch (err) {
    console.error(`[api] Failed to create platform draft for ${id}:`, err.message);
    return { ok: true, platformDraftId: null, note: 'Approved but platform draft creation failed: ' + err.message };
  }
});

// POST /api/drafts/send — approve and send in one step (board approval IS the L0 check)
routes.set('POST /api/drafts/send', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || null;

  // Approve the draft
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2, send_state = 'approved' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };

  await logBoardAction('sent', id, acted_by);

  // Send via channel-aware dispatcher
  try {
    const sentId = await sendViaDispatcher(id);
    return { ok: true, sentId, note: 'Approved and sent.' };
  } catch (err) {
    console.error(`[api] Failed to send draft ${id}:`, err.message);
    return { ok: false, error: err.message, note: 'Approved but send failed.' };
  }
});

// POST /api/drafts/send-approved — send a previously approved draft
routes.set('POST /api/drafts/send-approved', async (_req, body) => {
  const { id } = body;

  try {
    const sentId = await sendViaDispatcher(id);
    return { ok: true, sentId };
  } catch (err) {
    console.error(`[api] Failed to send approved draft ${id}:`, err.message);
    return { ok: false, error: err.message };
  }
});

// POST /api/drafts/:id/reject
routes.set('POST /api/drafts/reject', async (req, body) => {
  _cache.delete('drafts');
  const { id } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || null;
  const r = await query(
    `UPDATE agent_graph.action_proposals SET board_action = 'rejected', acted_at = now(), acted_by = $2, send_state = 'cancelled' WHERE id = $1 AND board_action IS NULL`,
    [id, acted_by]
  );
  if (r.rowCount === 0) return { ok: false, error: 'Draft not found or already acted on' };
  await logBoardAction('rejected', id, acted_by);
  await publishEvent('draft_reviewed', `Draft ${id} rejected by board`, null, null, { draft_id: id, action: 'rejected' });
  return { ok: true };
});

// POST /api/drafts/:id/edit — edit-then-approve (records edit delta)
routes.set('POST /api/drafts/edit', async (_req, body) => {
  _cache.delete('drafts');
  const { id, editedBody, notes } = body;

  // Get original draft + email context for edit delta
  const original = await query(
    `SELECT d.body, d.message_id, d.subject, d.to_addresses,
            m.from_address, m.triage_category
     FROM agent_graph.action_proposals d
     JOIN inbox.messages m ON m.id = d.message_id
     WHERE d.id = $1`,
    [id]
  );
  if (original.rows.length === 0) return { error: 'Draft not found' };

  const row = original.rows[0];
  const originalBody = row.body;

  // Update draft with edited version — guard: only if not already acted on or in-flight
  const editResult = await query(
    `UPDATE agent_graph.action_proposals
     SET board_action = 'edited',
         board_edited_body = $1,
         board_notes = $2,
         acted_at = now(),
         send_state = 'approved'
     WHERE id = $3
       AND board_action IS NULL
       AND send_state NOT IN ('staged', 'delivered', 'sending')`,
    [editedBody, notes || null, id]
  );
  if (editResult.rowCount === 0) {
    return { statusCode: 409, error: 'Draft already acted on or in-flight' };
  }

  // Record edit delta via edit-tracker (D4: most valuable data in the system)
  // Uses proper diff computation, edit type classification, and magnitude calculation
  await recordEditDelta({
    draftId: id,
    emailId: row.message_id,
    originalBody,
    editedBody,
    recipient: row.from_address,
    subject: row.subject,
    triageCategory: row.triage_category,
  });

  // Create platform draft with edited body via dispatcher (L0: draft-only, D2/G5)
  try {
    const result = await approveViaDispatcher(id);
    return { ok: true, platformDraftId: result.platformDraftId, channel: result.channel, note: 'Edited draft created.' };
  } catch (err) {
    console.error(`[api] Failed to create platform draft for ${id}:`, err.message);
    return { ok: true, platformDraftId: null, note: 'Approved but platform draft creation failed: ' + err.message };
  }
});

// GET /api/emails/body — fetch email body on-demand from Gmail (D1: metadata-only storage)
// P1: Board-only — agents must not access raw email bodies (prevents data exfiltration)
routes.set('GET /api/emails/body', async (req) => {
  if (!req.auth || req.auth.role !== 'board') {
    return { statusCode: 403, error: 'Board role required to access email bodies' };
  }
  const url = new URL(req.url, `http://localhost`);
  const emailId = url.searchParams.get('id');
  if (!emailId) return { error: 'Missing ?id= parameter' };

  const result = await query(
    `SELECT provider_msg_id, snippet, account_id, channel FROM inbox.messages WHERE id = $1`,
    [emailId]
  );
  if (result.rows.length === 0) return { error: 'Email not found' };

  const { provider_msg_id, snippet, account_id, channel } = result.rows[0];

  // Non-email channels don't have provider bodies — return snippet
  if (channel !== 'email' || !provider_msg_id) {
    return { body: snippet, snippet, channel };
  }

  try {
    const { fetchEmailBody } = await import('./gmail/client.js');
    const body = await fetchEmailBody(provider_msg_id, account_id);
    return { body, snippet, channel };
  } catch (err) {
    return { body: null, snippet, channel, error: err.message };
  }
});

// POST /api/drafts/bulk — batch approve/send/reject multiple drafts
routes.set('POST /api/drafts/bulk', async (req, body) => {
  _cache.delete('drafts');
  const { ids, action } = body;
  const acted_by = req.auth?.github_username || req.headers?.['x-board-user'] || null;
  const VALID_ACTIONS = new Set(['approve', 'send', 'reject']);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !action || !VALID_ACTIONS.has(action)) {
    return { error: 'Invalid request: ids must be 1-100 items with a valid action (approve/send/reject)' };
  }

  const results = [];
  for (const id of ids) {
    try {
      if (action === 'reject') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'rejected', acted_at = now(), acted_by = $2,
           send_state = 'cancelled' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        results.push({ id, ok: true });
      } else if (action === 'approve') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2,
           send_state = 'approved' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        await logBoardAction('approved', id, acted_by);
        try {
          const result = await approveViaDispatcher(id);
          results.push({ id, ok: true, platformDraftId: result.platformDraftId, channel: result.channel });
        } catch (err) {
          results.push({ id, ok: true, platformDraftId: null, error: err.message });
        }
      } else if (action === 'send') {
        const r = await query(
          `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now(), acted_by = $2,
           send_state = 'approved' WHERE id = $1 AND board_action IS NULL`, [id, acted_by || null]
        );
        if (r.rowCount === 0) { results.push({ id, ok: false, error: 'Already acted on' }); continue; }
        try {
          const sentId = await sendViaDispatcher(id);
          results.push({ id, ok: true, sentId });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return { results, processed: results.length };
});

registerSignalsRoutes(routes, cachedQuery, _cache, { withViewer }); // OPT-139: extracted from inline block (plan 003)

// GET /api/signals is registered in api-routes/flows.js (the live, tenant-scoped
// flow-signal feed over agent_graph.signals — the shape the board /signals page
// consumes). A prior handler here read inbox.signals + contacts + topics, but it
// was dead code: registerFlowRoutes() runs later and last-writer-wins on the
// routes Map silently shadowed it. That collision masked the cross-tenant read
// leak (STAQPRO-588). Do NOT re-register 'GET /api/signals' in this file — scope
// the flows.js handler instead.

// GET /api/today — OWE / WAITING / CONNECT dashboard data (ADR-014)
//
// STAQPRO-531: owner scope is derived from the AUTHENTICATED viewer, never the raw
// client `?owner=` param. The handler previously read an unverified `?owner=<username>`
// — any board member could pass `?owner=victim` and (via the cache key alone, while the
// queries were globally unscoped) read another member's OWE/WAITING data. This is the
// board landing page, exactly where "Dustin sees Eric's details" surfaced.
//
// New behavior (deny-by-default, P1):
//   - non-bypass viewer: client `?owner=` is IGNORED; scope = the viewer's own emails.
//     Unidentified/unresolved callers (bare shared secret, no x-board-user) → EMPTY.
//   - explicit internal caller (agent JWT, adminBypass): may pass `?owner=<username>` to
//     scope to that member's emails; with no `?owner=` they get the global org view.
// Scoping mirrors /api/drafts: a task belongs to a viewer when its source message was
// addressed (to/cc) to one of the viewer's resolved email identifiers.
// TODO(opt-166-p3): mixed principal — resolveViewerEmails() maps verified
// agent-JWT callers (req.auth.source === 'agent_jwt') to adminBypass: true
// (a currently-working, non-board caller; see api.js resolveViewerEmails).
// withBoardScope() THROWS for any req.auth.role !== 'board', so wrapping this
// handler would break that caller pre-flip (INERT-rule violation). Left
// unscoped intentionally; human_tasks/signal.contacts RLS-flip coverage for
// the agent-JWT path must come from a different mechanism than withBoardScope.
routes.set('GET /api/today', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const viewer = await resolveViewerEmails(req);
  if (!viewer) return { owe: [], waiting: [], connect: [], stats: {} };

  // STAQPRO-588 (ADR-012 M-C): tenancy principal for the org-shared CONNECT block.
  // The OWE/WAITING lists stay recipient-scoped (htViewerFilter on inbox.human_tasks,
  // which has no owner columns); CONNECT reads signal.contacts and is scoped by the
  // predicate below. The cache key (scopeKey) is principal-equivalent, so scoped
  // CONNECT rows never leak across cache buckets.
  const principal = await resolvePrincipal({ userId: viewer.ownerId, adminBypass: viewer.adminBypass });

  // Resolve the effective email scope. adminBypass callers may target another member
  // via ?owner=; everyone else is scoped to themselves (client ?owner= is ignored).
  const ownerFilter = url.searchParams.get('owner');
  const safeOwner = ownerFilter && /^[a-zA-Z0-9_-]+$/.test(ownerFilter) ? ownerFilter : null;
  let scopeEmails = viewer.emails;
  let scopeKey;
  if (viewer.adminBypass) {
    if (safeOwner) {
      // #508: plain username→emails lookup — no synthetic req.auth principal.
      const o = await lookupEmailsByUsername(safeOwner);
      scopeEmails = o?.emails || [];
      scopeKey = `owner:${safeOwner}`;
    } else {
      scopeEmails = null; // null = unfiltered global view (trusted internal caller)
      scopeKey = 'admin';
    }
  } else {
    // Non-bypass: deny-by-default. An identified member sees only their own recipients;
    // an unresolved member (emails:[]) gets nothing. Client ?owner= cannot widen this.
    scopeKey = `bm:${viewer.ownerId ?? '__empty__'}`;
  }

  // STAQPRO-531: key the cache by the SERVER-DERIVED scope, never the raw client param,
  // so one member can never read or poison another member's cache bucket.
  const cacheKey = `today:${scopeKey}`;
  const result = await cachedQuery(cacheKey, async () => {
    // Recipient-overlap filter: a human_task is in-scope when its source message was
    // addressed (to/cc) to one of the viewer's emails. scopeEmails === null means an
    // unfiltered global view (adminBypass with no ?owner=). An empty array yields no rows.
    const htParams = [];
    let htViewerFilter = '';
    if (scopeEmails !== null) {
      htParams.push(scopeEmails);
      // STAQPRO-549: recipient-overlap only constrains EMAIL-sourced tasks. The
      // EXISTS-over-to/cc test is meaningless for non-email channels (Slack,
      // Telegram, webhook) and for tasks with no source message — those rows
      // carry no to/cc addresses, so the bare EXISTS silently dropped every
      // OWE/WAITING obligation the brief still lists (the "empty Open
      // Obligations" bug). Gate the EXISTS on m.channel='email' and bypass it for
      // non-email / null-message tasks (m.id IS NULL after the LEFT JOIN means no
      // source message). Org scoping (htOrgFilter / visibleClause)
      // is unchanged and still AND-ed in below — this does NOT widen cross-org
      // visibility, only the within-org recipient filter.
      htViewerFilter = `
      AND (
        m.id IS NULL
        OR m.channel IS DISTINCT FROM 'email'
        OR EXISTS (
          SELECT 1 FROM unnest(
            COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
          ) AS addr
          WHERE lower(addr) = ANY($1::text[])
        )
      )`;
    }
    // ADR-008 Stream A — OWE / WAITING now read the relevance-gated, resolvable
    // inbox.human_tasks board instead of raw inbox.signals. Raw signals never
    // expire and sort overdue-first, so a Sept-2024 obligation led every view
    // (the "set up Lester" bug). human_tasks carries the lifecycle (resolve /
    // snooze) and the relevance gate already dropped vendor noise on promotion.
    //
    // Filters applied to BOTH lists:
    //   - non-terminal: status NOT IN ('done','skipped','not_for_us')
    //   - not snoozed:  snoozed_until IS NULL OR <= now()
    //   - direct staleness floor (Linus #7): drop anything > 7 days past due —
    //     do NOT rely on the promoter / isStillLive having pre-filtered.
    //
    // human_tasks has no `direction`; map task_type → the original buckets:
    //   OWE  (someone expects something FROM us)  = task_type='request' (inbound)
    //   WAITING (we expect something from someone) = everything else  (outbound)
    // Display fields (from_*, subject, channel, webhook_source, contact_*) come
    // via a LEFT JOIN to the source message so the response contract is
    // preserved; they are null when the source message is gone.
    const HT_BASE_FIELDS = `
      ht.id, ht.task_type AS signal_type, ht.title AS content,
      ht.extraction_confidence AS confidence, ht.due_date,
      ht.created_at, ht.message_id, NULL::text AS domain,
      m.from_address, m.from_name, m.subject, m.received_at, m.channel,
      CASE WHEN m.channel = 'webhook' THEN
        (SELECT SUBSTRING(l FROM 'webhook:(.+)') FROM UNNEST(m.labels) l WHERE l LIKE 'webhook:%' LIMIT 1)
      END AS webhook_source,
      c.contact_type, c.is_vip, c.tier`;
    const HT_LIVE_PREDICATE = `
      ht.deleted_at IS NULL
      AND ht.status NOT IN ('done','skipped','not_for_us')
      AND (ht.snoozed_until IS NULL OR ht.snoozed_until <= now())
      AND (ht.due_date IS NULL OR ht.due_date >= (now() - interval '7 days'))`;

    // OPT-162 Phase 3 (ADR-020): the obligations read can come from either the
    // legacy inbox.human_tasks-only path OR the union view (human_tasks ∪ work_items,
    // deduped). The cutover is behind TODAY_OBLIGATIONS_SOURCE (default OFF → legacy),
    // so the union goes live only when deliberately flipped after tenancy review.
    // BOTH paths apply IDENTICAL tenancy scoping (per-org visibleClause + per-viewer
    // recipient overlap) — the union view exposes the same scoping inputs the legacy
    // human_tasks query uses (owner_org_id; is_email_scoped/viewer_match_emails which
    // reproduce htViewerFilter exactly). See ./api-routes/obligations-today.js.
    const useUnion = unionSourceEnabled();

    // STAQPRO-588 (ADR-012 M-C): org-scope on owner_org_id (migration 134), AND-ed
    // with the recipient-overlap filter. adminBypass → 'TRUE'; unresolved principal →
    // 'FALSE' → zero rows (fail-closed). Params append AFTER htParams so positional
    // indices stay correct across owe/waiting/stats. The column is qualified to the
    // active source's alias (ht. legacy / o. union) — the principal, param values, and
    // start index are IDENTICAL either way, so tenancy is byte-for-byte equivalent.
    const orgClause = visibleClause(principal, {
      ownerOrgCol: useUnion ? 'o.owner_org_id' : 'ht.owner_org_id',
      startIndex: htParams.length + 1,
    });
    htParams.push(...orgClause.params);
    const htOrgFilter = ` AND ${orgClause.sql}`;
    // The union view's per-viewer filter is the exact analogue of htViewerFilter; when
    // the union is off this is unused and the legacy htViewerFilter applies unchanged.
    const obligVF = useUnion ? obligViewerFilter(scopeEmails) : '';

    // OWE: inbound asks (obligation_type/task_type='request').
    const owe = await query(
      useUnion
        ? obligOweQuery(obligVF, htOrgFilter)
        : `
      SELECT ${HT_BASE_FIELDS}, 'inbound'::text AS direction
      FROM inbox.human_tasks ht
      LEFT JOIN inbox.messages m ON m.id = ht.message_id
      LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
      WHERE ${HT_LIVE_PREDICATE}
        AND ht.task_type = 'request'${htViewerFilter}${htOrgFilter}
      ORDER BY
        CASE WHEN ht.due_date < now() THEN 0 ELSE 1 END,
        ht.due_date ASC NULLS LAST,
        ht.created_at DESC
    `,
      htParams,
    );

    // WAITING: everything else — work we owe / expect to land.
    const waiting = await query(
      useUnion
        ? obligWaitingQuery(obligVF, htOrgFilter)
        : `
      SELECT ${HT_BASE_FIELDS}, 'outbound'::text AS direction
      FROM inbox.human_tasks ht
      LEFT JOIN inbox.messages m ON m.id = ht.message_id
      LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
      WHERE ${HT_LIVE_PREDICATE}
        AND (ht.task_type IS NULL OR ht.task_type <> 'request')${htViewerFilter}${htOrgFilter}
      ORDER BY ht.created_at ASC
    `,
      htParams,
    );

    // CONNECT: contacts with decaying relationship strength, coldest first.
    // STAQPRO-588 (ADR-012 M-C): signal.contacts is now scoped by the tenancy
    // predicate (qualified on the joined contacts row c). Agents (adminBypass) keep
    // full access; an unidentified/unresolved principal → 'FALSE' → no rows.
    let connect = [];
    if (principal) {
      const vc = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 1 });
      connect = (await query(`
          SELECT v.*, c.vip_reason, c.notes
          FROM signal.v_contact_strength v
          JOIN signal.contacts c ON c.id = v.id
          WHERE v.tier IN ('inner_circle', 'active')
            AND v.relationship_strength < 60
            AND ${vc.sql}
          ORDER BY v.relationship_strength ASC
          LIMIT 15
        `, vc.params)).rows;
    }

    // Summary stats — recomputed from the SAME non-terminal, non-snoozed,
    // staleness-floored human_tasks population so the counts match the lists.
    // STAQPRO-531: apply the same recipient-overlap filter (htViewerFilter) so the
    // counts match the scoped OWE/WAITING lists and never leak another member's totals.
    const stats = await query(
      useUnion
        ? obligStatsQuery(obligVF, htOrgFilter)
        : `
      SELECT
        (SELECT COUNT(*) FROM inbox.human_tasks ht LEFT JOIN inbox.messages m ON m.id = ht.message_id WHERE ${HT_LIVE_PREDICATE} AND ht.task_type = 'request'${htViewerFilter}${htOrgFilter}) AS owe_count,
        (SELECT COUNT(*) FROM inbox.human_tasks ht LEFT JOIN inbox.messages m ON m.id = ht.message_id WHERE ${HT_LIVE_PREDICATE} AND (ht.task_type IS NULL OR ht.task_type <> 'request')${htViewerFilter}${htOrgFilter}) AS waiting_count,
        (SELECT COUNT(*) FROM inbox.human_tasks ht LEFT JOIN inbox.messages m ON m.id = ht.message_id WHERE ${HT_LIVE_PREDICATE} AND ht.due_date < now()${htViewerFilter}${htOrgFilter}) AS overdue_count,
        (SELECT COUNT(*) FROM inbox.human_tasks ht LEFT JOIN inbox.messages m ON m.id = ht.message_id WHERE ${HT_LIVE_PREDICATE} AND ht.due_date BETWEEN now() AND now() + interval '7 days'${htViewerFilter}${htOrgFilter}) AS due_this_week
    `,
      htParams,
    );

    return {
      owe: owe.rows,
      waiting: waiting.rows,
      connect,
      stats: stats.rows[0] || { owe_count: 0, waiting_count: 0, overdue_count: 0, due_this_week: 0 },
    };
  }, 15_000);
  return result || { owe: [], waiting: [], connect: [], stats: {} };
});

// GET /api/today/brief — Morning Brief: LLM-generated 2-4 line prose summary
// of today's meetings + open obligations. Phase 2 of the chat-experience plan.
//
// Query params:
//   scope        personal | org    (default personal)
//   email        viewer email      (required when scope=personal)
//   start_iso    start of "today" in caller TZ (required — UTC server can't guess)
//   end_iso      end of "today"   in caller TZ (required)
//   owner        owner handle for obligation filter (optional, mirrors /api/today)
routes.set('GET /api/today/brief', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const scope = url.searchParams.get('scope') === 'org' ? 'org' : 'personal';
  const emailParam = (url.searchParams.get('email') || '').trim().toLowerCase();
  const startIso = url.searchParams.get('start_iso');
  const endIso = url.searchParams.get('end_iso');
  const ownerFilter = url.searchParams.get('owner');
  const safeOwner = ownerFilter && /^[a-zA-Z0-9_-]+$/.test(ownerFilter) ? ownerFilter : null;

  if (!startIso || !endIso) return { brief: '', meta: { error: 'start_iso and end_iso required' } };
  if (scope === 'personal' && !emailParam) return { brief: '', meta: { error: 'email required when scope=personal' } };

  // STAQPRO-588 (ADR-012 M-C) BLOCKER: this route's narrative reads obligations
  // (inbox.human_tasks) + contacts (signal.contacts) with NO tenant scoping, so a
  // viewer's brief could summarize another org's obligations/contacts. Resolve the
  // read principal here and AND visibleClause() into BOTH reads. adminBypass (verified
  // agent JWT) → 'TRUE' (full access); unresolved principal → 'FALSE' → empty brief.
  const { principal } = await withViewer(req);

  // Cache must be keyed by the principal's read scope, or a scoped brief for one
  // viewer could be served to another (the cache would otherwise be the leak).
  const scopeKey = principal?.adminBypass
    ? 'admin'
    : (principal?.readOrgIds?.length ? [...principal.readOrgIds].sort().join(',') : 'none');
  const cacheKey = `today-brief:${scope}:${emailParam || 'all'}:${startIso}:${endIso}:${safeOwner || 'all'}:${scopeKey}`;

  const result = await cachedQuery(cacheKey, async () => {
    const HAPPENED_AT = `COALESCE(
      CASE WHEN d.metadata->>'happenedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
           THEN (d.metadata->>'happenedAt')::timestamptz ELSE NULL END,
      d.created_at)`;

    // Personal scope = meetings the viewer attended. Org = all meetings in window.
    const baseValues = [startIso, endIso];
    let participantFilter = '';
    if (scope === 'personal') {
      baseValues.push(emailParam);
      participantFilter = `
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
          WHERE LOWER(p->>'email') = $${baseValues.length}
        )`;
    }

    const meetings = await query(
      `SELECT d.id, d.title, d.participants, ${HAPPENED_AT} AS happened_at
       FROM content.documents d
       WHERE d.deleted_at IS NULL
         AND (d.source IN ('tldv','gemini')
              OR (d.source = 'drive' AND d.format IN ('tldv','gemini')))
         AND ${HAPPENED_AT} >= $1::timestamptz
         AND ${HAPPENED_AT} < $2::timestamptz
         ${participantFilter}
       ORDER BY happened_at ASC
       LIMIT 8`,
      baseValues
    );

    // "Mentioned in" — only in personal scope. Meetings the viewer did NOT
    // attend (under ANY of their identity aliases) but where their name or
    // an email local-part shows up in chunk text. Uses signal.contact_identities
    // so post-merge canonical contacts get all their aliases for free.
    let mentions = [];
    if (scope === 'personal' && emailParam) {
      // STAQPRO-588 (ADR-012 M-C): signal.contacts is tenant-scoped on c.owner_org_id
      // (migration 134). $1 = emailParam; the visibleClause params start at $2.
      // adminBypass → 'TRUE'; unresolved principal → 'FALSE' → no contact row resolved
      // (the viewer simply gets no alias expansion / mentions, fail-closed).
      const cScope = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 2 });
      // Resolve the viewer's canonical contact + all their email aliases.
      const aliasResult = await query(
        `SELECT c.id AS contact_id, c.name,
                COALESCE(
                  (SELECT array_agg(LOWER(identifier))
                   FROM signal.contact_identities ci
                   WHERE ci.contact_id = c.id AND ci.channel = 'email'),
                  ARRAY[LOWER(c.email_address)]
                ) AS emails
         FROM signal.contacts c
         WHERE (LOWER(c.email_address) = $1
            OR EXISTS (
              SELECT 1 FROM signal.contact_identities ci
              WHERE ci.contact_id = c.id
                AND ci.channel = 'email'
                AND LOWER(ci.identifier) = $1
            ))
            AND ${cScope.sql}
         LIMIT 1`,
        [emailParam, ...cScope.params]
      );

      const viewerEmails = aliasResult.rows[0]?.emails || [emailParam];
      const viewerName = aliasResult.rows[0]?.name || null;

      // Build search-token set: local-parts of every alias + name tokens
      // (first/last). Drop tokens shorter than 3 chars to avoid noise.
      const tokens = new Set();
      for (const e of viewerEmails) {
        const lp = (e || '').split('@')[0].replace(/[^a-z0-9]/g, '');
        if (lp.length >= 3) tokens.add(lp);
      }
      if (viewerName) {
        for (const part of viewerName.toLowerCase().split(/\s+/)) {
          const clean = part.replace(/[^a-z0-9]/g, '');
          if (clean.length >= 3) tokens.add(clean);
        }
      }

      const searchTokens = [...tokens];
      if (searchTokens.length > 0) {
        // ANY-match: chunk contains at least one token. Use OR'd ILIKE.
        const tokenChecks = searchTokens.map((_, i) => `POSITION($${i + 4}::text IN LOWER(ch.text)) > 0`).join(' OR ');
        const params = [startIso, endIso, viewerEmails, ...searchTokens];

        const mentionResult = await query(
          `SELECT DISTINCT d.id, d.title, ${HAPPENED_AT} AS happened_at, d.participants
           FROM content.documents d
           JOIN content.chunks ch ON ch.document_id = d.id
           WHERE d.deleted_at IS NULL
             AND (d.source IN ('tldv','gemini')
                  OR (d.source = 'drive' AND d.format IN ('tldv','gemini')))
             AND ${HAPPENED_AT} >= $1::timestamptz
             AND ${HAPPENED_AT} < $2::timestamptz
             AND (${tokenChecks})
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
               WHERE LOWER(p->>'email') = ANY($3::text[])
             )
           ORDER BY happened_at DESC
           LIMIT 5`,
          params
        );
        mentions = mentionResult.rows;
      }
    }

    // ADR-008 Stream A — obligations now read the relevance-gated, resolvable
    // inbox.human_tasks board instead of raw inbox.signals (the "set up Lester"
    // bug: raw signals never expire, sort overdue-first, and confabulate). We
    // surface only NON-TERMINAL cards that are not snoozed, plus a DIRECT
    // staleness floor (Linus #7 — do not rely on the promoter having pre-
    // filtered): anything more than 7 days past its due date is dropped here.
    //
    // human_tasks carries no signal `direction`. Map task_type → the brief's
    // inbound/outbound buckets: a 'request' is an inbound ask (someone is
    // waiting on us → "Waiting on"); everything else is work WE owe ("You owe").
    // The mapped `direction` preserves the downstream inbound/outbound split and
    // the existing response contract.
    // STAQPRO-588 (ADR-012 M-C): org-scope the obligations read on ht.owner_org_id
    // (migration 134). No other params on this query → visibleClause starts at $1.
    // adminBypass → 'TRUE'; unresolved principal → 'FALSE' → zero obligations.
    const htScope = visibleClause(principal, { ownerOrgCol: 'ht.owner_org_id', startIndex: 1 });
    const obligations = await query(
      `SELECT ht.title AS content,
              ht.due_date,
              ht.task_type AS signal_type,
              CASE WHEN ht.task_type = 'request' THEN 'inbound' ELSE 'outbound' END AS direction
         FROM inbox.human_tasks ht
        WHERE ht.deleted_at IS NULL
          AND ht.status NOT IN ('done', 'skipped', 'not_for_us')
          AND (ht.snoozed_until IS NULL OR ht.snoozed_until <= now())
          AND (ht.due_date IS NULL OR ht.due_date >= (now() - interval '7 days'))
          AND ${htScope.sql}
        ORDER BY (ht.due_date IS NULL), ht.due_date ASC, ht.created_at DESC
        LIMIT 8`,
      htScope.params
    );

    // No data → no brief, but emit a friendly placeholder so the UI doesn't break
    if (meetings.rows.length === 0 && mentions.length === 0 && obligations.rows.length === 0) {
      return {
        brief: scope === 'org'
          ? 'No meetings or obligations across the org today.'
          : 'Nothing on the calendar and no open obligations. Quiet day.',
        meta: {
          scope, meetings: 0, mentions: 0, obligations: 0,
          generatedAt: new Date().toISOString(),
        },
      };
    }

    // Build a compact prompt
    const meetingLines = meetings.rows.map(m => {
      const time = new Date(m.happened_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const attendees = Array.isArray(m.participants)
        ? m.participants.slice(0, 4).map(p => p.name || p.email).filter(Boolean).join(', ')
        : '';
      return `- ${time} · ${m.title || 'Untitled'}${attendees ? ` (${attendees})` : ''}`;
    }).join('\n') || '(none)';

    const mentionLines = mentions.map(m => {
      const time = new Date(m.happened_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const attendees = Array.isArray(m.participants)
        ? m.participants.slice(0, 3).map(p => p.name || p.email).filter(Boolean).join(', ')
        : '';
      return `- ${time} · ${m.title || 'Untitled'}${attendees ? ` (${attendees})` : ''}`;
    }).join('\n');

    const inbound = obligations.rows.filter(o => o.direction === 'inbound').slice(0, 4);
    const outbound = obligations.rows.filter(o => o.direction === 'outbound').slice(0, 4);

    const obligationLines = [
      ...(outbound.length > 0 ? ['You owe:', ...outbound.map(o => {
        const due = o.due_date ? ` (due ${new Date(o.due_date).toISOString().slice(0, 10)})` : '';
        return `- [${o.signal_type}]${due} ${(o.content || '').slice(0, 140)}`;
      })] : []),
      ...(inbound.length > 0 ? ['Waiting on:', ...inbound.map(o => {
        const due = o.due_date ? ` (due ${new Date(o.due_date).toISOString().slice(0, 10)})` : '';
        return `- [${o.signal_type}]${due} ${(o.content || '').slice(0, 140)}`;
      })] : []),
    ].join('\n') || '(none)';

    const audience = scope === 'org' ? 'the org' : 'the user';
    const todayIso = new Date().toISOString().slice(0, 10);
    const prompt = `Today's date is ${todayIso}. Write a 2-4 sentence morning brief for ${audience}. Be specific, terse, and actionable. No bullet points, no greetings, no fluff. Reference specific meeting names, attendees, and obligations by their substance — not by category.

Grounding rules (follow strictly):
- Do NOT invent or infer relative dates. Never write "yesterday", "Sunday", "this week", or any relative day unless it is literally derivable from the explicit due dates below relative to ${todayIso}.
- Each obligation's due date (if any) is shown as "(due YYYY-MM-DD)". Compare it to ${todayIso}. Anything more than 7 days past its due date is STALE — do NOT describe it as recent, current, or just-now overdue, and do NOT lead with it.
- Lead with genuinely current items: today's meetings and obligations due on or near ${todayIso}. If an item has no due date, treat it as ongoing, not overdue.${mentions.length > 0 ? '\n- If something flagged you in a meeting you did not attend, surface that.' : ''}

Today's meetings${scope === 'personal' ? " (you attended)" : ''}:
${meetingLines}
${mentionLines ? `\nMentioned but you did NOT attend:\n${mentionLines}\n` : ''}
Open obligations:
${obligationLines}

Brief:`;

    try {
      const { loadMergedConfig } = await import('../../lib/runtime/config-loader.js');
      const { createLLMClient, callProvider } = await import('../../lib/llm/provider.js');
      const config = await loadMergedConfig();
      // Haiku is fast + cheap. ~$0.0001 per brief at this prompt size.
      const llm = createLLMClient('claude-haiku-4-5-20251001', config.models);
      const response = await callProvider(llm, {
        system: 'You are a chief of staff writing a one-paragraph morning brief. No emoji, no bullets, no headers — just prose.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.4,
      });
      const brief = (response.text || '').trim();
      return {
        brief: brief || 'Brief unavailable.',
        mentions: mentions.map(m => ({ id: m.id, title: m.title, happenedAt: m.happened_at, participants: m.participants })),
        meta: {
          scope,
          meetings: meetings.rows.length,
          mentions: mentions.length,
          obligations: obligations.rows.length,
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.warn('[today-brief] LLM failed:', err.message);
      // Deterministic fallback so the page never breaks
      const mentionFrag = mentions.length > 0 ? ` · ${mentions.length} mention${mentions.length === 1 ? '' : 's'} of you` : '';
      const counts = `${meetings.rows.length} meetings${mentionFrag} · ${outbound.length} you owe · ${inbound.length} waiting on others`;
      return {
        brief: `${counts}. ${meetings.rows[0]?.title ? `First up: ${meetings.rows[0].title}.` : ''}`,
        mentions: mentions.map(m => ({ id: m.id, title: m.title, happenedAt: m.happened_at, participants: m.participants })),
        meta: {
          scope,
          meetings: meetings.rows.length,
          mentions: mentions.length,
          obligations: obligations.rows.length,
          generatedAt: new Date().toISOString(),
          fallback: true,
        },
      };
    }
  }, 600_000); // 10 min cache — briefs are expensive to regenerate

  return result || { brief: '', meta: { meetings: 0, obligations: 0 } };
});

// GET /api/metrics — Phase 1 success metrics (spec §14: all 13 targets)
// v_phase1_metrics has 13 subqueries — use a longer timeout and cache aggressively.
routes.set('GET /api/metrics', async () => {
  const result = await cachedQuery('metrics', async () => {
    const metrics = await query(`SELECT * FROM agent_graph.v_phase1_metrics`);
    return { metrics: metrics.rows[0] || null };
  }, 120_000); // 2 min cache — metrics don't change fast
  return result || { metrics: null };
});

// GET /api/stats — agent activity, budget, cost history
// Single query for agent activity (replaces v_agent_activity's 30 correlated subqueries).
routes.set('GET /api/stats', async () => {
  const result = await cachedQuery('stats', async () => {
    const agents = await query(`
      SELECT ac.id AS agent_id, ac.agent_type, ac.model,
        COALESCE(li.calls_today, 0) AS calls_today,
        COALESCE(li.cost_today_usd, 0) AS cost_today_usd,
        COALESCE(li.tokens_today, 0) AS tokens_today,
        COALESCE(wi_active.cnt, 0) AS active_tasks,
        COALESCE(wi_done.cnt, 0) AS completed_today
      FROM agent_graph.agent_configs ac
      LEFT JOIN (
        SELECT agent_id, COUNT(*) AS calls_today, SUM(cost_usd) AS cost_today_usd,
               SUM(input_tokens + output_tokens) AS tokens_today
        FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE GROUP BY agent_id
      ) li ON li.agent_id = ac.id
      LEFT JOIN (
        SELECT assigned_to, COUNT(*) AS cnt FROM agent_graph.work_items WHERE status = 'in_progress' GROUP BY assigned_to
      ) wi_active ON wi_active.assigned_to = ac.id
      LEFT JOIN (
        SELECT assigned_to, COUNT(*) AS cnt FROM agent_graph.work_items WHERE status = 'completed' AND updated_at >= CURRENT_DATE GROUP BY assigned_to
      ) wi_done ON wi_done.assigned_to = ac.id
      WHERE ac.is_active = true
    `);

    const budget = await query(`
      SELECT id, scope, scope_id, allocated_usd, spent_usd, reserved_usd,
        (allocated_usd - spent_usd - reserved_usd) AS remaining_usd,
        CASE WHEN allocated_usd > 0 THEN ROUND((spent_usd / allocated_usd) * 100, 2) ELSE 0 END AS utilization_pct,
        period_start, period_end
      FROM agent_graph.budgets WHERE period_end >= CURRENT_DATE
    `);

    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM inbox.messages WHERE received_at >= CURRENT_DATE) AS emails_received_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE processed_at >= CURRENT_DATE) AS emails_triaged_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'action_required' AND processed_at >= CURRENT_DATE) AS action_required_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'needs_response' AND processed_at >= CURRENT_DATE) AS needs_response_today,
        (SELECT COUNT(*) FROM inbox.messages WHERE triage_category = 'pending') AS emails_awaiting_triage,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND created_at >= CURRENT_DATE) AS drafts_created_today,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action IS NULL AND reviewer_verdict IS NOT NULL) AS drafts_awaiting_review,
        (SELECT COUNT(*) FROM agent_graph.action_proposals WHERE action_type = 'email_draft' AND board_action = 'approved' AND updated_at >= CURRENT_DATE) AS drafts_approved_today,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_graph.llm_invocations WHERE created_at >= CURRENT_DATE) AS cost_today_usd
    `);

    // Check halt status
    const haltResult = await query(
      `SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const haltActive = haltResult.rows.length > 0;

    // L0 exit criteria (14-day rolling edit rate + reviewed count)
    const l0 = await query(`
      SELECT
        COUNT(*) FILTER (WHERE board_action = 'edited')::int AS edited_14d,
        COUNT(*) FILTER (WHERE board_action IS NOT NULL)::int AS reviewed_14d
      FROM agent_graph.action_proposals
      WHERE acted_at >= CURRENT_DATE - interval '14 days'
    `).catch(() => ({ rows: [{ edited_14d: 0, reviewed_14d: 0 }] }));
    const l0Row = l0.rows[0] || { edited_14d: 0, reviewed_14d: 0 };
    const reviewed14d = parseInt(l0Row.reviewed_14d) || 0;
    const edited14d = parseInt(l0Row.edited_14d) || 0;
    const editRate14dPct = reviewed14d > 0 ? +(100 * edited14d / reviewed14d).toFixed(1) : 0;

    const statsRow = stats.rows[0] || {};
    statsRow.halt_active = haltActive;
    statsRow.drafts_reviewed_14d = reviewed14d;
    statsRow.edit_rate_14d_pct = editRate14dPct;

    return { agents: agents.rows, budget: budget.rows, stats: statsRow, costHistory: [] };
  });
  return result || { agents: [], budget: [], stats: null, costHistory: [] };
});

// GET /api/events — SSE stream for real-time dashboard updates
// Combines heartbeat polling (stats every 5s) with pg_notify event forwarding.
routes.set('GET /api/events', async (req, _body, res) => {
  res.writeHead(200, {
    ...getCorsHeaders(req),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');

  // STAQPRO-589 (ADR-012, Commit B): resolve the viewer principal ONCE at
  // connect. The event forwarder and the heartbeat both scope to this principal,
  // closing the live cross-tenant leak where every board client received every
  // org's events + the global daily briefing. Resolution failures behave like
  // every other scoped route: an unresolved principal sees only org-less control
  // events (halt/heartbeat) and an empty (fail-closed) briefing.
  let principal = null;
  try {
    ({ principal } = await withViewer(req));
  } catch { /* unresolved → empty principal, fail-closed below */ }
  // Per-principal cache key (identical shape to the scoped reads at api.js:1143).
  const scopeKey = !principal
    ? 'none'
    : principal.adminBypass
      ? 'admin'
      : `u:${principal.userId ?? '_'}|o:${(principal.readOrgIds || []).slice().sort().join(',')}`;

  // Forward pg_notify events to SSE clients in real-time, filtered per-org.
  let eventCleanup = null;
  let loggedUnknownOrgless = false;
  try {
    const { onAnyEvent } = await import('../lib/runtime/event-bus.js');
    const { shouldDeliverEvent, eventTypeOf } =
      await import('../../lib/runtime/state/sse-filter.js');
    eventCleanup = onAnyEvent((event) => {
      try {
        const { deliver, unknownOrgless } = shouldDeliverEvent(principal, event);
        if (unknownOrgless && !loggedUnknownOrgless) {
          // Visibility for missed org stamps: a dropped org-less, non-control
          // event means an emitter forgot to stamp owner_org_id. Fails closed
          // (no leak) but should be noticed. Log once per connection.
          loggedUnknownOrgless = true;
          console.warn(
            `[STAQPRO-589] SSE dropped org-less non-control event type=${eventTypeOf(event)} (fail-closed; emitter missing owner_org_id stamp?)`
          );
        }
        if (!deliver) return;
        res.write(`event: ${eventTypeOf(event)}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch { /* client disconnected */ }
    });
  } catch { /* event bus not available */ }

  // Heartbeat: poll for summary stats every 15s (pg_notify handles real-time
  // events). All three aggregates are scoped to the connect-time principal and
  // cached under per-principal keys so one principal can never read another's
  // scoped counts out of a shared cache bucket (fail-closed cache).
  const interval = setInterval(async () => {
    try {
      // signal.v_daily_briefing is a global-aggregate rollup with NO
      // owner_org_id column — an org predicate on it errors (42703). Scoping
      // comes from the view itself: security_invoker (migration 201) makes the
      // underlying tenant RLS apply to the caller, so post-flip each principal
      // reads counts over only its visible rows. Pre-flip the pool is
      // superuser (RLS bypassed), so org principals fail closed to null
      // instead of reading global cross-org counts. Board/adminBypass ('TRUE')
      // is entitled to the global rollup either way.
      const briefingData = await cachedQuery(`briefing:${scopeKey}`, async () => {
        const bv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
        if (bv.sql === 'FALSE') return { stats: null, briefing: null };
        const rlsEnforced = !!process.env.AUTOBOT_AGENT_DB_PASSWORD;
        if (bv.sql !== 'TRUE' && !rlsEnforced) return { stats: null, briefing: null };
        const s = await query(`SELECT * FROM signal.v_daily_briefing`);
        return { stats: s.rows[0] || null, briefing: null };
      });
      const pending = await cachedQuery(`sse_pending:${scopeKey}`, async () => {
        // action_proposals carries owner_org_id (migration 134) → org-scope the count.
        const pv = visibleClause(principal, { ownerOrgCol: 'owner_org_id', startIndex: 1 });
        const p = await query(
          `SELECT COUNT(*) AS count FROM agent_graph.action_proposals
            WHERE action_type = 'email_draft' AND reviewer_verdict IS NOT NULL
              AND board_action IS NULL AND ${pv.sql}`,
          pv.params
        );
        return parseInt(p.rows[0]?.count || '0');
      }, 10_000);
      // Pending HITL requests. campaign_hitl_requests has NO owner_org_id
      // (migration 134) → scope via JOIN to campaigns on campaigns.owner_org_id.
      const hitlPending = await cachedQuery(`sse_hitl:${scopeKey}`, async () => {
        const hv = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 1 });
        const h = await query(
          `SELECT COUNT(*) AS count
             FROM agent_graph.campaign_hitl_requests ch
             JOIN agent_graph.campaigns c ON c.id = ch.campaign_id
            WHERE ch.status = 'pending' AND ${hv.sql}`,
          hv.params
        );
        return parseInt(h.rows[0]?.count || '0');
      }, 10_000);
      res.write(`event: heartbeat\ndata: ${JSON.stringify({
        type: 'heartbeat',
        stats: briefingData.stats,
        pendingDrafts: pending,
        pendingHitl: hitlPending,
      })}\n\n`);
    } catch {
      // ignore query errors during SSE
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(interval);
    if (eventCleanup) eventCleanup();
  });
  return '__sse__'; // signal to handler not to send JSON response
});

// GET /api/debug — safe predefined queries only (dev only, no arbitrary SQL)
// No string interpolation — each table maps to a hardcoded query.
const DEBUG_TABLE_QUERIES = {
  'agent_graph.work_items': 'SELECT * FROM agent_graph.work_items ORDER BY created_at DESC LIMIT $1',
  'agent_graph.task_events': 'SELECT * FROM agent_graph.task_events ORDER BY created_at DESC LIMIT $1',
  'agent_graph.state_transitions': 'SELECT * FROM agent_graph.state_transitions ORDER BY created_at DESC LIMIT $1',
  'agent_graph.agent_configs': 'SELECT * FROM agent_graph.agent_configs ORDER BY created_at DESC LIMIT $1',
  'agent_graph.budgets': 'SELECT * FROM agent_graph.budgets ORDER BY created_at DESC LIMIT $1',
  'agent_graph.llm_invocations': 'SELECT * FROM agent_graph.llm_invocations ORDER BY created_at DESC LIMIT $1',
  'agent_graph.halt_signals': 'SELECT * FROM agent_graph.halt_signals ORDER BY created_at DESC LIMIT $1',
  'inbox.messages': 'SELECT * FROM inbox.messages ORDER BY created_at DESC LIMIT $1',
  'inbox.drafts': 'SELECT * FROM agent_graph.action_proposals ORDER BY created_at DESC LIMIT $1',
  'agent_graph.action_proposals': 'SELECT * FROM agent_graph.action_proposals ORDER BY created_at DESC LIMIT $1',
  'inbox.signals': 'SELECT * FROM inbox.signals ORDER BY created_at DESC LIMIT $1',
  'signal.contacts': 'SELECT * FROM signal.contacts ORDER BY created_at DESC LIMIT $1',
  'signal.topics': 'SELECT * FROM signal.topics ORDER BY created_at DESC LIMIT $1',
  'signal.briefings': 'SELECT * FROM signal.briefings ORDER BY created_at DESC LIMIT $1',
  'voice.edit_deltas': 'SELECT * FROM voice.edit_deltas ORDER BY created_at DESC LIMIT $1',
};
routes.set('GET /api/debug', async (req) => {
  const url = new URL(req.url, `http://localhost`);
  const table = url.searchParams.get('table');
  const sql = DEBUG_TABLE_QUERIES[table];
  if (!sql) {
    return { error: `Use ?table= with one of: ${Object.keys(DEBUG_TABLE_QUERIES).join(', ')}` };
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  const result = await query(sql, [limit]);
  return { rows: result.rows, count: result.rows.length };
});

// POST /api/inject — inject test emails into the pipeline (dev/demo only)
routes.set('POST /api/inject', async (_req, body) => {
  const isDemo = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';
  if (process.env.NODE_ENV === 'production' && !isDemo) {
    return { error: 'Inject endpoint is disabled in production' };
  }
  const { createWorkItem } = await import('./runtime/state-machine.js');
  const emails = body.emails || [];
  const results = [];

  for (const email of emails) {
    const gmailId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const threadId = `thread_${gmailId}`;

    const emailResult = await query(
      `INSERT INTO inbox.messages
       (provider_msg_id, thread_id, message_id, from_address, from_name, to_addresses, cc_addresses,
        subject, snippet, received_at, labels, has_attachments, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        gmailId, threadId, `<${gmailId}@test>`,
        email.from_address, email.from_name || 'Unknown',
        ['eric@staqs.io'], [],
        email.subject, email.snippet,
        new Date().toISOString(), email.labels || [],
        false, null,
      ]
    );

    const emailId = emailResult.rows[0]?.id;
    if (!emailId) continue;

    const workItem = await createWorkItem({
      type: 'task',
      title: `Process: ${email.subject}`,
      description: `Email from ${email.from_address}`,
      createdBy: 'orchestrator',
      assignedTo: 'executor-triage',
      priority: email.priority || 0,
      metadata: { email_id: emailId, provider_msg_id: gmailId },
    });

    if (workItem) {
      await query(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, emailId]);
      results.push({ emailId, workItemId: workItem.id, subject: email.subject });
    }
  }

  return { injected: results.length, results };
});

// POST /api/webhooks/tldv — TLDv "Transcript Ready" webhook
// Auth: header secret (Authorization: Bearer <secret> or X-Tldv-Secret), timing-safe
// comparison against TLDV_WEBHOOK_SECRET. Legacy ?secret= query param is a deprecated
// cutover-only fallback (Plan 021 — secrets must not live in URLs).
routes.set('POST /api/webhooks/tldv', async (req, body) => {
  const { handleTldvWebhook } = await import('./tldv/webhook.js');
  const url = new URL(req.url, 'http://localhost');
  return handleTldvWebhook(req, body, url);
});

// POST /api/webhooks/:source — ingest webhook events into the governed pipeline
// Auth: HMAC signature verification (per-source) OR Bearer token. Fail-closed.
routes.set('POST /api/webhooks/:source', async (req, body) => {
  const { createWorkItem } = await import('./runtime/state-machine.js');

  // Extract source from URL path
  const urlParts = new URL(req.url, 'http://localhost').pathname.split('/');
  const source = urlParts[3]; // /api/webhooks/:source

  // Validate source exists in config
  const sourceConfig = webhookSources.sources[source];
  if (!sourceConfig || !sourceConfig.enabled) {
    console.warn(`[webhook] Rejected unknown/disabled source: ${source}`);
    throw Object.assign(new Error('Invalid webhook source'), { statusCode: 400 });
  }

  // Auth: HMAC signature OR Bearer token (one must pass)
  const hmacSecretEnvKey = `WEBHOOK_SECRET_${source.toUpperCase()}`;
  const hmacSecret = process.env[hmacSecretEnvKey];

  // Per-source Bearer fallback: WEBHOOK_BEARER_<SOURCE> env var, rotatable independently of API_SECRET.
  // Used by clients (e.g. Apple Shortcut) that hold a scoped key rather than the org-wide secret.
  const sourceBearerEnvKey = `WEBHOOK_BEARER_${source.toUpperCase()}`;
  const sourceBearer = process.env[sourceBearerEnvKey];
  let sourceBearerAuthed = false;
  if (sourceBearer) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const presented = Buffer.from(authHeader.slice(7));
      const expected = Buffer.from(sourceBearer);
      if (presented.length === expected.length) {
        sourceBearerAuthed = timingSafeEqual(presented, expected);
      }
    }
  }

  const bearerAuthed = requireAuth(req) || sourceBearerAuthed;

  if (!bearerAuthed) {
    // HMAC verification path
    if (!hmacSecret) {
      // P1: fail-closed — no secret configured means no HMAC verification possible
      console.error(`[webhook] No HMAC secret configured for source: ${source} (env: ${hmacSecretEnvKey})`);
      throw Object.assign(new Error('Webhook authentication unavailable'), { statusCode: 500 });
    }

    const signatureHeader = req.headers[sourceConfig.hmacHeader.toLowerCase()] || '';
    if (!signatureHeader) {
      throw Object.assign(new Error('Missing HMAC signature header'), { statusCode: 401 });
    }

    const rawBody = req.rawBody || '';
    const computed = createHmac(sourceConfig.hmacAlgorithm, hmacSecret)
      .update(rawBody)
      .digest('hex');
    const expected = sourceConfig.hmacPrefix
      ? `${sourceConfig.hmacPrefix}${computed}`
      : computed;

    // Timing-safe comparison. Hash both sides to a fixed 32-byte digest first so
    // the length-difference branch can't leak the expected signature length to an
    // attacker (timing oracle) — timingSafeEqual requires equal-length buffers.
    const sigHash = createHash('sha256').update(String(signatureHeader)).digest();
    const expHash = createHash('sha256').update(String(expected)).digest();
    if (!timingSafeEqual(sigHash, expHash)) {
      console.warn(`[webhook] HMAC verification failed for source: ${source}`);
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
  }

  // GitHub-specific handling: route to appropriate handler by event type
  if (source === 'github') {
    const githubEvent = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];
    console.log(`[webhook] GitHub event: x-github-event=${githubEvent} delivery=${deliveryId} action=${body.action}`);
    const { handleGitHubWebhook } = await import('./github/webhook-handler.js');
    const result = await handleGitHubWebhook(githubEvent, body, createWorkItem, deliveryId);
    console.log(`[webhook] GitHub ingest result: ${JSON.stringify(result)}`);
    return result;
  }

  // Linear-specific handling: route issues + comments
  if (source === 'linear') {
    // Linear webhook payloads have type at top level (e.g. "Issue", "Comment")
    // OAuth app webhooks may omit type — detect issues by presence of data.teamId or data.stateId
    const isIssueEvent = body.type === 'Issue'
      || body.data?.teamId
      || body.data?.stateId
      || body.data?.labelIds;
    const isCommentEvent = body.type === 'Comment' || (body.data?.body && body.data?.issueId);
    console.log(`[webhook] Linear event: type=${body.type} action=${body.action} isIssue=${isIssueEvent} isComment=${isCommentEvent} keys=${Object.keys(body).join(',')}`);

    // AgentSessionEvent: Linear's Agent API — Jamie Bot was assigned/mentioned
    if (body.type === 'AgentSessionEvent') {
      const sessionId = body.agentSession?.id;
      const issueId = body.agentSession?.issueId;
      console.log(`[webhook] Linear AgentSession: action=${body.action} session=${sessionId} issue=${issueId}`);

      if (!issueId) {
        console.warn('[webhook] AgentSession missing issueId — skipping');
        return { skipped: true, reason: 'No issueId in agent session' };
      }

      // Route through ingest (not comment handler) — this is an assignment, not a comment
      const { handleLinearWebhook } = await import('./linear/ingest.js');
      const synthesizedIssue = {
        type: 'Issue',
        action: 'update',
        data: { id: issueId },
        updatedFrom: { assigneeId: null }, // triggers "delegated to" path in ingest
      };
      const result = await handleLinearWebhook(synthesizedIssue, createWorkItem);
      console.log(`[webhook] Linear AgentSession ingest result: ${JSON.stringify(result)}`);

      // Respond to Linear Agent API so Jamie Bot doesn't show "Did not respond"
      if (sessionId && process.env.LINEAR_API_KEY) {
        try {
          const workItemId = result?.workItemId || result?.id;
          const message = workItemId
            ? `Working on it — tracked as work item ${workItemId}`
            : result?.skipped ? `Already tracking this issue`
            : `Acknowledged — processing`;

          const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: process.env.LINEAR_API_KEY,
            },
            body: JSON.stringify({
              query: `mutation($sessionId: String!, $message: String!) {
                agentSessionResponse(input: { sessionId: $sessionId, message: $message }) { success }
              }`,
              variables: { sessionId, message },
            }),
          });
          const data = await res.json();
          if (data.errors) {
            // Fallback: post a comment on the issue instead
            const { addBotComment } = await import('./linear/client.js');
            await addBotComment(issueId, message);
            console.log(`[webhook] Linear AgentSession: GraphQL mutation not available, posted comment instead`);
          } else {
            console.log(`[webhook] Linear AgentSession responded: "${message}"`);
          }
        } catch (err) {
          console.warn(`[webhook] Failed to respond to Linear Agent API: ${err.message}`);
        }
      }

      return result;
    }

    if (isIssueEvent) {
      const { handleLinearWebhook } = await import('./linear/ingest.js');
      const result = await handleLinearWebhook(body, createWorkItem);
      console.log(`[webhook] Linear ingest result: ${JSON.stringify(result)}`);
      return result;
    }

    if (isCommentEvent && body.data?.body) {
      // Try comment-driven command handler first (board member /retry, /update, @Jamie)
      const { handleLinearComment } = await import('./linear/comment-handler.js');
      const commandResult = await handleLinearComment(body, createWorkItem);
      if (!commandResult.skipped) {
        console.log(`[webhook] Linear comment command result: ${JSON.stringify(commandResult)}`);
        return commandResult;
      }
      console.log(`[webhook] Linear comment no command (${commandResult.reason}) — falling back to signal`);

      // Tier 3: Comment on a Linear issue → signal-only (surfaces in briefing)
      const { ingestAsSignal } = await import('./webhooks/signal-ingester.js');
      const issueId = body.data.issueId || body.data.issue?.id;
      const result = await ingestAsSignal({
        source: 'linear',
        title: `Linear comment on ${issueId ? 'issue' : 'unknown'}`,
        snippet: String(body.data.body).slice(0, 2000),
        from: body.data.user?.name || body.data.userId || 'Linear',
        signals: [{
          signal_type: 'info',
          content: `Comment: ${String(body.data.body).slice(0, 500)}`,
          confidence: 0.7,
          direction: 'inbound',
        }],
        metadata: {
          linear_comment_id: body.data.id,
          linear_issue_id: issueId,
          webhook_source: 'linear',
        },
        labels: ['linear:comment'],
        providerMsgId: `linear_comment_${body.data.id}`,
      });
      console.log(`[webhook] Linear comment signal: ${JSON.stringify(result)}`);
      return result || { skipped: true, reason: 'Duplicate comment signal' };
    }

    return { skipped: true, reason: `Linear event type=${body.type}, not an issue or comment event` };
  }

  // Normalize payload — truncate attacker-controlled fields to prevent oversized inserts
  // Only accept string values for text fields; objects (e.g. localized string objects) would
  // produce "[object Object]" via String() coercion and corrupt stored data.
  const strField = (...fields) => fields.find(f => typeof f === 'string' && f) || null;
  const title = (strField(body.title, body.subject) || `Webhook event from ${source}`).slice(0, 500);
  const snippet = (strField(body.body, body.description, body.text) || '').slice(0, 2000) || `[${source} webhook event]`;
  const from = (strField(body.from, body.sender) || source).slice(0, 255);
  const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};
  const providerMsgId = String(body.id || body.event_id || `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 255);

  // Normalize attachments (feedback pipeline uses these for context)
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.slice(0, 10).map(a => ({
        url: String(a.url || '').slice(0, 2000),
        type: String(a.type || 'unknown').slice(0, 50),
        name: String(a.name || '').slice(0, 255),
      }))
    : [];

  // OPT-166 P3-B6: no board/agent principal on this request (generic webhook
  // fallthrough) — inbox.messages is system-writable (system_insert_messages
  // WITH CHECK is_system(), sql/200), so the INSERT and the later
  // work_item_id UPDATE both hard-fail 42501 unscoped post-flip. Fail-closed:
  // if withSystemScope throws, the handler errors (500) — no unscoped fallback.
  const sysScope = await withSystemScope('webhook-intake');
  let msgId;
  let workItem;
  try {
    // Insert message into inbox
    const msgResult = await sysScope(
      `INSERT INTO inbox.messages
       (provider_msg_id, provider, channel, thread_id, message_id,
        from_address, from_name, to_addresses, subject, snippet,
        received_at, labels, has_attachments, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (channel, channel_id) WHERE channel_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        providerMsgId, 'webhook', 'webhook',
        `wh_thread_${providerMsgId}`, `<${providerMsgId}@webhook>`,
        from, source, ['system@autobot'],
        title, snippet,
        new Date().toISOString(), [`webhook:${source}`],
        attachments.length > 0, providerMsgId,
      ]
    );

    msgId = msgResult.rows[0]?.id;
    if (!msgId) {
      // Dedup: ON CONFLICT triggered — event already processed
      console.log(`[webhook] Dedup: skipped duplicate ${source} event (providerMsgId=${providerMsgId})`);
      return { skipped: true, reason: 'Duplicate webhook event' };
    }

    // Create work item — enters standard governed pipeline
    workItem = await createWorkItem({
      type: 'task',
      title: `Webhook: ${title}`,
      description: `${source} webhook event`,
      createdBy: 'orchestrator',
      assignedTo: 'executor-triage',
      priority: 0,
      metadata: { ...metadata, email_id: msgId, provider_msg_id: providerMsgId, webhook_source: source, attachments },
    });

    if (workItem) {
      await sysScope(`UPDATE inbox.messages SET work_item_id = $1 WHERE id = $2`, [workItem.id, msgId]);
    }
  } finally {
    await sysScope.release();
  }

  return { id: msgId, workItemId: workItem?.id, source };
});

// GET /api/status — system status (derived from DB accounts, not env vars)
routes.set('GET /api/status', async () => {
  const hasClientCreds = !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
  const demoMode = process.argv.includes('--demo') || process.env.DEMO_MODE === '1';

  // Check Gmail connection from DB accounts, not env vars
  const gmailResult = await cachedQuery('status_gmail', async () => {
    const r = await query(
      `SELECT identifier FROM inbox.accounts WHERE channel = 'email' AND is_active = true LIMIT 1`
    );
    return r.rows[0] || null;
  });

  return {
    gmail_connected: !!gmailResult,
    gmail_credentials: hasClientCreds,
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    openai_configured: !!process.env.OPENAI_API_KEY,
    voyage_configured: !!process.env.VOYAGE_API_KEY,
    slack_configured: !!process.env.SLACK_BOT_TOKEN,
    demo_mode: demoMode,
    gmail_email: gmailResult?.identifier || null,
  };
});

// Compute the base URL for OAuth redirects — works locally and on Railway/cloud
function getBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = parseInt(process.env.API_PORT || '3001', 10);
  return `http://localhost:${port}`;
}

// GET /api/auth/gmail-url — generate OAuth URL for Gmail setup
// Accepts ?label= and ?owner= query params (passed through OAuth state)
// STAQPRO-318: also accepts ?accountId= for re-auth of an existing account
// whose refresh_token has been revoked / expired. When set, the callback
// rebinds the new token to the existing row and skips the setup → voice-train
// detour, since the account is already known.
routes.set('GET /api/auth/gmail-url', async (req) => {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return { error: 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env first' };
  }
  const url = new URL(req.url, getBaseUrl());
  const label = url.searchParams.get('label') || '';
  const owner = url.searchParams.get('owner') || '';
  const accountId = url.searchParams.get('accountId') || '';
  const redirectUri = `${getBaseUrl()}/api/auth/gmail-callback`;

  // STAQPRO-318: when reconnecting an existing account, look up its email so
  // we can pre-fill login_hint (forces Google to surface the same account)
  // and carry the row id through state so the callback rebinds the token.
  let reconnectEmail = null;
  let reconnectLabel = label;
  if (accountId) {
    const acct = await query(
      `SELECT identifier, label FROM inbox.accounts WHERE id = $1 AND channel = 'email' AND provider = 'gmail'`,
      [accountId],
    );
    if (acct.rows.length === 0) {
      return { error: 'Account not found' };
    }
    reconnectEmail = acct.rows[0].identifier;
    if (!reconnectLabel) reconnectLabel = acct.rows[0].label || '';
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts.other.readonly',
    ],
    state: JSON.stringify({
      label: reconnectLabel,
      owner,
      ...(accountId ? { reconnect: true, accountId, expectEmail: reconnectEmail } : {}),
    }),
    ...(reconnectEmail ? { login_hint: reconnectEmail } : {}),
  });
  return { url: authUrl };
});

// GET /api/auth/gmail-callback — OAuth callback, saves token to .env
routes.set('GET /api/auth/gmail-callback', async (req, _body, res) => {
  const url = new URL(req.url, getBaseUrl());
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    const safeError = String(error).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#ef4444">Auth Failed</h1><p>${safeError}</p><p>Close this tab and try again.</p></body></html>`);
    return '__sse__';
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body>Missing auth code</body></html>');
    return '__sse__';
  }

  try {
    const redirectUri = `${getBaseUrl()}/api/auth/gmail-callback`;
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      redirectUri
    );
    const { tokens } = await oauth2Client.getToken(code);

    // Verify the token works
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;

    // Parse state parameter for label + owner
    const stateParam = url.searchParams.get('state');
    let label = 'Gmail';
    let owner = null;
    let reconnect = false;
    let reconnectAccountId = null;
    let expectEmail = null;
    try {
      if (stateParam) {
        const state = JSON.parse(stateParam);
        label = state.label || label;
        owner = state.owner || null;
        reconnect = state.reconnect === true;
        reconnectAccountId = state.accountId || null;
        expectEmail = state.expectEmail || null;
      }
    } catch {}

    // STAQPRO-318: reconnect flow — must rebind tokens to the existing row.
    // Refuse if the newly-authed Google account doesn't match the one the user
    // was reconnecting (prevents accidentally orphaning the existing row +
    // creating a stranger row under it).
    if (reconnect && expectEmail && email.toLowerCase() !== String(expectEmail).toLowerCase()) {
      console.warn(`[api] Reconnect mismatch: expected ${expectEmail}, got ${email}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const safeExpect = String(expectEmail).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const safeGot = String(email).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#ef4444">Reconnect Mismatch</h1><p>You were reconnecting <strong>${safeExpect}</strong> but signed in as <strong>${safeGot}</strong>.</p><p>Sign out of Google in this browser and try again — Reconnect must use the same account.</p></body></html>`);
      return '__sse__';
    }

    // Save to inbox.accounts table (encrypted credentials)
    const encryptedCreds = encryptCredentials({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });

    // Resolve owner_id from board_members table
    let ownerId = null;
    if (owner) {
      const bmResult = await query(`SELECT id FROM agent_graph.board_members WHERE github_username = $1`, [owner]);
      ownerId = bmResult.rows[0]?.id || null;
    }

    let accountId;
    if (reconnect && reconnectAccountId) {
      // STAQPRO-318: rebind to the existing row — voice profile is already
      // trained, so skip the setup detour and go straight back to 'active'.
      // Clear last_error so the dashboard stops showing the failure state.
      const updateResult = await query(
        `UPDATE inbox.accounts
            SET credentials = $1,
                is_active = true,
                sync_status = 'active',
                last_error = NULL,
                updated_at = now()
          WHERE id = $2
          RETURNING id`,
        [encryptedCreds, reconnectAccountId],
      );
      accountId = updateResult.rows[0]?.id;
      if (!accountId) {
        // Row vanished between gmail-url and callback — fall back to upsert path.
        console.warn(`[api] Reconnect target ${reconnectAccountId} not found; falling back to upsert`);
        reconnect = false;
      } else {
        clearAccountsCache();
        clearAuthCache(email);
        console.log(`[api] Gmail account reconnected: ${email[0]}***@${email.split('@')[1] || '?'} (id=${accountId})`);
      }
    }
    if (!reconnect || !accountId) {
      const insertResult = await query(
        `INSERT INTO inbox.accounts (channel, provider, label, identifier, credentials, sync_status, owner, owner_id)
         VALUES ('email', 'gmail', $1, $2, $3, 'setup', $4, $5)
         ON CONFLICT (channel, provider, identifier) DO UPDATE SET
           credentials = $3, label = $1, is_active = true, sync_status = 'setup',
           owner = COALESCE($4, inbox.accounts.owner),
           owner_id = COALESCE($5, inbox.accounts.owner_id),
           updated_at = now()
         RETURNING id`,
        [label, email, encryptedCreds, owner, ownerId]
      );
      accountId = insertResult.rows[0]?.id;
      clearAccountsCache();
      clearAuthCache(email);
      console.log(`[api] Gmail account saved to DB: ${email[0]}***@${email.split('@')[1] || '?'} (setup mode)`);
    }

    // Redirect back to settings page with success params. Normalize the env
    // var: coerce to https:// when no scheme is set, and REJECT Railway
    // internal hostnames (*.railway.internal) outright — they are only
    // resolvable on the private network, so a browser redirect to one is a
    // guaranteed dead end (it ate Eric's reconnect on 2026-06-09). When the
    // env var is unusable we fall through to the inline HTML success page
    // below, which always works.
    let dashboardUrl = process.env.DASHBOARD_URL;
    if (dashboardUrl && !/^https?:\/\//i.test(dashboardUrl)) {
      dashboardUrl = `https://${dashboardUrl}`;
    }
    if (dashboardUrl) {
      try {
        const host = new URL(dashboardUrl).hostname.toLowerCase();
        if (host.endsWith('.railway.internal')) {
          console.warn(`[api] DASHBOARD_URL is a Railway-internal hostname (${host}) — unusable for browser redirects; serving inline success page. Set DASHBOARD_URL to the public board URL.`);
          dashboardUrl = null;
        }
      } catch {
        dashboardUrl = null; // unparseable env value — fall back to HTML page
      }
    }
    if (dashboardUrl) {
      const successFlag = reconnect && reconnectAccountId ? 'reconnected=true' : 'connected=true';
      res.writeHead(302, {
        Location: `${dashboardUrl.replace(/\/$/, '')}/settings?accountId=${accountId}&email=${encodeURIComponent(email)}&${successFlag}`
      });
      res.end();
    } else {
      const safeEmail = String(email).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#22c55e">Gmail Connected!</h1><p>Account <strong>${safeEmail}</strong> linked successfully.</p><p>Account ID: ${accountId}</p><p>Next: call <code>POST /api/voice/bootstrap?accountId=${accountId}</code> to train voice profiles, then <code>POST /api/accounts/${accountId}/activate</code> to start polling.</p></body></html>`);
    }
    return '__sse__';
  } catch (err) {
    console.error('[api] Gmail OAuth error:', err.message);
    const safeErr = String(err.message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="background:#0a0a0f;color:#e4e4e7;font-family:system-ui;padding:60px;text-align:center"><h1 style="color:#ef4444">Token Exchange Failed</h1><p>${safeErr}</p><p>Close this tab and try again.</p></body></html>`);
    return '__sse__';
  }
});

// GET /api/debug/pipeline — show work items, events, transitions (dev only)
// 30s TTL safety net — event-driven invalidation handles freshness via startCacheInvalidationListener()
routes.set('GET /api/debug/pipeline', async () => {
  const result = await cachedQuery('pipeline', async () => {
    const workItems = await query(
      `WITH recent AS (
        SELECT w.id, w.type, w.title, w.status, w.assigned_to, w.created_by, w.metadata, w.created_at, w.updated_at,
               m.channel AS message_channel, a.label AS account_label
        FROM agent_graph.work_items w
        LEFT JOIN inbox.messages m ON m.id = (w.metadata->>'email_id')
        LEFT JOIN inbox.accounts a ON a.id = m.account_id
        ORDER BY w.updated_at DESC LIMIT 20
      ),
      demo AS (
        SELECT w.id, w.type, w.title, w.status, w.assigned_to, w.created_by, w.metadata, w.created_at, w.updated_at,
               NULL::text AS message_channel, NULL::text AS account_label
        FROM agent_graph.work_items w
        WHERE w.assigned_to IN ('executor-redesign', 'executor-blueprint')
        ORDER BY w.updated_at DESC LIMIT 10
      )
      SELECT * FROM recent
      UNION
      SELECT * FROM demo
      ORDER BY updated_at DESC`
    );
    const events = await query(
      `SELECT event_id, event_type, work_item_id, target_agent_id, processed_at, created_at
       FROM agent_graph.task_events ORDER BY created_at DESC LIMIT 30`
    );
    const transitions = await query(
      `SELECT id, work_item_id, from_state, to_state, agent_id, reason, created_at
       FROM agent_graph.state_transitions ORDER BY created_at DESC LIMIT 20`
    );
    return { work_items: workItems.rows, events: events.rows, transitions: transitions.rows };
  }, 30_000);
  return result || { work_items: [], events: [], transitions: [] };
});

// GET /api/board — Kanban view (ADR-001/002/003)
const BOARD_LANE_CAP = 50;
// ADR-003: completed lane is recency-scoped so stale items don't dominate the board.
const BOARD_COMPLETED_WINDOW = '14 days';
// ADR-002: open needs-attention rows older than this are treated as stale.
const BOARD_ATTENTION_WINDOW = '30 days';
const BOARD_CACHE_TTL_MS = 30_000;

const BOARD_WORK_ITEM_COLUMNS =
  'id, type, title, status, assigned_to, created_by, created_at, updated_at';

function _firstLine(s) {
  if (!s) return '';
  const idx = s.indexOf('\n');
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

function toWorkItemCard(row) {
  return {
    kind: 'work_item',
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    assigned_to: row.assigned_to,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toProposalCard(row) {
  const title = row.subject && String(row.subject).trim().length > 0
    ? row.subject
    : _firstLine(row.body) || 'Untitled proposal';
  return {
    kind: 'proposal',
    id: row.id,
    title,
    action_type: row.action_type,
    work_item_id: row.work_item_id,
    created_at: row.created_at,
  };
}

function toAttentionCard(row) {
  const reason = row.payload && typeof row.payload === 'object'
    ? row.payload.reason
    : null;
  return {
    kind: 'attention',
    id: String(row.id),
    title: reason || 'Attention required',
    signature: row.signature,
    work_item_id: row.work_item_id,
    created_at: row.created_at,
  };
}

async function fetchFlowingWorkItems() {
  const result = await query(
    `SELECT ${BOARD_WORK_ITEM_COLUMNS}
     FROM agent_graph.work_items
     WHERE type IN ('directive', 'workstream')
       AND status IN ('assigned', 'in_progress', 'review')
     ORDER BY updated_at DESC`
  );
  return result.rows;
}

async function fetchCreatedWorkItems() {
  const result = await query(
    `SELECT ${BOARD_WORK_ITEM_COLUMNS}
     FROM agent_graph.work_items
     WHERE type IN ('directive', 'workstream')
       AND status = 'created'
     ORDER BY updated_at DESC
     LIMIT ${BOARD_LANE_CAP}`
  );
  return result.rows;
}

async function fetchCompletedWorkItems() {
  const result = await query(
    `SELECT ${BOARD_WORK_ITEM_COLUMNS}
     FROM agent_graph.work_items
     WHERE type IN ('directive', 'workstream')
       AND status = 'completed'
       AND updated_at >= now() - interval '${BOARD_COMPLETED_WINDOW}'
     ORDER BY updated_at DESC
     LIMIT ${BOARD_LANE_CAP}`
  );
  return result.rows;
}

async function fetchPendingProposals() {
  const result = await query(
    `SELECT id, subject, body, action_type, work_item_id, created_at
     FROM agent_graph.action_proposals
     WHERE board_action IS NULL
     ORDER BY created_at DESC`
  );
  return result.rows;
}

async function fetchOpenAttention() {
  const result = await query(
    `SELECT id, signature, work_item_id, payload, created_at
     FROM agent_graph.needs_attention_log
     WHERE acknowledged_at IS NULL
       AND created_at >= now() - interval '${BOARD_ATTENTION_WINDOW}'
     ORDER BY created_at DESC`
  );
  return result.rows;
}

// Human tasks (PRD: meeting-actions-to-kanban §11.2). Excludes terminal
// statuses (skipped, not_for_us) and respects the 14-day completed window
// for done. Status-to-lane bucketing happens in toHumanTaskCard + the
// dispatcher below.
async function fetchHumanTasks() {
  const result = await query(
    `SELECT id, signal_id, message_id, source_quote,
            title, description, due_date, priority, size,
            assignee_contact_id, assignee_label, assignee_confidence,
            status, snoozed_until,
            task_type, project_id, engagement_id, tags,
            next_action_hint, related_contact_ids,
            relevance_score, extraction_confidence,
            last_feedback, last_feedback_at,
            created_at, updated_at
       FROM inbox.human_tasks
      WHERE deleted_at IS NULL
        AND status NOT IN ('skipped', 'not_for_us')
        AND (status <> 'done' OR updated_at >= now() - interval '${BOARD_COMPLETED_WINDOW}')
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                      WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
        due_date NULLS LAST,
        updated_at DESC
      LIMIT 200`
  );
  return result.rows;
}

function emptyBoardLanes() {
  return {
    needs_you: [], created: [], assigned: [], in_progress: [], review: [], completed: [],
  };
}

export async function getBoard(_req) {
  const result = await cachedQuery('board', async () => {
    const [flowing, created, completed, proposals, attentions, humanTasks] = await Promise.all([
      fetchFlowingWorkItems(),
      fetchCreatedWorkItems(),
      fetchCompletedWorkItems(),
      fetchPendingProposals(),
      fetchOpenAttention(),
      fetchHumanTasks(),
    ]);

    const lanes = emptyBoardLanes();
    lanes.created = created.map(toWorkItemCard);
    lanes.completed = completed.map(toWorkItemCard);

    for (const row of flowing) {
      const lane = lanes[row.status];
      if (lane) lane.push(toWorkItemCard(row));
    }

    lanes.needs_you = [
      ...proposals.map(toProposalCard),
      ...attentions.map(toAttentionCard),
    ];

    appendHumanTasksToLanes(lanes, humanTasks);

    return { lanes };
  }, BOARD_CACHE_TTL_MS);

  return result || { lanes: emptyBoardLanes() };
}

routes.set('GET /api/board', getBoard);

// Human-tasks routes (PRD: meeting-actions-to-kanban §11, v0.2 tech-spec
// FR-3/FR-18/FR-27/FR-28/FR-29). The board surface uses /api/board; these
// endpoints are the cards' own CRUD + lifecycle + sticky-aware PATCH.
registerHumanTaskRoutes(routes, { withViewer }); // STAQPRO-608: org-scope /api/human-tasks

// --------------------------------------------------------------------------
// Skip-with-reason for /board "Needs you" lane (ADR-005, migration 111)
// --------------------------------------------------------------------------

// Duplicate of api-routes/needs-attention.js#requireBoard — that helper is
// module-private and lifting it into a 1-file shared module isn't worth the
// ceremony for v1. Collapse when a 3rd caller appears.
function requireBoard(req) {
  if (!req.auth || req.auth.role !== 'board') {
    const e = new Error('Board role required');
    e.statusCode = 403;
    throw e;
  }
}

function resolveBoardIdentity(req) {
  return req.auth?.github_username || req.auth?.sub || 'unknown';
}

function normalizeReason(body) {
  return typeof body?.reason === 'string' && body.reason.trim().length > 0
    ? body.reason
    : null;
}

// Returns the captured :id segment, or null if the URL does not match the
// /api/board/<segment>/:id/skip shape.
function parseBoardSkipId(url, segment) {
  const pathname = new URL(url, 'http://localhost').pathname;
  const re = new RegExp(`^/api/board/${segment}/([^/]+)/skip$`);
  const m = pathname.match(re);
  return m ? m[1] : null;
}

export async function skipProposal(req, body) {
  requireBoard(req);

  const id = parseBoardSkipId(req.url, 'proposals');
  if (!id) {
    const e = new Error('Invalid proposal id'); e.statusCode = 400; throw e;
  }

  const reason = normalizeReason(body);
  const actedBy = resolveBoardIdentity(req);

  const existing = await query(
    `SELECT id, board_action FROM agent_graph.action_proposals WHERE id = $1`,
    [id]
  );
  if (existing.rows.length === 0) {
    const e = new Error('proposal not found'); e.statusCode = 404; throw e;
  }
  // Preserve non-skip verdicts: only null or an existing 'skipped' may be
  // overwritten with another skip (re-skip is idempotent).
  const currentAction = existing.rows[0].board_action;
  if (currentAction !== null && currentAction !== 'skipped') {
    const e = new Error('proposal already acted on'); e.statusCode = 409; throw e;
  }

  const updated = await query(
    `UPDATE agent_graph.action_proposals
        SET board_action = 'skipped',
            board_notes  = $2,
            acted_at     = now(),
            acted_by     = $3,
            updated_at   = now()
      WHERE id = $1
      RETURNING id, board_action, board_notes, acted_at, acted_by`,
    [id, reason, actedBy]
  );

  _cache.delete('board');
  _cache.delete('drafts');

  return {
    ok: true,
    id,
    board_action: updated.rows[0].board_action,
    board_notes: updated.rows[0].board_notes,
    acted_at: updated.rows[0].acted_at,
    acted_by: updated.rows[0].acted_by,
  };
}
routes.set('POST /api/board/proposals/:id/skip', skipProposal);

export async function skipAttention(req, body) {
  requireBoard(req);

  const idStr = parseBoardSkipId(req.url, 'attention');
  if (!idStr) {
    const e = new Error('Invalid attention id'); e.statusCode = 400; throw e;
  }
  const id = Number.parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    const e = new Error('Invalid attention id'); e.statusCode = 400; throw e;
  }

  const reason = normalizeReason(body);
  const ackedBy = resolveBoardIdentity(req);

  // Re-ack is idempotent — do NOT filter by acknowledged_at IS NULL here.
  const existing = await query(
    `SELECT id FROM agent_graph.needs_attention_log WHERE id = $1`,
    [id]
  );
  if (existing.rows.length === 0) {
    const e = new Error('attention row not found'); e.statusCode = 404; throw e;
  }

  const updated = await query(
    `UPDATE agent_graph.needs_attention_log
        SET acknowledged_at       = now(),
            acknowledged_by       = $2,
            acknowledgment_reason = $3
      WHERE id = $1
      RETURNING id, acknowledged_at, acknowledged_by, acknowledgment_reason`,
    [id, ackedBy, reason]
  );

  _cache.delete('board');

  return {
    ok: true,
    id: updated.rows[0].id,
    acknowledged_at: updated.rows[0].acknowledged_at,
    acknowledged_by: updated.rows[0].acknowledged_by,
    acknowledgment_reason: updated.rows[0].acknowledgment_reason,
  };
}
routes.set('POST /api/board/attention/:id/skip', skipAttention);

// POST /api/auth/gmail-disconnect — clear Gmail token
routes.set('POST /api/auth/gmail-disconnect', async () => {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, 'utf-8');
    envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
    envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
    envContent = envContent.replace(/\n{3,}/g, '\n\n'); // clean up blank lines
    writeFileSync(envPath, envContent);
  }
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.GMAIL_USER_EMAIL;
  console.log('[api] Gmail disconnected');
  return { ok: true };
});

// POST /api/halt — trigger HALT
routes.set('POST /api/halt', async (_req, body) => {
  const raw = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const reason = raw || 'Board triggered HALT via dashboard';
  await emitHalt(reason);
  return { ok: true, message: 'HALT signal emitted', reason };
});

// POST /api/resume — clear HALT
routes.set('POST /api/resume', async () => {
  await clearHalt();
  return { ok: true, message: 'HALT cleared, agents resuming' };
});

// GET /api/halt-status — current halt state
routes.set('GET /api/halt-status', async () => {
  const halted = await isHalted();
  return { halted };
});

// GET /api/inbox — recent emails with triage status (direct query, no view)
routes.set('GET /api/inbox', async (req) => {
  // OPT-166 P3: deny-by-default tenant scoping. Previously this read
  // inbox.messages with no WHERE, so a bare api_secret (no board viewer) saw
  // every org's mail. inbox.messages has permissive RLS (read USING(true)), so
  // the STAQPRO-263 flip does NOT filter it — visibleClause is the only tenant
  // boundary. Unidentified caller → principal null-userId/empty-orgs → 'FALSE'
  // → zero rows; verified agent-JWT (adminBypass) → 'TRUE'; board viewer → own
  // + org rows. Cache key is per-principal so one caller can't warm another's.
  const { principal, viewer } = await withViewer(req);
  const scopeKey = viewer?.adminBypass
    ? '__admin__'
    : `u:${principal?.userId ?? '_'}|o:${(principal?.readOrgIds || []).slice().sort().join(',')}`;
  const scope = visibleClause(principal, { ownerOrgCol: 'm.owner_org_id', startIndex: 1 });
  const result = await cachedQuery(`inbox:${scopeKey}`, async () => {
    const r = await query(`
      SELECT m.id, m.provider_msg_id, m.from_address, m.from_name, m.subject, m.snippet,
        m.received_at, m.triage_category, m.priority_score,
        m.channel, m.account_id,
        a.label AS account_label,
        (m.processed_at IS NOT NULL) AS is_processed
      FROM inbox.messages m
      LEFT JOIN inbox.accounts a ON a.id = m.account_id
      WHERE ${scope.sql}
      ORDER BY m.received_at DESC LIMIT 50
    `, scope.params);
    return { emails: r.rows };
  });
  return result || { emails: [] };
});

// GET /api/board-members — list all board members
routes.set('GET /api/board-members', async () => {
  const result = await query(
    `SELECT id, github_username, display_name, email, telegram_id, role, is_active, created_at
     FROM agent_graph.board_members WHERE is_active = true ORDER BY created_at`
  );
  return { members: result.rows };
});

const VALID_BOARD_ROLES = ['admin', 'member', 'external_agent'];

// POST /api/board-members/:id/role — update a board member's role (admin only)
routes.set('POST /api/board-members/role', async (req, body) => {
  await requireBoardAdmin(req);
  const { memberId, role: newRole } = body || {};
  if (!memberId || !newRole) {
    throw Object.assign(new Error('memberId and role required'), { statusCode: 400 });
  }
  if (!VALID_BOARD_ROLES.includes(newRole)) {
    throw Object.assign(new Error(`Invalid role. Must be: ${VALID_BOARD_ROLES.join(', ')}`), { statusCode: 400 });
  }
  await query(
    `UPDATE agent_graph.board_members SET role = $1, updated_at = now() WHERE id = $2`,
    [newRole, memberId]
  );
  console.log('Board member role updated', { memberId, newRole, changedBy: req.auth?.sub });
  return { ok: true, memberId, role: newRole };
});

// POST /api/board-members — create or reactivate a board member (admin only)
routes.set('POST /api/board-members', async (req, body) => {
  await requireBoardAdmin(req);
  const { display_name, github_username, email, role } = body || {};
  if (!display_name || !github_username || !role) {
    throw Object.assign(new Error('display_name, github_username, and role required'), { statusCode: 400 });
  }
  if (!VALID_BOARD_ROLES.includes(role)) {
    throw Object.assign(new Error(`Invalid role. Must be: ${VALID_BOARD_ROLES.join(', ')}`), { statusCode: 400 });
  }
  const r = await query(
    `INSERT INTO agent_graph.board_members (github_username, display_name, email, role, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (github_username) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       email        = EXCLUDED.email,
       role         = EXCLUDED.role,
       is_active    = true,
       updated_at   = now()
     RETURNING id, github_username, display_name, email, telegram_id, role, is_active, created_at`,
    [github_username, display_name, email || null, role]
  );
  console.log('Board member created', { memberId: r.rows[0].id, github_username, createdBy: req.auth?.sub });
  return { ok: true, member: r.rows[0] };
});

// PATCH /api/board-members/:id — update mutable fields (admin only)
routes.set('PATCH /api/board-members/:id', async (req, body) => {
  await requireBoardAdmin(req);
  const url = new URL(req.url, 'http://localhost');
  const memberId = url.pathname.split('/').pop();
  if (!memberId) {
    throw Object.assign(new Error('memberId required'), { statusCode: 400 });
  }
  const allowed = ['display_name', 'email', 'github_username'];
  const setFragments = [];
  const values = [];
  for (const field of allowed) {
    if (body && Object.prototype.hasOwnProperty.call(body, field)) {
      values.push(body[field]);
      setFragments.push(`${field} = $${values.length}`);
    }
  }
  if (setFragments.length === 0) {
    throw Object.assign(new Error('No mutable fields provided'), { statusCode: 400 });
  }
  values.push(memberId);
  const r = await query(
    `UPDATE agent_graph.board_members
     SET ${setFragments.join(', ')}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING id, github_username, display_name, email, telegram_id, role, is_active, created_at`,
    values
  );
  if (r.rows.length === 0) {
    throw Object.assign(new Error('Board member not found'), { statusCode: 404 });
  }
  console.log('Board member updated', { memberId, fields: Object.keys(body || {}), changedBy: req.auth?.sub });
  return { ok: true, member: r.rows[0] };
});

// DELETE /api/board-members/:id — soft delete (admin only, refuses self-delete)
routes.set('DELETE /api/board-members/:id', async (req) => {
  const callerId = await requireBoardAdmin(req);
  const url = new URL(req.url, 'http://localhost');
  const memberId = url.pathname.split('/').pop();
  if (!memberId) {
    throw Object.assign(new Error('memberId required'), { statusCode: 400 });
  }
  if (callerId && callerId === memberId) {
    throw Object.assign(new Error('Cannot remove yourself'), { statusCode: 400 });
  }
  const r = await query(
    `UPDATE agent_graph.board_members
     SET is_active = false, updated_at = now()
     WHERE id = $1 AND is_active = true
     RETURNING id`,
    [memberId]
  );
  if (r.rows.length === 0) {
    throw Object.assign(new Error('Board member not found'), { statusCode: 404 });
  }
  console.log('Board member soft-deleted', { memberId, removedBy: req.auth?.sub });
  return { ok: true, memberId };
});

// GET /api/accounts — list configured accounts with sync status.
//
// STAQPRO-531: scope is SERVER-DERIVED from the authed viewer. A board member
// sees only their OWN accounts + org-SHARED infra. The raw client `?owner=` is
// IGNORED for non-bypass viewers (no `?owner=victim` enumeration). Only an
// explicit internal caller (agent JWT, adminBypass) sees all accounts and may
// target a specific member via `?owner=`. The cache key folds in the viewer so
// one member's list can never be served from another member's bucket.
routes.set('GET /api/accounts', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const viewer = await resolveViewerEmails(req);
  const githubUsername = req.auth?.github_username || null;

  // Fail-closed: unidentified/unresolved callers (no viewer, or a bare shared
  // secret with no x-board-user and no resolved ownerId) see nothing.
  if (!viewer || (!viewer.adminBypass && !viewer.ownerId && !githubUsername)) {
    return { accounts: [] };
  }

  if (viewer.adminBypass) {
    // Internal/agent path: full org view, honoring an optional ?owner= target.
    const ownerFilter = url.searchParams.get('owner');
    const safeOwner = ownerFilter && /^[a-zA-Z0-9_@.+-]+$/.test(ownerFilter) ? ownerFilter : null;
    const cacheKey = safeOwner ? `accounts:owner:${safeOwner}` : 'accounts:__admin__';
    const result = await cachedQuery(cacheKey, async () => {
      const r = safeOwner
        ? await query(
            `SELECT id, channel, label, identifier, is_active, last_sync_at, sync_status, last_error, owner, created_at
             FROM inbox.accounts WHERE owner = $1 ORDER BY created_at`, [safeOwner])
        : await query(
            `SELECT id, channel, label, identifier, is_active, last_sync_at, sync_status, last_error, owner, created_at
             FROM inbox.accounts ORDER BY created_at`);
      return { accounts: r.rows };
    }, 30_000);
    return result || { accounts: [] };
  }

  // Identified board member: own ∪ org-shared only. Client ?owner= cannot widen.
  const cacheKey = `accounts:${accountsCacheKey(viewer, githubUsername)}`;
  const result = await cachedQuery(cacheKey, async () => {
    const r = await query(
      `SELECT id, channel, label, identifier, is_active, last_sync_at, sync_status, last_error, owner, created_at
         FROM inbox.accounts
        WHERE owner_id = $1 OR owner = $2 OR (owner_id IS NULL AND owner IS NULL)
        ORDER BY created_at`,
      [viewer.ownerId, githubUsername]
    );
    return { accounts: r.rows };
  }, 30_000);
  return result || { accounts: [] };
});

// POST /api/voice/bootstrap — run voice training for a newly connected account
routes.set('POST /api/voice/bootstrap', async (_req, body) => {
  const { accountId, sampleSize } = body;
  if (!accountId) return { error: 'accountId required' };

  const authClient = await getAuthForAccount(accountId);
  const contactsSynced = await syncGoogleContacts(authClient).catch(err => {
    console.warn('[voice/bootstrap] Contacts sync failed (non-fatal):', err.message);
    return 0;
  });

  // Import sent emails for voice training (default 500 for better profile quality)
  const importCount = sampleSize || 500;
  const imported = await bootstrapSentEmails(importCount, authClient);

  // Build account-scoped profiles (was missing accountId — caused weak G3 scores)
  const profile = await buildGlobalProfile(accountId);
  await buildRecipientProfiles(accountId);

  // Also rebuild legacy/unscoped profiles for backward compat
  await buildGlobalProfile();
  await buildRecipientProfiles();

  let embeddingsGenerated = 0;
  if (hasEmbeddingProvider()) {
    embeddingsGenerated = await generateEmbeddings(importCount);
  }

  // Activate the account (setup → pending) so the poller picks it up
  await query(
    `UPDATE inbox.accounts SET sync_status = 'pending', updated_at = now() WHERE id = $1 AND sync_status = 'setup'`,
    [accountId]
  );
  clearAccountsCache();

  return { imported, contactsSynced, profile: !!profile, embeddingsGenerated, sampleSize: importCount };
});

// POST /api/voice/rebuild — rebuild all voice profiles with edit delta corrections
routes.set('POST /api/voice/rebuild', async () => {
  const stats = await rebuildAllProfiles();
  return { ok: true, ...stats };
});

// GET /api/voice/profiles — all voice profiles (global + per-recipient)
routes.set('GET /api/voice/profiles', async () => {
  const result = await query(
    `SELECT scope, scope_key, greetings, closings, formality_score, avg_length, sample_count, last_updated
     FROM voice.profiles
     ORDER BY scope, scope_key`
  );
  return { profiles: result.rows };
});

// GET /api/voice/edits — recent edit deltas + 14-day edit rate
routes.set('GET /api/voice/edits', async () => {
  const edits = await query(
    `SELECT edit_type, edit_magnitude, recipient, subject, created_at
     FROM voice.edit_deltas
     ORDER BY created_at DESC
     LIMIT 20`
  );
  const editRate = await getEditRate(14);
  return { edits: edits.rows, editRate };
});

// POST /api/contacts/sync — import Google Contacts into signal.contacts
routes.set('POST /api/contacts/sync', async (_req, body) => {
  const { accountId } = body;
  const count = await syncGoogleContacts(null, accountId || null);
  _cache.delete('signals');
  _cache.delete('signals_feed');
  return { ok: true, synced: count };
});

// POST /api/accounts/activate — skip voice training and activate account
routes.set('POST /api/accounts/activate', async (req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  // STAQPRO-531: viewer-first → fetch → 404 → 403 → mutate. Ownership-denied and
  // not-found must THROW with statusCode (the dispatcher only upgrades HTTP status
  // for thrown errors; a returned { statusCode } object still goes out as 200).
  const viewer = await resolveViewerEmails(req);
  const acct = await query(`SELECT owner, owner_id FROM inbox.accounts WHERE id = $1`, [accountId]);
  if (acct.rows.length === 0) {
    throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  }
  if (!mayManageAccount(viewer, req.auth?.github_username || null, acct.rows[0])) {
    throw Object.assign(new Error('Forbidden: account belongs to another board member'), { statusCode: 403 });
  }

  const result = await query(
    `UPDATE inbox.accounts SET sync_status = 'pending', updated_at = now() WHERE id = $1 AND sync_status = 'setup' RETURNING id`,
    [accountId]
  );
  clearAccountsCache();

  if (result.rows.length === 0) return { error: 'Account not found or not in setup state' };
  return { ok: true, accountId: result.rows[0].id };
});

// GET /api/auth/gmail — start OAuth flow for adding a new Gmail account
routes.set('GET /api/auth/gmail', async (req) => {
  const url = new URL(req.url, `http://localhost`);
  const label = url.searchParams.get('label') || 'Gmail';
  const owner = url.searchParams.get('owner') || null;
  const authUrl = getAuthUrl(label, owner);
  return { url: authUrl };
});

// GET /api/voice/status — voice training state for settings page
routes.set('GET /api/voice/status', async () => {
  const result = await cachedQuery('voice_status', async () => {
    const sentResult = await query(`SELECT COUNT(*) AS cnt FROM voice.sent_emails`);
    const sentEmails = parseInt(sentResult.rows[0]?.cnt || '0', 10);

    const embResult = await query(`SELECT COUNT(*) AS cnt FROM voice.sent_emails WHERE embedding IS NOT NULL`);
    const embeddingsGenerated = parseInt(embResult.rows[0]?.cnt || '0', 10);

    const profileResult = await query(
      `SELECT sample_count, formality_score, last_updated FROM voice.profiles WHERE scope = 'global' LIMIT 1`
    );
    const globalProfile = profileResult.rows[0]
      ? { sampleCount: Number(profileResult.rows[0].sample_count), formality: Number(profileResult.rows[0].formality_score), lastUpdated: profileResult.rows[0].last_updated }
      : null;

    const recipientResult = await query(`SELECT COUNT(*) AS cnt FROM voice.profiles WHERE scope = 'recipient'`);
    const recipientProfiles = parseInt(recipientResult.rows[0]?.cnt || '0', 10);

    const deltaResult = await query(`SELECT COUNT(*) AS cnt FROM voice.edit_deltas`);
    const editDeltas = parseInt(deltaResult.rows[0]?.cnt || '0', 10);

    const embeddingProvider = process.env.VOYAGE_API_KEY ? 'voyage' : process.env.OPENAI_API_KEY ? 'openai' : null;

    return { sentEmails, embeddingsGenerated, globalProfile, recipientProfiles, editDeltas, embeddingProvider };
  });
  return result || { sentEmails: 0, embeddingsGenerated: 0, globalProfile: null, recipientProfiles: 0, editDeltas: 0, embeddingProvider: null };
});

// POST /api/accounts/disconnect — deactivate a specific account
routes.set('POST /api/accounts/disconnect', async (req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  // STAQPRO-531: viewer-first → fetch → 404 → 403 → mutate. Denied/not-found
  // must THROW (the dispatcher only upgrades HTTP status for thrown errors).
  const viewer = await resolveViewerEmails(req);
  const acct = await query(`SELECT owner, owner_id FROM inbox.accounts WHERE id = $1`, [accountId]);
  if (acct.rows.length === 0) {
    throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  }
  if (!mayManageAccount(viewer, req.auth?.github_username || null, acct.rows[0])) {
    throw Object.assign(new Error('Forbidden: account belongs to another board member'), { statusCode: 403 });
  }

  const result = await query(
    `UPDATE inbox.accounts SET is_active = false, updated_at = now() WHERE id = $1 RETURNING identifier`,
    [accountId]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  }

  const identifier = result.rows[0].identifier;

  // If this account matches the default env var email, clear env vars too
  if (identifier && identifier === process.env.GMAIL_USER_EMAIL) {
    const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
      envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
      envContent = envContent.replace(/\n{3,}/g, '\n\n');
      writeFileSync(envPath, envContent);
    }
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_USER_EMAIL;
  }

  clearAccountsCache();
  _cache.delete('status');
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  for (const k of _cache.keys()) if (k === 'briefing' || k.startsWith('briefing:')) _cache.delete(k);
  return { ok: true, identifier };
});

// POST /api/accounts/delete — permanently remove an account and its associated data
routes.set('POST /api/accounts/delete', async (req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  // STAQPRO-531: viewer-first → fetch → 404 → 403 → mutate, BEFORE the cascading
  // delete (this drops messages/signals/drafts). Denied/not-found must THROW (the
  // dispatcher only upgrades HTTP status for thrown errors).
  const viewer = await resolveViewerEmails(req);
  const acct = await query(`SELECT identifier, owner, owner_id FROM inbox.accounts WHERE id = $1`, [accountId]);
  if (acct.rows.length === 0) {
    throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  }
  if (!mayManageAccount(viewer, req.auth?.github_username || null, acct.rows[0])) {
    throw Object.assign(new Error('Forbidden: account belongs to another board member'), { statusCode: 403 });
  }
  const identifier = acct.rows[0].identifier;

  // Delete associated data in dependency order (children before parents)
  await query(`DELETE FROM inbox.signals WHERE message_id IN (SELECT id FROM inbox.messages WHERE account_id = $1)`, [accountId]);
  await query(`DELETE FROM agent_graph.action_proposals WHERE message_id IN (SELECT id FROM inbox.messages WHERE account_id = $1)`, [accountId]);
  await query(`DELETE FROM agent_graph.action_proposals WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.sync_state WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.messages WHERE account_id = $1`, [accountId]);
  await query(`DELETE FROM inbox.accounts WHERE id = $1`, [accountId]);

  // Clear env vars if this was the default account
  if (identifier && identifier === process.env.GMAIL_USER_EMAIL) {
    const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, '');
      envContent = envContent.replace(/^GMAIL_USER_EMAIL=.*$/m, '');
      envContent = envContent.replace(/\n{3,}/g, '\n\n');
      writeFileSync(envPath, envContent);
    }
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_USER_EMAIL;
  }

  clearAccountsCache();
  _cache.delete('status');
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  for (const k of _cache.keys()) if (k === 'briefing' || k.startsWith('briefing:')) _cache.delete(k);
  return { ok: true, identifier, deleted: true };
});

// POST /api/accounts/resync — reset sync state so next poll re-fetches recent emails
routes.set('POST /api/accounts/resync', async (req, body) => {
  const { accountId } = body;
  if (!accountId) return { error: 'accountId required' };

  // STAQPRO-531: viewer-first → fetch → 404 → 403 → mutate. Denied/not-found
  // must THROW (the dispatcher only upgrades HTTP status for thrown errors).
  const viewer = await resolveViewerEmails(req);
  const acct = await query(
    `SELECT id, identifier, owner, owner_id FROM inbox.accounts WHERE id = $1 AND is_active = true`, [accountId]
  );
  if (acct.rows.length === 0) {
    throw Object.assign(new Error('Account not found or inactive'), { statusCode: 404 });
  }
  if (!mayManageAccount(viewer, req.auth?.github_username || null, acct.rows[0])) {
    throw Object.assign(new Error('Forbidden: account belongs to another board member'), { statusCode: 403 });
  }

  await query(`DELETE FROM inbox.sync_state WHERE account_id = $1`, [accountId]);

  clearAccountsCache();
  _cache.delete('inbox');
  _cache.delete('pipeline');
  _cache.delete('signals');
  _cache.delete('signals_feed');
  for (const k of _cache.keys()) if (k === 'briefing' || k.startsWith('briefing:')) _cache.delete(k);

  return { ok: true, message: 'Sync reset — re-fetching on next poll' };
});

// POST /api/settings/keys — set API keys via UI (writes to .env)
routes.set('POST /api/settings/keys', async (_req, body) => {
  const { key, value } = body;
  const ALLOWED_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'SLACK_BOT_TOKEN']);
  if (!key || !ALLOWED_KEYS.has(key)) return { error: `Invalid key. Allowed: ${[...ALLOWED_KEYS].join(', ')}` };
  if (!value || typeof value !== 'string' || value.length < 8) return { error: 'Value must be a string of at least 8 characters' };

  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
  }

  writeFileSync(envPath, envContent);
  process.env[key] = value;

  return { ok: true };
});

// GET /api/contacts/:id — single contact with projects, identities, signals,
// and organization context. Signals query follows ALL email identities (not
// just the primary email) so a person who writes from multiple addresses
// shows their unified history.
routes.set('GET /api/contacts/:id', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.pathname.split('/').pop();

  // STAQPRO-588 (ADR-012 M-C): single-contact read was previously unscoped — any
  // authenticated caller could fetch any contact by id (the per-row form of the
  // /api/contacts leak). Scope the base contacts row c by the tenancy predicate.
  // $1 = id; visibleClause params follow (startIndex: 2). Unresolved principal →
  // 'FALSE' → no row → "Contact not found" (fail-closed). The downstream
  // identities/projects/signals reads below are keyed by this contact id, so they
  // only return data once the parent contact has passed the scope check.
  const { principal } = await withViewer(req);
  if (!principal) return { error: 'Contact not found' };
  const v = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 2 });
  const contactResult = await query(
    `SELECT c.*, v.relationship_strength,
            o.id   AS org_resolved_id,
            o.name AS org_resolved_name,
            o.slug AS org_resolved_slug,
            o.org_type AS org_resolved_type
       FROM signal.contacts c
       LEFT JOIN signal.v_contact_strength v ON v.id = c.id
       -- ADR-012 §11 DoD#5 (STAQPRO-588): signal.organizations is JOINed for the
       -- org name/slug/type of a contact the viewer is ALREADY authorized to see.
       -- The scope predicate is on c.owner_org_id in the WHERE, so this LEFT JOIN
       -- cannot widen the contact set — it only annotates an in-scope row. Decision:
       -- ACCEPT (no restricted projection needed); the org row surfaced is, by
       -- construction, the org of a contact already inside the tenant boundary.
       LEFT JOIN signal.organizations o ON o.id = c.organization_id
      WHERE c.id = $1 AND ${v.sql}`,
    [id, ...v.params],
  );
  if (contactResult.rows.length === 0) {
    return { error: 'Contact not found' };
  }
  const contact = contactResult.rows[0];

  const identitiesResult = await query(
    `SELECT id, channel, identifier, label, verified_at, stale_after, source, metadata, created_at
       FROM signal.contact_identities WHERE contact_id = $1 ORDER BY created_at`,
    [id],
  );

  const projectsResult = await query(
    `SELECT * FROM signal.contact_projects WHERE contact_id = $1 AND is_active = true ORDER BY is_primary DESC, created_at`,
    [id],
  );

  // Cross-identity signals: pull everything sent from any email identity
  // bound to this contact, not just contact.email_address.
  const signalsResult = await query(
    `SELECT s.id, s.signal_type, s.content, s.confidence, s.due_date,
            s.resolved, s.resolved_at, s.direction, s.domain, s.created_at,
            m.subject, m.channel, m.from_address
       FROM inbox.signals s
       JOIN inbox.messages m ON m.id = s.message_id
      WHERE lower(m.from_address) IN (
        SELECT identifier FROM signal.contact_identities
         WHERE contact_id = $1 AND channel = 'email'
      )
      ORDER BY s.created_at DESC LIMIT 20`,
    [id],
  );

  return {
    contact,
    identities: identitiesResult.rows,
    projects: projectsResult.rows,
    signals: signalsResult.rows,
  };
});

// POST /api/contacts/:id/projects — add a project to a contact
routes.set('POST /api/contacts/:id/projects', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2]; // /api/contacts/:id/projects

  const { project_name, platform, locator, platform_config, is_primary } = body;
  if (!project_name || !platform || !locator) {
    return { error: 'project_name, platform, and locator are required' };
  }
  const validPlatforms = ['github', 'shopify', 'wordpress', 'vercel', 'linear', 'database', 'other'];
  if (!validPlatforms.includes(platform)) {
    return { error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}` };
  }

  const result = await query(
    `INSERT INTO signal.contact_projects (contact_id, project_name, platform, locator, platform_config, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contact_id, platform, locator)
     DO UPDATE SET is_active = true, updated_at = now()
     RETURNING *`,
    [contactId, project_name, platform, locator, platform_config || '{}', is_primary || false]
  );

  return { project: result.rows[0] };
});

// POST /api/contacts/:id/projects/remove — soft-delete a project
routes.set('POST /api/contacts/:id/projects/remove', async (_req, body) => {
  const { projectId } = body;
  if (!projectId) {
    return { error: 'projectId is required' };
  }

  const result = await query(
    `UPDATE signal.contact_projects SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`,
    [projectId]
  );
  if (result.rows.length === 0) {
    return { error: 'Project not found' };
  }
  return { project: result.rows[0] };
});

// GET /api/contacts — list all contacts with identities and projects
// NOTE(STAQPRO-531): signal.contacts is org-shared relationship data with no per-owner
// column (UNIQUE on email_address; schema comment in sql/001-baseline.sql confirms
// "org-wide, not siloed"). It is therefore gated to authenticated board members rather
// than truly per-viewer scoped: an unidentified/unresolved caller (bare shared secret,
// no x-board-user) gets an EMPTY list — never global rows.
// OPT-72: Per-viewer prioritization — the same org-shared rows are returned for every
// viewer, but ordered and annotated by the requesting viewer's personal interaction
// history derived from inbox.messages. No migration required: affinity is computed
// inline from existing message data. No per-viewer data is exposed — only the shared
// contact row is returned; the ordering signal is derived from the viewer's own
// messages, never exposing another viewer's personal correspondence.
// TODO(opt-166-p3): mixed principal — withViewer()/resolveViewerEmails() maps
// verified agent-JWT callers (req.auth.source === 'agent_jwt') to
// adminBypass: true (a currently-working, non-board caller; see api.js
// resolveViewerEmails). withBoardScope() THROWS for any req.auth.role !==
// 'board', so wrapping this handler would break that caller pre-flip
// (INERT-rule violation). Left unscoped intentionally; signal.contacts
// RLS-flip coverage for the agent-JWT path must come from a different
// mechanism than withBoardScope.
routes.set('GET /api/contacts', async (req) => {
  // STAQPRO-588 (ADR-012 M-C): THE documented cross-tenant leak. Previously any
  // identified board member got ALL contacts (Dustin saw Eric's). Now the read is
  // scoped by the tenancy predicate: own ∪ org-shared ∪ federation. Agents
  // (adminBypass) still get TRUE (full org-wide). An unidentified/unresolved caller
  // resolves to an empty principal → visibleClause → 'FALSE' → zero rows (fail-closed).
  const { viewer, principal } = await withViewer(req);
  if (!principal) return { contacts: [] };
  const v = visibleClause(principal, { ownerOrgCol: 'c.owner_org_id', startIndex: 1 });

  // OPT-72 (perf fix): Derive per-viewer affinity via a single-pass CTE.
  // BEFORE: two correlated subqueries per contact row (viewer_affinity + viewer_engaged)
  //   PLUS a third correlated subquery in the ORDER BY — O(contacts × messages).
  // AFTER: one CTE scans inbox.messages ONCE, pre-filtered to only the viewer's own
  //   messages (from_address = viewer email OR viewer email in to/cc). For each such
  //   message the "other party" email is derived, then GROUP BY gives affinity counts.
  //   The contacts query LEFT JOINs the CTE result — O(viewer_messages + contacts).
  // Fail-safe: when viewerEmails is empty (adminBypass / no accounts) the CTE WHERE
  //   clause is always false → zero rows → all affinity 0 → global order preserved.
  // No cross-viewer leak: the CTE is parameterized on $N (viewer's own emails),
  //   server-derived by resolveViewerEmails, never request-supplied.
  const viewerEmails = (!viewer || viewer.adminBypass) ? [] : (viewer.emails || []);

  // Placeholder index after visibleClause params. visibleClause params come first
  // (startIndex: 1), so viewer emails param is at v.nextIndex.
  const emailsParamIdx = v.nextIndex;
  const params = [...v.params, viewerEmails];

  const result = await query(
    `WITH viewer_affinity AS (
       -- Single scan of inbox.messages, pre-filtered to only the viewer's messages.
       -- For inbound messages (contact → viewer): other_email = from_address.
       -- For outbound messages (viewer → contact): other_email = each to/cc address
       --   that is NOT one of the viewer's own addresses.
       -- Groups by other_email to produce (other_email, affinity_count).
       -- When $${emailsParamIdx}::text[] is empty, the WHERE is always false → zero rows.
       SELECT lower(other_email) AS other_email, COUNT(*)::int AS affinity_count
       FROM (
         -- inbound: viewer received a message from someone else
         SELECT lower(m.from_address) AS other_email
         FROM inbox.messages m
         WHERE EXISTS (
           SELECT 1 FROM unnest(
             COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])
           ) AS addr WHERE lower(addr) = ANY($${emailsParamIdx}::text[])
         )
           AND NOT (lower(m.from_address) = ANY($${emailsParamIdx}::text[]))
         UNION ALL
         -- outbound: viewer sent a message to someone else
         SELECT lower(addr) AS other_email
         FROM inbox.messages m,
              unnest(COALESCE(m.to_addresses, ARRAY[]::text[]) || COALESCE(m.cc_addresses, ARRAY[]::text[])) AS addr
         WHERE lower(m.from_address) = ANY($${emailsParamIdx}::text[])
           AND NOT (lower(addr) = ANY($${emailsParamIdx}::text[]))
       ) sub
       GROUP BY lower(other_email)
     )
     SELECT c.id, c.email_address, c.name, c.contact_type, c.is_vip,
            c.phone, c.default_repos, c.emails_received, c.emails_sent,
            c.last_received_at, c.created_at, c.organization, c.tier, c.notes,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ci.id, 'channel', ci.channel, 'identifier', ci.identifier)) FROM signal.contact_identities ci WHERE ci.contact_id = c.id), '[]'::jsonb) AS identities,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', cp.id, 'project_name', cp.project_name, 'platform', cp.platform, 'locator', cp.locator, 'is_primary', cp.is_primary)) FROM signal.contact_projects cp WHERE cp.contact_id = c.id AND cp.is_active = true), '[]'::jsonb) AS projects,
            -- OPT-72: affinity from pre-computed CTE join — no per-row subquery.
            COALESCE(va.affinity_count, 0) AS viewer_affinity,
            -- viewer_engaged: true iff the viewer has any correspondence with this contact
            (va.other_email IS NOT NULL) AS viewer_engaged
     FROM signal.contacts c
     LEFT JOIN viewer_affinity va ON lower(c.email_address) = va.other_email
     WHERE ${v.sql}
     ORDER BY
       -- OPT-72: viewer's most-engaged contacts first; tie-break by global recency.
       -- Uses the already-joined CTE value — no third subquery in ORDER BY.
       COALESCE(va.affinity_count, 0) DESC,
       COALESCE(c.last_received_at, c.created_at) DESC
     LIMIT 200`,
    params
  );
  return { contacts: result.rows };
});

// POST /api/contacts/classify — auto-classify contacts by email frequency and patterns
routes.set('POST /api/contacts/classify', async () => {
  // Inbound email counts per sender
  const inboundResult = await query(
    `SELECT lower(from_address) AS email, COUNT(*)::int AS cnt
     FROM inbox.messages
     WHERE direction = 'inbound' AND from_address IS NOT NULL
     GROUP BY lower(from_address)`
  );
  const inboundMap = new Map();
  for (const row of inboundResult.rows) {
    inboundMap.set(row.email, row.cnt);
  }

  // Outbound email counts per recipient
  const outboundResult = await query(
    `SELECT lower(addr) AS email, COUNT(*)::int AS cnt
     FROM inbox.messages, unnest(to_addresses) AS addr
     WHERE direction = 'outbound' AND to_addresses IS NOT NULL
     GROUP BY lower(addr)`
  );
  const outboundMap = new Map();
  for (const row of outboundResult.rows) {
    outboundMap.set(row.email, row.cnt);
  }

  // All contacts
  const contactsResult = await query(
    `SELECT id, email_address, contact_type, tier FROM signal.contacts WHERE email_address IS NOT NULL`
  );

  const automatedPattern = /no-reply|mailer-daemon|postmaster|bounce|auto-?reply|daemon/i;
  const newsletterPattern = /noreply|newsletter|notifications?|updates?@|digest@|news@|info@|marketing@/i;
  const serviceDomains = new Set([
    'github.com', 'linear.app', 'vercel.com', 'railway.app',
    'stripe.com', 'slack.com', 'notion.so', 'figma.com', 'sentry.io'
  ]);

  let updated = 0;
  for (const contact of contactsResult.rows) {
    const email = contact.email_address.toLowerCase();
    const inbound = inboundMap.get(email) || 0;
    const outbound = outboundMap.get(email) || 0;
    const total = inbound + outbound;
    const domain = email.split('@')[1] || '';

    let newTier = contact.tier;
    let newType = contact.contact_type;

    // Classify tier by email pattern
    if (automatedPattern.test(email)) {
      newTier = 'automated';
    } else if (newsletterPattern.test(email)) {
      newTier = 'newsletter';
    } else if (total >= 10) {
      newTier = 'inner_circle';
    } else if (total >= 5) {
      newTier = 'active';
    } else if (inbound > 0 && outbound === 0) {
      newTier = 'inbound_only';
    }

    // Classify type for known service domains
    if (serviceDomains.has(domain)) {
      newType = 'service';
    }

    // Only update if something changed
    if (newTier !== contact.tier || newType !== contact.contact_type) {
      await query(
        `UPDATE signal.contacts SET tier = $1, contact_type = $2, updated_at = now() WHERE id = $3`,
        [newTier, newType, contact.id]
      );
      updated++;
    }
  }

  return { classified: updated, total: contactsResult.rows.length };
});

// POST /api/contacts/:id — update contact fields (enrichment)
routes.set('POST /api/contacts/:id', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.pathname.split('/').pop();
  const { name, contact_type, tier, is_vip, phone, default_repos, organization, notes, vip_reason } = body;

  // Validate phone format if provided (empty string = clear)
  if (phone && !/^\+[1-9]\d{1,14}$/.test(phone)) {
    return { error: 'Phone must be E.164 format (e.g. +14155551234)' };
  }

  // Validate tier against the DB CHECK constraint (sql/085-add-inactive-tier.sql).
  // Catches typos before they round-trip to Postgres as 23514 errors.
  const VALID_TIERS = ['inner_circle', 'active', 'inactive', 'inbound_only', 'newsletter', 'automated', 'unknown'];
  if (tier !== undefined && tier !== null && tier !== '' && !VALID_TIERS.includes(tier)) {
    return { error: `Invalid tier "${tier}". Must be one of: ${VALID_TIERS.join(', ')}` };
  }

  // Validate contact_type against the DB CHECK constraint (sql/056-rag-participants.sql).
  const VALID_CONTACT_TYPES = [
    'cofounder', 'board', 'investor', 'team', 'advisor', 'customer', 'prospect',
    'partner', 'vendor', 'legal', 'accountant', 'recruiter', 'service',
    'newsletter', 'participant', 'unknown',
  ];
  if (contact_type !== undefined && contact_type !== null && contact_type !== '' && !VALID_CONTACT_TYPES.includes(contact_type)) {
    return { error: `Invalid contact_type "${contact_type}". Must be one of: ${VALID_CONTACT_TYPES.join(', ')}` };
  }

  // Validate default_repos format if provided
  if (default_repos && !Array.isArray(default_repos)) {
    return { error: 'default_repos must be an array' };
  }
  if (default_repos) {
    for (const r of default_repos) {
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(r)) {
        return { error: `Invalid repo format: ${r}. Use owner/repo.` };
      }
    }
  }

  // Build SET clauses dynamically — only update fields that were sent.
  // Distinguishes "not sent" (undefined → keep existing) from "sent empty" (clear it).
  const setClauses = ['updated_at = now()'];
  const params = [id];
  let paramIdx = 2;

  if (name !== undefined) { setClauses.push(`name = $${paramIdx++}`); params.push(name || null); }
  if (contact_type !== undefined) { setClauses.push(`contact_type = $${paramIdx++}`); params.push(contact_type || 'unknown'); }
  if (tier !== undefined) { setClauses.push(`tier = $${paramIdx++}`); params.push(tier || 'unknown'); }
  if (is_vip !== undefined) { setClauses.push(`is_vip = $${paramIdx++}`); params.push(is_vip); }
  if (phone !== undefined) { setClauses.push(`phone = $${paramIdx++}`); params.push(phone || null); }
  if (default_repos !== undefined) { setClauses.push(`default_repos = $${paramIdx++}`); params.push(default_repos); }
  if (organization !== undefined) { setClauses.push(`organization = $${paramIdx++}`); params.push(organization || null); }
  if (notes !== undefined) { setClauses.push(`notes = $${paramIdx++}`); params.push(notes || null); }
  if (vip_reason !== undefined) { setClauses.push(`vip_reason = $${paramIdx++}`); params.push(vip_reason || null); }

  if (setClauses.length === 1) {
    return { error: 'No fields to update' };
  }

  const result = await query(
    `UPDATE signal.contacts SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    return { error: 'Contact not found' };
  }
  return { contact: result.rows[0] };
});

// DELETE /api/contacts/:id — hard-delete a contact card.
// CASCADE removes signal.contact_identities + signal.contact_projects.
// Does NOT remove emails, transcripts, or RAG documents — those are independent
// content chains (inbox.messages, content.documents, voice.sent_emails) that may
// involve other people. Any retrieval-surface redaction is handled separately
// and is out of scope for this route.
routes.set('DELETE /api/contacts/:id', async (req) => {
  await requireBoardAdmin(req);
  const url = new URL(req.url, 'http://localhost');
  const id = url.pathname.split('/').pop();
  const result = await query(
    `DELETE FROM signal.contacts WHERE id = $1
     RETURNING id, email_address, name`,
    [id]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Contact not found'), { statusCode: 404 });
  }
  return { deleted: result.rows[0] };
});

// GET /api/github/repos — list accessible repos for repo picker
routes.set('GET /api/github/repos', async () => {
  if (!process.env.GITHUB_TOKEN && !process.env.GITHUB_APP_ID) {
    return { error: 'GitHub credentials not configured (GITHUB_TOKEN or GITHUB_APP_ID)' };
  }
  const { listAccessibleRepos } = await import('./github/issues.js');
  const repos = await listAccessibleRepos();
  return { repos };
});

// ── Entity Resolution (GitHub #56) ──

// GET /api/contacts/:id/identities — list identities for a contact
routes.set('GET /api/contacts/:id/identities', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2]; // /api/contacts/:id/identities
  const result = await query(
    `SELECT id, channel, identifier, label, verified_at, stale_after, source, created_at
     FROM signal.contact_identities WHERE contact_id = $1 ORDER BY channel, created_at`,
    [contactId]
  );
  return { identities: result.rows };
});

// POST /api/contacts/:id/identities — add an identity to a contact
routes.set('POST /api/contacts/:id/identities', async (req, body) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const contactId = parts[parts.length - 2];
  const { channel, identifier, label, source } = body;
  if (!channel || !identifier) return { error: 'channel and identifier required' };
  try {
    // Check if identity already belongs to a different contact (P3: no silent ownership theft)
    const existing = await query(
      `SELECT id, contact_id FROM signal.contact_identities WHERE channel = $1 AND identifier = $2`,
      [channel, identifier]
    );
    if (existing.rows.length > 0 && existing.rows[0].contact_id !== contactId) {
      return { error: `Identity ${channel}:${identifier} already belongs to contact ${existing.rows[0].contact_id}. Use merge to combine contacts.` };
    }

    const result = await query(
      `INSERT INTO signal.contact_identities (contact_id, channel, identifier, label, source, verified_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (channel, identifier) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [contactId, channel, identifier, label || null, source || 'manual']
    );
    return { ok: true, id: result.rows[0]?.id };
  } catch (err) {
    return { error: err.message };
  }
});

// POST /api/contacts/:id/split-identities — STAQPRO-308 Phase 2
//
// Move N identities off a source contact into a brand-new contact. The inverse
// of /api/contacts/merge. Linus pre-implementation review notes baked in:
//   - Strict board-admin auth (no X-Board-User header escape; closes the
//     forged-identity hole that /api/contacts/merge still has).
//   - performed_by is sourced strictly from the verified JWT identity.
//   - Validation lives at both layers: HTTP returns 400 with a helpful
//     message; the SQL function re-checks under FOR UPDATE.
routes.set('POST /api/contacts/:id/split-identities', async (req, body) => {
  await requireBoardAdmin(req);
  const performedBy = req.auth?.github_username;
  if (!performedBy) {
    throw Object.assign(new Error('split-identities requires a verified board JWT (github_username) for audit'), { statusCode: 403 });
  }

  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const sourceId = parts[parts.length - 2]; // /api/contacts/:id/split-identities

  const { identityIds, newContact, reason } = body || {};
  if (!Array.isArray(identityIds) || identityIds.length === 0) {
    return { error: 'identityIds (non-empty array) required' };
  }
  if (!newContact || typeof newContact !== 'object') {
    return { error: 'newContact object required' };
  }
  const { name, primaryEmail, organization, contactType, tier } = newContact;
  if (!name || !primaryEmail) {
    return { error: 'newContact.name and newContact.primaryEmail required' };
  }
  if (!reason || typeof reason !== 'string') {
    return { error: 'reason required for audit' };
  }

  try {
    const result = await query(
      `SELECT signal.split_contact_identities($1::text, $2::text[], $3, $4, $5, $6, $7, $8, $9) AS result`,
      [
        sourceId,
        identityIds,
        name,
        primaryEmail,
        organization || null,
        contactType || 'unknown',
        tier || 'active',
        reason,
        performedBy,
      ]
    );
    return result.rows[0]?.result || { error: 'Split failed' };
  } catch (err) {
    return { error: err.message };
  }
});

// POST /api/contacts/merge — merge two contacts into one (hard merge — existing function)
routes.set('POST /api/contacts/merge', async (req, body) => {
  const { primaryId, secondaryId, reason } = body;
  if (!primaryId || !secondaryId) return { error: 'primaryId and secondaryId required' };
  if (primaryId === secondaryId) return { error: 'Cannot merge a contact with itself' };
  const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'board';
  try {
    const result = await query(
      `SELECT signal.merge_contacts($1, $2, $3, $4) AS result`,
      [primaryId, secondaryId, reason || 'manual merge', boardUser]
    );
    return result.rows[0]?.result || { error: 'Merge failed' };
  } catch (err) {
    return { error: err.message };
  }
});

// POST /api/contacts/auto-merge — OPT-81: run the scored auto-merge pass.
// SOFT merge only — sets merged_into, no hard deletes. Reversible via
// POST /api/contacts/:id/unmerge. Optional body: { dryRun: true } to preview.
routes.set('POST /api/contacts/auto-merge', async (req, body) => {
  const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'auto_merge_pass';
  const dryRun = body?.dryRun === true;
  try {
    const { runAutoMergePass } = await import('../../lib/signal/contact-auto-merge.js');
    const result = await runAutoMergePass(query, { performedBy: boardUser, dryRun });
    return { ok: true, ...result };
  } catch (err) {
    return { error: err.message };
  }
});

// POST /api/contacts/:id/unmerge — OPT-81: reverse a soft auto-merge.
// Restores merged_into=NULL and re-points identities back to the secondary.
routes.set('POST /api/contacts/:id/unmerge', async (req) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 2]; // /api/contacts/:id/unmerge
  const boardUser = req.auth?.github_username || req.headers?.['x-board-user'] || 'board';
  try {
    const result = await query(
      `SELECT signal.unmerge_contacts($1, $2) AS result`,
      [id, boardUser],
    );
    return result.rows[0]?.result || { error: 'Unmerge failed' };
  } catch (err) {
    return { error: err.message };
  }
});

// GET /api/contacts/duplicates — find potential duplicate contacts.
//
// Three signals, each independent:
//   1. Strong name match alone (sim > 0.7)
//   2. Soft name match + same organization_id (post-080 FK)
//   3. Soft name match + shared email domain across any of their identities
//      (catches the "Eric Gang at staqs vs Eric Gang at umbadvisors" case
//      that the org-text-only heuristic missed)
//
// `match_reason` column tells the UI which signal fired so it can render
// the appropriate badge.
routes.set('GET /api/contacts/duplicates', async () => {
  const result = await query(`
    WITH pairs AS (
      SELECT
        c1.id AS id_a, c1.name AS name_a, c1.email_address AS email_a,
        c2.id AS id_b, c2.name AS name_b, c2.email_address AS email_b,
        similarity(COALESCE(c1.name,''), COALESCE(c2.name,'')) AS name_sim,
        c1.organization_id AS org_a,
        c2.organization_id AS org_b
      FROM signal.contacts c1
      JOIN signal.contacts c2 ON c1.id < c2.id
      WHERE similarity(COALESCE(c1.name,''), COALESCE(c2.name,'')) > 0.4
    )
    SELECT
      p.*,
      CASE
        WHEN p.name_sim > 0.7 THEN 'strong_name'
        WHEN p.org_a IS NOT NULL AND p.org_a = p.org_b THEN 'shared_org'
        WHEN EXISTS (
          SELECT 1
            FROM signal.contact_identities i1
            JOIN signal.contact_identities i2
              ON split_part(i1.identifier, '@', 2) = split_part(i2.identifier, '@', 2)
           WHERE i1.contact_id = p.id_a
             AND i2.contact_id = p.id_b
             AND i1.channel = 'email' AND i2.channel = 'email'
             AND split_part(i1.identifier, '@', 2) <> ''
        ) THEN 'shared_domain'
        ELSE NULL
      END AS match_reason
    FROM pairs p
    WHERE
         p.name_sim > 0.7
      OR (p.org_a IS NOT NULL AND p.org_a = p.org_b)
      OR EXISTS (
        SELECT 1
          FROM signal.contact_identities i1
          JOIN signal.contact_identities i2
            ON split_part(i1.identifier, '@', 2) = split_part(i2.identifier, '@', 2)
         WHERE i1.contact_id = p.id_a
           AND i2.contact_id = p.id_b
           AND i1.channel = 'email' AND i2.channel = 'email'
           AND split_part(i1.identifier, '@', 2) <> ''
      )
    ORDER BY name_sim DESC
    LIMIT 50
  `);
  return { duplicates: result.rows };
});

// GET /api/github/activity — STAQPRO-532: surface agent-authored GitHub PR/issue activity
// as a first-class read-only board view. No new ingestion pipeline — this reads the
// existing queryable stores that the GitHub webhook handler already maintains:
//   - agent_graph.action_proposals (action_type='code_fix_pr') for PRs, whose lifecycle
//     is fully derivable from send_state/board_action (the webhook handler flips
//     send_state→'delivered' + board_action→'approved' on PR-merged, →'cancelled' on close).
//   - agent_graph.issue_triage_log for inbound GitHub-sourced issue triage activity.
// Org-level dev data with no per-owner column → mayReadOrgShared-gated exactly like
// /api/contacts and the /api/signals contacts block (STAQPRO-531/540 scoping discipline).
// Unidentified/unresolved callers (bare shared secret, no x-board-user) get empty arrays,
// never global rows. Cached (cachedQuery) so repeated board polls don't re-scan.
//
// STAQPRO-588 (ADR-012 M-C): intentionally NOT migrated to visibleClause. The backing
// tables (agent_graph.action_proposals, agent_graph.issue_triage_log) are org-level
// dev artifacts and migration 134 deliberately did NOT add owner_user_id/owner_org_id
// to agent_graph.*. There is no owner column to scope on; the mayReadOrgShared gate is
// the correct boundary for this org-wide view. Do NOT clone visibleClause here against
// non-existent columns — it would break the query for every caller (fail-closed but
// also fail-useful). TODO(STAQPRO-589): if agent_graph dev artifacts ever become
// per-tenant, add owner columns + visibleClause then.
routes.set('GET /api/github/activity', async (req) => {
  const viewer = await resolveViewerEmails(req);
  // adminBypass (agent JWT) and identified board members may read org-shared dev activity.
  if (!mayReadOrgShared(viewer)) {
    return { pull_requests: [], issue_events: [], counts: { open: 0, merged: 0, closed: 0, issues: 0 } };
  }

  const data = await cachedQuery('github_activity', async () => {
    const [prs, issues] = await Promise.all([
      // Agent-authored PRs (executor-coder / claw-* store the PR via webhook-handler).
      // status is derived: send_state 'delivered' (board_action approved) = merged,
      // 'cancelled' = closed, anything else with a PR URL = open.
      query(`
        SELECT id, subject, body, github_pr_url, github_pr_number, target_repo,
               linear_issue_url, campaign_id, send_state, board_action,
               reviewer_verdict, created_at, updated_at
        FROM agent_graph.action_proposals
        WHERE action_type = 'code_fix_pr'
          AND github_pr_url IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 100
      `),
      // Recent GitHub-sourced issue triage activity (issue webhooks land here).
      query(`
        SELECT id, source, source_issue_id, source_issue_url, title,
               clarity_score, scope_estimate, classification, decision,
               decision_overridden_by, decision_overridden_at, created_at
        FROM agent_graph.issue_triage_log
        WHERE source = 'github'
        ORDER BY created_at DESC
        LIMIT 50
      `),
    ]);

    let openCount = 0, mergedCount = 0, closedCount = 0;
    const pull_requests = prs.rows.map((row) => {
      let status;
      if (row.send_state === 'delivered' || row.board_action === 'approved') {
        status = 'merged';
        mergedCount++;
      } else if (row.send_state === 'cancelled' || row.board_action === 'rejected') {
        status = 'closed';
        closedCount++;
      } else {
        status = 'open';
        openCount++;
      }
      return {
        id: row.id,
        title: row.subject || `PR #${row.github_pr_number}`,
        status,
        github_pr_url: row.github_pr_url,
        github_pr_number: row.github_pr_number,
        target_repo: row.target_repo,
        linear_issue_url: row.linear_issue_url,
        campaign_id: row.campaign_id,
        reviewer_verdict: row.reviewer_verdict,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    const issue_events = issues.rows.map((row) => ({
      id: row.id,
      title: row.title,
      source_issue_url: row.source_issue_url,
      source_issue_id: row.source_issue_id,
      classification: row.classification,
      scope_estimate: row.scope_estimate,
      clarity_score: row.clarity_score,
      decision: row.decision,
      resolved: row.decision_overridden_by != null,
      resolved_by: row.decision_overridden_by,
      created_at: row.created_at,
    }));

    return {
      pull_requests,
      issue_events,
      counts: {
        open: openCount,
        merged: mergedCount,
        closed: closedCount,
        issues: issue_events.length,
      },
    };
  });

  return data || { pull_requests: [], issue_events: [], counts: { open: 0, merged: 0, closed: 0, issues: 0 } };
});

// Register modular route handlers
registerGateRoutes(routes);
registerFinanceRoutes(routes);
registerAuditRoutes(routes);
registerConstitutionalRoutes(routes);
registerPhaseRoutes(routes);
registerRunnerRoutes(routes);
registerDistributionRoutes(routes);
registerValueRoutes(routes);
registerGovernanceRoutes(routes, cachedQuery);
registerPublicArchiveRoutes(routes);
registerResearchRoutes(routes);
registerRedesignRoutes(routes);
registerFrontDoorRoutes(routes);
registerIntentRoutes(routes, { withViewer });
registerDecisionRoutes(routes);
registerBlueprintRoutes(routes);
registerSpecGraphRoutes(routes);
registerCampaignRoutes(routes, cachedQuery, _cache, { withViewer });
registerProjectRoutes(routes, { withViewer });
registerEngagementsRoutes(routes, { withViewer }); // STAQPRO-618: org-scope + owner-stamp engagements
registerTriageRoutes(routes);
registerActivityRoutes(routes, { withViewer }); // STAQPRO-608 r2a: org-scope /api/activity
registerTraceRoutes(routes);
registerPipelineRoutes(routes, cachedQuery, { withViewer }); // OPT-166 P3: org-scope /api/pipeline/timeline message read
registerTrustRoutes(routes);
registerRunRoutes(routes, cachedQuery, { withViewer }); // STAQPRO-597: org-scope /api/runs
registerCronRoutes(routes);
registerAgentRoutes(routes, getCorsHeaders);
registerDocumentRoutes(routes, cachedQuery, { withViewer }); // STAQPRO-608: org-scope /api/documents
registerVoiceMemoRoutes(routes);
registerTranscriptRoutes(routes);
registerMeetingsRoutes(routes, { withViewer });
registerMeetingRegistryRoutes(routes, { withViewer }); // Feature 007: meeting hierarchy reads + personal→org promote
registerCalendarRoutes(routes, { withViewer, resolveViewerEmails }); // STAQPRO-608 org-scope + OPT-126 per-member watch/event scoping
registerVoicePrintsRoutes(routes, { withViewer }); // STAQPRO-608: org-scope /api/voice-prints
registerOrganizationsRoutes(routes, { withViewer }); // STAQPRO-608: org-scope /api/organizations
registerTenancyOrgsRoutes(routes, { withViewer }); // owning-org picker source: tenancy.orgs ∩ caller memberships (capture-source owner_org_id)
registerDealsRoutes(routes, { withViewer }); // STAQPRO-608 r2a: org-scope /api/deals
registerRelationshipsRoutes(routes, { withViewer }); // STAQPRO-608 r2b: org-scope /api/contacts/:id/strength + /api/relationship-health
registerProvenanceRoutes(routes, { withViewer }); // OPT-2: org-scope /api/provenance/:source_meeting_id (meeting→signal→ticket chain)
registerSearchRoutes(routes);
registerIngestRoutes(routes, cachedQuery, { withViewer }); // STAQPRO-611: token-derived ownership + anti-abuse
registerArtifactRoutes(routes, cachedQuery, { withViewer }); // OPT-92: artifact registry (token-derived ownership + anti-abuse + fail-closed reads)
registerCaptureSourceRoutes(routes, cachedQuery, { withViewer, resolveImpersonationEmail }); // OPT-96/OPT-101: board-human writes, org-scoped reads, server-derived owner_email + org-membership check
registerDrivePickerRoutes(routes, { resolveImpersonationEmail }); // OPT-101: GET /api/drive/shared-drives + GET /api/drive/folders (board-human, server-derived impersonation)
registerSlackProjectMapRoutes(routes, { query }); // OPT-46: POST/GET/DELETE /api/slack/project-map (org-shared, board-human writes)
registerBoardAuthRoutes(routes);
registerCustomerAuthRoutes(routes, query, { withViewer }); // OPT-37: board-human mint/revoke, org-scoped list. NOTE: pass the RAW query — customer-auth.js calls query(sql, params) directly; cachedQuery has the (key, queryFn, ttl) signature and would treat the params array as a thunk ("queryFn is not a function").
registerBoardRoutes(routes);
registerActionRoutes(routes);
registerServiceRoutes(routes);
registerResearchSourceRoutes(routes, { withViewer }); // STAQPRO-608 r2a: org-scope /api/feeds + /api/research-sources
registerPreferencesRoutes(routes);
registerSharingRoutes(routes, { withViewer }); // ADR-017: knowledge share grants (create/accept/decline/revoke/list)
registerNeedsAttentionRoutes(routes);
registerFlowRoutes(routes, { withViewer });
registerContentRoutes(routes, { withViewer });
registerSigningRoutes(routes);
registerContractRoutes(routes, { withViewer });
registerCounterpartyRoutes(routes, { withViewer }); // STAQPRO-608 r2a: org-scope /api/counterparties
registerBrandProfileRoutes(routes);
registerWeeklyRecapRoutes(routes);
registerGuardrailRoutes(routes);
registerBackfillRoutes(routes);

// /today + /linear surfaces (v0.2 tech-spec §4.1, FR-16/FR-24/FR-26/FR-34..36).
// The Linear client/team are lazily resolved at call-time so endpoints
// degrade gracefully when LINEAR_API_KEY / LINEAR_TEAM_ID aren't set —
// tests and dev environments don't need to wire mocks for /today/tasks.
//
// _linearClient is populated by src/index.js after wireLinearV2() succeeds.
// When the runtime never wired Linear (env missing, satellite, tests),
// the getter returns null and the /api/linear/* handlers throw the
// 412 Precondition Failed they're designed to throw.
let _linearClient = null;
export function setLinearClient(client) {
  _linearClient = client || null;
}

registerTodayRoutes(routes);
registerLinearRoutes(routes, {
  getContext: () => ({
    teamId:       process.env.LINEAR_TEAM_ID || null,
    linearClient: _linearClient,
  }),
});
registerFederationRoutes(routes, query); // OPT-76 (T1-F): federation grant/query/revocations
registerTelegramRoutes(routes); // OPT-74: Telegram inbound/outbound observability (read-only)

// Phase 1 success metrics (SPEC §14)
routes.set('GET /api/metrics/phase1', async (_req, _body) => {
  const metrics = await cachedQuery('phase1-metrics', collectPhase1Metrics, 120_000);
  return metrics;
});

routes.set('GET /api/strategic-decisions', async () => {
  const result = await cachedQuery('strategic-decisions', async () => {
    const r = await query(`
      SELECT id, proposed_action, rationale, decision_type, recommendation,
             board_verdict, board_notes, decided_at,
             perspective_scores, created_at
      FROM agent_graph.strategic_decisions
      WHERE board_verdict IS NULL
      UNION ALL
      SELECT * FROM (
        SELECT id, proposed_action, rationale, decision_type, recommendation,
               board_verdict, board_notes, decided_at,
               perspective_scores, created_at
        FROM agent_graph.strategic_decisions
        WHERE board_verdict IS NOT NULL
        ORDER BY decided_at DESC
        LIMIT 10
      ) recent
      ORDER BY created_at DESC
    `);
    return { decisions: r.rows };
  }, 30_000);
  return result || { decisions: [] };
});

/**
 * Parse JSON body from request.
 */
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') return resolve({});
    const chunks = [];
    let size = 0;
    // Attachment uploads carry base64 payloads (~33% overhead on 25MB max) — needs ~35MB.
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const isAttachmentUpload = req.method === 'POST' && /^\/api\/contracts\/[^/]+\/attachments$/.test(pathname);
    // Voice memo uploads carry raw audio bytes (octet-stream); 50MB cap + small margin.
    const isVoiceMemoUpload = req.method === 'POST' && pathname === '/api/voice-memo/upload';
    // Voice-print enrollment carries a short audio clip (~30-60s); 15MB cap is plenty.
    const isVoicePrintEnroll = req.method === 'POST' && pathname === '/api/voice-prints/enroll';
    // Engagement proposal uploads carry base64-encoded .pdf/.docx/.txt (~33%
    // overhead). A 950KB docx becomes ~1.27MB JSON, which blows the 1MB default
    // — give proposals a 25MB body cap (≈18MB raw file).
    const isProposalUpload = req.method === 'POST' && /^\/api\/engagements\/[^/]+\/proposals$/.test(pathname);
    const MAX = isVoiceMemoUpload
      ? 52 * 1024 * 1024
      : isAttachmentUpload
        ? 35 * 1024 * 1024
        : isProposalUpload
          ? 25 * 1024 * 1024
          : isVoicePrintEnroll
            ? 15 * 1024 * 1024
            : 1024 * 1024;
    // Content-Length pre-check: reject oversized requests before buffering. Catches honest
    // clients (Apple Shortcut always sends Content-Length); chunked-encoding bypass still
    // exists but the in-stream check below caps allocation at MAX bytes per request.
    // Resolve a sentinel (don't destroy the socket) so the request loop can
    // return a clean 413 instead of a bare connection reset → proxy 502.
    const declaredLength = parseInt(req.headers['content-length'] || '0', 10);
    if (declaredLength > MAX) { return resolve({ __tooLarge: true, max: MAX, declared: declaredLength }); }
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); resolve({}); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      req.rawBody = buf; // Buffer preserves exact bytes for HMAC verification
      try { resolve(JSON.parse(buf.toString('utf8'))); } catch { resolve({}); }
    });
  });
}

/**
 * Match a request to a route handler.
 * Supports simple path patterns like POST /api/drafts/approve with { id } in body.
 */
// STAQPRO-542 (ADR-014 M3): canonical route-key normalizer. Returns the Map
// key the dispatcher will consult (parameterized :id, regex routes) for a raw
// (method, pathname), or null if no route matches. matchRoute() and the
// route-tier classifier MUST both normalize through this single function so the
// classification table can never be phantom-green against a divergent key
// (the STAQPRO-588 route-collision class).
export function routeKeyFor(method, pathname) {
  const key = `${method} ${pathname}`;
  if (routes.has(key)) return key;

  // Prefix match: POST /api/webhooks/:source (check exact routes first)
  if (method === 'POST' && pathname.startsWith('/api/webhooks/')) {
    const exactKey = `POST ${pathname}`;
    if (routes.has(exactKey)) return exactKey;
    return 'POST /api/webhooks/:source';
  }

  // Flow definitions: DELETE /api/flows/:id (STAQPRO-615). Single trailing
  // segment only — multi-segment flow paths (/executions, /:id/run, /catalog/*)
  // are GET/POST and handled by their own exact/param keys, so a DELETE on one
  // segment is unambiguous.
  if (method === 'DELETE' && /^\/api\/flows\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/flows/:id';
  }

  // Skip-with-reason for /board "Needs you" lane (ADR-005)
  if (method === 'POST' && /^\/api\/board\/proposals\/[^/]+\/skip$/.test(pathname)) {
    return 'POST /api/board/proposals/:id/skip';
  }
  if (method === 'POST' && /^\/api\/board\/attention\/[^/]+\/skip$/.test(pathname)) {
    return 'POST /api/board/attention/:id/skip';
  }

  // Human-tasks dynamic routes (PRD: meeting-actions-to-kanban §11,
  // v0.2 tech-spec FR-3/FR-18/FR-27/FR-28/FR-29).
  if (method === 'POST' && /^\/api\/human-tasks\/[^/]+\/action$/.test(pathname)) {
    return 'POST /api/human-tasks/:id/action';
  }
  if (method === 'POST' && /^\/api\/human-tasks\/[^/]+\/inline-answer$/.test(pathname)) {
    return 'POST /api/human-tasks/:id/inline-answer';
  }
  if (method === 'POST' && /^\/api\/human-tasks\/[^/]+\/lifecycle$/.test(pathname)) {
    return 'POST /api/human-tasks/:id/lifecycle';
  }
  if (method === 'PATCH' && /^\/api\/human-tasks\/[^/]+\/fields$/.test(pathname)) {
    return 'PATCH /api/human-tasks/:id/fields';
  }
  if (method === 'POST' && /^\/api\/human-tasks\/[^/]+\/push$/.test(pathname)) {
    return 'POST /api/human-tasks/:id/push';
  }

  // Prefix match: GET /api/redesign/status/:id
  if (method === 'GET' && /^\/api\/redesign\/status\/[^/]+$/.test(pathname)) {
    return 'GET /api/redesign/status/:id';
  }
  // Prefix match: GET /api/redesign/preview/:id
  if (method === 'GET' && /^\/api\/redesign\/preview\/[^/]+$/.test(pathname)) {
    return 'GET /api/redesign/preview/:id';
  }
  // Prefix match: POST /api/redesign/:id/cancel
  if (method === 'POST' && /^\/api\/redesign\/[^/]+\/cancel$/.test(pathname)) {
    return 'POST /api/redesign/:id/cancel';
  }
  // Prefix match: POST /api/redesign/:id/retry
  if (method === 'POST' && /^\/api\/redesign\/[^/]+\/retry$/.test(pathname)) {
    return 'POST /api/redesign/:id/retry';
  }
  // Prefix match: GET /api/front-door/corpus/:slug (feature 008 Phase 1).
  // The exact 'GET /api/front-door/corpus' key was already checked above.
  if (method === 'GET' && /^\/api\/front-door\/corpus\/[^/]+$/.test(pathname)) {
    return 'GET /api/front-door/corpus/:slug';
  }
  // Prefix match: GET /api/blueprint/status/:id
  if (method === 'GET' && /^\/api\/blueprint\/status\/[^/]+$/.test(pathname)) {
    return 'GET /api/blueprint/status/:id';
  }
  // Prefix match: GET /api/blueprint/view/:id
  if (method === 'GET' && /^\/api\/blueprint\/view\/[^/]+$/.test(pathname)) {
    return 'GET /api/blueprint/view/:id';
  }

  // Prefix match: GET /api/meetings/:id
  if (method === 'GET' && /^\/api\/meetings\/[^/]+$/.test(pathname) && pathname !== '/api/meetings') {
    return 'GET /api/meetings/:id';
  }

  // Feature 007: meeting registry param routes. The exact sub-routes
  // (GET/PATCH /api/meeting-registry/source-precedence) are resolved by the
  // routes.has() check at the TOP of routeKeyFor, so they win over the :id
  // matcher below — "source-precedence" is never read as a meeting id.
  if (method === 'POST' && /^\/api\/meeting-registry\/[^/]+\/promote$/.test(pathname)) {
    return 'POST /api/meeting-registry/:id/promote';
  }
  if (method === 'GET' && /^\/api\/meeting-registry\/[^/]+$/.test(pathname) && pathname !== '/api/meeting-registry') {
    return 'GET /api/meeting-registry/:id';
  }

  // OPT-93: on-demand enrichment reads (links + derived facts for one entity).
  // Multi-segment — must be matched BEFORE the single-segment /api/artifacts/:id
  // below so an `enrich/...` path is never swallowed by the artifact-by-id rule.
  if (method === 'GET' && /^\/api\/artifacts\/enrich\/contact\/[^/]+$/.test(pathname)) {
    return 'GET /api/artifacts/enrich/contact/:id';
  }
  if (method === 'GET' && /^\/api\/artifacts\/enrich\/project\/[^/]+$/.test(pathname)) {
    return 'GET /api/artifacts/enrich/project/:id';
  }

  // OPT-94: link-management surface. The multi-segment GET /api/artifacts/links/*
  // routes are exact keys matched at the top of routeKeyFor; the PATCH on a single
  // link id is parameterized. These MUST be matched BEFORE the single-segment
  // GET /api/artifacts/:id rule below so a /links/... path is never swallowed by
  // the artifact-by-id matcher (mirrors how enrich/... is ordered above).
  if (method === 'PATCH' && /^\/api\/artifacts\/links\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/artifacts/links/:id';
  }

  // OPT-92: GET /api/artifacts/:id (single artifact + versions). Single trailing
  // segment only — the bare /api/artifacts list is an exact key matched above.
  // (GET /api/artifacts/links/pending and /links/stats are exact keys resolved by
  // the routes.has() check at the top of routeKeyFor, so they win over this rule.)
  if (method === 'GET' && /^\/api\/artifacts\/[^/]+$/.test(pathname) && pathname !== '/api/artifacts') {
    return 'GET /api/artifacts/:id';
  }

  // Prefix match: DELETE /api/voice-prints/:id
  if (method === 'DELETE' && /^\/api\/voice-prints\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/voice-prints/:id';
  }

  // ADR-017: sharing grant lifecycle + collections + groups + topics.
  if (method === 'POST' && /^\/api\/sharing\/grants\/[^/]+\/accept$/.test(pathname)) {
    return 'POST /api/sharing/grants/:id/accept';
  }
  if (method === 'POST' && /^\/api\/sharing\/grants\/[^/]+\/decline$/.test(pathname)) {
    return 'POST /api/sharing/grants/:id/decline';
  }
  if (method === 'POST' && /^\/api\/sharing\/grants\/[^/]+\/revoke$/.test(pathname)) {
    return 'POST /api/sharing/grants/:id/revoke';
  }
  if (method === 'POST' && /^\/api\/sharing\/collections\/[^/]+\/members$/.test(pathname)) {
    return 'POST /api/sharing/collections/:id/members';
  }
  if (method === 'DELETE' && /^\/api\/sharing\/collections\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/sharing/collections/:id';
  }
  if (method === 'POST' && /^\/api\/sharing\/groups\/[^/]+\/members$/.test(pathname)) {
    return 'POST /api/sharing/groups/:id/members';
  }
  if (method === 'DELETE' && /^\/api\/sharing\/groups\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/sharing/groups/:id';
  }
  if (method === 'POST' && /^\/api\/sharing\/topics\/[^/]+\/assign$/.test(pathname)) {
    return 'POST /api/sharing/topics/:id/assign';
  }
  if (method === 'DELETE' && /^\/api\/sharing\/topics\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/sharing/topics/:id';
  }

  // Prefix match: GET /api/organizations/:id
  if (method === 'GET' && /^\/api\/organizations\/[^/]+$/.test(pathname) && pathname !== '/api/organizations') {
    return 'GET /api/organizations/:id';
  }

  // OPT-2: GET /api/provenance/:source_meeting_id (single path segment)
  if (method === 'GET' && /^\/api\/provenance\/[^/]+$/.test(pathname)) {
    return 'GET /api/provenance/:source_meeting_id';
  }

  // Prefix match: GET /api/contacts/:id/connections
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/connections$/.test(pathname)) {
    return 'GET /api/contacts/:id/connections';
  }

  // Board members (admin management)
  if (method === 'PATCH' && /^\/api\/board-members\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/board-members/:id';
  }
  if (method === 'DELETE' && /^\/api\/board-members\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/board-members/:id';
  }

  // Deals (Phase 4)
  if (method === 'PATCH' && /^\/api\/deals\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/deals/:id';
  }
  if (method === 'DELETE' && /^\/api\/deals\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/deals/:id';
  }
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/deals$/.test(pathname)) {
    return 'GET /api/contacts/:id/deals';
  }
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/tags$/.test(pathname)) {
    return 'GET /api/contacts/:id/tags';
  }
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/tags$/.test(pathname)) {
    return 'POST /api/contacts/:id/tags';
  }
  if (method === 'DELETE' && /^\/api\/contacts\/[^/]+\/tags\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/contacts/:id/tags/:tag';
  }

  // Phase 5: relationships
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/strength$/.test(pathname)) {
    return 'GET /api/contacts/:id/strength';
  }

  // Prefix match: POST /api/intents/:id/approve
  if (method === 'POST' && /^\/api\/intents\/[^/]+\/approve$/.test(pathname)) {
    return 'POST /api/intents/:id/approve';
  }
  // Prefix match: POST /api/intents/:id/reject
  if (method === 'POST' && /^\/api\/intents\/[^/]+\/reject$/.test(pathname)) {
    return 'POST /api/intents/:id/reject';
  }

  // Prefix match: GET /api/contacts/:id/identities
  if (method === 'GET' && /^\/api\/contacts\/[^/]+\/identities$/.test(pathname)) {
    return 'GET /api/contacts/:id/identities';
  }
  // Prefix match: POST /api/contacts/:id/identities
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/identities$/.test(pathname)) {
    return 'POST /api/contacts/:id/identities';
  }
  // Prefix match: POST /api/contacts/:id/split-identities (STAQPRO-308 Phase 2)
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/split-identities$/.test(pathname)) {
    return 'POST /api/contacts/:id/split-identities';
  }
  // OPT-81: POST /api/contacts/:id/unmerge — reverse a soft auto-merge
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/unmerge$/.test(pathname)) {
    return 'POST /api/contacts/:id/unmerge';
  }
  // Prefix match: POST /api/contacts/:id/projects/remove (most specific first)
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/projects\/remove$/.test(pathname)) {
    return 'POST /api/contacts/:id/projects/remove';
  }
  // Prefix match: POST /api/contacts/:id/projects
  if (method === 'POST' && /^\/api\/contacts\/[^/]+\/projects$/.test(pathname)) {
    return 'POST /api/contacts/:id/projects';
  }
  // Prefix match: GET /api/contacts/:id (not the list endpoint)
  if (method === 'GET' && /^\/api\/contacts\/[^/]+$/.test(pathname) && pathname !== '/api/contacts' && pathname !== '/api/contacts/duplicates') {
    return 'GET /api/contacts/:id';
  }
  // Prefix match: POST /api/contacts/classify (before :id catch-all)
  if (method === 'POST' && pathname === '/api/contacts/classify') {
    return 'POST /api/contacts/classify';
  }
  // OPT-81: POST /api/contacts/auto-merge — scored soft-merge pass
  if (method === 'POST' && pathname === '/api/contacts/auto-merge') {
    return 'POST /api/contacts/auto-merge';
  }
  // Prefix match: POST /api/contacts/:id
  if (method === 'POST' && /^\/api\/contacts\/[^/]+$/.test(pathname) && pathname !== '/api/contacts/merge' && pathname !== '/api/contacts/classify' && pathname !== '/api/contacts/auto-merge') {
    return 'POST /api/contacts/:id';
  }
  // Prefix match: DELETE /api/contacts/:id
  if (method === 'DELETE' && /^\/api\/contacts\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/contacts/:id';
  }

  // Campaign routes
  if (method === 'POST' && pathname === '/api/campaigns') {
    return 'POST /api/campaigns';
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/preview$/.test(pathname)) {
    return 'GET /api/campaigns/:id/preview';
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/download$/.test(pathname)) {
    return 'GET /api/campaigns/:id/download';
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/iterations$/.test(pathname)) {
    return 'GET /api/campaigns/:id/iterations';
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+$/.test(pathname) && pathname !== '/api/campaigns') {
    return 'GET /api/campaigns/:id';
  }
  if (method === 'PATCH' && /^\/api\/campaigns\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/campaigns/:id';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/approve$/.test(pathname)) {
    return 'POST /api/campaigns/:id/approve';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/pause$/.test(pathname)) {
    return 'POST /api/campaigns/:id/pause';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/resume$/.test(pathname)) {
    return 'POST /api/campaigns/:id/resume';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/cancel$/.test(pathname)) {
    return 'POST /api/campaigns/:id/cancel';
  }
  // Campaign history + HITL routes
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/history$/.test(pathname)) {
    return 'GET /api/campaigns/:id/history';
  }
  if (method === 'GET' && /^\/api\/campaigns\/[^/]+\/hitl\/pending$/.test(pathname)) {
    return 'GET /api/campaigns/:id/hitl/pending';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/hitl\/request$/.test(pathname)) {
    return 'POST /api/campaigns/:id/hitl/request';
  }
  if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/hitl\/[^/]+\/respond$/.test(pathname)) {
    return 'POST /api/campaigns/:id/hitl/:requestId/respond';
  }
  // Explorer domain toggle: /api/explorer/domains/:domain/toggle
  if (method === 'POST' && /^\/api\/explorer\/domains\/[^/]+\/toggle$/.test(pathname)) {
    return 'POST /api/explorer/domains/:domain/toggle';
  }

  // Service routes: /api/services/:name/pause|resume|trigger
  if (method === 'POST' && /^\/api\/services\/[^/]+\/pause$/.test(pathname)) {
    return 'POST /api/services/:name/pause';
  }
  if (method === 'POST' && /^\/api\/services\/[^/]+\/resume$/.test(pathname)) {
    return 'POST /api/services/:name/resume';
  }
  if (method === 'POST' && /^\/api\/services\/[^/]+\/trigger$/.test(pathname)) {
    return 'POST /api/services/:name/trigger';
  }

  // Content routes
  if (method === 'GET' && pathname === '/api/content/drafts') {
    return 'GET /api/content/drafts';
  }
  if (method === 'GET' && /^\/api\/content\/drafts\/[^/]+$/.test(pathname) && pathname !== '/api/content/drafts') {
    return 'GET /api/content/drafts/:id';
  }
  if (method === 'POST' && pathname === '/api/content/requests') {
    return 'POST /api/content/requests';
  }
  if (method === 'POST' && /^\/api\/content\/drafts\/[^/]+\/approve$/.test(pathname)) {
    return 'POST /api/content/drafts/:id/approve';
  }
  if (method === 'POST' && /^\/api\/content\/drafts\/[^/]+\/body$/.test(pathname)) {
    return 'POST /api/content/drafts/:id/body';
  }
  if (method === 'POST' && /^\/api\/content\/drafts\/[^/]+\/reject$/.test(pathname)) {
    return 'POST /api/content/drafts/:id/reject';
  }

  // Signing routes (board-authenticated)
  if (method === 'GET' && /^\/api\/signatures\/[^/]+$/.test(pathname) && pathname !== '/api/signatures') {
    return 'GET /api/signatures/:id';
  }
  if (method === 'POST' && /^\/api\/signatures\/[^/]+\/revoke$/.test(pathname)) {
    return 'POST /api/signatures/:id/revoke';
  }
  // Contract routes — order matters: most-specific path first inside each family.
  // Static-segment routes (templates/...) must come before any broad
  // `/api/contracts/[^/]+/...` pattern that could otherwise match them.

  // Template CRUD (static "templates" segment in position 3 — checked first)
  if (method === 'PATCH' && /^\/api\/contracts\/templates\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/contracts/templates/:id';
  }
  if (method === 'POST' && /^\/api\/contracts\/templates\/[^/]+\/archive$/.test(pathname)) {
    return 'POST /api/contracts/templates/:id/archive';
  }
  if (method === 'GET' && /^\/api\/contracts\/templates\/[^/]+$/.test(pathname)) {
    return 'GET /api/contracts/templates/:id';
  }

  // Proposals — two-level (:id and :proposalId); most-specific first
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/proposals\/[^/]+\/accept$/.test(pathname)) {
    return 'POST /api/contracts/:id/proposals/:proposalId/accept';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/proposals\/[^/]+\/dismiss$/.test(pathname)) {
    return 'POST /api/contracts/:id/proposals/:proposalId/dismiss';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/proposals\/[^/]+\/reply$/.test(pathname)) {
    return 'POST /api/contracts/:id/proposals/:proposalId/reply';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/proposals\/[^/]+\/replies$/.test(pathname)) {
    return 'GET /api/contracts/:id/proposals/:proposalId/replies';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/proposals$/.test(pathname)) {
    return 'GET /api/contracts/:id/proposals';
  }

  // Versions — two-level; specific before less-specific
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/revert\/[^/]+$/.test(pathname)) {
    return 'POST /api/contracts/:id/revert/:versionId';
  }
  // /versions/diff must be checked BEFORE /versions/:versionId since "diff"
  // is a literal sibling at the same path slot and would otherwise match.
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/versions\/diff$/.test(pathname)) {
    return 'GET /api/contracts/:id/versions/diff';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/versions\/[^/]+$/.test(pathname)) {
    return 'GET /api/contracts/:id/versions/:versionId';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/versions$/.test(pathname)) {
    return 'GET /api/contracts/:id/versions';
  }

  // Attachments (more specific first)
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/attachments\/[^/]+\/download$/.test(pathname)) {
    return 'GET /api/contracts/:id/attachments/:attId/download';
  }
  if (method === 'DELETE' && /^\/api\/contracts\/[^/]+\/attachments\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/contracts/:id/attachments/:attId';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/attachments$/.test(pathname)) {
    return 'GET /api/contracts/:id/attachments';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/attachments$/.test(pathname)) {
    return 'POST /api/contracts/:id/attachments';
  }

  // Single-leaf contract routes under /api/contracts/:id/<leaf>
  if (method === 'DELETE' && /^\/api\/contracts\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/contracts/:id';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/send$/.test(pathname)) {
    return 'POST /api/contracts/:id/send';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/edit$/.test(pathname)) {
    return 'POST /api/contracts/:id/edit';
  }
  if (method === 'POST' && /^\/api\/contracts\/[^/]+\/pre-send-check$/.test(pathname)) {
    return 'POST /api/contracts/:id/pre-send-check';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/audit$/.test(pathname)) {
    return 'GET /api/contracts/:id/audit';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/pdf$/.test(pathname)) {
    return 'GET /api/contracts/:id/pdf';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/docx$/.test(pathname)) {
    return 'GET /api/contracts/:id/docx';
  }
  if (method === 'PATCH' && /^\/api\/contracts\/[^/]+\/brand-profile$/.test(pathname)) {
    return 'PATCH /api/contracts/:id/brand-profile';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/verify$/.test(pathname)) {
    return 'GET /api/contracts/:id/verify';
  }
  if (method === 'GET' && /^\/api\/contracts\/[^/]+\/work-items$/.test(pathname)) {
    return 'GET /api/contracts/:id/work-items';
  }

  // Brand profiles — fonts/color/logo/footer config consumed by the
  // pdf-render + docx-render pipelines. Asset routes have two path params
  // (:id and :kind); routeKeyFor must match the longest pattern first.
  if (method === 'POST' && /^\/api\/brand-profiles\/[^/]+\/assets\/[^/]+$/.test(pathname)) {
    return 'POST /api/brand-profiles/:id/assets/:kind';
  }
  if (method === 'GET' && /^\/api\/brand-profiles\/[^/]+\/assets\/[^/]+$/.test(pathname)) {
    return 'GET /api/brand-profiles/:id/assets/:kind';
  }
  if (method === 'DELETE' && /^\/api\/brand-profiles\/[^/]+\/assets\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/brand-profiles/:id/assets/:kind';
  }
  if (method === 'POST' && /^\/api\/brand-profiles\/[^/]+\/archive$/.test(pathname)) {
    return 'POST /api/brand-profiles/:id/archive';
  }
  if (method === 'POST' && /^\/api\/brand-profiles\/[^/]+\/make-default$/.test(pathname)) {
    return 'POST /api/brand-profiles/:id/make-default';
  }
  if (method === 'PATCH' && /^\/api\/brand-profiles\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/brand-profiles/:id';
  }
  if (method === 'GET' && /^\/api\/brand-profiles\/[^/]+$/.test(pathname) && pathname !== '/api/brand-profiles') {
    return 'GET /api/brand-profiles/:id';
  }

  // Counterparties
  if (method === 'POST' && /^\/api\/counterparties\/[^/]+\/archive$/.test(pathname)) {
    return 'POST /api/counterparties/:id/archive';
  }
  if (method === 'PATCH' && /^\/api\/counterparties\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/counterparties/:id';
  }
  if (method === 'GET' && /^\/api\/counterparties\/[^/]+$/.test(pathname) && pathname !== '/api/counterparties') {
    return 'GET /api/counterparties/:id';
  }

  // Public signing routes (token-authenticated, no board auth)
  // Attachment download + proposal replies must come BEFORE the generic
  // /api/sign/:token match since that pattern also matches multi-segment paths
  // if we're not careful. All patterns here are anchored so they're mutually exclusive.
  if (method === 'GET' && /^\/api\/sign\/[^/]+\/attachments\/[^/]+\/download$/.test(pathname)) {
    return 'GET /api/sign/:token/attachments/:attId/download';
  }
  if (method === 'POST' && /^\/api\/sign\/[^/]+\/proposals\/[^/]+\/reply$/.test(pathname)) {
    return 'POST /api/sign/:token/proposals/:proposalId/reply';
  }
  if (method === 'POST' && /^\/api\/sign\/[^/]+\/proposals$/.test(pathname)) {
    return 'POST /api/sign/:token/proposals';
  }
  if (method === 'GET' && /^\/api\/sign\/[^/]+\/proposals$/.test(pathname)) {
    return 'GET /api/sign/:token/proposals';
  }
  if (method === 'GET' && /^\/api\/sign\/[^/]+$/.test(pathname)) {
    return 'GET /api/sign/:token';
  }
  if (method === 'POST' && /^\/api\/sign\/[^/]+$/.test(pathname)) {
    return 'POST /api/sign/:token';
  }

  // Engagements (client project → living spec). Six parameterized routes;
  // each must be wired here because matchRoute does not auto-resolve :id.
  if (method === 'GET' && /^\/api\/engagements\/[^/]+$/.test(pathname) && pathname !== '/api/engagements') {
    return 'GET /api/engagements/:id';
  }
  if (method === 'PATCH' && /^\/api\/engagements\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/engagements/:id';
  }
  if (method === 'DELETE' && /^\/api\/engagements\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/engagements/:id';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/proposals$/.test(pathname)) {
    return 'POST /api/engagements/:id/proposals';
  }
  if (method === 'DELETE' && /^\/api\/engagements\/[^/]+\/proposals\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/engagements/:id/proposals/:pid';
  }
  if (method === 'PATCH' && /^\/api\/engagements\/[^/]+\/sections\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/engagements/:id/sections/:sid';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/sections$/.test(pathname)) {
    return 'POST /api/engagements/:id/sections';
  }
  if (method === 'DELETE' && /^\/api\/engagements\/[^/]+\/sections\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/engagements/:id/sections/:sid';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/sections\/[^/]+\/reorder$/.test(pathname)) {
    return 'POST /api/engagements/:id/sections/:sid/reorder';
  }
  // section-proposals/bulk must be tested BEFORE the :pid pattern because
  // "bulk" matches [^/]+
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/section-proposals\/bulk$/.test(pathname)) {
    return 'POST /api/engagements/:id/section-proposals/bulk';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/section-proposals\/[^/]+$/.test(pathname)) {
    return 'POST /api/engagements/:id/section-proposals/:pid';
  }
  if (method === 'GET' && /^\/api\/engagements\/[^/]+\/audit$/.test(pathname)) {
    return 'GET /api/engagements/:id/audit';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/merge$/.test(pathname)) {
    return 'POST /api/engagements/:id/merge';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/synthesize$/.test(pathname)) {
    return 'POST /api/engagements/:id/synthesize';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/conflicts\/[^/]+\/resolve$/.test(pathname)) {
    return 'POST /api/engagements/:id/conflicts/:cid/resolve';
  }
  if (method === 'GET' && /^\/api\/engagements\/[^/]+\/export\.md$/.test(pathname)) {
    return 'GET /api/engagements/:id/export.md';
  }
  if (method === 'GET' && /^\/api\/engagements\/[^/]+\/export\.docx$/.test(pathname)) {
    return 'GET /api/engagements/:id/export.docx';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/export\/gdoc$/.test(pathname)) {
    return 'POST /api/engagements/:id/export/gdoc';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/generate-proposal$/.test(pathname)) {
    return 'POST /api/engagements/:id/generate-proposal';
  }
  if (method === 'GET' && /^\/api\/engagements\/[^/]+\/generated-proposals$/.test(pathname)) {
    return 'GET /api/engagements/:id/generated-proposals';
  }
  if (method === 'GET' && /^\/api\/engagements\/[^/]+\/generated-proposals\/[^/]+$/.test(pathname)) {
    return 'GET /api/engagements/:id/generated-proposals/:gpid';
  }
  if (method === 'DELETE' && /^\/api\/engagements\/[^/]+\/generated-proposals\/[^/]+$/.test(pathname)) {
    return 'DELETE /api/engagements/:id/generated-proposals/:gpid';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/generated-proposals\/upload$/.test(pathname)) {
    return 'POST /api/engagements/:id/generated-proposals/upload';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/generated-proposals\/[^/]+\/approve$/.test(pathname)) {
    return 'POST /api/engagements/:id/generated-proposals/:gpid/approve';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/generated-proposals\/[^/]+\/unapprove$/.test(pathname)) {
    return 'POST /api/engagements/:id/generated-proposals/:gpid/unapprove';
  }
  if (method === 'POST' && /^\/api\/engagements\/[^/]+\/draft-contract$/.test(pathname)) {
    return 'POST /api/engagements/:id/draft-contract';
  }
  // Note: these three are exact-match keys (no :id) — already handled by the
  // initial routes.has(key) check above. Listed here as a comment so the
  // pattern is visible:
  //   POST /api/engagements/client-search
  //   POST /api/engagements/expand-client
  //   POST /api/engagements/auto-build

  // STAQPRO-619-A: Linear team-settings — PUT /api/linear/teams/:id. Exact
  // /api/linear/teams (GET) and /api/linear/backfill (POST) are exact-match
  // keys already resolved by the routes.has(key) check above.
  if (method === 'PATCH' && /^\/api\/linear\/teams\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/linear/teams/:id';
  }

  // OPT-96: capture-sources PATCH /api/capture-sources/:id. Exact
  // /api/capture-sources (GET list + POST create) are exact-match keys already
  // resolved by the routes.has(key) check above.
  if (method === 'PATCH' && /^\/api\/capture-sources\/[^/]+$/.test(pathname)) {
    return 'PATCH /api/capture-sources/:id';
  }

  return null;
}

export function matchRoute(method, pathname) {
  const k = routeKeyFor(method, pathname);
  return k ? (routes.get(k) || null) : null;
}

/**
 * Start the API server.
 */
export function startApiServer(port = 3001) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, getCorsHeaders(req));
      res.end();
      return;
    }

    const handler = matchRoute(req.method, pathname);
    if (!handler) {
      res.writeHead(404, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Request-level timeout: prevents dashboard hanging when DB is busy.
    // Long-running endpoints (voice bootstrap, embeddings) get extended timeouts.
    // Voice-print enrollment runs ffmpeg decode + WavLM ONNX inference on the
    // enrollment audio, plus a one-time HF model download on cold start —
    // routinely exceeds the 30s POST default and produced a misleading
    // "Service busy" UI error while the backend completed the enrollment fine.
    const LONG_RUNNING = new Set(['/api/voice/bootstrap', '/api/voice/rebuild', '/api/voice-prints/enroll', '/api/contacts/sync', '/api/cron/explorer', '/api/chat/message', '/api/chat/auto',
      // Engagements LLM-heavy endpoints with no :id parameter:
      '/api/engagements/auto-build',
      '/api/engagements/client-search',
    ]);
    // Engagements long-running ops with a :id segment: Sonnet passes that
    // routinely run 30-120s. Regex because of the path parameter.
    const isEngagementLongRunning =
      req.method === 'POST' &&
      (
        /^\/api\/engagements\/[^/]+\/synthesize$/.test(pathname) ||
        /^\/api\/engagements\/[^/]+\/generate-proposal$/.test(pathname)
      );
    const timeoutMs = LONG_RUNNING.has(pathname) || isEngagementLongRunning ? 300_000
      : req.method === 'POST' ? 30_000 : 10_000;
    let responded = false;
    const requestTimeout = setTimeout(() => {
      if (!responded && !res.writableEnded) {
        responded = true;
        console.warn(`[api] Request timeout: ${req.method} ${pathname}`);
        res.writeHead(503, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service busy — agents processing, try again shortly' }));
      }
    }, timeoutMs);

    try {
      // ── STAQPRO-542 (ADR-014): route-tier middleware — FIRST dispatch step ──
      // Runs BEFORE the isWebhook/isRedesign/isBlueprint/isSigning/
      // isVoiceMemoUpload/isPublic bypass checks below, so no route can walk
      // around the tier decision (ADR-014 §2 / Linus BLOCKER). Classifies the
      // route, best-effort resolves identity, attaches req.routeTier /
      // req.viewer / req.principal for handlers, then applies the tier's mode.
      //
      // PHASE 0: every tier is 'observe' (DB default + fail-safe) — this logs
      // would-be denials and ALWAYS continues. The 'enforce' branch is present
      // but unreached until a tier is flipped (follow-up). Zero behavior change.
      // Belt-and-suspenders: this block runs FIRST on every request. Its parts
      // are total (classifyRoute/identityGate are pure; getTierMode swallows DB
      // errors → 'observe'), but an outer guard guarantees an unexpected throw
      // can never 500 a request that used to succeed — it falls through to the
      // normal dispatch below. NOTE: when a tier is flipped to 'enforce' (the
      // follow-up PR), this catch MUST fail CLOSED (deny) instead of continuing.
      // Captured outside the try so the catch can fail CLOSED for enforced tiers
      // (ADR-014: an unexpected error on an enforcing route must deny, never fall
      // through). tierMode is resolved early (getTierMode swallows DB errors →
      // 'observe'), so by the time any throw-prone code runs the catch knows it.
      let _tierMode = 'observe';
      try {
        const tierInfo = classifyRoute(req.method, pathname);
        req.routeTier = tierInfo;
        _tierMode = await getTierMode(tierInfo.tier);
        // Best-effort identity resolution (sets req.auth). Never throws — failure
        // simply means req.auth stays undefined and the gate sees no auth.
        try { await resolveAuth(req); } catch { /* unauthenticated */ }
        // Attach the tenancy principal so handlers stop re-resolving (the gate
        // does NOT apply visibleClause — scope stays a handler obligation, §4).
        try {
          const wv = await withViewer(req);
          req.viewer = wv.viewer;
          req.principal = wv.principal;
        } catch {
          req.viewer = null;
          req.principal = null;
        }
        // ── OPT-37: customer authorization ceiling (ALWAYS enforced) ──────────
        // External customer tokens are a NEW capability with no backward-compat
        // to preserve, so they fail-closed from day one (P1) and do NOT ride the
        // observe-mode grace period the internal tiers use. A customer principal
        // may only reach public, public-signing, and org-shared (its own org via
        // visibleClause). ops-control / admin / viewer-scoped / webhook-authed are
        // structurally denied here — even though ops-control is identity=authed-any
        // and would otherwise admit any authenticated caller. This is the
        // infrastructure boundary the MCP/CLI tool exposure mirrors, not relies on.
        if (req.auth?.source === 'customer_jwt') {
          const CUSTOMER_ALLOWED_TIERS = new Set(['public', 'public-signing', 'org-shared']);
          if (!CUSTOMER_ALLOWED_TIERS.has(tierInfo.tier)) {
            responded = true;
            clearTimeout(requestTimeout);
            console.warn(
              `[customer-ceiling] deny: ${req.method} ${pathname} tier=${tierInfo.tier} ` +
              `principal=${req.auth.sub} org=${req.auth.org_id}`
            );
            res.writeHead(403, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden', reason: 'customer-tier-not-permitted' }));
            return;
          }
        }

        const tierMode = _tierMode;
        const gate = identityGate(tierInfo.identity, req.auth || null, tierInfo.via);
        if (!gate.allow) {
          if (tierMode === 'enforce') {
            // Enforce flip (migration 160 flips admin + org-shared): apply the
            // identity gate as a hard 401/403.
            responded = true;
            clearTimeout(requestTimeout);
            res.writeHead(gate.status || 403, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: gate.status === 401 ? 'Unauthorized' : 'Forbidden', reason: gate.reason }));
            return;
          }
          // observe: log the would-be denial and CONTINUE (never block).
          console.warn(
            `[route-tier] observe: ${req.method} ${pathname} tier=${tierInfo.tier} ` +
            `would=${gate.status || 403} reason=${gate.reason} via=${tierInfo.via}`
          );
        }
      } catch (e) {
        // ADR-014: fail CLOSED on an enforcing route — an unexpected middleware
        // error must never silently fall through to the handler when the tier is
        // enforcing. Observe tiers still fail open (never break a live request).
        if (_tierMode === 'enforce') {
          responded = true;
          clearTimeout(requestTimeout);
          console.warn(`[route-tier] enforce fail-closed on middleware error: ${req.method} ${pathname}: ${e?.message || e}`);
          res.writeHead(403, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden', reason: 'gate-error' }));
          return;
        }
        console.warn(`[route-tier] middleware error (continuing): ${e?.message || e}`);
      }

      // Auth: unified resolver supports board JWT, agent JWT, and legacy Bearer.
      // Webhooks, redesign, blueprint, voice-memo handle their own auth inside the handler.
      const isWebhook = pathname.startsWith('/api/webhooks/');
      const isRedesign = pathname.startsWith('/api/redesign/');
      const isBlueprint = pathname.startsWith('/api/blueprint/');
      const isSigning = pathname.startsWith('/api/sign/');  // Public e-signature endpoints (token-authenticated)
      const isVoiceMemoUpload = pathname === '/api/voice-memo/upload';  // Bearer-auth handled in route via WEBHOOK_BEARER_VOICE_MEMO
      // Front door (feature 008): published-only corpus reads + anonymous,
      // clamped, IP-rate-limited visit beacon. Public by design (route-tiers
      // 'public') — consumed by site frontends with no Optimus principal.
      const isFrontDoor = pathname.startsWith('/api/front-door/');
      // Linus: campaign preview/download now requires auth (P1 deny by default)
      const routeKey = `${req.method} ${pathname}`;
      const isPublic = PUBLIC_ROUTES.has(routeKey);
      // P1: deny by default — auth everything except explicit exemptions
      const needsAuth = !isWebhook && !isRedesign && !isBlueprint && !isSigning && !isVoiceMemoUpload && !isFrontDoor && !isPublic;

      if (needsAuth) {
        const authed = await resolveAuth(req);
        if (!authed) {
          responded = true;
          clearTimeout(requestTimeout);
          res.writeHead(401, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        // Rate limiting (board JWT only — agents + legacy Bearer are exempt)
        if (req.auth && req.auth.source !== 'agent_jwt' && req.auth.source !== 'api_secret') {
          try {
            const { checkRateLimit } = await import('./runtime/rate-limiter.js');
            const limit = await checkRateLimit(req.auth.sub, req.auth.role);
            if (!limit.allowed) {
              responded = true;
              clearTimeout(requestTimeout);
              res.writeHead(429, {
                ...getCorsHeaders(req),
                'Content-Type': 'application/json',
                'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)),
              });
              res.end(JSON.stringify({ error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs }));
              return;
            }
          } catch (e) {
            // Rate limiter failure is non-blocking (fail-open for availability)
            console.warn(`[api] Rate limiter error: ${e.message}`);
          }
        }
        // NemoClaw heartbeat: record board JWT activity for dashboard visibility (fire-and-forget)
        if (req.auth && req.auth.source === 'jwt' && req.auth.role === 'board' && req.auth.github_username) {
          const extAgentId = `nemoclaw-${req.auth.github_username}`;
          query(
            `INSERT INTO agent_graph.agent_heartbeats (agent_id, heartbeat_at, status, pid)
             VALUES ($1, now(), 'online', 0)
             ON CONFLICT (agent_id) DO UPDATE SET heartbeat_at = now(), status = 'online'`,
            [extAgentId]
          ).catch(() => {});
        }
      }

      const body = await parseBody(req);

      // Oversized payload — parseBody flagged it from the Content-Length
      // pre-check. Return a clear 413 instead of letting the handler choke on
      // an empty body (which surfaced as a confusing bare 502 upstream).
      if (body && body.__tooLarge) {
        responded = true;
        clearTimeout(requestTimeout);
        res.writeHead(413, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Payload too large: ${(body.declared / 1024 / 1024).toFixed(1)}MB exceeds the ${(body.max / 1024 / 1024).toFixed(0)}MB limit for this endpoint. For large documents, paste the text instead.`,
        }));
        return;
      }

      const result = await handler(req, body, res);

      if (responded) return; // timeout already sent 503
      responded = true;
      clearTimeout(requestTimeout);

      // SSE handlers manage their own response
      if (result === '__sse__') return;

      // OAuth redirect support (board-auth.js returns { _redirect: url })
      if (result && result._redirect) {
        res.writeHead(302, { ...getCorsHeaders(req), 'Location': result._redirect });
        res.end();
        return;
      }

      // Raw binary response support (file downloads, etc.)
      // Handler returns { __raw_response: true, status, headers, body: Buffer|string }
      if (result && result.__raw_response) {
        res.writeHead(result.status || 200, { ...getCorsHeaders(req), ...(result.headers || {}) });
        res.end(result.body);
        return;
      }

      res.writeHead(200, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (responded) return; // timeout already sent 503
      responded = true;
      clearTimeout(requestTimeout);
      const status = err.statusCode || 500;
      console.error(`[api] ${req.method} ${pathname} error (${status}):`, err.message);
      res.writeHead(status, { ...getCorsHeaders(req), 'Content-Type': 'application/json' });
      // OPT-101: when a thrown error carries a machine-readable errorCode (e.g.
      // 'impersonation_unavailable', 'drive_unavailable'), surface it as `error`
      // and keep the human message as `detail` so clients can branch on the code.
      // Backward-compatible: errors without errorCode keep the legacy { error } shape.
      const payload = err.errorCode
        ? { error: err.errorCode, detail: err.message }
        : { error: err.message };
      res.end(JSON.stringify(payload));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[api] Port ${port} is already in use. Kill the other process or set API_PORT in .env`);
    } else {
      console.error(`[api] Server error:`, err.message);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`[api] Dashboard API listening on http://localhost:${port}`);
  });

  return server;
}

/**
 * Warm the API cache. Call this BEFORE starting agent loops so PGlite is idle.
 * On first boot the cache is empty — without a warm, every dashboard page
 * gets null data until PGlite becomes available between agent queries.
 */
export async function warmApiCache() {
  const endpoints = ['GET /api/briefing', 'GET /api/stats', 'GET /api/signals',
    'GET /api/signals/feed', 'GET /api/signals/feedback/metrics', 'GET /api/drafts',
    'GET /api/metrics', 'GET /api/inbox', 'GET /api/debug/pipeline',
    'GET /api/status', 'GET /api/accounts', 'GET /api/voice/status'];
  let ok = 0;
  for (const key of endpoints) {
    try {
      const handler = routes.get(key);
      if (handler) { await handler({ url: '/', headers: {} }, {}); ok++; }
    } catch (err) { console.warn(`[api] Cache warm failed for ${key}: ${err.message}`); }
  }
  console.log(`[api] Cache warmed (${ok}/${endpoints.length} endpoints)`);
}

/**
 * Listen for pg_notify state changes and invalidate API cache.
 * Call after initPgNotify() so the event bus receives cross-process notifications.
 */
export function startCacheInvalidationListener() {
  onAnyEvent((payload) => {
    if (payload.event_type === 'state_changed' || payload.event_type === 'task_assigned') {
      _cache.delete('pipeline');
      _cache.delete('status');
    }
  });
  console.log('[api] Cache invalidation listener active');
}
