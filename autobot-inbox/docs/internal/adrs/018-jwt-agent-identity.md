---
title: "ADR-018: JWT Agent Identity — Board Mandate"
description: "Board reverses ADR-015 deferral. JWT-scoped agent identity required for Phase 1 exit."
---

# ADR-018: JWT Agent Identity — Board Mandate

**Date**: 2026-03-07
**Status**: Accepted
**Supersedes**: ADR-015 (JWT Deferral to Phase 2)

## Context

ADR-015 deferred JWT-scoped agent identity to Phase 2, accepting HMAC-signed claims + application-layer session vars as sufficient for Phase 1's threat model.

During the Phase 1 exit audit (2026-03-07), the board (Eric + Dustin) reviewed the deferral and reversed it. The reasoning:

1. **New contributors joining this week** — the single-process, two-person trust assumption no longer holds
2. **Railway deployment tonight** — agents will run on shared infrastructure, not localhost
3. **Spec compliance** — the spec says "JWT identity" and the board wants literal compliance, not equivalent enforcement
4. **Principle alignment** — P2 (infrastructure enforces; prompts advise) demands cryptographic identity, not application-layer identity

## Decision

Implement JWT-scoped agent identity before Phase 1 formally exits.

### Implementation Scope

1. **JWT issuer** — sign agent tokens at process startup with RS256 (reuse the GitHub App PEM key or generate a dedicated signing key)
2. **Token claims** — `{ agent_id, tier, allowed_tools, iat, exp }` per spec §5
3. **Short-lived tokens** — 15-minute TTL, auto-refresh in AgentLoop
4. **DB connection scoping** — each agent's token sets `app.agent_id` via `withAgentScope()` (already implemented) but now validated against the JWT signature
5. **RLS activation** — connect as `autobot_agent` role (defined in seed, not yet used) with RLS policies enforced
6. **Audit log binding** — `state_transitions.agent_id` becomes JWT-verified, not just a string

### Out of Scope (Phase 2)

- Per-agent DB roles (one role per agent, not one shared `autobot_agent` role)
- Token revocation list (kill switch is sufficient for Phase 1)
- External JWT verification (no agents call external APIs with JWT yet)

### Trigger from ADR-015 Met

Conditions 1 and 3 from ADR-015 are now met:
- **Multi-contributor**: New contributors joining this week
- **Network-exposed**: Railway deployment exposes the API port

## Consequences

- ADR-015 is superseded — JWT is no longer deferred
- `AGENT_SIGNING_KEY` env var required (or reuse GitHub App PEM)
- AgentLoop must acquire and refresh JWT tokens
- `withAgentScope()` validates JWT signature before setting session var
- RLS policies become runtime enforcement, not just schema documentation
- Connection pool must support the `autobot_agent` role (Railway Postgres)

## OWASP Agentic Security Initiative (ASI) Mapping

Added 2026-05-11 (STAQPRO-263 PR-C). The OWASP ASI top-ten enumerates the
primary threats against agentic systems. This ADR's controls map to those
threats as follows. Threats not listed below are out of scope for ADR-018.

| ASI Threat | Mitigation provided by ADR-018 | Residual / out of scope |
|------------|-------------------------------|-------------------------|
| **ASI-02 Tool Misuse** | JWT `tools` claim is signed alongside `sub`; enforcement layer (Phase 2) can deny calls outside the allow-list without trusting the caller's self-declared agent ID. | Tool integrity hash check (separate control) and the actual deny enforcement happen above the auth layer. |
| **ASI-03 Privilege Compromise** | RS256 signature prevents an agent from forging a token claiming another agent's `sub`/`tier`. `withAgentScope()` rejects unverified identity in enforcement mode (`REQUIRE_AGENT_JWT=true`). | Per-agent DB roles (one role per agent) deferred to Phase 2 — current model is one shared `autobot_agent` role gated by `current_agent_id()`. |
| **ASI-08 Repudiation & Untraceability** | `state_transitions.agent_id` is set from the verified JWT `sub` claim, not from caller-supplied input. Combined with hash-chained transitions and the PR-C audit row (`agent_graph.threat_memory`, class `INTEGRITY_FAILURE` / `ESCALATION_BYPASS`), every identity assertion — success or failure — is non-repudiable. | Token revocation list deferred to Phase 2; kill switch is the Phase 1 substitute. |
| **ASI-09 Identity Spoofing & Impersonation** | **Primary mitigation.** RS256 over `{ iss, sub, tier, tools, iat, exp, jti }`, 15-minute TTL, issuer-pinned to `optimus-agent`, sub format-validated. | External-system identity (calls *out* to third-party APIs as the agent) not in scope for this ADR. |

