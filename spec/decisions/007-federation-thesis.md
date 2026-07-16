# ADR-007: Federation Thesis — Inter-Organizational Governance as Long Arc

**Date**: 2026-05-11
**Status**: Proposed — awaiting board review (Eric + Dustin)
**Issue**: What is Optimus's second-act product motion, and what architectural constraints does that impose on current Phase 1 work?

---

## Context

Optimus is currently a single-company governed agent organization. One product is live: `autobot-inbox`, running at UMB Advisors (N=1). The spec's endgame (SPEC §14, AutoBot) describes a constitutional autonomous organization. But between Phase 1 MVP and AutoBot lies a second-act product question that has not been recorded as an architectural decision: **what does Optimus sell to its second and third customer, and does that shape what we build now?**

This ADR records that strategic decision and the concrete pre-GA design constraints it imposes. It does not replace SPEC.md — it records the decision that federation is the destination and what that means for code shipping this quarter.

---

## Decision

Three claims, stated plainly:

### (a) Long-arc product: inter-organizational governance infrastructure

Optimus's durable product is governance infrastructure that works *across* organizational boundaries — verifiable records of what agents did, to whose data, under what policy, between organizations that do not share infrastructure. `autobot-inbox` is the wedge: it funds the runway, proves the operating model, and generates the first real-world trust record. It is not the destination.

This is a strategic bet, not a feature plan. It does not change what ships in the next 90 days. It does change which architectural choices we tolerate versus which ones we treat as pre-GA blocking.

### (b) The 10x primitive: portable verifiable capability receipts

The defensible primitive is not "mind-meld knowledge graphs." It is a **portable, verifiable capability receipt** — a signed, replayable proof that "Agent X at Org A read Document Y at Org B under Policy Z at time T." Hash-chained. Externally verifiable without Optimus running on the recipient side.

This converts every cross-org agent interaction into a credential the receiving organization can audit independently. M&A diligence becomes "give me 90 days of receipts touching the data room." It is the SWIFT message of agent governance: boring, standardized, composable.

This is built as a **governance overlay on top of MCP/A2A transport**, not as a competing wire protocol. Anthropic and Google are standardizing inter-agent protocols at the wire layer. Optimus's competitive position is the governance and audit layer on top of that standard — not a bespoke transport stack underneath it. Any hour spent on proprietary agent-to-agent RPC is a sunk cost the day MCP federation ships. See Counter-positions below.

The existing infrastructure in `lib/runtime/agent-jwt.js`, `lib/rag/retriever.js` (STAQPRO-310, migration 108 `classification_level smallint`), and `lib/db.js` (`state_transitions` hash chain) is roughly 70% of this primitive. The missing 20%: receipts must be **portable** — verifiable by a recipient org without running Optimus. The missing 10%: an `origin_org` anchor so receipts can be attributed when they leave this installation.

### (c) Adoption path: vertical roll-ups, not PE-firm mandates

The initial federation customer is not a PE firm mandating software across portcos — PE firms issue best-practice memos that get ignored. Portfolio CEOs guard autonomy. Finance/reporting tooling tied to value-creation plans is the one exception, and Optimus is not that yet.

The defensible path is **vertical roll-ups**: HVAC chains, dental groups, MSP aggregators. Same ultimate owner, shared ontology across entities, frequent inter-company transactions (staff sharing, vendor contracts, referrals), and a single decision-maker who can mandate the install. Federation value is realizable within 90 days of a second install in the same vertical rather than two years into a PE relationship.

UMB Advisors is N=1, not validation. It is a controlled environment where Eric controls deployment. The step after UMB is one external customer in the same vertical — financial advisory or professional services — where the federation value hypothesis can be tested with a real negotiated policy boundary.

---

## Consequences — Design Constraints Imposed Now

These are pre-GA blocking items. Retrofitting them after a second customer is live requires painful migrations. Shipping them now costs essentially nothing.

### 1. JWT `iss` and `org` claims — extend ADR-018 immediately

Current ADR-018 token shape (`lib/runtime/agent-jwt.js`): `{ sub, tier, tools, iat, exp, jti }`. Issuer is currently pinned to the string `"optimus-agent"` (single-org assumption baked into the verify path).

**Required change (pre-GA):** Add `iss` and `org` to every token minted, defaulting to `"self"` for single-org installs:

```js
// lib/runtime/agent-jwt.js — extend mintAgentToken()
{
  iss: process.env.OPTIMUS_ORG_ID ?? "self",  // NEW — federation issuer
  org: process.env.OPTIMUS_ORG_ID ?? "self",  // NEW — org identity
  sub: agentId,                                // unchanged
  tier: agent.tier,                            // unchanged
  tools: agent.allowed_tools,                  // unchanged
  iat, exp, jti                               // unchanged
}
```

`verifyAgentToken()` in `lib/db.js` becomes issuer-aware: it accepts tokens from trusted remote issuers by looking up JWKS at `https://{iss}/.well-known/optimus-jwks.json` (cached 1h). Single-org tokens still verify against the local key — no behavior change until a second org is configured.

