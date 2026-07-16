// STAQPRO-542 — Route-tier classifier (ADR-014, feature spec 002).
//
// PHASE 0 — OBSERVE ONLY. This module classifies every backend route into a
// two-axis access tier { identity, scope } (ADR-014 M1). The enforce-mode gate
// logic lives here too but is flag-gated OFF (all tiers default to `observe`
// via getTierMode() — see api.js). This PR changes ZERO production behavior.
//
// Design (ADR-014):
//   - M1 two-axis model: identity ∈ {public, webhook-secret, signing-token,
//     authed-any, board-only}; scope ∈ {none, org, owner}. The 7 named tiers
//     are a derived view (TIER_PRESETS).
//   - M2 prefix/module default + exceptions: an ordered prefix rule list maps
//     path-prefix → tier (one decision per module), plus an exact-match
//     exceptions map (METHOD /path → tier) for sensitive overrides. An
//     unmatched authed route falls to the MOST-RESTRICTIVE default
//     (`viewer-scoped` = {authed-any, owner}) — fail-closed on data.
//   - M3 shared normalization: classify() normalizes the raw path through the
//     SAME routeKeyFor() the dispatcher uses (no independent regex), so the
//     classification table can never be phantom-green against a divergent key.
//
// The middleware (api.js) closes the IDENTITY class only. Scope is a declared
// obligation handlers still enforce with visibleClause (ADR-014 §4 / M-D
// ratchet STAQPRO-589) — passing the gate is necessary but not sufficient.

import { routeKeyFor } from './api.js';

// ── Axes ────────────────────────────────────────────────────────────────────
export const IDENTITY = Object.freeze({
  PUBLIC: 'public',                 // no auth
  WEBHOOK_SECRET: 'webhook-secret', // route's own query-param / signature secret
  SIGNING_TOKEN: 'signing-token',   // public signing token validated in handler
  AUTHED_ANY: 'authed-any',         // any authenticated principal (board | agent | api_secret)
  BOARD_ONLY: 'board-only',         // board JWT only — never agent JWT, never bare api_secret
});

export const SCOPE = Object.freeze({
  NONE: 'none',
  ORG: 'org',
  OWNER: 'owner',
});

// ── 7 named tiers → axes (ADR-014 §1) ─────────────────────────────────────────
export const TIER_PRESETS = Object.freeze({
  'public':         { identity: IDENTITY.PUBLIC,         scope: SCOPE.NONE },
  'webhook-authed': { identity: IDENTITY.WEBHOOK_SECRET, scope: SCOPE.NONE },
  'public-signing': { identity: IDENTITY.SIGNING_TOKEN,  scope: SCOPE.NONE },
  'ops-control':    { identity: IDENTITY.AUTHED_ANY,     scope: SCOPE.NONE },
  'admin':          { identity: IDENTITY.BOARD_ONLY,     scope: SCOPE.NONE },
  'org-shared':     { identity: IDENTITY.AUTHED_ANY,     scope: SCOPE.ORG },
  'viewer-scoped':  { identity: IDENTITY.AUTHED_ANY,     scope: SCOPE.OWNER },
});

// Most-restrictive default for an unmatched authed route (M2 fail-closed).
export const DEFAULT_TIER = 'viewer-scoped';

