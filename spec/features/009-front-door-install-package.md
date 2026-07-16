# Feature 009 — Front Door Install Package (productize the Intent Front Door)

**Status:** Draft — board review pending
**Author:** Eric (via Claude session 2026-06-10)
**Builds on:** Feature 008 (Progressive Intent Front Door — SHIPPED, live on altitudeguitar.com 2026-06-09/10). Reference implementation: ag-webapp (Next.js 16) + Optimus front-door backend.
**Related prior art:** Fibr (one-script edge install — the packaging pattern, not the intent model), llms.txt convention, A2A agent cards (`/.well-known/agent.json`), Shopify app proxy.
**Related Linear:** OPT-116…OPT-125 (project "Front Door — Install Package (Feature 009)"; mapping in §11)

---

## Summary

Feature 008 proved the Intent Front Door on one site we control. Feature 009 turns it into a **product a third-party domain owner installs on their own site**. The distribution model is fixed (Eric, 2026-06-10): *end users install nothing; the domain owner installs the front door.* A domain owner who installs gets the full agent-facing surface — `llms.txt`, `/.well-known/agent.json`, a same-domain `/api/intent` endpoint, intent landing pages, visitor classification + provenance beacons, and (where the tier supports it) the UA-negotiated machine-readable storefront — backed by the existing multi-tenant Optimus corpus/cold-tail engine.

What ships: a ladder of four install packages (one per customer platform/effort level) plus the backend multi-tenant foundation that makes serving strangers safe (per-site isolation, provisioning, per-site keys). What changes after it ships: onboarding a new site goes from "Staqs engineer with direct DB access runs a CLI" to "customer self-serves in under an hour; first agent-served page same day."

Sales proof point already in hand: a cold Claude agent, given nothing but the domain, discovered the entire surface on altitudeguitar.com unprompted and called it "a useful reference pattern for client sites" (2026-06-10).

## 1. THE PACKAGING LADDER (the model)

Four tiers, ordered by how little the customer must touch. Each tier is a different **install artifact** over the **same backend**. A customer can upgrade tiers without re-onboarding (same site registration, same corpus).

| Tier | Artifact | Customer platform | Install effort | Surface delivered |
|---|---|---|---|---|
| **W — Edge Worker** (P1) | Cloudflare Worker one-script | **Any site** (origin untouched) | Paste one script + config into their own CF account (decided, was Q3) | llms.txt, agent.json, `/api/intent` proxy, visitor classification + beacon, `Link: llms-txt` header injection. Intent pages resolve to the hosted subdomain (thin slice of tier H pulled forward — decided, was Q2); edge rendering is a v1 non-goal |
| **N — npm package** (P2) | `@staqs/front-door` for Next.js | Next.js sites | `npm install` + config object + mount 3 route handlers | Everything 008 shipped on ag-webapp: full proxy classification, `/api/intent`, agent.json, `/ai` markdown surface + intent ISR pages via userland renderers |
| **S — Shopify app** (P3) | Shopify app (app proxy + theme extension) | Shopify storefronts | App-store install, OAuth | Same as W plus native catalog access (no catalog-host config), merchant-facing settings UI |
| **H — Hosted CNAME** (P4) | `ai.theirdomain.com` CNAME to us | Anyone | One DNS record | Agent surface hosted entirely by Staqs on a subdomain; origin completely untouched |

The Worker tier is P1 because it is the **universal** install — the "one-script" pitch works on WordPress, Webflow, Squarespace, custom stacks — and because everything it serves is replicable at the edge without origin cooperation (verified against the reference implementation, §7).

## 2. WHAT THE CUSTOMER GETS (capability matrix)

| Capability | W (Worker) | N (npm) | S (Shopify) | H (CNAME) |
|---|---|---|---|---|
| `llms.txt` + `Link` header | ✅ | ✅ | ✅ | ✅ (on subdomain) |
| `/.well-known/agent.json` A2A card | ✅ | ✅ | ✅ | ✅ (on subdomain) |
| Same-domain `POST/GET /api/intent` | ✅ (proxy) | ✅ | ✅ (app proxy) | subdomain, not same-domain |
| Visitor classification + provenance beacon | ✅ | ✅ | ✅ | ❌ (no main-domain traffic visibility) |
| Tier-1 referrer-based intent routing (human rewrites) | ✅ | ✅ | ✅ | ❌ |
| Intent landing pages | ✅ on hosted subdomain (§7) | ✅ on their domain (userland template) | ✅ on their domain | ✅ (on subdomain) |
| UA-negotiated markdown storefront (`/ai`) | ❌ v1 (needs a data layer; upgrade path = N/S/H) | ✅ (userland renderers) | ✅ | ✅ |
| AEO (published intents indexable, sitemap) | subdomain-scoped | ✅ | ✅ | subdomain-scoped |

