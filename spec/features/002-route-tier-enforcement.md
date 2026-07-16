# 002 — Route-Tier Enforcement (deny-by-default authZ boundary)

> Feature spec for **STAQPRO-542**. Status: **DESIGN — awaiting board sign-off on tier taxonomy + rollout before implementation** (the issue lists an ADR + this spec as a precondition).

## Context

Today, data scoping at the backend is **opt-in per handler**: a route is only tenant-safe if its author remembered to resolve a viewer/principal and append `visibleClause`. The 588 (signals) and 596 (`/today`) leaks were both handlers that forgot. An "audit every handler" approach has no enforcement — the next route ships unscoped.

The fix is a **structural forcing function**: a classification table that must name a tier for *every* route, a middleware that resolves the viewer once and **denies any unclassified path** (P1 deny-by-default, P2 infra-enforces), and a CI test that fails if a registered route has no tier entry. This collapses the audit from O(routes) to O(1 middleware + 1 table).

### Reality check (changes the issue's assumptions)
- **434 registered routes**, not ~195 (api.js: 66; api-routes/*: 368 across 50 modules). 2.3× the estimate — classification and blast-radius are correspondingly larger.
- **`/api/ops` no longer exists** in the codebase. The issue's "proxy second door" framing is stale; the board (Next.js) calls the backend directly with a board JWT / `x-board-user`. The live risk is **board member A reading member B's data** through any of the ~404 routes that don't self-scope (only ~5 do).
- Single dispatch choke point already exists: `autobot-inbox/src/api.js` server handler (~L4585–4706), where auth is resolved before `handler(req, body)`. The middleware mounts here.

## User stories
- **As the platform**, every backend route MUST carry an explicit tier, so a new route cannot ship reachable-but-unclassified.
- **As board member A**, I MUST NOT be able to read board member B's viewer-scoped data through any route.
- **As an operator**, I want a single diffable table that says what each route's access tier is, reviewed in PRs.

## Tier taxonomy (proposed — needs board sign-off)
| Tier | Meaning | Middleware gate | Handler obligation |
|---|---|---|---|
| `public` | No auth (health, OAuth callbacks, webhooks w/ own secret) | none | — |
| `ops-control` | Internal agent/scheduler ops (cron, halt, agent config, ingest) | authenticated (board **or** agent JWT) | — (no per-viewer data) |
| `org-shared` | Org-scoped reads/writes | authenticated + principal has an org | append `visibleClause` (org) |
| `viewer-scoped` | Per-user data (drafts, emails, contacts, calendar) | authenticated + resolved viewer | scope by `owner_user_id` ∪ org |

First-pass counts (from inventory): public ~10, ops-control ~50, org-shared ~280, viewer-scoped ~30, **ambiguous ~64** (need per-handler review — see Open Questions).

## What to build
1. **`autobot-inbox/src/route-tiers.js`** — the classification table: `routeKey (METHOD /path, :id-normalized) → tier`. The single auditable artifact.
2. **Middleware** at the api.js choke point: resolve `withViewer(req)` once → `req.viewer` / `req.principal`; classify the (normalized) path → `req.routeTier`; enforce the tier's identity gate; **unclassified → 403**.
3. **Coverage test** (`test:ci`): enumerate the live `routes` Map, assert every key has a tier entry; fail if any route is unclassified. This is the forcing function (independent of the runtime rollout phase below).
4. Handlers keep row-level `WHERE owner = $1` / `visibleClause` (defense in depth); the middleware guarantees the identity gate is structural, not forgotten.

## Rollout (REQUIRED — avoids a 434-route big-bang outage)
A deny-by-default gate over 434 routes risks 403-ing legitimate traffic on any misclassification.
- **Phase 0 — observe (ship first):** middleware classifies + **logs** unclassified / tier-mismatch, but does **not** 403 at runtime (warn-only via an env flag, default observe). The coverage **test** still hard-fails CI for unclassified routes, so the table must be complete on merge. Bake on prod; watch logs for surprises.
- **Phase 1 — enforce (flip after clean bake):** set the flag to enforce; unclassified / failed-gate → 403. Live-verify (board A cannot read board B; unclassified path → 403) before and after.

## Design hardening (Linus pre-impl review, 2026-06-02)
These are corrections to the design, to apply during implementation:

1. **Bypass-ordering (BLOCKER).** The dispatch currently skips `resolveAuth` for five special-cases — `isWebhook` (`/api/webhooks/*`), `isRedesign` (`/api/redesign/*`), `isBlueprint` (`/api/blueprint/*`), `isSigning` (`/api/sign/*`), `isVoiceMemoUpload` (`=/api/voice-memo/upload`). The tier middleware MUST run **before** these checks, and these five become **explicit tiers** (`webhook-authed` / `token-authed` / `public-signing`) the middleware enforces — otherwise 434 routes pass the gate while 5 categories walk around it. No route may reach a handler without passing the tier gate.
2. **Coverage-test normalization (BLOCKER).** The coverage test MUST normalize route keys with the **same `matchRoute` logic** the runtime uses (not an independent regex), or it produces phantom coverage (table green, runtime consults a different key — the 588 collision class again). Mandate reuse of `matchRoute`'s normalization.
3. **Identity-gate ≠ data-gate (MAJOR).** Passing the tier gate is **necessary but not sufficient**: a `viewer-scoped` route that passes the identity gate but forgets `visibleClause` still leaks A→B (exactly the 588/596 class). The middleware closes the "no auth at all" / "unclassified" class only.
4. **`/api/signatures` header-trust (MAJOR).** `signing.js` trusts `x-board-user` with no token check (distinct from the `/api/sign/*` public bypass). These routes need real board-JWT validation at the gate — flag them explicitly in the table so the 434-fill doesn't rubber-stamp `x-board-user: anyone`.
5. **Observe-mode blind spot (MAJOR).** Observe mode only answers "will this 403 legit traffic?" — it does NOT surface data-scope leaks (a wrong-owner route passes silently). Viewer-scoped routes identified in observe mode must be queued for a **parallel handler audit** (596-class), separate from watching 403 false-positives.

## Acceptance
- [ ] `route-tiers.js` covers all 434 routes **incl. the 5 bypass categories**; `test:ci` fails (via shared `matchRoute` normalization) if a registered route has no tier entry.
- [ ] Tier middleware runs ahead of ALL bypass checks; no handler reachable without a tier decision.
- [ ] Test: unclassified path → 403 (enforce mode).
- [ ] Test: board member A cannot read member B's `viewer-scoped` data; `/api/signatures` requires a real board JWT (not header trust).
- [ ] `org-shared` vs `viewer-scoped` identity gate enforced in middleware, verified by test. **Stated explicitly:** the gate closes identity-class bugs only — viewer-scoped routes still require a separate `visibleClause` audit (596-class).
- [ ] Phased rollout flag (observe → enforce); prod observed clean before enforce; viewer-scoped routes queued for parallel data-scope audit.
- [ ] ADR recorded for the boundary model + taxonomy (`spec/decisions/`).

## Open questions (board / ADR-level — blocking implementation)
1. **Taxonomy:** are 4 tiers right? Is a 5th `admin`/board-only tier needed for destructive ops (kill-switch, deletes, agent reconfig) that agent JWTs must NOT reach?
2. **ops-control identity:** should some ops routes require board JWT specifically (not agent JWT)? E.g. halt/resume, prod deletes.
3. **The ~64 ambiguous routes** + verifying the ~280 "org-shared" are not actually viewer-scoped — needs handler-by-handler review with domain knowledge. Who classifies (board vs me with board review of the table diff)?
4. **Rollout:** confirm observe-first (recommended) vs straight enforce.
5. **Artifact:** feature spec sufficient, or full ADR in `spec/decisions/` first (issue says "ADR recorded")?

## Scope / non-goals
- Not changing handler-level row scoping that already exists (588/596/593 work stands).
- Not re-introducing `/api/ops` (gone).
- Not a rewrite of `resolveAuth` — the middleware composes with existing auth resolution.

## Relationship
Supersedes the reachability stopgap framing of STAQPRO-540. Builds on 531/588/596 (handler scoping) and 593 (write stamp). The middleware's `req.principal` lets handlers stop re-resolving the principal individually.
