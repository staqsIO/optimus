# Federation Tier 1 — Cross-Instance Handshake: Design Spike

**Status:** Spike output — for board review (go/no-go input, not a build ticket)
**Date:** 2026-07-04
**Parent:** ADR-007 (`spec/decisions/007-federation-thesis.md`), `spec/proposals/federation-tier1-staqs-umb.md`, `spec/proposals/capability-receipt-envelope.md`
**Scope:** Design only. No code in this doc's diff. A thin cross-instance prototype is specified below as a deferred follow-up, not built here.
**Linear:** Plan 039 (GitHub issue #483)

## TL;DR

The capability-receipt primitives for cross-instance federation are already built and unit-tested — but only ever exercised as a **single-instance loopback simulation**. The actual cross-instance path (Instance B verifying a receipt issued by a genuinely separate Instance A, over the network, using A's published public key) is a **stub that fails by construction today**: `autobot-inbox/src/api-routes/federation.js`'s `jwksFetcher` always returns `{ keys: [] }`, so any receipt whose issuer differs from the verifying instance's own org DID cannot resolve a public key and verification throws. Cross-instance federation is designed but has never been proven; nothing has run against two databases. Recommendation at the end.

## 1. Inventory — what's built vs what's missing

| Layer | Status | Evidence |
|---|---|---|
| JWS sign/verify primitive | **Built, unit-tested** | `lib/federation/capability-receipt-jws.js` — `signReceipt()`/`verifyReceipt()`, RS256, checks sig/exp/nbf/aud/iss/jti-revocation |
| Envelope format (v0.1, frozen) | **Defined** | `spec/proposals/capability-receipt-envelope.md`; implemented verbatim in `capability-receipt-jws.js:8-27` |
| Grant persistence table | **Built, migrated** | `autobot-inbox/sql/169-federation-grants.sql` — `agent_graph.federation_grants` (jti PK, issuer_org/audience_org as free-text DIDs, scope_capability/scope_filter, contract_hash, signed_envelope, revoked_at) |
| Grant/query/revocation HTTP endpoints | **Built** | `autobot-inbox/src/api-routes/federation.js` — `POST /api/federation/grant`, `GET /api/federation/query`, `GET /.well-known/federation/revocations.json` |
| Hash-chained grant lifecycle audit | **Built** | `169-federation-grants.sql:108-213` — `fn_federation_grant_lifecycle()` trigger writes `state_transitions` rows on issue/revoke, synthetic `work_item_id = 'federation:grant:<jti>'` |
| Query-side audit + shared contract anchor | **Built** | `federation.js:63-100` `auditFederationQuery()` — writes `federation:query:<jti>` rows with `config_hash = contract_hash`, joinable with the grant chain |
| Federated KG import landing table | **Schema only, no callers** | `autobot-inbox/sql/117-federated-kg-imports.sql` — explicitly "Phase 1 stays empty... no callers yet, no triggers, no RLS policies" |
| **Real cross-instance JWKS resolution** | **NOT built (stub)** | `federation.js:199-207` — `jwksFetcher` hardcoded to `{ keys: [] }`; `capability-receipt-jws.js:150-156` `defaultJwksFetcher()` exists (fetches `https://<domain>/.well-known/jwks.json`) but is never wired into the route — the route only exercises the `issuerDid === currentOrgDid` self-verify short-circuit (`capability-receipt-jws.js:331-336`) |
| **JWKS publication endpoint** (`/.well-known/jwks.json`) | **NOT built** | Not present anywhere in `autobot-inbox/src/api-routes/`; `getPublicKeyPem()` exists in the primitive but nothing serves it over HTTP |
| **Second Optimus instance** | **NOT provisioned** | `spec/STATE.md:22,69` — STAQPRO-501 (2nd instance, critical path) still in Backlog; UMB Advisors runs no Optimus install today |
| **Cross-instance round-trip proof** | **Not proven — only self-loopback proven** | `autobot-inbox/test/federation-roundtrip.test.js:1-32` — explicit code comment: "the query endpoint expects `expectedAudience = orgDid` (the ISSUING org)... In a production two-org deploy, Org B would call Org A's endpoint... In this single-install test we model the issuer side." One PGlite DB, one injected keypair shared by both simulated orgs. |
| Intra-instance cross-org grants (different mechanism, same name) | **Built, live, RLS-enforced** | `tenancy.federation_grants` (`autobot-inbox/sql/133-tenancy-schema.sql:45-50`, FK'd to `tenancy.orgs`) — consumed by `lib/tenancy/scope.js:110-152` `visibleClause()`. This is **single-database, multi-org visibility sharing** (e.g. two orgs in the same Optimus install seeing each other's shared rows), unrelated to cross-instance federation despite the identical name. See §5. |

**Bottom line:** every primitive a cross-instance handshake needs exists in isolated, unit-tested form. What has never happened is two of them talking to each other across a network boundary with different keys, different databases, and different `OPTIMUS_ORG_DID` values. The one code path built specifically for that case (remote JWKS fetch) is a placeholder that cannot succeed.

## 2. The Handshake Protocol (as designed, citing existing primitives)

Two instances: **Instance A** (issuer, e.g. Staqs) and **Instance B** (audience, e.g. UMB). Each runs its own Postgres, its own Neo4j, its own `AGENT_JWT_KEY_PEM` keypair, its own `OPTIMUS_ORG_DID`.

### Step 1 — Grant issuance (A → B)

A board-authenticated human on Instance A calls `POST /api/federation/grant` (`federation.js:116-180`):

```
POST /api/federation/grant
{ audience_org: "did:web:umbadvisors.com", scope: { capability, filter, max_results, max_calls }, contract_hash, ttl }
```

- Gated by `requireBoardHuman()` (`federation.js:42-49`) — board role + GitHub identity only. No agent can self-issue a grant.
- `signReceipt()` (`capability-receipt-jws.js:183-224`) builds the v0.1 JWT claim set, signs with A's RS256 private key, returns a compact JWS.
- The row is persisted to A's `agent_graph.federation_grants` (jti as PK) — this is **local to A only**. B has no copy of the grant row; B only ever holds the signed receipt string.
- The `169-federation-grants.sql` trigger writes `federation:grant:<jti>` into A's `state_transitions` hash chain, anchored on `contract_hash`.
- The signed envelope (JWS string) is returned to the caller, who is responsible for delivering it to B out-of-band (email, MCP message, manual copy — Tier 1 has no negotiation protocol, per `capability-receipt-envelope.md` §"What's Deliberately NOT in v0.1").

### Step 2 — Receipt presentation (B → A)

B calls A's query endpoint, presenting the receipt as a bearer credential:

```
GET https://<A's host>/api/federation/query?capability=kg.read
Authorization: Bearer <JWS>
```

This is the step that is currently unbuildable across a real network boundary: A's `GET /api/federation/query` handler (`federation.js:183-347`) hardcodes `expectedAudience: orgDid` and `currentOrgDid: orgDid` to **A's own** `OPTIMUS_ORG_DID` (line 210-216) — i.e. the endpoint only verifies receipts where `aud === A`. That part is correct (A is the query endpoint, so `aud` should indeed be A). What's missing is the reverse case this design implies but never wires up: **if B also runs its own instance with its own query endpoint that A might call**, B's endpoint would need to verify a receipt whose `iss` is A — and that requires B fetching A's JWKS. `defaultJwksFetcher()` (`capability-receipt-jws.js:150-156`) is written to do exactly this (`https://<issuer-domain>/.well-known/jwks.json`) but (a) no route serves that URL on either instance and (b) `federation.js` never passes it to `verifyReceipt()` — it passes the always-empty stub instead.

### Step 3 — Verification + scope enforcement (at A, the issuer)

`verifyReceipt()` (`capability-receipt-jws.js:248-317`) runs, in order: JWS structure → time bounds (`exp`/`nbf`) → `aud` match → `scope.capability` present → signature (via `resolvePublicKey`, self-short-circuit today) → revocation check (fail-open on fetch error, `capability-receipt-jws.js:310-314` — see §6).

Critically, **scope is enforced server-side from A's own DB row, never from the bearer token's claims** (`federation.js:288-289`, "audience cannot widen scope by re-interpreting filter" — this is P1/P2 by design). A re-fetches the persisted `scope_filter`/`max_results`/`max_calls` for the `jti` and applies those, ignoring whatever the JWS claims say if they've somehow diverged. `max_calls` is enforced by counting `'served'` audit rows for that jti (no dedicated `usage_count` column — migration 169 design note, `federation.js:230-232`).

### Step 4 — Result return

For `capability: "kg.read"`, A builds a parameterized Cypher `WHERE` from the persisted filter (`origin_org`, `label`, `name_contains` — an allow-listed field set, not free-form interpolation) and runs it against A's own Neo4j via `lib/graph/client.js:runCypher()`, capped at `min(grant.max_results, 100)`. The result crosses back as a JSON node list in the HTTP response. `rag.read` and `audit.read` capabilities are named in the envelope schema but have no implementation (`federation.js:334`, "reserved for future tickets").

### Step 5 — Audit (both sides, independently anchored)

A writes `federation:query:<jti>` to its own `state_transitions`, with `config_hash = contract_hash` — the same value the grant-issuance trigger wrote to `federation:grant:<jti>`. This is the mechanism by which two **independent** hash chains (one per instance) become joinable without either instance trusting the other's chain: both reference the same `contract_hash`, computed off the shared business contract (NDA/SOW), not off anything either instance's runtime generated. B, in this design, would need its own audit write on *its* side recording "I presented receipt `jti` and got result X" — **this half is unspecified**. Nothing in the current code writes an audit row on the audience side, because the audience side (a real Instance B) has never existed to write one.

## 3. Trust Model

| Question | Answer (as designed) | Citation |
|---|---|---|
| What is signed, by whom? | The full JWT claim set (§2 envelope schema) is signed by the **issuing org's** RS256 private key (`AGENT_JWT_KEY_PEM` / same key material as agent JWTs — `capability-receipt-jws.js:29-31,49-96`) | `capability-receipt-jws.js` |
| How does a verifier get the issuer's public key? | Self-issued (`iss === currentOrgDid`): local key, no network call. Cross-instance: `defaultJwksFetcher()` hits `https://<domain>/.well-known/jwks.json`, 60s cache — **but no endpoint serves this today, and the route layer doesn't even call the real fetcher** | `capability-receipt-jws.js:150-156,331-357`; gap noted in §1, §2 |
| Who decides what a receipt authorizes? | The **issuer**, unilaterally, at issuance time. The bearer (audience) cannot negotiate or expand scope — enforcement is table-driven from the issuer's own `federation_grants` row at query time, not from token claims (P1: deny-by-default) | `federation.js:288-289` |
| Is there a shared trust anchor between orgs? | No PKI, no CA, no global identity service — `did:web` ties trust to DNS control of the issuer's domain (per-org JWKS at a well-known URL), consistent with the envelope spec's explicit "no global identity service" principle | `capability-receipt-envelope.md` §Design Principles |
| What anchors the two sides' audit trails together? | `contract_hash` — a hash of the **off-chain** business contract (NDA/SOW), independent of either instance's runtime. Both `federation:grant:<jti>` and `federation:query:<jti>` chains embed it as `config_hash`, making cross-chain reconstruction a join on a shared, externally-verifiable value rather than a claim either instance could unilaterally fabricate | `169-federation-grants.sql:159-163`; `federation.js:56-62,258` (OPT-54 note) |
| Does the recipient trust the issuer's enforcement, or verify independently? | Recipient does **not** need to trust remote enforcement for the receipt's validity (signature + exp/nbf/revocation are independently checkable) — but *does* have to trust the issuer's scope enforcement at query time, since the filter lives only in the issuer's DB row and is never disclosed to or checked by the audience. This is a deliberate P1 choice (issuer-side enforcement) but means the audience has no cryptographic proof the issuer actually applied the stated filter — only the audit row's word for it. | ADR-007 §4 receipt example: "Recipient re-verifies `classification_ceiling` against their own grant record — never trusts remote enforcement" — **this line in the ADR is aspirational; the current code has no recipient-side re-verification because there is no distinct recipient instance yet** |

## 4. Data Exchanged

- **In-band (over the wire):** the compact JWS receipt string (header.payload.signature) presented as a `Bearer` token; the JSON query result (scoped KG node slice, `≤ max_results`).
- **Out-of-band (Tier 1, no negotiation protocol):** the receipt itself, delivered from issuer to audience by whatever channel the board human uses (per `capability-receipt-envelope.md`, bilateral negotiation is explicitly out of v0.1 scope).
- **At-rest, issuer-only:** `agent_graph.federation_grants` row (full scope, contract hash, signed envelope copy) — **not replicated to the audience instance**. If Instance A goes down or its DB is lost, Instance B retains only the opaque JWS string it was handed; it cannot independently discover what it was granted beyond decoding the (unverified-without-A's-key) JWT payload.
- **Landing zone for bulk KG export (separate from live query):** `agent_graph.federated_kg_imports` (migration 117) — a signed JSON-LD blob table, described in ADR-007 as "Neo4j is a local enrichment cache; the authoritative cross-org substrate is a signed JSON-LD blob landed in Postgres." This is schema-only, zero callers, and represents a **different exchange mode** (asynchronous bulk import) than the live `GET /api/federation/query` path (synchronous, per-call). The design spike found no code anywhere that populates this table — it is pure landing-zone scaffolding, and the relationship between "live per-query federation" (§2) and "bulk KG import" (`federated_kg_imports`) is itself an open question (§7).

## 5. Two Different "Federation" Mechanisms — Do Not Conflate

The spike surfaced a naming collision worth flagging explicitly because it is a real confusion risk for anyone reading the codebase cold:

| | `tenancy.federation_grants` | `agent_graph.federation_grants` |
|---|---|---|
| Scope | **Intra-instance**: two orgs sharing one Optimus Postgres | **Cross-instance**: two separate Optimus installs, separate databases |
| Schema | `grantor_org_id`/`grantee_org_id` are `UUID` FK'd to `tenancy.orgs(id)` | `issuer_org`/`audience_org` are free-text DID strings, no FK (can't FK across install boundaries) |
| Enforcement point | `lib/tenancy/scope.js:visibleClause()` — appended to every tenant-scoped SQL `WHERE` (RLS-adjacent, Layer A) | `federation.js` HTTP route handlers — a distinct query endpoint, not a SQL-layer filter |
| Status | **Live today** — this is how e.g. two orgs within one install see each other's shared rows | **Designed, self-tested only** — this spike's subject |
| Migration | `133-tenancy-schema.sql` | `169-federation-grants.sql` |

This spike is entirely about the **second** row of this table. The tenancy-RLS mechanism in the first row is mature, already covered by `test/tenancy-parity.test.js`, and out of scope here — but any future work in this area should rename one of the two tables (or at minimum add a doc comment cross-referencing the other) before a second engineer conflates them, because `grep federation_grants` today returns both with no visual distinction beyond schema prefix.

## 6. Failure, Replay, and Revocation Handling

| Concern | Current behavior | Assessment |
|---|---|---|
| Receipt expiry | `exp` claim, max 24h TTL enforced at sign time (`MAX_TTL_SECONDS`, `capability-receipt-jws.js:132,189`); also independently re-checked from the DB row's `expires_at` at query time (`federation.js:267-270`) | Solid — two independent checks (JWT claim + DB row), can't be extended by a stale cached token |
| Revocation | Issuer maintains a revocation list; `jti` checked against it on every verify (`capability-receipt-jws.js:304-314`), 60s cache (`CACHE_TTL_MS`); **also** independently re-checked against the DB row's `revoked_at` (`federation.js:261-264`) | **Fail-open on fetch error** (`capability-receipt-jws.js:310-314`: "Fail-open on revocation fetch errors (network partition) but log") — this directly contradicts P1 (deny-by-default) for the cross-instance case: if B can't reach A's revocation endpoint (network partition, A down), `verifyReceipt()` treats the receipt as *not revoked* rather than rejecting it. For the current self-loopback (no network hop) this never triggers; for a real cross-instance deploy it is a live gap. In-code the *query-time* re-check against the local DB row is fail-closed (missing row → `404`), but that only helps when the caller *is* the issuer, which is the only case exercised today. |
| Replay | `jti` uniqueness (PK on `agent_graph.federation_grants.jti`) + one-shot-per-grant semantics prevent minting two receipts with the same jti; but nothing prevents **replaying the same valid, non-revoked receipt** for repeated queries — that's `max_calls`, not a replay defense, and is by design (a receipt is meant to be reusable within its scope) | Working as designed, but worth stating explicitly: this envelope is a *capability* token, not a *nonce*. Replay of a captured-in-transit receipt (e.g. an eavesdropped bearer token before TLS) is not defended against beyond `max_calls`/`exp` — standard bearer-token risk, mitigated only by transport security, which is unstated/assumed. |
| Revocation propagation timing | `capability-receipt-envelope.md` names a 60s target ("Revocation propagates within 60s"); the 60s figure is the **cache TTL** in `capability-receipt-jws.js:138`, not a measured propagation time — `[UNVERIFIED]`: no cross-instance test has ever measured actual propagation latency, since no second instance has issued a network call to fetch a revocation list. | Cannot verify until a real second instance exists. |
| RLS interaction | The cross-instance query path (`federation.js`) does **not** go through `lib/tenancy/scope.js`'s `visibleClause()` at all — it enforces scope via the hand-rolled Cypher `WHERE` builder against Neo4j (§2 Step 4), which is a separate enforcement surface from the Postgres RLS/tenancy layer entirely. A cross-instance query cannot "bypass RLS" in the sense the plan's STOP condition worries about, because it never touches Postgres RLS-guarded tables in the first place — it only touches Neo4j, gated by the filter allow-list in `federation.js:299-316`. **This is itself worth flagging**: if a future capability (`rag.read`, `audit.read`) is implemented against Postgres-backed content, it would need to compose with `visibleClause()` rather than inventing a third ad hoc filter mechanism, or the "issuer enforces, audience trusts" model (§3) plus a Postgres RLS bypass (e.g. a service-role connection used to serve the federation endpoint) becomes a genuine data-leak surface — precisely the STOP condition in Plan 039. No such Postgres-backed capability exists yet, so this is preventive, not a live finding. |

## 7. Open Questions

1. **The JWKS stub is the actual blocker, not a detail.** Before any real second instance is provisioned, `federation.js` needs a live `jwksFetcher` (the primitive already exists — `defaultJwksFetcher()`) and a route serving `/.well-known/jwks.json` on each instance. Without this, cross-instance verification cannot succeed for any receipt where `iss !== currentOrgDid` — which is every real federation case. This is not a nice-to-have; it's the single missing wire between "designed" and "works."
2. **What does the audience-side audit trail look like?** §2 Step 5 notes the current audit write is issuer-only. A real Instance B needs its own `state_transitions`-equivalent write (`federation:presented:<jti>`?) referencing the shared `contract_hash`, or the cross-org audit-join promise (ADR-007, tier1 proposal §"Success Criteria") is only ever half-true — reconstructible from A's side, not B's.
3. **Fail-open revocation is a real cross-instance risk (§6).** Should the query endpoint hard-fail (fail-closed) if the revocation fetch errors, at least for non-self-issued receipts? The current fail-open is defensible for self-loopback (no network hop can fail) but not for a genuine cross-instance deploy.
4. **`did:web` vs opaque DID / key rotation.** `capability-receipt-envelope.md` open question, still unresolved: tying trust to DNS control means a domain compromise or DNS outage is a trust-boundary event. No key-rotation story exists yet (what happens to outstanding receipts if `AGENT_JWT_KEY_PEM` rotates?).
5. **Bulk KG import vs live query — one mechanism or two?** `federated_kg_imports` (migration 117, async bulk signed-blob import) and the live `GET /api/federation/query` path (§2, synchronous per-call) are architecturally distinct and neither references the other. Is Tier 1 committing to both, or does the bulk-import table get deprecated/repurposed once live query is proven? Nothing in ADR-007 or the tier1 proposal resolves this.
6. **Where does a real second instance's revocation list live, and who polls whom?** Today, revocation-list serving and revocation-list fetching are both stubbed/self-referential. The proposal doc names polling as the Tier 1 mechanism (vs push) — confirmed as the intended design, but the actual cross-instance HTTP client for polling a *remote* org's revocation URL does not exist (only the local DB-row query used for self-serving `/.well-known/federation/revocations.json`).
7. **Scope-filter allow-list is capability-specific and manually maintained.** `kg.read`'s filter fields (`origin_org`, `label`, `name_contains`) are hand-listed in `federation.js:299-316`. Adding `rag.read`/`audit.read` means writing an equally careful allow-list against a different data store each time, with no shared abstraction. Is that acceptable per-capability duplication, or does it want a shared "safe filter" builder before a second capability ships?
8. **Contract-hash provenance.** `contract_hash` is asserted to anchor an off-chain business document (NDA/SOW), but nothing in the system verifies that hash actually corresponds to a real signed document, or stores/links the document itself. Is that intentionally out of scope (a human/legal-process guarantee, not a system one), or a gap?
9. **Which vertical/second instance actually gets provisioned first?** Still open per ADR-007 §Open Questions (a) and unchanged by this spike — STAQPRO-501 has no target date.

## 8. Recommendation (go/no-go input for the board)

**Do not build the full Tier 1 runtime yet.** The design is sound and mostly complete on paper, but the single highest-value next unit of work is narrow and cheap: wire the already-written `defaultJwksFetcher()` into `federation.js`, add a `/.well-known/jwks.json` route to serve `getPublicKeyPem()`, and re-run `federation-roundtrip.test.js`-style coverage across **two actual PGlite/Postgres instances with two actual keypairs** (not one shared keypair) to prove the cross-instance signature-verification path for real. That is a half-day to one-day spike, not the multi-week Tier 1 build, and it is the one thing standing between "primitives exist" and "handshake works." Everything else in this doc (audience-side audit, revocation fail-open, filter allow-list) is real but lower-urgency hardening that can follow once the core cross-instance verify path is proven.

Provisioning an actual second Optimus instance (STAQPRO-501) remains the correct trigger for the rest of Tier 1 (T1-C through T1-G per `spec/proposals/federation-tier1-linear-tickets.md`) — that sequencing is unchanged by this spike.

## Follow-Up (deferred, not built in this spike)

Per this plan's scope constraint (design doc only, no code), the concrete next step — a thin prototype proving one real cross-instance grant → receipt → query → verify round-trip against two independent database instances with two independent keypairs, including one deliberately-unauthorized-scope rejection — is specified here as the immediate follow-up task, not implemented in this branch. It should live as an integration test (mirroring `autobot-inbox/test/federation-roundtrip.test.js` but with two distinct `getDb()`-backed connections and two distinct injected keypairs) plus the `jwksFetcher`/`/.well-known/jwks.json` wiring named in §7 Q1 and §8.
