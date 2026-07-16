# External Customer Access + On-Prem / Portability Path (OPT-37)

> **Provenance:** relocated from `spec/decisions/017` into the implementation-ADR
> sequence as **028** so the OPT-37 PR stays a single agent-tier change (the
> `config-isolation` gate forbids mixing board-tier `spec/` files with agent-tier
> code). The `ADR-012`/`ADR-014` references below point to the **`spec/decisions/`**
> sequence, not this folder. Board sign-off is still required (see status).

> Authored 2026-06-08. Status: **PROPOSED** — needs board sign-off because it
> defines a new external-facing credential class and a security boundary (root
> CLAUDE.md: "never present as final anything involving security boundaries").
> Builds on ADR-012 (tenancy/authorization spine), ADR-014 (route-tier taxonomy),
> and the OPT-37 customer-token implementation that ships alongside this note.

## TL;DR / Recommendation

Optimus now supports a **third token class — the external customer token** — so a
customer's own agent system (Cursor, bespoke) can consume the company brain over
the existing hosted Board API, scoped to exactly one org. This note records that
decision and lays out the **on-prem / portability horizon** as a phased path,
recommending we deliberately **defer a forked standalone instance** in favor of
the hosted, per-org-scoped model until a customer contractually requires
data residency.

## What shipped with this note (the near-term decision)

- **`customer_principals`** (migration 159) — a durable external identity bound to
  one `tenancy.orgs` row. Not a `board_members` row; not an internal agent.
- **`optimus-customer` JWT** (separate keypair, `lib/runtime/agents/customer-jwt.js`)
  — re-verified every request against `is_active` + org binding + jti revocation.
- **Customer authorization ceiling** (`api.js`) — a customer token reaches only
  `public` + `org-shared` tiers; everything else is `403`, **always enforced**
  (not gated by the observe/enforce rollout). Org scope fail-closes to its one org
  via `syntheticPrincipal(org_id)` → `visibleClause`.
- **MCP/CLI** — token-class-aware: a customer token auto-registers the 10
  customer-safe tools (KB + artifacts + enrichment) and disables the heartbeat.
- **Enforce flip** (migration 160) — `admin` + `org-shared` tiers → `enforce`.

This satisfies the OPT-37 external-access core **without** a standalone instance:
the customer points their client at our hosted API with their token.

## The portability question

"On-prem / a customer's own agents consuming the company brain / a standalone
Optimus instance" can mean three increasingly heavy things. We should not conflate
them:

| Level | What it is | What it costs | When justified |
|---|---|---|---|
| **L1 — Hosted, per-org scoped** (shipped) | Customer's agents call our hosted API with an org-scoped customer token | ~0 new infra | Default. Covers the engagement surface today. |
| **L2 — Federated read** | Customer runs their own Optimus org; selected resources shared cross-org via `tenancy.federation_grants` (ADR-012 Tier 3, dormant) | Activate federation runtime, revocation/audit (OPT-75–79) | When two orgs (e.g. Staqs ↔ UMB) must mind-meld but keep separate tenancy |
| **L3 — Standalone / on-prem instance** | A forked Optimus deployment in the customer's environment, their DB, their keys | High: deploy story, migration packaging, key management, update channel, support | Only when data residency / air-gap is a contractual requirement |

### Recommendation: L1 now, L2 next, L3 only on demand

1. **L1 is the product** for external engagement and is live. Push customers here
   first — it is the lowest blast radius (one credential class, one enforcement
   boundary, one codebase to patch).
2. **L2 (federation)** is the real "mind-meld" and is where the schema already
   points (`federation_grants` exists but matches nothing until a grant is
   issued). The remaining work is the *grant issuance + revocation + audit*
   runtime, tracked in OPT-75–79. The customer-token principal slots into this
   cleanly: a federated read is just a customer/org principal whose
   `visibleClause` third branch (federation) starts returning rows.
3. **L3 (standalone)** should be **deferred until a customer requires it**.
   Forking a running instance multiplies the security surface (every constitutional
   gate, every key, every migration now lives in an environment we don't operate)
   and contradicts P4 (boring infrastructure) and the single-source-of-truth task
   graph. When it is required, the portability seams to preserve are: (a) the
   `tenancy` schema as the only multi-org boundary, (b) the route-tier table as the
   single enforcement config, (c) no hardcoded org UUIDs outside
   `lib/tenancy/scope.js` (`CURRENT_ORG_ID`), and (d) the JWT keypairs as the only
   trust roots. Keeping those four clean today is what makes L3 a deployment
   exercise later rather than a rewrite.

## Open questions for the board

1. **Customer token TTL + rotation.** Currently 24h (same as board). External
   clients may want longer-lived credentials with explicit rotation. Decide a
   policy (e.g. 24h + a documented re-issue/rotation flow vs. a longer TTL).
2. **Per-scope hard enforcement.** The ceiling is tier-based; campaign/wiki writes
   are `org-shared` (tier-permitted) but omitted from the customer tool set and
   excluded by token scope. If a customer must be *hard*-blocked from those,
   add per-scope checks on those routes. Needed now, or defer?
3. **Federation trigger.** What concrete first use case flips us from L1 to L2
   (the Staqs ↔ UMB mind-meld is the obvious candidate)?
4. **L3 line in the sand.** Agree we do not build a standalone instance until a
   signed requirement exists — so we don't pre-pay that complexity.

## Non-goals (this note)

- Building the federation grant runtime (OPT-75–79).
- Building a standalone deployment/packaging pipeline (L3).
- Admin self-service customer-token management UI (board API exists; a UI is a
  follow-up if volume warrants).
