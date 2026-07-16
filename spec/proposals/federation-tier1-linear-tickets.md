# Federation Tier 1 — Linear Ticket Drafts

**Status:** Draft for review (2026-05-14)
**Parent:** ADR-007 / `spec/proposals/federation-tier1-staqs-umb.md`
**Target project:** Optimus (Phase 2 — Repeatable Install) *(see capacity note below)*
**Team:** STAQPRO
**Owner:** Eric

## Capacity Note (read before cutting)

Phase 1 is mid-stabilization: M2/M2b triage latency and M9 gate enforcement are still red, and STAQPRO-301 (voice-similarity rewrite) is the active M3 work. **Tier 1 federation tickets should land in Phase 2, not Phase 1**, with two exceptions that are cheap and additive:

- **T1-A** and **T1-B** below are the pre-GA blockers. They're 30–100 LOC each, fully backward-compatible (`"self"` default), and worth shipping into Phase 1 to avoid migration pain later. They do not compete with M5/M8/M14.
- All other tickets (**T1-C** through **T1-G**) require the second Optimus instance to exist, so they're Phase 2 by construction.

## Ticket List

### T1-A — Add `iss@org` + `org` + `aud` claims to agent JWT (pre-GA)

**Title:** Extend agent JWT claim set with `org` + `aud` (ADR-018 addendum)
**Project:** Phase 1 — MVP Completion
**Parent:** STAQPRO-263 (JWT agent identity rollout)
**Priority:** Medium
**Estimate:** 0.5d

**Description:**
Implements the ADR-018 addendum (2026-05-14) extending the agent token claim set to support federation per ADR-007.

**Acceptance criteria:**
- `lib/runtime/agent-jwt.js` reads `ORG_DID` env var (default `"self"`)
- `signAgentToken` emits `iss: "optimus-agent@<org-did>"`, `org: <org-did>`, `aud: <org-did>`
- `verifyAgentToken` accepts both v1 (no `org`/`aud`) and v2 tokens; v1 treated as `org="self"`, `aud="self"`
- New env flag `REQUIRE_FEDERATION_CLAIMS=false` (default). When `true`, v1 tokens are rejected with `INTEGRITY_FAILURE` audit row per addendum table
- `aud` mismatch produces `INTEGRITY_FAILURE` audit row
- Existing 12-min refresh loop in AgentLoop unchanged
- Unit tests cover: v1 accept, v2 accept, missing `org` under enforce, `aud` mismatch
- No production behaviour change with default env (rollout is purely additive)