**Why this must ship pre-GA:** Adding `iss`/`org` later requires re-signing every cached token, updating `state_transitions` (which records `agent_id` from the verified JWT `sub`), and rewriting the RLS scaffolding that will gate on `current_org_id()`. Adding it now when all tokens are locally minted is a one-line change that costs nothing. This extends ADR-018 (STAQPRO-263); no new ADR needed.

**Deferred:** `aud` (target org), `fed_grant` (grant UUID), `act` delegation chain (RFC 8693). These are additive and only needed when a real federation request is issued.

### 2. `origin_org` property on all Neo4j nodes

ADR-019 adopted Neo4j for the knowledge graph. Currently nodes have no `origin_org` property — they are implicitly "this org."

**Required change (pre-GA):** All node creation in `lib/graph/` must include `origin_org: process.env.OPTIMUS_ORG_ID ?? "self"`. Set it at write time, not migration time — there is no retrofit path for existing nodes other than a full graph rewrite.

When a second org's KG data arrives (export/import), nodes get label `External:{Type}` and `origin_org: "orgB"`. Cross-org `SAME_AS` edges are created only by Reviewer-tier agents, never auto-merged. Email/domain fields are hints, not identity keys.

**Why this must ship pre-GA:** A graph with no `origin_org` property cannot be partitioned after the fact without reading and rewriting every node. Adding it at write time when single-org is the only mode costs a single constant per write.

**Neo4j as local cache, not federation substrate:** Per Liotta's assessment (see Counter-positions), Neo4j is a local convenience. The authoritative KG export for federation is a signed JSON-LD blob stored in Postgres (`agent_graph.federated_kg_imports`). Neo4j is re-derivable from that blob. Expanding Neo4j investment — clustering, remote BOLT connections, shared graph across orgs — is explicitly halted until a federation customer exists.

### 3. `classification_level smallint` is the canonical classification primitive

STAQPRO-310 (migration 108) shipped the correct primitive. `lib/rag/retriever.js` exports `CLASSIFICATION_LEVELS` (PUBLIC=0, INTERNAL=1, CONFIDENTIAL=2, RESTRICTED=3) and `toClassificationLevel()`. The `<=` comparison on the integer column is correct (P1).

**No change required.** When a federation grant is issued, it carries `max_classification smallint` that caps what a grantee org can receive. The existing ordinal is directly reusable as the cap field — no schema migration needed at federation time.

**Critical:** Do not clone the deprecated `<= 'INTERNAL'` lexicographic pattern from migration 017's `content.match_chunks()` into any new retriever code. The correct pattern is in `lib/rag/retriever.js:157`.

### 4. Capability receipt envelope — define the format now

Even though no receiving org exists, the receipt envelope format must be stable before the first federated query is issued. Retrofitting the format after a customer negotiates against it is a coordination problem.

**Minimum viable receipt (to be formalized in `lib/audit/` before GA):**

```json
{
  "receipt_version": "1",
  "origin_org": "orgA",
  "grant_id": "uuid",
  "agent_sub": "agent:executor-research",
  "agent_tier": "executor",
  "action": "rag_query",
  "document_ids": ["uuid", ...],
  "classification_ceiling": 1,
  "issued_at": "ISO8601",
  "transition_hash": "sha256:...",
  "signature": "ed25519:..."
}
```

`transition_hash` is the hash-chain anchor from `state_transitions` (already computed). `signature` uses the org's signing key (same key pair as `AGENT_JWT_KEY_PEM`). Recipient re-verifies `classification_ceiling` against their own grant record — never trusts remote enforcement (P1).

---

## Consequences — What Gets Killed or Redirected

These are Liotta's explicit "don't do" findings, incorporated honestly.

**No second product before autobot-inbox lands at a second org.** Federation needs N≥2 installs of the *same* product. A second product before the first product has a second customer fragments the surface area, delays the federation hypothesis test, and makes ontology stabilization impossible.

**Halt Neo4j expansion beyond current product needs.** Neo4j is a local query convenience for single-org graph traversal. It is not the federation substrate. Investing in Neo4j clustering, remote access, or shared-graph-across-orgs patterns before a federation customer exists builds the wrong thing. Track expansion against a specific federation customer requirement, not a roadmap assumption.

**Migrate inter-agent comms to MCP transport; deprecate bespoke RPC.** Any internal agent-to-agent call that invents a proprietary envelope or session format is a sunk cost when MCP federation ships. The correct posture is to ride MCP as transport and build the governance/audit layer on top. Current agent communication runs through the Postgres task graph (ADR-001) — this is fine and aligns with P4 (boring infrastructure). The risk is new agent-to-agent interfaces being added as proprietary HTTP/WebSocket rather than MCP-compatible.

**No external federation pitch until N=2.** The thesis requires a second install to be credible. Pitching federation with N=1 invites the reasonable objection that there is nothing to federate. The external narrative stays "governed agent organization for a single company" until UMB plus one external customer is demonstrably running.

---

## Deferred — Do Not Build Yet