// ── Exact-match exceptions (METHOD /normalized-path → tier) ───────────────────
// Sensitive overrides that must not inherit their module's prefix tier.
// These are the seed classifications from known facts (the task's "Seed" list)
// plus the ambiguous routes that need a per-handler decision.
export const EXCEPTIONS = Object.freeze({
  // ── public (PUBLIC_ROUTES in api.js + OAuth bootstrap) ──────────────────────
  'GET /api/health': 'public',
  'GET /api/auth/github': 'public',
  'GET /api/auth/github/callback': 'public',
  'GET /api/auth/gmail-url': 'public',
  'GET /api/auth/gmail-callback': 'public',
  'GET /api/board-member': 'public',          // called during NextAuth OAuth before JWT exists
  'GET /api/public/events': 'public',
  'GET /api/public/events/feed': 'public',
  'GET /api/public/merkle': 'public',
  'GET /api/public/stats': 'public',

  // ── webhook-authed (own secret; never skipped — middleware-first) ───────────
  'POST /api/webhooks/tldv': 'webhook-authed',
  'POST /api/webhooks/assemblyai': 'webhook-authed',
  'POST /api/webhooks/:source': 'webhook-authed',
  'POST /api/voice-memo/upload': 'webhook-authed', // WEBHOOK_BEARER_VOICE_MEMO

  // ── ops-control (cron self-gates with CRON_SECRET) ──────────────────────────
  'POST /api/cron/explorer': 'ops-control',
  'GET /api/cron/explorer/status': 'ops-control',
  'POST /api/cron/signatures-sweep': 'ops-control',

  // ── admin (board-JWT-only; destructive control / governance boundary) ───────
  'POST /api/halt': 'admin',
  'POST /api/resume': 'admin',
  'POST /api/inject': 'admin',                 // manual event injection
  'POST /api/models/add': 'admin',
  'POST /api/models/remove': 'admin',
  'POST /api/models/sync': 'admin',            // model-sync
  'POST /api/agents/config': 'admin',          // agent reconfig
  'POST /api/agents/toggle': 'admin',          // enable/disable agents
  'POST /api/board-members': 'admin',
  'POST /api/board-members/role': 'admin',
  'PATCH /api/board-members/:id': 'admin',
  'DELETE /api/board-members/:id': 'admin',
  'POST /api/settings/keys': 'admin',          // secret/key management
  'POST /api/governance/directive': 'admin',   // create DIRECTIVE (board-only)
  'POST /api/governance/command': 'admin',
  'POST /api/governance/decide': 'admin',
  'POST /api/governance/autonomy/promote': 'admin',
  'POST /api/decisions/:id/verdict': 'admin',  // board verdict on strategic decision
  'POST /api/decisions/:id/reverse': 'admin',
  'POST /api/phase/activate': 'admin',         // phase transition
  'POST /api/spec-graph/reseed': 'admin',

  // ── OPT-37: customer-token administration → admin (board-only) ───────────────
  // Minting/rotating/revoking EXTERNAL customer credentials is a control-plane,
  // credential-issuing act. These MUST NOT inherit the '/api/auth/' prefix rule
  // (ops-control = authed-any), which would let an agent JWT mint customer tokens.
  // The in-handler requireBoardHuman + assertCallerInOrg gates are the enforcement;
  // this lifts them to board-only at the tier level. GET list is likewise board-only.
  'POST /api/auth/customer-token': 'admin',
  'POST /api/auth/customer-token/issue': 'admin',
  'POST /api/auth/customer-token/revoke': 'admin',
  'GET /api/customer-principals': 'admin',

  // prod deletes → admin
  'DELETE /api/contacts/:id': 'admin',
  'DELETE /api/documents': 'admin',
  'DELETE /api/projects/members': 'admin',
  'DELETE /api/wiki/page': 'admin',
  'DELETE /api/redesign/clear': 'admin',

  // ── ops-control: agent/operational queues + feed polling ────────────────────
  'POST /api/feeds/poll': 'ops-control',          // agent-driven RSS/source poll

  // ── ops-control: lifecycle / keep-alive (dead-man RENEW is ops, not admin) ──
  'POST /api/phase/dead-man-switch/renew': 'ops-control',
  'GET /api/phase/dead-man-switch': 'ops-control',
  'GET /api/phase/config': 'ops-control',
  'GET /api/phase/current': 'ops-control',
  'GET /api/phase/exploration': 'ops-control',

  // ── viewer-scoped seed set (per-user data) ──────────────────────────────────
  'GET /api/drafts': 'viewer-scoped',
  'GET /api/contacts': 'viewer-scoped',
  'GET /api/contacts/:id': 'viewer-scoped',
  'GET /api/today': 'viewer-scoped',
  'GET /api/today/brief': 'viewer-scoped',
  'GET /api/today/linear': 'viewer-scoped',
  'GET /api/today/tasks': 'viewer-scoped',
  'GET /api/today/meetings': 'viewer-scoped',
  'GET /api/today/meeting-attendees': 'viewer-scoped',
  'GET /api/provenance/:source_meeting_id': 'viewer-scoped', // OPT-2: board reads its org's meeting→work chain (visibleClause fail-closed)
  'GET /api/signals': 'viewer-scoped',         // STAQPRO-588: viewer-scoped
  'GET /api/signals/feed': 'viewer-scoped',
  'GET /api/signals/briefings': 'viewer-scoped',
  'GET /api/briefing': 'viewer-scoped',
  'GET /api/emails/body': 'viewer-scoped',
  'GET /api/inbox': 'viewer-scoped',

  // ── org-shared seed set ─────────────────────────────────────────────────────
  // /api/signatures: classify org-shared now; the board-JWT enforcement flip is
  // a follow-up (do NOT hard-enforce in this PR — ADR-014 §4 corollary).
  'GET /api/signatures': 'org-shared',
  'GET /api/signatures/:id': 'org-shared',
  'POST /api/signatures/create': 'org-shared',
  'POST /api/signatures/:id/revoke': 'org-shared',

  // ── STAQPRO-611: MCP capture write surface → org-shared ──────────────────────
  // Writes a KB document owned by the caller's org. identity=authed-any (any
  // board/agent token), scope=org. The handler derives owner_org_id from the
  // token (never the body), server-derives the dedup key, and enforces a per-user
  // daily cap — see src/api-routes/ingest.js.
  'POST /api/ingest': 'org-shared',

  // ── OPT-92: artifact registry → org-shared ──────────────────────────────────
  // The registry is org-scoped data over content.documents. identity=authed-any
  // (any board/agent token), scope=org. The write handler derives owner_org_id
  // from the token (never the body), server-derives the dedup keys, enforces a
  // per-user daily cap; the reads apply visibleClause(owner_org_id) fail-closed —
  // see src/api-routes/artifacts.js.
  'POST /api/artifacts': 'org-shared',
  'GET /api/artifacts': 'org-shared',
  'GET /api/artifacts/:id': 'org-shared',

  // ── OPT-93: on-demand enrichment reads → org-shared ─────────────────────────
  // Per-entity artifact links + derived facts; reads apply visibleClause(
  // owner_org_id) fail-closed (a Staqs viewer never sees a UMB entity's links/
  // facts) — see src/api-routes/artifacts.js (entityEnrichment).
  'GET /api/artifacts/enrich/contact/:id': 'org-shared',
  'GET /api/artifacts/enrich/project/:id': 'org-shared',

  // ── OPT-94: link-management surface → org-shared ────────────────────────────
  // The board review queue, precision-SLO stats, and the confirm/reject mutation
  // over content.artifact_entity_links. identity=authed-any, scope=org; the reads
  // apply visibleClause(owner_org_id) fail-closed and the PATCH additionally
  // requires a privileged writer (board human OR verified agent) IN THE HANDLER —
  // see src/api-routes/artifacts.js (requirePrivilegedWriter). The in-handler gate
  // is the same pattern as the flow write surface (POST/DELETE /api/flows), which
  // is likewise classified org-shared at the tier level.
  'GET /api/artifacts/links/pending': 'org-shared',
  'GET /api/artifacts/links/stats': 'org-shared',
  'PATCH /api/artifacts/links/:id': 'org-shared',

  // ── OPT-96 (Feature 005): capture-sources board surface → org-shared ─────────
  // The board-managed per-org registry of passive capture sources. identity=
  // authed-any, scope=org. The GET list applies visibleClause(owner_org_id)
  // fail-closed. The POST (create) and PATCH (edit) additionally require a board
  // HUMAN in the handler (requireBoardHuman) — the same board-human + org-scoped
  // pattern as PATCH /api/artifacts/links/:id above, classified org-shared at the
  // tier level (the in-handler gate is stricter than the tier). owner_org_id is
  // validated against tenancy.orgs and stamped from a validated row, never an
  // untrusted body — see src/api-routes/capture-sources.js.
  'POST /api/capture-sources': 'org-shared',
  'GET /api/capture-sources': 'org-shared',
  'PATCH /api/capture-sources/:id': 'org-shared',

  // ── OPT-46: Slack channel ↔ project/engagement mapping → org-shared ─────────
  // Board-managed per-org registry mapping Slack channels to projects/engagements.
  // identity=authed-any, scope=org. POST/DELETE additionally require requireBoardHuman
  // in the handler (same pattern as capture-sources). org_id is stamped from the
  // validated principal — never from the untrusted request body.
  'POST /api/slack/project-map': 'org-shared',
  'GET /api/slack/project-map': 'org-shared',
  'DELETE /api/slack/project-map/:channelId': 'org-shared',

  // ── OPT-101 (Feature 006): Drive picker → admin (board-only) ────────────────
  // The Drive folder/shared-drive picker. These read the AUTHENTICATED caller's
  // OWN Google Drive structure via DWD impersonation (the impersonated email is
  // derived server-side from board_members.email — NEVER from the request). There
  // is no Optimus org-data tenancy to scope here (Google's ACL does the scoping
  // via the impersonated identity), but they expose Drive structure and carry a
  // SENSITIVE impersonation surface, so they are BOARD-ONLY (identity=board-only,
  // scope=none = 'admin' tier). The in-handler requireBoardHuman gate is the
  // enforcement; this exception lifts them OUT of the broad '/api/drive/' prefix
  // rule (ops-control = authed-any) below, which would be too permissive — an
  // agent JWT must never browse a board member's Drive. See
  // src/api-routes/drive-picker.js + resolveImpersonationEmail in api.js.
  'GET /api/drive/shared-drives': 'admin',
  'GET /api/drive/folders': 'admin',

  // ── Feature 007: meeting registry (content.meetings identity layer) ─────────
  // identity=authed-any, scope=org. Reads apply visibleClause with BOTH
  // ownerUserCol='owner_id' (Tier-1 personal meetings) and owner_org_id
  // (Tier-2 org-shared) fail-closed; the cross-scope peer link runs under the
  // SAME predicate. The promote POST additionally requires the personal OWNER
  // in the handler (consent boundary; stricter than the tier) and passes the
  // meeting row's own org to the trusted core, never the body — see
  // src/api-routes/meeting-registry.js.
  'GET /api/meeting-registry': 'org-shared',
  'GET /api/meeting-registry/:id': 'org-shared',
  'POST /api/meeting-registry/:id/promote': 'org-shared',
  // Configurable D4 source precedence (per-org / per-user). GET reads the
  // caller's resolved layers; PATCH sets user-level (any member, own override)
  // or org-level (requireBoardHuman in the handler — stricter than the tier).
  // owner_org_id is token-derived, never the body. See meeting-registry.js +
  // lib/content/meeting-prefs.js.
  'GET /api/meeting-registry/source-precedence': 'org-shared',
  'PATCH /api/meeting-registry/source-precedence': 'org-shared',

  // ── STAQPRO-597: /api/runs ("Runs" monitoring alias) → org-shared ───────────
  // The runs API enumerates agent_graph.work_items (the root work-item DAG), NOT
  // agent_graph.campaigns as the issue background assumed. work_items DID get
  // owner_org_id (migration 134), so /api/runs serves PER-ORG rows and is a
  // 596-class enumeration vector when unscoped. Classify org-shared (authed-any
  // + scope=org), and the LIST handler (GET /api/runs) now applies
  // visibleClause(owner_org_id) — see src/api-routes/runs.js. The /tree,
  // /activity, /transitions sub-routes take an explicit run id and read the
  // subtree of a single work item; the root id lookup is org-gated, the
  // recursive child reads inherit the root's org (a child cannot belong to a
  // different org than its root run). Previously these resolved
  // via='prefix' to ops-control (no per-tenant scope) — a deliberate
  // misclassification this entry corrects.
  'GET /api/runs': 'org-shared',
  'GET /api/runs/tree': 'org-shared',
  'GET /api/runs/activity': 'org-shared',
  'GET /api/runs/transitions': 'org-shared',

  // ── STAQPRO-597: explicit per-route classification of the routes that were ──
  // previously covered only by a broad viewer-scoped FAMILY PREFIX rule (lines
  // in PREFIX_RULES for /api/contacts, /api/chat, /api/voice, /api/voice-prints,
  // /api/calendar, /api/meetings, /api/drafts, /api/emails, /api/signals). Those
  // family rules picked the most-restrictive tier (viewer-scoped) as a
  // fail-closed default for the whole module. Per ADR-014 M2 / STAQPRO-597 every
  // route must carry an EXPLICIT, handler-vetted decision rather than inherit a
  // module default. Handler evidence (api.js + api-routes/{calendar,voice-prints,
  // meetings,agents}.js) confirms each reads per-user / per-voice / per-contact
  // data (signal.contacts, voice.*, inbox.calendar_*, chat sessions, drafts,
  // emails, signals) — viewer-scoped is correct, now stated explicitly so the
  // classification no longer relies on the catch-all family prefix. The family
  // prefix rules are retained below as a fail-closed backstop for any NEW route
  // added to these modules before it gets its own exception.
  'GET /api/calendar/day': 'viewer-scoped',
  'GET /api/calendar/months': 'viewer-scoped',
  'GET /api/calendar/watches': 'viewer-scoped',
  'POST /api/calendar/watches': 'viewer-scoped',
  'POST /api/calendar/watches/backfill': 'viewer-scoped',
  'POST /api/calendar/watches/remove': 'viewer-scoped',
  'GET /api/chat/history': 'viewer-scoped',
  'GET /api/chat/sessions': 'viewer-scoped',
  'POST /api/chat/sessions': 'viewer-scoped',
  'PATCH /api/chat/sessions': 'viewer-scoped',
  'DELETE /api/chat/sessions': 'viewer-scoped',
  'POST /api/chat/sessions/title': 'viewer-scoped',
  'POST /api/chat/session': 'viewer-scoped',
  'POST /api/chat/message': 'viewer-scoped',
  'POST /api/chat/auto': 'viewer-scoped',
  'POST /api/chat/stream': 'viewer-scoped',
  'POST /api/chat/feedback': 'viewer-scoped',
  'GET /api/contacts/duplicates': 'viewer-scoped',
  'GET /api/contacts/:id/connections': 'viewer-scoped',
  'GET /api/contacts/:id/deals': 'viewer-scoped',
  'GET /api/contacts/:id/identities': 'viewer-scoped',
  'GET /api/contacts/:id/strength': 'viewer-scoped',
  'GET /api/contacts/:id/tags': 'viewer-scoped',
  'POST /api/contacts/:id': 'viewer-scoped',
  'POST /api/contacts/:id/identities': 'viewer-scoped',
  'POST /api/contacts/:id/projects': 'viewer-scoped',
  'POST /api/contacts/:id/projects/remove': 'viewer-scoped',
  'POST /api/contacts/:id/split-identities': 'viewer-scoped',
  'POST /api/contacts/:id/tags': 'viewer-scoped',
  'POST /api/contacts/:id/unmerge': 'viewer-scoped',    // OPT-81: reverse soft auto-merge
  'DELETE /api/contacts/:id/tags/:tag': 'viewer-scoped',
  'POST /api/contacts/auto-merge': 'viewer-scoped',     // OPT-81: scored soft-merge pass
  'POST /api/contacts/classify': 'viewer-scoped',
  'POST /api/contacts/merge': 'viewer-scoped',
  'POST /api/contacts/sync': 'viewer-scoped',
  'GET /api/meetings': 'viewer-scoped',
  'GET /api/meetings/:id': 'viewer-scoped',
  'GET /api/voice/edits': 'viewer-scoped',
  'GET /api/voice/profiles': 'viewer-scoped',
  'GET /api/voice/status': 'viewer-scoped',
  'POST /api/voice/bootstrap': 'viewer-scoped',
  'POST /api/voice/rebuild': 'viewer-scoped',
  'GET /api/voice-prints': 'viewer-scoped',
  'GET /api/voice-prints/unenrolled': 'viewer-scoped',
  'POST /api/voice-prints/enroll': 'viewer-scoped',
  'POST /api/voice-prints/unenrolled/:id/approve': 'viewer-scoped',
  'DELETE /api/voice-prints/:id': 'viewer-scoped',
  'DELETE /api/voice-prints/unenrolled/:id': 'viewer-scoped',
  'POST /api/drafts/approve': 'viewer-scoped',
  'POST /api/drafts/bulk': 'viewer-scoped',
  'POST /api/drafts/edit': 'viewer-scoped',
  'POST /api/drafts/reject': 'viewer-scoped',
  'POST /api/drafts/send': 'viewer-scoped',
  'POST /api/drafts/send-approved': 'viewer-scoped',
  'POST /api/emails/archive': 'viewer-scoped',
  'POST /api/emails/unarchive': 'viewer-scoped',
  'POST /api/signals': 'viewer-scoped',
  'POST /api/signals/feedback': 'viewer-scoped',
  'GET /api/signals/feedback/metrics': 'viewer-scoped',
  'POST /api/signals/resolve': 'viewer-scoped',
  'POST /api/signals/unresolve': 'viewer-scoped',

  // ── ADR-017: knowledge share grants (user-tier; every route anchors on
  // the calling principal, granter/target authorization in lib/sharing/grants.js)
  'GET /api/sharing/grants': 'viewer-scoped',
  'GET /api/sharing/me': 'viewer-scoped',
  'GET /api/sharing/pending-count': 'viewer-scoped',
  'POST /api/sharing/grants': 'viewer-scoped',
  'POST /api/sharing/grants/:id/accept': 'viewer-scoped',
  'POST /api/sharing/grants/:id/decline': 'viewer-scoped',
  'POST /api/sharing/grants/:id/revoke': 'viewer-scoped',
  'POST /api/sharing/principals/resolve': 'viewer-scoped',
  'GET /api/sharing/collections': 'viewer-scoped',
  'POST /api/sharing/collections': 'viewer-scoped',
  'POST /api/sharing/collections/:id/members': 'viewer-scoped',
  'DELETE /api/sharing/collections/:id': 'viewer-scoped',
  'GET /api/sharing/groups': 'viewer-scoped',
  'POST /api/sharing/groups': 'viewer-scoped',
  'POST /api/sharing/groups/:id/members': 'viewer-scoped',
  'DELETE /api/sharing/groups/:id': 'viewer-scoped',
  'GET /api/sharing/topics': 'viewer-scoped',
  'POST /api/sharing/topics': 'viewer-scoped',
  'POST /api/sharing/topics/:id/assign': 'viewer-scoped',
  'DELETE /api/sharing/topics/:id': 'viewer-scoped',
  'GET /api/sharing/metrics': 'viewer-scoped',

  // ── OPT-76 (T1-F): Federation grant/query/revocations ───────────────────────
  // POST /api/federation/grant → admin (board-only, credential-issuing, control-plane).
  //   Issuing a cross-org capability receipt is a high-trust act equivalent to
  //   minting a customer token — it must require a board human. Never an agent JWT.
  // GET /api/federation/query → ops-control (receipt-authenticated in-handler).
  //   The grant receipt is a signed bearer token. At the tier level this is
  //   authed-any so the middleware passes it through; the handler verifies the
  //   JWS receipt itself (a separate credential type, not a board JWT). Using
  //   ops-control (authed-any/none) matches the customer-surface pattern where
  //   the handler bears the full auth responsibility.
  // GET /.well-known/federation/revocations.json → public (RFC-standard discovery).
  //   Published revocation list required by all federation peers; no auth.
  'POST /api/federation/grant':                     'admin',
  'GET /api/federation/query':                      'ops-control',
  'GET /.well-known/federation/revocations.json':   'public',
});