## 3. USER STORIES

- **US-0 (domain owner, non-technical platform)**: As the owner of a store on any web stack, I want to paste one edge script and a small config and have my site become agent-legible (llms.txt, agent card, working intent endpoint), so that AI assistants send me qualified buyers without my replatforming anything.
- **US-1 (domain owner, Next.js developer)**: As a developer running a Next.js storefront, I want to `npm install @staqs/front-door`, pass a config object, and mount the provided handlers, so that I get the full 008 surface — including the markdown storefront — without copying code from a reference repo.
- **US-2 (Shopify merchant)**: As a Shopify merchant, I want to install an app from the app store and click "enable," so that I get the front door with my catalog wired automatically.
- **US-3 (zero-touch buyer)**: As a domain owner who won't touch code OR DNS proxies, I want to add a single CNAME record, so that agents get an `ai.mydomain.com` surface without my site changing at all.
- **US-4 (Staqs/Optimus board)**: As the operator, I want every customer site isolated — its own rate budget, spend caps, flags, and key — so that one abusive or busy customer can't starve, poison, or bill-shock the others, and so I can shut one site off without touching the rest.
- **US-5 (visiting AI agent)**: As an assistant shopping on behalf of a user, I want to discover `agent.json` on the customer's own domain and call the API it describes with no signup, so that I can get an intent-matched page in one round trip (identical to the altitudeguitar.com experience).
- **US-6 (Staqs operator onboarding a customer)**: As the person onboarding site #2..N, I want to provision the site, connect its catalog, propose intents, get owner approval, and publish — entirely through an authenticated API/flow with no direct database access — so that onboarding scales past the engineer who built it.

## 4. ONBOARDING FLOW (provision → seed → install → verify)

The flow is the same for all tiers; only the final "install" step differs.

1. **Provision**: operator (later: customer self-serve) registers the site → backend creates the site record (host, owning org, plan/limits, flags) and issues a **per-site key**. MUST: the owning org is fixed at provision time, never inferred later.
2. **Catalog connect**: customer supplies their catalog source (e.g. their `.myshopify.com` host for headless storefronts). MUST: stored per-site, not in a shared global env map.
3. **Propose**: backend brainstorms head intents from the catalog (~$0.30/site, one LLM pass). Output is a reviewable list.
4. **Approve**: site owner (or operator on their behalf) approves/edits the proposed intents. MUST: nothing publishes without an explicit approval step — the 008 board-review discipline, delegated to the paying owner.
5. **Generate + publish**: approved intents become corpus entries (screened, embedded, published). Per-row cost recorded, charged to the site's plan.
6. **Install**: tier-specific artifact (paste Worker / npm install / app install / CNAME).
7. **Verify**: an automated install checker fetches the customer domain from outside and confirms the surface (llms.txt reachable, agent.json valid, `/api/intent` round-trips, classification headers present). MUST: customer sees pass/fail per check; the demo prompt ("ask any tool-using assistant to fetch `https://<their-domain>/.well-known/agent.json` and use it") works on first green.

## 5. TENANCY & DATA MODEL (what P0 adds)

008's storage is already keyed by site (`site_host` on every corpus/visit row, owning org on corpus). What's missing is a **first-class site registry** — today "a site exists" is implicit in seeded rows plus global env vars. P0 makes the site the unit of provisioning, config, limits, and auth:

