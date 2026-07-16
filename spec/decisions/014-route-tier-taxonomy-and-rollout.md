# ADR-014: Route-Tier Taxonomy & Enforcement Rollout

**Date**: 2026-06-02
**Status**: **Accepted** 2026-06-02 (board sign-off: Dustin agreed the `admin`=board-only governance boundary; Eric agreed the taxonomy). Revised post-review (Liotta + Linus — see "Review & accepted modifications"). Implementation: observe-first per M5.
**Issue**: STAQPRO-542 (route-tier classifier middleware). Refines **ADR-009** (which chose the classifier *model*) with the concrete tier taxonomy, the bypass-category handling, the coverage-test contract, and the rollout — informed by the full route inventory and a Linus pre-implementation review. Feature spec: `spec/features/002-route-tier-enforcement.md`.

---

## Context

ADR-009 decided the *model*: the authorization boundary lives at the backend endpoint via a **route-tier classifier middleware** (deny-by-default), with the board proxies as defense-in-depth. It deliberately left the **tier taxonomy** and rollout to a follow-up ("ADR for the boundary model + tier taxonomy"). This ADR is that follow-up.

Two inputs sharpen it since ADR-009:

1. **The real surface is 434 routes, not ~195** (api.js: 66; `api-routes/*`: 368 across 50 modules). 64 are genuinely ambiguous and need per-handler review. `/api/ops` **no longer exists** in the codebase — the board (Next.js) calls the backend directly with a board JWT / `x-board-user`, so the live risk is board-member A reading B's data through any of the ~404 routes that don't self-scope (only ~5 do), not a proxy second-door.
2. **A Linus pre-implementation review** of the design (feature spec 002) found three bypass/false-confidence gaps that must be decided here, not discovered during coding (below).

## Decision

### 1. Seven tiers (not four) — the bypass categories are tiers, and `admin` is split out

ADR-009 named four tiers (`viewer-scoped | org-shared | ops-control | public`). The inventory shows that is insufficient: five dispatch special-cases currently **skip `resolveAuth`** entirely (`/api/webhooks/*`, `/api/redesign/*`, `/api/blueprint/*`, `/api/sign/*`, `=/api/voice-memo/upload`), and "ops-control" conflates read-only status with destructive control. The taxonomy:

| Tier | Routes | Identity gate (middleware) | Handler obligation |
|---|---|---|---|
| `public` | health, OAuth callbacks, board-member bootstrap | none | — |
| `webhook-authed` | `/api/webhooks/*`, voice-memo upload, TLDv | the webhook's **own secret** (query-param / signature), verified in the gate — not skipped | — |
| `public-signing` | `/api/sign/:token` | signing **token** validated | — |
| `ops-control` | cron, scheduler, agent status/config reads, ingest, dead-man-switch **renew**, `/api/redesign/*`, `/api/blueprint/*` (agent-driven pipelines) | authenticated: board **or** agent JWT (+ `api_secret` for Railway-internal) | — |
| `admin` | `/api/halt`·`/api/resume`, prod deletes, agent reconfig, model sync | **board JWT only** — never agent JWT, never `api_secret`-without-viewer. Safe because autonomous halt is **in-process** (the dead-man-switch scheduler + guard-check write `halt_signals` directly; the HTTP route is board-dashboard-triggered), so board-only does not break agent self-governance. Lifecycle/keep-alive (dead-man **renew**) is `ops-control`, not here. | — |
| `org-shared` | org-scoped reads/writes | authenticated board member with an org | append `visibleClause` (org) |
| `viewer-scoped` | per-user data (drafts, emails, contacts, calendar) | authenticated + resolved viewer | scope by `owner_user_id` ∪ org |

This answers the spec's open questions: **yes to a 5th `admin` tier** (Q1), and **`admin` = board-JWT-only** so an agent identity can never reach a destructive control (Q2).

### 2. The middleware runs BEFORE the dispatch bypass checks (Linus BLOCKER)

Today the five special-cases short-circuit `resolveAuth`. If the tier middleware ran *after* them, 434 routes would pass the gate while 5 categories walk around it. **The middleware is the first thing in the dispatch**: it classifies every path (including the five), resolves the appropriate identity for the tier, and only then either runs the handler or returns 403/401. The bypass categories are not exempt — they are explicit tiers (`webhook-authed` / `public-signing`) the middleware enforces. No route reaches a handler without a tier decision.

### 3. The coverage test reuses `matchRoute` normalization (Linus BLOCKER)

The CI/`test:ci` coverage test enumerates the live `routes` Map and fails if any registered route lacks a tier entry — the forcing function. It MUST normalize keys with the **same `matchRoute` logic the runtime uses** (parameterized `:id`, regex routes), not an independent regex. Otherwise the table is phantom-green while the runtime consults a different key — the STAQPRO-588 route-collision class in a new hat.