**Out of scope:** flipping `REQUIRE_FEDERATION_CLAIMS=true` (that's its own ticket once UMB instance exists), JWKS publication, delegation tokens.

---

### T1-B — Add `origin_org` to all Neo4j enrichers + backfill (pre-GA)

**Title:** Tag Neo4j nodes with `origin_org` (ADR-007 pre-GA blocker)
**Project:** Phase 1 — MVP Completion
**Parent:** ADR-019 (Neo4j knowledge graph)
**Priority:** Medium
**Estimate:** 1d

**Description:**
Second pre-GA blocker from ADR-007. Every node in the knowledge graph gains an `origin_org` property so future federation queries can filter by issuing org without conflating data from other instances.

**Acceptance criteria:**
- All 5 files in `lib/graph/*.js` enrichers updated: every `MERGE` / `CREATE` includes `origin_org: $orgId`
- `$orgId` reads from `ORG_DID` env (default `"self"`), same as T1-A
- All read queries gain default filter `origin_org = $orgId` unless explicit federation flag is set (TBD — for now, hardcode to current org)
- Cypher migration script backfills existing nodes: `MATCH (n) WHERE n.origin_org IS NULL SET n.origin_org = "self"`
- Index added: `CREATE INDEX origin_org_idx FOR (n) ON (n.origin_org)`
- Smoke test: `/governance`, contacts page, claw learning, M13 autonomy promotion all continue working (the 4 confirmed downstream consumers per memory note)
- No production behaviour change for single-org Staqs Pro

**Out of scope:** federation read paths, cross-org joins.

---

### T1-C — Provision UMB Advisors Optimus instance

**Title:** Stand up second Optimus instance for UMB Advisors
**Project:** Phase 2 — Repeatable Install
**Priority:** High (blocks all federation work)
**Estimate:** 2d

**Description:**
Per ADR-007 Tier 1, UMB Advisors LLC gets its own Optimus instance for the self-federation test bed. Identical stack, separate data plane.

**Acceptance criteria:**
- New Supabase project `optimus-umb` (us-west-2, separate from Staqs Pro)
- New Railway service `autobot-inbox-api-umb` deploying from `main`
- `ORG_DID=did:web:umbadvisors.com` (vs Staqs's `did:web:staqs.io`)
- Separate `AGENT_JWT_KEY_PEM` keypair generated (do NOT reuse Staqs key)
- Separate Gmail OAuth credentials for `signing@umbadvisors.com`
- Migrations run cleanly from 001-baseline through latest
- Smoke: agent loop boots, draft pipeline runs end-to-end on a test email
- DNS: `inbox.umbadvisors.com` points to Railway service

**Dependencies:** T1-A, T1-B (instance must boot with v2 claims from day 1)

---

### T1-D — Migration: `agent_graph.federation_grants` table

**Title:** Add federation_grants table (issuer/audience/scope/revocation)
**Project:** Phase 2 — Repeatable Install
**Priority:** High
**Estimate:** 0.5d

**Description:**
Postgres table backing the capability-receipt envelope (`spec/proposals/capability-receipt-envelope.md`).

**Acceptance criteria:**
- New migration in `autobot-inbox/sql/`: `agent_graph.federation_grants`
- Columns: `jti uuid PK, issuer_org text NOT NULL, audience_org text NOT NULL, subject_agent uuid, scope_capability text NOT NULL, scope_filter jsonb NOT NULL, max_results int, max_calls int, contract_hash text NOT NULL, signed_envelope text NOT NULL, issued_at timestamptz, expires_at timestamptz, revoked_at timestamptz NULL, created_by uuid`
- Indexes: `(audience_org, expires_at) WHERE revoked_at IS NULL`, `(contract_hash)`
- Hash-chained: `INSERT INTO state_transitions` trigger for every grant lifecycle event
- RLS policy: only the issuing org's agents can `INSERT`; both issuer and audience can `SELECT` their own rows
- Migrates cleanly on both Staqs and UMB Postgres

---

### T1-E — `lib/federation/receipt.js` — sign/verify primitive

**Title:** Capability receipt sign/verify primitive
**Project:** Phase 2 — Repeatable Install
**Priority:** High
**Estimate:** 1.5d

**Description:**
Implements the v0.1 envelope from `spec/proposals/capability-receipt-envelope.md`. Pure library — no transport, no HTTP endpoints in this ticket.

**Acceptance criteria:**
- `signReceipt({issuer, audience, subject, scope, contractHash, ttl})` returns signed JWS
- `verifyReceipt(receipt, {expectedAudience, currentOrgDid})` returns `{valid, claims, reason}`
- Verifies signature against issuer's JWKS (cached 60s)
- Checks `exp`, `nbf`, `aud`, `iss`, `jti` not in revocation list
- Revocation list polled from `<issuer-base-url>/.well-known/federation/revocations.json` (60s cache)
- Unit tests cover: happy path, expired, wrong audience, revoked, bad signature, missing scope
- No DB writes in this ticket — pure crypto primitive

**Dependencies:** T1-A (uses agent JWT keys, same RS256 path)

---

### T1-F — Federation grant + query endpoints

**Title:** POST /federation/grant + GET /federation/query
**Project:** Phase 2 — Repeatable Install
**Priority:** Medium
**Estimate:** 2d

**Description:**
HTTP endpoints wrapping T1-E primitive. CLI-only consumers in v0.1 — no board UI.

**Acceptance criteria:**
- `POST /federation/grant` — board-authenticated, accepts `{audience_org, scope, contract_hash, ttl}`, returns signed receipt + persists to `federation_grants`
- `GET /federation/query?capability=kg.read` — accepts receipt in `Authorization: Bearer <receipt>` header, verifies via T1-E, enforces `scope.filter` at Neo4j query time, returns scoped KG slice
- Scope enforcement happens at the *issuing* org's query layer — audience cannot extend by re-interpreting filter
- Both endpoints write audit rows on every call (success or failure)
- `max_results` and `max_calls` caps enforced server-side
- Revocation list endpoint: `GET /.well-known/federation/revocations.json`

**Dependencies:** T1-D, T1-E

---

### T1-G — End-to-end demo: Staqs↔UMB cross-org query with revocation

**Title:** Federated KG demo: Staqs ↔ UMB with revocation + audit join
**Project:** Phase 2 — Repeatable Install
**Priority:** High (Tier 1 success criterion)
**Estimate:** 1d

**Description:**
Demonstrates ADR-007 Tier 1 success criteria end-to-end. Manual smoke test, documented runbook for board demo.

**Acceptance criteria:**
- Issue grant: Staqs → UMB, capability `kg.read`, filter `node.tags CONTAINS 'umb-engagement'`, 24h TTL
- From UMB Optimus: query Staqs for nodes matching the filter, receive ≤500 results, all stamped `origin_org="did:web:staqs.io"`
- Revoke grant from Staqs. Within 60s, UMB's next call returns 401 with `INTEGRITY_FAILURE` audit row on both sides
- Reconstruct audit chain from both `state_transitions` tables using shared `contract_hash` — verify hash continuity on each side independently
- Runbook written to `autobot-inbox/docs/internal/federation-tier1-runbook.md` for board demo
- No regressions in single-org code paths (verified via existing test suite)

**Dependencies:** T1-A through T1-F

---

## Sequencing

```
T1-A ─┐
       ├─→ T1-C ─→ T1-D ─→ T1-E ─→ T1-F ─→ T1-G
T1-B ─┘
```

T1-A and T1-B are parallel; everything else is serial.

## Review Checklist Before Cutting

- [ ] T1-A scope confirms no breaking change to existing tokens
- [ ] T1-B backfill query reviewed against current Neo4j node count (memory note: 5 enricher files load-bearing — confirm `origin_org` filter doesn't break governance/contacts/claw/M13 reads)
- [ ] T1-C cost confirmed — Supabase project + Railway service adds ~$50/mo recurring
- [ ] T1-D table design reviewed by PostgresDBA before migration
- [ ] T1-E receipt format frozen at v0.1 — any envelope changes after this point are breaking
- [ ] No ticket touches M5/M8/M14 stabilization paths

## Not in this batch

- ADR-007 update to reference these tickets (paper-only follow-up)
- ADR-018 follow-up to flip `REQUIRE_FEDERATION_CLAIMS=true` (Tier 2 work)
- Capability-receipts spec repo extraction to `staqsIO/capability-receipts` (post-Tier 1)
- Board UI for grant management (CLI-only in v0.1)