| Concept | Today (008, single-customer) | P0 target (multi-customer) |
|---|---|---|
| Site existence | Implicit (first seeded corpus row) | Explicit registry row: synthetic site id (the PK), host as a unique-but-mutable attribute, owning org, plan, status (active/suspended). Host is NOT the primary key — domains change hands (re-sale, agency→client handoff); identity must survive a host change without data migration |
| Owning org | Inferred from earliest seed row at cold-tail write time | Stamped at provision; all writes inherit from the registry. Re-assignable by operator (audit-logged) — the invariant is "org is never **inferred**," not "never changed" |
| Catalog mapping | One global env JSON map | Per-site registry field |
| Feature flags (serve-by-match, cold-tail) | Global env, all-sites-at-once | Per-site, registry-backed; global env becomes the default only |
| Rate limits / caps | Global buckets shared by all sites (cold-tail/day, submit/day, beacon) + one per-site row cap | Per-site buckets and ceilings, set by plan; global backstop above them |
| Management auth | None (only public reads exist; seeding = direct DB) | Per-site key authorizes seed/manage/promote for that site only; public reads stay public and keyless |
| Visit telemetry | Anonymous, site-keyed, no org | Unchanged for v1 (org-stamping deferred to 008 Phase 2 attribution spine — noted, not built here) |

## 6. SECURITY GATES (P1/P2 — hard prerequisites)

### 6.1 BLOCKERs (must exist before any external customer is provisioned)

- **Per-site rate/spend isolation.** Today every limit that matters is a single global bucket; the first busy customer exhausts the cold-tail daily budget for everyone, and an attacker hammering one customer's endpoint rate-limits all customers. Each site MUST have its own buckets with plan-set ceilings, plus a global backstop. **Per-site buckets MUST be DB-backed (or shared-store) — following the existing DB-backed global-daily-cap pattern, NOT the in-memory per-IP window pattern** — because in-process counters silently multiply every ceiling by N the moment the API scales horizontally; per-site isolation that only holds on a single instance is a lie. (P1: deny by default; G10-adjacent spend control.)
- **Per-site management key.** Seeding, regenerating, promoting unlisted rows, and changing site config MUST require the site's key and MUST be scoped to exactly that site. A leaked key for site A MUST NOT permit any read or write against site B. **The key is NOT a new auth system: it is the existing OPT-37 customer-principal JWT extended with a required site-id claim and a front-door-manage scope** — inheriting minting, rotation, revocation, scope-whitelisting, and the control plane that already exist. Routes assert the site-id match (the leak-isolation boundary); note the principal class is org-shared by design, so the site claim is a mandatory *narrowing*, not raw reuse. Public marketing-copy reads and the anonymous beacon remain keyless (unchanged from 008). (P2: infrastructure enforces; P4: boring — don't build a second key class.)
- **Org fixed at provision.** The owning org MUST be stamped when the site is provisioned, and every subsequent write inherits it from the registry. The current inference-from-first-seed-row behavior is fragile under multi-customer onboarding order and MUST be removed. (P1.)
- **Per-site kill switch.** Operator MUST be able to suspend a single site (stop serving its corpus, reject its cold-tail, refuse its key) without redeploying or touching other sites. (Kill-switch architecture, CONSTITUTION.)
- **G8 screening stays mandatory** on every intent input regardless of which install tier delivered it — the Worker/app/CNAME tiers are new front doors to the same screened pipeline, never bypasses of it.

### 6.2 Cost / abuse bounds

