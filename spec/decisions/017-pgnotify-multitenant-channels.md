# ADR-017: pg_notify Multi-Tenant Channel Strategy

**Date**: 2026-06-13
**Status**: PENDING BOARD DECISION
**Issue**: OPT-59
**Related**: ADR-012 (authz spine / 3-tier tenancy), ADR-018 PR-B (RLS + non-superuser role flip), Phase 2 of the Proper Path plan

---

## Context

### The problem: LISTEN/NOTIFY is a global broadcast

PostgreSQL's `pg_notify` / `LISTEN` mechanism is **database-wide**. Every client that issues `LISTEN <channel>` on the same database receives every notification fired to that channel — regardless of which tenant (org) the payload belongs to. There is no per-role or per-schema filtering at the Postgres level.

Optimus is moving toward a multi-org world (UMB Advisors + Staqs + future orgs) on a **shared Postgres database**. Once a second org is live, any LISTEN client for a given channel receives notifications containing the other org's data unless the channel names are partitioned or the application filters on receipt.

### Current channel inventory

All channels found in the codebase as of 2026-06-13:

**`lib/` subsystem channels (graph sync — `lib/graph/sync.js:11-19`):**
```
task_completed
intent_decided
draft_reviewed
contact_changed
identity_changed
organization_changed
project_membership_changed
```

**`autobot-inbox/src/` product channels (grep of `pg_notify(` calls):**
```
autobot_events
capture_ingested
hitl_resolved
human_task_completed
human_task_divergence
human_task_enrichment_pending
human_task_push_pending
human_task_ready_for_optimus
human_task_resync
```

**`lib/hitl/index.js:103`** issues `LISTEN hitl_resolved` — a per-request blocking wait for human input, currently without any tenant scoping.

**`lib/db.js:144–152`** documents the session-pooler (port 5432) / transaction-pooler (port 6543) split; LISTEN connections stay on the session pooler. The Phase 1 fix consolidated all LISTEN clients onto a single shared `pg-listener`.

### The cross-org event-leak risk

Without channel scoping:

1. Agent runtime on Org A subscribes to `LISTEN task_completed`.
2. Org B's runtime fires `pg_notify('task_completed', '{"org_id":"B","task_id":"..."}')`.
3. Org A's listener receives the notification. It may log it, process it (if the handler doesn't check `org_id`), or discard it — but it **always receives it**.
4. Even discard-on-receipt leaks metadata (event timing, payload size) across the org boundary, which violates P1 (deny by default) and ADR-012's tenancy model.

The risk is **currently low** (single org in production) but becomes a P0 blocker the moment Org B's first agent runtime connects to the same database.

### Design principles in play

- **P1 Deny by default** — nothing is permitted unless explicitly granted. A shared channel grants every LISTEN client all notifications.
- **P2 Infrastructure enforces; prompts advise** — enforcement must not rely on per-agent payload filtering.
- **P4 Boring infrastructure** — the solution should be the simplest change that achieves the isolation guarantee.

---

## Options

### Option A: `org_id`-prefixed channel names (Recommended)

Partition the channel namespace by prepending the org's UUID to every channel name:

```
# current
pg_notify('task_completed', payload)
LISTEN task_completed

# proposed
pg_notify('org_7c164445_task_completed', payload)   -- Staqs
pg_notify('org_95391e55_task_completed', payload)   -- UMB Advisors
LISTEN org_7c164445_task_completed                  -- Staqs runtime only
```

Each agent runtime subscribes only to its own org's channels. The channel name itself is the tenant boundary. No Postgres configuration change is required; no schema migration needed.

**Tradeoffs:**

| Dimension | Assessment |
|---|---|
| Implementation cost | Low: grep-replace `pg_notify` call sites and LISTEN registrations; wrap in a `notifyChannel(orgId, channel, payload)` helper |
| Postgres overhead | Negligible: Postgres channel names are strings; there is no per-channel resource allocation |
| Enforcement | Software-enforced (P2 caveat: a bug in the helper could use the wrong org prefix) |
| Isolation strength | Strong enough for data privacy; channel name leaks nothing about payload content |
| Operability | Channel names appear in logs — makes tenant attribution of events immediately readable |
| Migration | Each call site must be updated. `hitl_resolved` has a request-scoped ID in the payload already; can be made `hitl_resolved_<requestId>` (no org prefix needed — already request-scoped) |
| Multi-process | The shared pg-listener in `autobot-inbox/src/runner.js:126` and `src/index.js:186` subscribes on behalf of all agents in that process; in a single-org-per-process model this is fine |
| PGlite fallback | `lib/hitl/index.js:140` already falls back to polling if LISTEN fails; prefix does not affect the fallback path |