All of the following are additive and impose no migration cost when a federation customer arrives. Building them now without a customer wastes capacity and creates maintenance surface.

- `agent_graph.federation_grants` table (grant issuance, max_classification cap, scope_filter jsonb, contract_hash anchor, revocation)
- JWKS publication endpoint (`/.well-known/optimus-jwks.json`)
- Delegation token minting (cross-org JWT with `aud`, `fed_grant`, `act` claims)
- KG export/import pipeline (signed JSON-LD blob generation and ingest into `federated_kg_imports`)
- Cross-org audit join (walking both orgs' `state_transitions` chains, joining on `contract_hash`)
- Dual-board grant approval UI in `/governance`
- `pg_notify('fed_grant_revoked', grant_id)` grant revocation fanout

Trigger for de-deferral: a specific named prospective customer in a target vertical has agreed to a pilot conversation.

---

## Open Questions

**(a) Which vertical roll-up is the test bed?**
UMB Advisors is the first install. The second install should be in a vertical with shared ontology and frequent inter-entity transactions. Financial advisory RIAs (shared clients, shared vendors) and professional services MSPs (shared staff, shared tooling contracts) are the leading candidates. This is a go-to-market decision, not an engineering decision — but engineering needs the answer to know which entity schemas to stabilize.

**(b) How does the receipt format interop with emerging MCP audit conventions?**
MCP does not yet have a standardized audit/receipt convention. The format defined above is provisional. Before the first real federated query, this format should be checked against whatever audit primitives MCP/A2A has shipped by that point. If MCP defines a standard receipt, Optimus adopts it rather than maintaining a bespoke format. Track: Anthropic's MCP spec changelog.

**(c) Postgres-as-SoT vs columnar event store for federation-grade graph.**
Liotta flagged that federation-grade graph at scale wants a columnar event store with materialized views per consumer, not a shared graph database. The current Postgres task graph (ADR-001) is correct for Phase 1. The tension surfaces when Org A's Postgres and Org B's Postgres need to be joined across a trust boundary without sharing a connection pool. The receipt-based approach defers this: each org holds its own chain, and the contract_hash is the keystone that joins them. If query patterns require cross-org joins in real time rather than asynchronous receipt exchange, this architecture needs revisiting. No action now.

---

## Counter-Positions Considered

These are Liotta's stress-test objections. They are surfaced here because a decision record is stronger for acknowledging the strongest case against it.

**The MCP displacement risk.** Anthropic and Google are standardizing inter-agent protocols at the wire level. If federation becomes a commodity protocol (it will), a bespoke Optimus federation layer is the Lotus Notes of agent governance — over-engineered infrastructure for what becomes a handshake. This is a real existential threat. The response recorded in this ADR — ride MCP as transport, build governance overlay on top — is a direct answer to this objection. If the answer is wrong, this ADR needs to be revisited when MCP federation ships.

**The frequency-of-use objection.** M&A diligence happens 1–3x per decade per company. JV ramps maybe once a year. Network effects require repeated transactions to compound. Two organizations that interact twice a year will never overcome the activation energy of negotiating a federation policy. This is why the adoption path is vertical roll-ups (frequent intra-portfolio transactions) rather than PE mandates or one-off M&A. Liotta's objection is valid against the original "M&A diligence" framing and is part of why that framing is not in this ADR's Decision section.

**The CISO-buys-SOC2-not-hash-chains critique.** CISOs do not care that the audit log is hash-chained; they care that Optimus is on their approved vendor list. "Verifiable provenance" is an engineering aesthetic, not a buying criterion for enterprise procurement. Glean closes these deals without it. This objection is correct about enterprise procurement. The response: vertical roll-up buyers are owner-operators (roll-up CEOs, operating partners with a specific mandate), not enterprise CISOs. The buying criterion is "can I see what my agents did across all my entities" — and the receipt primitive answers that question directly for the right buyer profile.

**The PE beachhead is not validation.** PE firms don't mandate software across portcos. UMB Advisors is a controlled environment (Eric controls deployment) and cannot be extrapolated to PE portfolio adoption. This is incorporated directly into Decision (c): UMB is N=1 stepping stone, not validation. The validation requires one external customer in a target vertical.

---

## Affected Files

- `lib/runtime/agent-jwt.js` — add `iss`, `org` claims to `mintAgentToken()`; extend `verifyAgentToken()` to be issuer-aware
- `lib/db.js` — `withAgentScope` signature stays stable; RLS gains `current_org_id()` GUC when federation is active
- `lib/rag/retriever.js` — no change; `classification_level smallint` is already correct (STAQPRO-310)
- `lib/graph/` — all node creation must include `origin_org` property (default `"self"`)
- `lib/audit/` — new: capability receipt format definition and signing utility (pre-GA, before first federation)

## Cross-Project Impact

This ADR is scoped to `~/Optimus`. No other sub-project is currently affected. If `autobot-inbox` is deployed as a separate install at a second organization, that install becomes a distinct deployment with its own signing key and `OPTIMUS_ORG_ID` environment variable — not a separate codebase fork.
