# Capability Receipt Envelope — Draft Spec v0.1

**Status:** Draft (2026-05-13)
**Parent:** ADR-007 (Federation Thesis)
**Purpose:** Define a minimal, portable envelope format that lets one governed agent organization issue a *scoped, time-bounded, revocable* capability to another, with cryptographic verifiability and a reconstructible cross-org audit chain.

## Design Principles

- **Boring crypto.** RS256 JWT-over-JSON. No exotic curves, no homomorphic anything. (P4)
- **MCP-compatible.** The envelope rides on existing MCP/A2A transport. Optimus does not invent a new protocol; it adds governance metadata to messages already in flight.
- **Deny-by-default.** A receipt grants exactly what it enumerates — no wildcards, no implicit transitive grants. (P1)
- **Audit by structure.** Every receipt issuance and consumption produces an immutable audit row on both sides, anchored by `contract_hash`. (P3)
- **No global identity service.** Each org publishes its JWKS at a well-known URL. Verification is point-to-point.

## Envelope Schema (v0.1)

```json
{
  "v": "1",
  "iss": "did:web:staqs.io",
  "aud": "did:web:umbadvisors.com",
  "sub": "agent:claw-workshop",
  "jti": "01HXXXXXX",
  "iat": 1747180800,
  "exp": 1747267200,
  "nbf": 1747180800,
  "scope": {
    "capability": "kg.read",
    "filter": {
      "node_types": ["Person", "Company", "Project"],
      "predicate": "node.tags CONTAINS 'umb-engagement-2026q2'"
    },
    "max_results": 500,
    "max_calls": 100
  },
  "contract_hash": "sha256:abc123...",
  "revocable_at": "https://staqs.io/.well-known/federation/revocations",
  "act": null
}
```

### Field Semantics

| Field | Meaning |
|-------|---------|
| `v` | Envelope version. Bump on breaking changes. |
| `iss` | Issuing org DID. `did:web:<domain>` initially; opaque DIDs later. |
| `aud` | Audience org DID. Single audience per receipt (no broadcast grants). |
| `sub` | Subject agent (the bearer that may exercise this capability). |
| `jti` | Unique receipt ID. Used for revocation + audit join. |
| `iat`/`exp`/`nbf` | Standard JWT time claims. `exp - iat <= 24h` enforced. |
| `scope.capability` | Verb in dot-namespaced form. Initial set: `kg.read`, `rag.read`, `audit.read`. No write capabilities in v0.1. |
| `scope.filter` | Capability-specific filter object. Enforced by the *issuing* org at query time. |
| `scope.max_results` | Hard cap on returned records per call. |
| `scope.max_calls` | Hard cap on invocations within the receipt lifetime. |
| `contract_hash` | Hash of the underlying business contract (NDA, SOW, JV agreement) authorizing this federation. Anchors the cross-org audit chain. |
| `revocable_at` | URL where the issuer publishes revocation lists. Audience SHOULD check before consuming. |
| `act` | RFC 8693 delegation chain. `null` in v0.1 (no multi-hop). |

## Lifecycle

1. **Issue.** Issuer signs envelope with its org keypair. Records `{jti, audience, scope, contract_hash}` in `agent_graph.federation_grants`. Hash-chains an audit row.
2. **Transport.** Envelope is attached to an MCP message (e.g., as a tool_use parameter or message header). Transport is unchanged.
3. **Consume.** Audience verifies signature via issuer's JWKS, checks revocation, checks `exp`/`nbf`/`aud`/`sub`, invokes the issuer's capability endpoint with the receipt.
4. **Enforce.** *Issuer* enforces scope at query time. The audience cannot extend scope by re-interpreting the filter.
5. **Audit.** Both sides write an immutable row: `{jti, contract_hash, agent_id, action, result_count, ts}`. Rows are hash-chained within each org; the shared `contract_hash` allows cross-org reconstruction.
6. **Revoke.** Issuer adds `jti` to its revocation list. Audience SHOULD poll; issuer MUST reject revoked `jti` on any subsequent call regardless.

## What's Deliberately NOT in v0.1

- Write capabilities (no `kg.write`, no `task.create`). Read-only federation first.
- Delegation chains (`act` claim). Single-hop only.
- Bilateral negotiation protocol. Issuance is one-way; the audience requests out-of-band.
- Standard scope grammar across capabilities. Each capability defines its own `filter` shape in v0.1.
- Anything in TUF / Sigstore / SPIFFE. Considered, deferred — too much surface area for an experimental primitive.

## Why Not Just OAuth Token Exchange (RFC 8693)?

RFC 8693 is the closest existing standard and we should be honest about why we're not just using it verbatim:

- RFC 8693 gives us the *delegation* shape (`act` chain) — we adopt that field.
- It does NOT give us scoped filters, result caps, contract anchoring, or revocation list semantics.
- The capability-receipt envelope is "RFC 8693 + governance metadata." Not a competing standard, an extension layer.

## Reference Implementation Plan

- `lib/federation/receipt.js` — issue/verify/revoke primitives. ~150 LOC.
- `agent_graph.federation_grants` table (Postgres migration).
- `/.well-known/federation/jwks.json` — issuer JWKS.
- `/.well-known/federation/revocations.json` — revocation list (polled, cached 60s).
- `POST /federation/grant` — issue endpoint (authenticated, board-approved).
- `POST /federation/query` — consume endpoint (verifies receipt, enforces scope, returns slice).

## Open Questions (for early feedback)

1. **DID method.** `did:web` is pragmatic but ties identity to DNS. Worth supporting `did:key` for offline scenarios?
2. **Revocation polling vs push.** Polling is boring (P4). Push (webhook) is faster. Start polling, add push later?
3. **Should `contract_hash` be globally addressable?** I.e., should there be a shared registry of contract hashes? Probably no — bilateral is fine for v0.1.
4. **Compatibility with Microsoft's agent-governance-toolkit envelopes.** Worth a compatibility note once their spec stabilizes.

## Publication Plan

- v0.1 lives here in `spec/proposals/`.
- Once Tier 1 (Staqs↔UMB) ships and the envelope survives contact with reality, extract to its own repo: `staqsIO/capability-receipts` (Apache-2.0). Reference implementation in JS + TS types.
- Goal: be the spec someone else cites, not the spec someone else replaces.