### Audit emission on failure (PR-C, 2026-05-11)

Every `verifyAgentToken()` failure inside `resolveAgentIdentity()`
(`lib/db.js`) emits a hash-chained row to `agent_graph.threat_memory`
via `recordThreatEvent()`:

| Failure path | `threat_class` | `severity` | `source_type` |
|--------------|----------------|------------|---------------|
| Malformed JWT / bad signature / expired / bad issuer / bad sub | `INTEGRITY_FAILURE` | `HIGH` | `gateway_inbound` |
| Plain-string agent ID under `REQUIRE_AGENT_JWT=true` | `ESCALATION_BYPASS` | `HIGH` | `gateway_inbound` |

Emission is fire-and-forget — audit infrastructure failures cannot break
the auth path. The detail JSON includes the first 32 chars of the
offending input (never the full token) plus the error message.

Note: the `autobot-inbox/src/api.js` board-auth handler also calls
`verifyAgentToken`, but only inside a try-board-then-try-agent probe —
failures there are *expected* normal flow and are not audited.

## Addendum — Federation Claim Extension (2026-05-14)

Added to align with ADR-007 (Federation Thesis). The first pre-GA blocker
named in `spec/proposals/federation-tier1-staqs-umb.md` requires extending
the agent token's claim set. This addendum specifies the extension; the
core ADR-018 decision (RS256, 15-min TTL, audit-on-failure, RLS pathway)
is unchanged.

### Claim set v2

| Claim   | v1 (current)            | v2 (this addendum)                                       | Notes |
|---------|-------------------------|----------------------------------------------------------|-------|
| `iss`   | `"optimus-agent"`       | `"optimus-agent@<org-did>"` (e.g. `optimus-agent@did:web:staqs.io`) | Composite. Verifier splits on `@` and matches both halves. |
| `sub`   | agent_id (UUID)         | agent_id (UUID) — unchanged                              | Globally unique already; org disambiguates only on collisions. |
| `org`   | *(absent)*              | `<org-did>` (e.g. `did:web:staqs.io`)                    | NEW. Required claim under v2 enforcement. |
| `aud`   | *(absent)*              | `<org-did>` of the consuming org                         | NEW. For agent-loop tokens this equals the issuer's org half (self-consumption). Federation receipts use a different audience. |
| `tier`  | tier name               | unchanged                                                |  |
| `tools` | allow-list              | unchanged                                                |  |
| `iat`/`exp`/`jti` | as v1         | unchanged                                                |  |

### Backward compatibility

`verifyAgentToken` MUST accept v1 tokens (no `org` / no `aud`) during the
rollout window and treat them as `org = "self"`, `aud = "self"`. Once both
Optimus instances (Staqs and UMB per ADR-007 Tier 1) are issuing v2 tokens,
a follow-up change flips `REQUIRE_FEDERATION_CLAIMS=true` and v1 tokens
are rejected with an `INTEGRITY_FAILURE` audit row.

### Default value for single-org deploys

`ORG_DID` env var defaults to `"self"`. Existing single-org deploys
(including Staqs Pro before UMB stands up) emit tokens with `org: "self"`
and `aud: "self"`. This is intentionally non-routable — nothing outside
the issuing process will accept `"self"` as a valid federation org — so
the default cannot accidentally leak grants across orgs.

### Audit emission

The ASI-09 audit row (`verifyAgentToken` failure) gains two new failure
paths under v2 enforcement:

| Failure path | `threat_class` | `severity` |
|--------------|----------------|------------|
| Missing `org` claim under `REQUIRE_FEDERATION_CLAIMS=true` | `INTEGRITY_FAILURE` | `HIGH` |
| `aud` mismatch (token issued for a different org) | `INTEGRITY_FAILURE` | `HIGH` |

### OWASP-ASI mapping update

This addendum strengthens **ASI-09 (Identity Spoofing & Impersonation)**
for the cross-org case: a token from org A cannot be replayed against
org B because the `aud` claim binds it to the issuing org's own
consumers. Without this, federation grants would inherit only the
intra-org spoofing protection from v1.

### Out of scope (still)

- Federation grant tables (`agent_graph.federation_grants`) — see ADR-007 proposal.
- JWKS publication at `/.well-known/federation/jwks.json` — Tier 2 concern.
- Delegation chains (RFC 8693 `act` claim) — explicitly deferred.
- Per-agent keypairs — same Phase 2 status as ADR-018 originally specified.

### Why this is an addendum, not a new ADR

Same controls, same crypto, same enforcement model. Only the claim set
widens. Splitting this into a new ADR would obscure that ADR-018's
identity primitive is what makes ADR-007's federation primitive
buildable in the first place.