### 4. The tier gate closes the identity class only — data-scope stays a separate, tracked obligation (Linus MAJOR)

Passing the tier gate is **necessary but not sufficient**. A `viewer-scoped` route that passes the identity gate but forgets `visibleClause` still leaks A→B (the 588/596 class). The middleware closes "no auth / unclassified" and attaches `req.principal` so handlers stop re-resolving — but it does **not** absolve viewer-scoped/org-shared handlers of row scoping. Those remain enforced by the M-D read ratchet (STAQPRO-589) and audited per-handler. The acceptance criteria state this bluntly so the gate is not mistaken for a data-leak fix.

Corollary (Linus MAJOR): the `/api/signatures` family currently trusts `x-board-user` with **no token check** (distinct from the `/api/sign/*` public bypass). Classifying it `org-shared`/`viewer-scoped` and requiring a real board JWT at the gate is part of this work — flagged explicitly so the 434-route fill does not rubber-stamp `x-board-user: anyone`.

### 5. Phased rollout: observe → enforce, with a parallel data-scope audit (Linus MAJOR)

A deny-by-default gate over 434 routes risks 403-ing legitimate traffic on any misclassification. Rollout is flagged:

- **Phase 0 — observe:** middleware classifies + **logs** unclassified / tier-mismatch but does not 403 at runtime (default). The **coverage test still hard-fails CI** for unclassified routes, so the table is complete on merge. Bake on prod; watch logs.
- **Phase 1 — enforce:** flip the flag; unclassified / failed-gate → 403. Live-verify before/after (unclassified → 403; board A cannot read B).

Observe mode answers "will this 403 legit traffic?" — it does **not** surface data leaks. So viewer-scoped routes identified in observe mode are queued for a **parallel handler audit** (596-class), separate from watching 403 false-positives.

## Review & accepted modifications (Liotta + Linus, 2026-06-02)

Both agents reviewed; verdicts synthesized. The 7-tier taxonomy and the core architecture (middleware-first, deny-by-default, coverage-test forcing-function, build-before-RLS) are **ACCEPTED**. Accepted refinements, folded into the Decision above and the implementation:

**M1 — Two-axis model (Liotta, ACCEPT-MODIFY).** Store classification as two orthogonal fields **`{ identity, scope }`**, not one ordinal enum — the "Identity gate" and "Handler obligation" columns are already two dimensions. `identity ∈ {public, webhook-secret, signing-token, authed-any, board-only}`; `scope ∈ {none, org, owner}`. The 7 named tiers are a *derived view*. This kills the ordinal-enum trap (cf. the RAG `classification <= 'INTERNAL'` lexicographic bug) and — critically — makes **`scope` a CI-lintable declared obligation**: a route declared `scope:owner|org` whose handler doesn't reference the scope helper fails the coverage test. That turns "identity-gate ≠ data-gate" from a repeated warning into structural enforcement.

**M2 — Prefix/module default + exceptions, not a 434-row table (Liotta, ACCEPT-MODIFY — highest-leverage).** Derive the default `{identity,scope}` by path-prefix/module (~12 prefixes), default = **most-restrictive** (`board-only`/`owner` for an unmatched authed route); the explicit table holds only the **~70 exceptions** (the 64 ambiguous + sensitive overrides). A new route inherits a *fail-closed* default with **no table edit**, shrinking the auditable artifact ~5× and removing the "one viewer→public typo silently leaks" surface (mis-set defaults fail *closed*, not open). The coverage test still enforces completeness.

**M3 — Route-surface-diff test (Liotta + Linus Gap C, ACCEPT-ADD).** The whole O(1) collapse assumes every route passes the single `routes`-Map choke point. Add a test that diffs the **live HTTP surface** (all `register*Routes` results after full init, + any SSE/`upgrade`/raw listeners) against the classified Map and fails on divergence. Without it the coverage test is phantom-green for a route registered off-Map — the 588 collision class. Coverage test must enumerate the Map **after all `register*Routes` complete**.

**M4 — `admin` = board-JWT-only: ACCEPT (Linus conflict resolved by code).** Linus flagged that board-only could break agent-triggered halt. Verified: autonomous halt is **in-process** (dead-man-switch scheduler + guard-check write `halt_signals`; HTTP `/api/halt` is board-dashboard-triggered), so board-only is safe. Carve-out applied: dead-man **renew** → `ops-control`. Observe phase must confirm **0** agent-JWT/`api_secret` hits on any `admin` route before enforce; only add a narrow `agent-control` tier if observe surfaces a real agent-HTTP caller (YAGNI until then).

**M5 — Per-tier rollout (Liotta, ACCEPT-MODIFY).** Not a single global flag: **enforce `public` + `admin` (+ webhook/signing secret-auth) on day one** (near-zero false-positive — an agent JWT hitting `/halt` *should* 403); **observe `org-shared`/`viewer-scoped`** (~310 routes carry the 403-legit-traffic risk). Flip gate = **0 unexpected tier-mismatches over a 72h prod bake** (P5 measure, not a calendar date). Flag is **DB-backed config** (hot-flip, no redeploy — avoids the Railway identical-image gotcha; consistent with how halt works, P4).