**Channel count:** 9 product + 7 graph = 16 channels × number of orgs. At 3 orgs = 48 channel subscriptions per runtime instance — well within Postgres limits.

### Option B: Physical database separation (one DB per org)

Each org gets its own Postgres database (or Supabase project). LISTEN/NOTIFY is isolated by construction. RLS is also per-database.

**Tradeoffs:**

| Dimension | Assessment |
|---|---|
| Isolation strength | Absolute — no shared surface |
| Implementation cost | Very high: connection string per org, migration tooling per org, cross-org federated queries need an explicit federation layer (ADR-007 federation thesis) |
| Operational cost | N × Railway services, N × Supabase projects, N × migration pipelines |
| Consistency | Cross-org data (federation receipts, shared contacts) becomes an explicit distributed systems problem |
| P4 boring infra | Violates: this is novel infra complexity for a problem Option A solves adequately |
| Timeline | Incompatible with the Phase 2 / demo window |

Physical separation is the right long-term model for full regulatory isolation between orgs (e.g., when UMB has distinct data-residency requirements). It is not the right answer for the current Phase 2 problem.

---

## Recommendation

**Adopt Option A: `org_id`-prefixed channel names.**

This is the boring-infrastructure (P4) call. It closes the cross-org event-leak risk with a small, auditable code change, no new infrastructure, and no schema migration. It is consistent with the existing P1 / ADR-012 tenancy model: the org boundary is already expressed in every row via `owner_org_id`; channel names should carry the same boundary.

### Migration sketch

1. **Add helper** `lib/runtime/pg-listener.js` (or `lib/db.js`): `channelFor(orgId, baseName)` → `org_${orgId.replace(/-/g, '')}_${baseName}`. The org UUID without hyphens keeps names under 63 chars (Postgres NAMEDATALEN limit: 32-char UUID → 28-char hex + 4-char prefix + channel name ≤ 63 total; longest current channel = `project_membership_changed` = 27 chars; 28 + 1 + 27 = 56 ✓).
2. **Update all `pg_notify(...)` call sites** (9 in `autobot-inbox/src/`, 7 via DB triggers if any) to use `channelFor(orgId, base)`.
3. **Update all `LISTEN`/`UNLISTEN` registrations** in `src/runner.js:126`, `src/index.js:186`, `lib/graph/sync.js:151`, `lib/hitl/index.js:103` to subscribe to org-prefixed names. `hitl_resolved` is already request-scoped by payload; switch to `hitl_resolved_<requestId>` (no org prefix needed) to keep it lightweight.
4. **Config flag**: `LISTEN_ORG_PREFIX_ENABLED=true` — gates the new behavior so existing single-org deployments continue to work during the cutover window. Remove after all runtimes are updated.
5. **Fuzz harness** (Phase 2 exit gate per the Proper Path plan): assert that a simulated Org B `pg_notify` call is never received by an Org A LISTEN client.

### Dependency

This migration must land **before** any second org runtime connects to the shared database, and **after** ADR-018 PR-B (RLS flip) is validated in staging — the two changes are independent but the PR-B staging checklist should include a LISTEN channel audit.

---

## Alternatives Not Pursued

- **Row-level NOTIFY filtering via Postgres triggers**: Triggers can embed `org_id` in the payload for NOTIFY; clients still receive all notifications and must filter on receipt. This is application-level filtering, which violates P2.
- **Redis Pub/Sub per org**: Would replace pg_notify entirely, adding a new dependency. Violates P4. Rejected.

---

## Decision

**PENDING BOARD DECISION.**

Recommendation is Option A (org_id-prefixed channels). Board must decide before Org B runtime goes live.

Open question for the board: should `hitl_resolved` use request-ID scoping (proposed above) or org-prefix scoping? Request-ID is tighter but requires the campaign HITL caller to know the request ID at LISTEN time (it already does — `lib/hitl/index.js:56` uses `requestId`).