// ── Ordered prefix/module rules (M2) ──────────────────────────────────────────
// One decision per module. First match wins; order matters (most specific first
// within a module family). An unmatched authed route falls to DEFAULT_TIER.
// `match(method, key)` returns the tier name or null.
export const PREFIX_RULES = Object.freeze([
  // public bypass families (token / own-secret)
  { test: (m, p) => p.startsWith('/api/sign/'),       tier: 'public-signing' },
  { test: (m, p) => p.startsWith('/api/webhooks/'),   tier: 'webhook-authed' },

  // Front door (feature 008): published-only corpus reads + anonymous clamped
  // visit beacon, consumed by site frontends with no Optimus principal.
  // Reads expose screened/sanitized marketing copy only; the beacon is
  // IP-rate-limited in the handler.
  { test: (m, p) => p.startsWith('/api/front-door/'), tier: 'public' },

  // agent-driven pipelines → ops-control (no per-viewer data)
  { test: (m, p) => p.startsWith('/api/redesign/'),   tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/blueprint/'),  tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/cron/'),        tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/phase/'),       tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/services/'),    tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/runners'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/explorer'),     tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/distribution/'),tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/transcripts/'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/triage'),       tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/spec-graph/'),  tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/spec-proposals'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/linear/'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/github/'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/drive/'),       tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/debug'),        tier: 'ops-control' },

  // agent status/config READS + ingest → ops-control (writes overridden in EXCEPTIONS)
  { test: (m, p) => p.startsWith('/api/agents'),       tier: 'ops-control' },
  { test: (m, p) => p === '/api/agent-activity',       tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/documents/ingest'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/documents/embed'),  tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/documents/reembed'),tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/pipeline/'),    tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/runs'),         tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/audit'),        tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/gates'),        tier: 'ops-control' },
  // OPT-82: per-agent trust scores (P5) — read-only operational metrics, observe-only.
  { test: (m, p) => p.startsWith('/api/trust'),        tier: 'ops-control' },
  // OPT-74: telegram inbound/outbound observability — read-only ops surface.
  { test: (m, p) => p.startsWith('/api/telegram'),     tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/guardrails'),   tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/constitutional'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/finance'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/value'),        tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/metrics'),      tier: 'ops-control' },
  { test: (m, p) => p === '/api/stats',                tier: 'ops-control' },
  { test: (m, p) => p === '/api/status',               tier: 'ops-control' },
  { test: (m, p) => p === '/api/halt-status',          tier: 'ops-control' },
  { test: (m, p) => p === '/api/health',               tier: 'public' },
  { test: (m, p) => p === '/api/events',               tier: 'ops-control' },
  { test: (m, p) => p === '/api/tasks/trace',          tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/governance/'),  tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/decisions'),    tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/research'),     tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/intents'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/needs-attention'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/config/'),      tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/settings/'),    tier: 'ops-control' },
  { test: (m, p) => p === '/api/preferences',          tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/board-members'),tier: 'ops-control' },
  { test: (m, p) => p === '/api/board-member',         tier: 'public' },
  { test: (m, p) => p.startsWith('/api/board'),        tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/models'),       tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/weekly-recap'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/workstation'),  tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/strategic-decisions'), tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/accounts'),     tier: 'ops-control' },
  { test: (m, p) => p.startsWith('/api/auth/'),        tier: 'ops-control' },

  // signatures family → org-shared (board-JWT enforcement flip deferred)
  { test: (m, p) => p.startsWith('/api/signatures'),   tier: 'org-shared' },

  // org-shared families (org-scoped reads/writes; visibleClause(org) obligation)
  { test: (m, p) => p.startsWith('/api/contracts'),    tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/counterparties'), tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/brand-profiles'), tier: 'org-shared' }, // content.brand_profiles — org-level branding (was unclassified, OPT-37)
  { test: (m, p) => p.startsWith('/api/engagements'),  tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/organizations'),tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/tenancy'),      tier: 'org-shared' }, // GET /api/tenancy/orgs — caller's own tenancy.orgs (readOrgIds-scoped), owning-org picker source
  { test: (m, p) => p.startsWith('/api/deals'),        tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/relationship-health'), tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/relationships'),tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/projects'),     tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/wiki'),         tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/campaigns'),    tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/runs'),         tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/flows'),        tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/content'),      tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/documents'),    tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/artifacts'),    tier: 'org-shared' }, // OPT-92: artifact registry by org
  { test: (m, p) => p.startsWith('/api/capture-sources'), tier: 'org-shared' }, // OPT-96: capture sources by org
  { test: (m, p) => p.startsWith('/api/slack/project-map'), tier: 'org-shared' }, // OPT-46: Slack channel↔project mapping
  { test: (m, p) => p.startsWith('/api/search'),       tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/activity'),     tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/human-tasks'),  tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/tags'),         tier: 'org-shared' },
  { test: (m, p) => p.startsWith('/api/actions'),      tier: 'org-shared' }, // operational queues (campaigns/PRs/triage)
  { test: (m, p) => p.startsWith('/api/feeds'),        tier: 'org-shared' }, // content.research_sources by project

  // viewer-scoped families (per-user data; visibleClause(owner) obligation)
  { test: (m, p) => p.startsWith('/api/drafts'),       tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/contacts'),     tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/today'),        tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/signals'),      tier: 'viewer-scoped' },
  { test: (m, p) => p === '/api/briefing',             tier: 'viewer-scoped' },
  { test: (m, p) => p === '/api/inbox',                tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/emails'),       tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/calendar'),     tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/meetings'),     tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/chat'),         tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/voice-prints'), tier: 'viewer-scoped' },
  { test: (m, p) => p.startsWith('/api/voice'),        tier: 'viewer-scoped' },
]);

