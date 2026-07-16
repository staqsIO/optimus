# ADR-009: Board↔Backend AuthZ Boundary — the Endpoint is the Gate, the Proxy is Defense-in-Depth

**Date**: 2026-05-30
**Status**: Proposed (pending Dustin review — security boundary, per root CLAUDE.md)
**Issue**: STAQPRO-540 (`/api/ops` board proxy has no path allowlist — second unrestricted door to backend). Discovered during STAQPRO-534 review; same bug class as STAQPRO-531.

---

## Context

### The trigger

The Board Workstation (`board/`, Next.js, board.staqs.io) reaches the autobot-inbox Express backend through **two** server-side proxies that both attach the shared `Authorization: Bearer ${API_SECRET}` and a forwarded `X-Board-User` identity:

- **`/api/inbox-proxy`** (`board/src/app/api/inbox-proxy/route.ts`) — has an explicit path allowlist (`ALLOWED_PATHS` / `ALLOWED_PREFIXES`, **110 entries**). Hardened by STAQPRO-531/537.
- **`/api/ops`** (`board/src/app/api/ops/route.ts`, client helper `opsFetch`/`opsPost`/`opsPatch`/`opsDelete` in `board/src/lib/ops-api.ts`) — has only `validatePath()`: must start with `/api/`, no `..`, no `@#`, and a constructed-URL origin check. **This is sanitization, not an allowlist.** It proxies ANY `/api/*` backend path.

Most board pages (signals, contracts-verify, activity, chat, governance, …) use `opsFetch`. Measured surface: **~161 distinct path patterns across 385 call sites** flow through `/api/ops`. Because that door is open, the `/api/inbox-proxy` allowlist is bypassed for the majority of board traffic.

### Why this is the same bug class as STAQPRO-531

STAQPRO-531 fixed a multi-tenant data leak where `inbox-proxy` dropped viewer identity and the backend's `api_secret` path returned global (all-owner) data. The fix scoped a handful of endpoints (drafts, contacts, today, signals-contacts, briefings) to the forwarded viewer and made a bare shared secret resolve to **empty**, not adminBypass.

`/api/ops` reopens the same hole for the entire un-audited surface. Two facts make this concrete:

1. **The scoping primitive does not reach the route modules.** `resolveViewerEmails(req)` and `mayReadOrgShared()` are defined only in `autobot-inbox/src/api.js` — there are **zero references in the `api-routes/*.js` modules** (agents, content, contracts, counterparties, deals, documents, engagements, feeds, governance, projects, services, signing, triage). Of ~195 total backend route registrations, only ~5 are confirmed viewer-scoped.
2. **A logged-in board member resolves to a real owner.** `api.js` sets `req.auth.github_username = req.headers['x-board-user']`; `resolveViewerEmails` keys on that and yields a real owner with `mayReadOrgShared=true`. STAQPRO-531's empty-result safety therefore only protects *unidentified* callers (bare secret, no `x-board-user`) — **not board member A reaching board member B's data** on any reachable-but-unscoped endpoint.

So today there is effectively **zero** proxy-layer boundary — not a weakened one. `/api/ops` is wide open and bypasses inbox-proxy's allowlist.

### The decision the ticket framed

- **(a) Allowlist** `/api/ops` to the needed path set (make the proxy the gate), or
- **(b) Declare** `/api/ops` the "trusted board channel," treat the allowlist as defense-in-depth, and audit every backend `/api/*` handler for server-side scoping (the endpoint is the gate).

---

## Decision

**Hybrid, weighted to (b): the endpoint is the authorization gate; the proxy allowlist is defense-in-depth.** Three decisions:

### 1. A path allowlist protects reachability, not data — so the proxy is not the right place for the authZ boundary

The proxy receives `{path, body}` and a forwarded identity. It never sees rows or row-ownership, so it cannot evaluate the only question that matters: *can this viewer see this row?* Authorization is a function of `(viewer, row)`; the proxy sees neither. Encoding a data-access policy in the proxy violates **P2** (infrastructure enforces; the enforcement boundary must be capable of evaluating the policy) and rots the moment a parameterized route (`/api/contracts/:id/edit`, `?owner=`) is added. Allowlisting `/api/ops` shrinks the surface from ~195 routes to ~161 patterns but leaves the actual hole — any board member reading any owner's data — wide open. **Option (a) alone is reachability theater.**