**M6 — Success metrics (Liotta, ACCEPT-ADD, P5).** (a) 0 unclassified routes (CI-hard); (b) count of routes resolving to the most-restrictive *default* — trends down as ambiguous ones are reviewed; (c) observe-phase mismatch events/day; (d) extend `scripts/verify-tenancy-live.mjs`: board A → 403/empty on B's `viewer-scoped` routes, **agent JWT → 403 on every `admin` route**.

**M7 — `api_secret` per-tier (Linus Gap A, ACCEPT-DOCUMENT).** Legacy Bearer with `x-board-user` resolves that owner (org/owner scope applies); bare `api_secret` (no `x-board-user`) → empty/deny (STAQPRO-531); `api_secret` may reach `ops-control` (Railway-internal) but **never `admin`**.

**One board sign-off item (Dustin's constitutional domain):** confirm "destructive HTTP ops (`/api/halt`, prod deletes, reconfig, model-sync) are board-JWT-only." Evidence above says it's safe; it is still a governance-boundary call.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep ADR-009's 4 tiers | Leaves the 5 `resolveAuth`-bypass categories outside the gate, and lets an agent JWT reach destructive controls. `admin` + the authed-bypass tiers are required. |
| Middleware after the bypass checks | 5 categories walk around the gate (Linus BLOCKER). Rejected. |
| Independent regex in the coverage test | Phantom-green vs runtime key (588 class). Must reuse `matchRoute`. |
| Straight enforce (no observe phase) | Big-bang 403 risk over 434 routes; a single misclassification is a prod outage. Observe-first de-risks. |
| Postgres RLS instead | Orthogonal, deeper layer; blocked on ADR-018 PR-B (pool still superuser). Composes later, not a substitute now. |

## Consequences

**Positive:** a real, deny-by-default authZ boundary at the one place that can evaluate it; the 5 bypass categories become enforced tiers; destructive ops are board-only; the classification table is one diffable artifact; the coverage test makes "ship a new route unclassified" impossible.

**Negative / risks:** classifying 434 routes is real one-time work (the 64 ambiguous need handler review) — mitigated because deny-by-default fails *closed* (a missed route 403s, it does not leak) and observe-first prevents outages. Misclassifying viewer-scoped → org-shared/public would leak — mitigated by tests on sensitive routes, explicit review of any `public`/`org-shared` entry, and the retained `visibleClause` data layer. Identity-gate-≠-data-gate must be repeated loudly so the gate is not over-trusted.

## Relationship to Existing Decisions

- **Refines ADR-009** (board↔backend authZ boundary — the model). This ADR fixes the taxonomy + rollout 009 deferred.
- **Composes with ADR-012** (authorization spine / 3-tier tenancy) and **ADR-018 PR-B** (STAQPRO-263, pool off superuser → RLS): middleware is the app-layer gate now; RLS is the DB-layer gate later. Not mutually exclusive.
- **Builds on** STAQPRO-531/588/596 (per-handler scoping) and **593** (write-path stamp); the M-D ratchet (589) backstops the data-scope obligation this gate does not itself close.
- **Consistent with ADR-002** (individual install): board members are distinct viewers within one org.

## Implementation

Per feature spec `002-route-tier-enforcement.md`. Sequenced: (1) `route-tiers.js` table covering all 434 routes incl. the bypass tiers; (2) middleware ahead of all dispatch bypass checks, resolving identity per tier and attaching `req.principal`; (3) coverage test reusing `matchRoute` normalization; (4) tests: unclassified → 403, A-cannot-read-B, `/api/signatures` requires board JWT, `admin` rejects agent JWT; (5) observe → enforce flag + parallel data-scope audit of viewer-scoped routes.

**SPEC references**: §0 P1 (deny-by-default), P2 (infrastructure enforces), P3 (transparency by structure), P5 (measure before trust); §5 (guardrail enforcement).

## Affected Files

- `autobot-inbox/src/api.js` — mount middleware as the first dispatch step; promote `resolveViewerEmails`/`mayReadOrgShared` into a shared module.
- (new) `autobot-inbox/src/route-tiers.js` — the path→tier table (single source of truth).
- (new) `autobot-inbox/test/route-tier-coverage.test.js` — coverage forcing-function + tier-enforcement tests.
- `autobot-inbox/src/api-routes/signing.js` — require a real board JWT (stop trusting `x-board-user`).
- `autobot-inbox/src/api-routes/*.js` — inherit the gate; row-level scoping retained as defense in depth.

## Cross-Project Impact

Scoped to `~/Optimus` (`autobot-inbox` backend). No other sub-project affected.