function tierToAxes(tier) {
  const axes = TIER_PRESETS[tier];
  if (!axes) throw new Error(`route-tiers: unknown tier '${tier}'`);
  return axes;
}

/**
 * Classify a route into its access tier + axes.
 *
 * @param {string} method  HTTP method (GET/POST/...)
 * @param {string} pathname  raw request path OR an already-normalized Map key path
 * @returns {{ tier, identity, scope, via, key }}
 *   via ∈ 'exception' | 'prefix' | 'default'
 *   key = the normalized route key the dispatcher consults (or `${method} ${pathname}` if unmatched)
 *
 * M3: normalizes through routeKeyFor() — the SAME function matchRoute() uses —
 * so the classification never diverges from the runtime route key.
 */
export function classify(method, pathname) {
  // Normalize to the canonical Map key (parameterized :id, regex routes).
  const normKey = routeKeyFor(method, pathname) || `${method} ${pathname}`;
  // normKey is `METHOD /path`; split once.
  const sp = normKey.indexOf(' ');
  const m = normKey.slice(0, sp);
  const normPath = normKey.slice(sp + 1);

  // 1. exact-match exception (sensitive overrides)
  const exc = EXCEPTIONS[normKey];
  if (exc) {
    return { tier: exc, ...tierToAxes(exc), via: 'exception', key: normKey };
  }

  // 2. ordered prefix/module rules
  for (const rule of PREFIX_RULES) {
    if (rule.test(m, normPath)) {
      return { tier: rule.tier, ...tierToAxes(rule.tier), via: 'prefix', key: normKey };
    }
  }

  // 3. most-restrictive fail-closed default
  return { tier: DEFAULT_TIER, ...tierToAxes(DEFAULT_TIER), via: 'default', key: normKey };
}