### 2. The boundary is created at the backend endpoint, via deny-by-default — not by auditing 195 handlers

Option (b) as literally written ("audit every handler") is O(n) human review with no enforcement: the 196th route ships unscoped, and an audit is neither **P5** (measure, don't trust) nor **P2** (infrastructure enforces). Scoping today is **opt-in** per handler (remember to call `resolveViewerEmails` and filter) — which is exactly why only ~5 of ~195 routes are scoped.

Flip it to **opt-out via a single route-tier classifier middleware**, mounted ahead of the routers in `autobot-inbox/src/api.js`:

- A single classification table maps each route (prefix/regex) to a tier: **`viewer-scoped`** (owner's private data) | **`org-shared`** (data any board member may read, gated by `mayReadOrgShared`) | **`ops-control`** (halt/resume/scheduler/governance controls) | **`public`** (health, OAuth callbacks, webhooks).
- The middleware resolves the viewer once, attaches `req.viewer`, and **denies any request whose path matches no tier** (P1, deny by default). A newly registered route with no tier entry returns 403 until classified. This is the forcing function an audit lacks.
- `viewer-scoped` / `org-shared` access is gated structurally at the boundary; handlers additionally apply row-level `WHERE owner = $1` (defense in depth), but the gate no longer depends on each handler remembering to.

This collapses the work from O(195 handlers) to **O(1 middleware + 1 classification table)**. The table becomes the single auditable artifact — reviewable in one file, diffed in every PR — instead of a policy scattered across 195 call sites.

### 3. The proxy allowlist stays, as the outer (defense-in-depth) layer

After the endpoint gate exists, an allowlist on `/api/ops` (mirroring inbox-proxy's `ALLOWED_PREFIXES`) is a legitimate second layer — it constrains reachability so a bug in tier classification has a smaller blast radius. It is added *after* the boundary, never *as* the boundary.

---

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|---|---|---|---|
| (a) Allowlist `/api/ops` only | Cheap, mechanical, lands in a day | Protects reachability, not data; two large drifting allowlists (110 + ~161); does not close the cross-viewer leak | Theater for any unscoped endpoint; leaves the real hole open |
| (b) as written — audit 195 handlers | Conceptually correct (endpoint is the gate) | No enforcement; the next route ships unscoped; O(n) human review; violates P5/P2 | Right target, wrong mechanism — an audit is not infrastructure |
| Postgres RLS keyed on the agent/viewer role | Strongest isolation; DB-enforced | The pool connects as the `postgres.<project>` superuser today (bypasses RLS — see ADR-018 PR-B); high-risk, needs a planned window | Prerequisite not yet met; orthogonal and slower; pursue independently |
| External policy engine (OPA / Cedar) | Purpose-built | New service dependency; violates P4 (boring infrastructure); the scoping primitives already exist in `api.js` | Over-engineering; reuse what exists |
| **Hybrid: endpoint-gate via classifier middleware + proxy allowlist as defense-in-depth (chosen)** | Real boundary in one chokepoint; deny-by-default forcing function; defense in depth; P1/P2/P4/P5 aligned | Requires classifying ~195 routes once (but in one table, enforced) | Selected |

---

## Consequences

**Positive:**
- A real authorization boundary exists where it can actually evaluate the policy (the endpoint, with `req.viewer` and the row in hand).
- Deny-by-default (P1) on unclassified routes: future routes cannot silently ship unscoped — they 403 until classified.
- The classification table is a single, reviewable, diffable artifact — auditability by structure (P3), not by effort.
- The two proxies converge on a coherent model: both become defense-in-depth in front of an enforcing backend.
- Restores P2: enforcement is infrastructure (middleware + DB filter), not a per-handler convention an author may forget.

**Negative / Risks:**
- Classifying ~195 routes is real one-time work. Mitigation: it is one table; deny-by-default means an incomplete table fails closed (a missed route 403s, it does not leak), so the work can land incrementally without a security gap.
- Misclassifying a `viewer-scoped` route as `org-shared` (or `public`) would leak. Mitigation: tests assert tier for sensitive routes; `public` membership requires explicit justification in review; the row-level `WHERE owner` filter remains as a second layer.
- Latency: resolving the viewer once per request in middleware. Negligible — it already happens for scoped routes; this centralizes rather than adds it.
- Ship-0 (the allowlist) can be mistaken for "done." Mitigation: this ADR exists precisely to prevent that; STAQPRO-540 is explicitly re-scoped to the stopgap, with STAQPRO-542 owning the real fix.

**Neutral:**
- No change to the shared `API_SECRET` transport or to `X-Board-User` forwarding (STAQPRO-534 already fixed forwarding the unambiguous `username`).
- Board UI is unaffected at the page level; only un-scoped endpoints change behavior (they begin enforcing).

---

## Relationship to Existing Decisions

- **Generalizes STAQPRO-531**: 531 scoped ~5 endpoints by hand. This ADR makes per-endpoint viewer scoping the *structural default* for the whole surface rather than a per-handler opt-in.
- **Builds toward ADR-018** (JWT-scoped agent identity, STAQPRO-263): the classifier middleware is the application-layer boundary; ADR-018's PR-B (pool connects as `autobot_agent`, enabling RLS) is the deeper DB-layer boundary. They compose — middleware now, RLS later — and are not mutually exclusive.
- **Consistent with ADR-002** (individual install over multi-tenant): even single-install, board members are distinct viewers; "viewer-scoped" is the per-member boundary within one org install.
- **Does not affect ADR-007 / ADR-008**: federation and the signal→action bridge are orthogonal to the board↔backend HTTP authZ boundary.

---

## Implementation

Sequenced as three landable units, each its own Linear issue:

- **Ship-0 — STAQPRO-540 (stopgap, this week):** Add a prefix/regex allowlist to `validatePath()` in `board/src/app/api/ops/route.ts`, generated from the ~161 measured `ops*` path patterns, mirroring inbox-proxy's `ALLOWED_PREFIXES`. Closes the "arbitrary `/api/*`" reachability door. Explicitly a stopgap — it does **not** close the cross-viewer data leak. Pair with a backend default-deny on unknown paths so the two proxies converge. Acceptance: a non-allowlisted path is rejected (test).
- **Ship-1 — STAQPRO-542 (the real boundary):** Route-tier classifier middleware in `autobot-inbox/src/api.js`, mounted ahead of the `api-routes/*` routers, keyed on `req.viewer`. Classification table covering all ~195 routes; CI/test fails if a registered route has no tier entry; tests assert unclassified → 403 and that board member A cannot read board member B's `viewer-scoped` data via `/api/ops`. A feature spec (`spec/features/NNN-route-tier-enforcement.md`) precedes implementation.
- **This ADR — STAQPRO-543:** the decision record (done).

**SPEC references**: P1 deny-by-default, P2 infrastructure enforces, P3 transparency by structure, P4 boring infrastructure, P5 measure before trust (§0); guardrail enforcement (§5).

---

## Affected Files

- `board/src/app/api/ops/route.ts` — Ship-0: add prefix/regex allowlist to `validatePath()`.
- `board/src/lib/ops-api.ts` — no change expected; client helpers already pass full paths.
- `autobot-inbox/src/api.js` — Ship-1: mount route-tier classifier middleware ahead of routers; promote `resolveViewerEmails`/`mayReadOrgShared` into a shared module the middleware and `api-routes/*` can both import.
- `autobot-inbox/src/api-routes/*.js` — Ship-1: routes inherit the tier gate; row-level `WHERE owner` filters retained as defense in depth.
- (new) route classification table — Ship-1: single source of truth for path→tier, location TBD in the feature spec (colocated with `api.js` or `config/`).
- `board/src/app/api/inbox-proxy/route.ts` — unchanged; its 110-entry allowlist is reframed as defense-in-depth alongside `/api/ops`'s.

## Cross-Project Impact

Scoped to `~/Optimus`. The `autobot-inbox` backend gains the enforcing boundary; the `board/` workstation gains the Ship-0 allowlist. No other sub-project is affected.