- Plan-level ceilings per site: cold-tail mints/day, corpus row cap, enrichment spend/day, proposal regeneration frequency. Defaults conservative; raising them is a plan/billing action, not an env edit.
- Per-row generation cost continues to be recorded (008 already does this); v1 MUST aggregate it per site so a bill could be computed, even before billing exists (§6.3).
- The install verifier and onboarding endpoints get their own narrow rate limits (they're unauthenticated-adjacent and internet-facing).
- **Verifier SSRF bound:** the install verifier MUST only fetch the registered host of a provisioned site — never an arbitrary caller-supplied URL. An authenticated endpoint that fetches any URL on command is a classic pivot; the host allowlist is the load-bearing half of the verifier's safety, the rate limit is the other.

### 6.3 Explicitly OUT of scope (premature)

- **Charging money.** v1 records per-site usage/cost; invoicing, payment, plan upgrade flows are not in this feature. (Pricing model = open question Q1.)
- **Per-tenant content-safety templates.** One shared conservative Model Armor template for all sites in v1. Revisit when a customer's category demands it (Q4).
- **Customer-facing analytics dashboard.** Visit/attribution reporting per site is Phase 2 of 008 (provenance spine); not duplicated here.
- **Multi-turn A2A interrogation** (008 Phase 3-B) — the packaged agent card stays single-turn `get_intent_landing_page`.
- **Self-serve signup with payment.** v1 onboarding is operator-driven through the API; the customer approves intents and installs, but account creation is manual.

## 7. ARCHITECTURE (boundaries, verified against the reference implementation)

**Backend (Optimus).** Already multi-tenant at the storage and matching layer — corpus, cold-tail, visits, caps are all site-keyed; the seed pipeline takes site + org explicitly. P0 work is concentrated in exactly four places: the site registry, per-site keys on the management surface, per-site limit buckets, and per-site flags. No re-architecture of the serve path.

**Worker tier boundary (Q2 — DECIDED).** Verified replicable at the edge with zero origin changes: visitor classification (the classifier is a pure, dependency-free function already ported to TS once), `Link: llms-txt` header injection, serving `llms.txt` + `agent.json` from config, and proxying `/api/intent` upstream (with client-IP forwarding and retry-once, matching the reference). The Worker does **exactly that and nothing more**: endpoint + discovery. Intent URLs it returns resolve to pages on the **hosted subdomain**, served from the corpus by the existing serve route parameterized by site — a thin slice of tier H pulled forward, not a new render path. Edge rendering (the Worker fetching the catalog itself and assembling pages) is an explicit v1 non-goal: it would build a second catalog data layer inside the least-observable, least-updatable artifact and split the page renderer into two drifting implementations to avoid an origin round-trip we don't need.

**Worker durability/update model (Q3 + Q5 — DECIDED).** The Worker runs in the **customer's own Cloudflare account** for P1 (zero platform build; blast radius of a bad deploy is one customer; CF-for-SaaS is revisited at P4 when centralized update economics justify the platform work). The pasted snippet is a **thin, version-pinned loader** — it carries the site identity and a pinned version, and pulls the actual classification/serving logic from a Staqs-hosted versioned endpoint. Security fixes ship server-side without the customer's pasted bytes ever changing; breaking changes mint a new pinned version plus an advisory while old versions keep working. No client-side auto-update. (The Worker already depends on Staqs for `/api/intent`, so the loader adds no new dependency class.)

**npm tier boundary.** Roughly 60–65% of the ag-webapp reference is packageable behind a config object (site host/URL, upstream URL, site description): the proxy classification logic, intent API route, agent-card handler, classifier + markdown-sanitizer utilities, header config. The rest is intentionally **userland**: `llms.txt` content (the customer's voice), the intent-page template, and the markdown renderers (typed against the site's own data layer). The package ships those as documented patterns + examples, not as code that pretends to be site-agnostic.

**One backend, many fronts.** All tiers call the same public corpus/intent API and the same provisioned site registry. The install artifacts contain no business logic that isn't classification, serving static-ish declarations, or proxying — matching durability expectations: a Worker snippet a customer pasted 18 months ago must keep working (versioning policy = Q5).

## 8. SUCCESS METRICS (P5 — measure before you trust/scale)

- **Install time**: Worker tier installable on a site we do NOT control in < 15 minutes from provision to green verifier. npm tier < 1 hour including userland templates.
- **Adoption**: ≥ 3 external (non-Staqs-operated) sites live within 30 days of P1 shipping; ≥ 1 on the Worker tier.
- **Isolation proof**: synthetic load against one site's endpoints consumes zero of any other site's rate budget and does not move other sites' serve latency p50 (measured before first external customer).
- **Onboarding cost**: ≤ $1 LLM spend per site for propose + generate at the 15-intent default (008 actual: $0.32).
- **The demo replicates**: a cold tool-using assistant pointed only at a customer's domain discovers and successfully uses the intent surface, on the first external install (the altitudeguitar.com proof, reproduced on a stranger's site).
- **Zero cross-tenant incidents**: no site ever serves, leaks, or lets a key touch another site's rows (continuously assertable from logs/tests).

## 9. PHASING