/**
 * Enforce-mode identity gate (ADR-014 §1). PURE function — no I/O — so it is
 * unit-testable directly (M: test the gate function, not via prod). This is the
 * code path used when a tier's mode === 'enforce'. In Phase 0 every tier is
 * 'observe' so this is never reached at runtime; it is present and tested so
 * the enforce flip (follow-up) is a config change, not new code.
 *
 * @param {string} identity  one of IDENTITY.*
 * @param {object|null} auth  the resolved req.auth (null = unauthenticated)
 * @param {string} via  classify().via — 'default' means bare-fallback (unclassified)
 * @returns {{ allow: boolean, status?: 401|403, reason?: string }}
 */
export function identityGate(identity, auth, via) {
  // An unclassified bare-default route is treated as deny in enforce mode.
  if (via === 'default') {
    return { allow: false, status: 403, reason: 'unclassified' };
  }
  switch (identity) {
    case IDENTITY.PUBLIC:
      return { allow: true };
    case IDENTITY.WEBHOOK_SECRET:
      // Webhook's own secret is checked in the handler — the gate only declines
      // to require a board JWT. Allow through to the handler's own check.
      return { allow: true };
    case IDENTITY.SIGNING_TOKEN:
      // Signing token validated in the handler.
      return { allow: true };
    case IDENTITY.AUTHED_ANY:
      if (!auth) return { allow: false, status: 401, reason: 'auth-required' };
      return { allow: true };
    case IDENTITY.BOARD_ONLY:
      // A real human board viewer only. The source checks are LOAD-BEARING, not
      // redundant with the role check: legacy api_secret resolves to role:'board'
      // (api.js — `sub:'legacy'`), so the role check ALONE would let a bare
      // shared secret reach destructive admin ops. Reject by source FIRST
      // (agent_jwt = autonomous agent; bare api_secret = no human viewer), then
      // role as the catch-all (ADR-014 M4/M7: never agent JWT, never
      // api_secret-without-viewer).
      if (!auth) return { allow: false, status: 401, reason: 'auth-required' };
      if (auth.source === 'agent_jwt') {
        return { allow: false, status: 403, reason: 'board-only:agent-jwt' };
      }
      if (auth.source === 'api_secret' && !auth.github_username) {
        return { allow: false, status: 403, reason: 'board-only:bare-api-secret' };
      }
      if (auth.role !== 'board') {
        return { allow: false, status: 403, reason: 'board-only' };
      }
      return { allow: true };
    default:
      return { allow: false, status: 403, reason: 'unclassified-identity' };
  }
}