- **P0 — Backend multi-tenant foundation** (blocks everything): site registry + provisioning; per-site keys on the management surface; per-site rate/spend buckets + kill switch; per-site flags + catalog mapping; org stamped at provision. Exit: two sites provisioned side by side (altitudeguitar.com migrated onto the registry + one test site), isolation proof green.
- **P1 — Worker one-script + operator onboarding**: the CF Worker artifact (classification, llms.txt, agent.json, intent proxy, header injection) as a thin pinned loader with config-driven site strings; the hosted-subdomain intent-page serve route (thin P4 slice, per Q2); onboarding flow (§4) callable end-to-end via authenticated API; automated install verifier (registered-host-only). Exit: a non-Staqs site installs in <15 min and passes the verifier; its `/api/intent` URLs resolve to live hosted pages.
- **P2 — npm `@staqs/front-door`**: extract the reference into a published package + userland examples; ag-webapp consumes the package (dogfood = the reference site runs on the public artifact). Exit: ag-webapp on the package in prod with no behavior change.
- **P3 — Shopify app**: app proxy + theme extension + merchant settings; catalog wiring native. Exit: one merchant install through Shopify review.
- **P4 — Hosted CNAME tier**: `ai.theirdomain` serving the agent surface from our infra. Exit: one customer live via DNS-only install.

## 10. OPEN QUESTIONS

- [ ] **Q1 — Pricing/billing model.** Per-site flat? Usage (cold-tail mints / agent serves)? Tier-priced by artifact? v1 records usage per site; the board needs a pricing decision before public availability (not before P0/P1 build).
- [x] **Q2 — Where do Worker-tier intent pages live?** **DECIDED (Liotta review, 2026-06-10): endpoint-only Worker + hosted-subdomain pages.** The Worker ships endpoint + discovery; intent URLs resolve to the hosted subdomain, served from corpus by the existing serve route (thin slice of P4 pulled forward). Edge rendering rejected: second catalog data layer in the least-updatable artifact + a guaranteed-to-drift duplicate renderer. See §7.
- [x] **Q3 — Whose Cloudflare account runs the Worker?** **DECIDED: customer's own CF account for P1.** CF-for-SaaS revisited at P4 when ≥10 sites make centralized snippet updates worth the platform build. See §7.
- [ ] **Q4 — Per-tenant content-safety posture.** Shared conservative screen template is the v1 decision; what customer category forces revisiting (and is that customer declined instead)?
- [x] **Q5 — Artifact versioning/update channel.** **DECIDED: thin version-pinned loader over Staqs-hosted versioned logic.** Security fixes ship server-side, pasted bytes never change; breaking changes mint a new pinned version + advisory; no client-side auto-update. npm tier uses ordinary semver. See §7.
- [ ] **Q6 — Referer stripping (008 carryover).** Do real claude.ai/ChatGPT clicks carry a Referer, or do classifiers need utm/query-param fallback? Affects the value story of the classification capability in every tier.

## 11. DECOMPOSITION (Linear issues — confirm at planning)

| Code | Linear | Issue | Layer |
|---|---|---|---|
| P0-A | OPT-116 | Site registry (synthetic id PK, mutable host, org FK) + provisioning API + per-site key = customer-principal JWT with site claim + manage scope (mig + backend) | backend |
| P0-B | OPT-117 | Per-site rate/spend buckets (DB-backed, NOT in-memory) + plan ceilings + per-site kill switch | backend |
| P0-C | OPT-118 | Per-site flags + catalog mapping in registry; org stamped at provision; migrate altitudeguitar.com onto the registry | backend |
| P1-A | OPT-119 | CF Worker artifact: thin pinned loader + Staqs-hosted versioned logic (classification, llms.txt, agent.json, intent proxy, header injection), config-driven | worker pkg |
| P1-B | OPT-120 | Hosted-subdomain intent-page serve route (thin P4 slice; Worker-tier intent URLs resolve here) | hosted |
| P1-C | OPT-121 | Onboarding flow end-to-end over authenticated API (provision → propose → approve → generate → publish) | backend |
| P1-D | OPT-122 | Automated install verifier (fetches ONLY the registered host of a provisioned site, per-check pass/fail, own rate limit) | backend/tool |
| P2-A | OPT-123 | Extract + publish `@staqs/front-door`; ag-webapp dogfoods it | npm pkg |
| P3-A | OPT-124 | Shopify app (proxy + theme extension + settings) | app |
| P4-A | OPT-125 | Hosted `ai.theirdomain` CNAME tier | hosted |
