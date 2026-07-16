# ADR-021: Tenancy GUCs + DB-level RLS backstop for the leak class

- **Status:** Accepted (security follow-through)
- **Date:** 2026-06-17
- **Deciders:** Eric (board), Carlos (engineering)
- **Builds on:** ADR-012 (authorization spine), ADR-018 (agent JWT), ADR-019 (board JWT)
- **Principles:** P1 (deny-by-default), P2 (infra enforces — not prompts, not app code), P3 (transparency), P4 (boring infra)

## Context — what the codebase already had

ADR-012 §5 laid out a two-layer defense for tenant-scoped reads:

1. **App layer (PRIMARY today):** `lib/tenancy/scope.js:visibleClause()` — the WHERE
   fragment every tenant-scoped read appends. M-C (STAQPRO-588) routed the leaky reads
   through this; the parity test `test/tenancy-parity.test.js` pins the equivalence with
   the SQL function.
2. **DB layer (target):** the SQL function `tenancy.visible(row_owner_user, row_owner_org)`
   from migration 133, designed to read two session GUCs:
   - `app.user` — the caller's `board_members.id`
   - `app.org_ids` — CSV of org UUIDs the caller can read

The SQL function existed. The schema, the column stamps (mig 134), and the federation
predicate were all there. The **only missing piece**, called out by name in migration
133's header — *"GUCs set by lib/tenancy via SET LOCAL in a per-request txn — BLOCKER 3"* —
was the wiring that actually sets those GUCs inside the scoped transaction.

Result: `tenancy.visible()` was unused. No RLS policy referenced it. The leak surface
was the application layer alone, which is exactly the configuration that produced
STAQPRO-588 (`/api/signals` cross-org leak) and the #432/#442/#455 recurring bug class.

## Decision

Plumb the tenancy GUCs through the existing scoped-client machinery, and plant SELECT
policies USING `tenancy.visible(...)` on the 11 tenant-owner-stamped tables. Ship both
as **additive, dormant** changes — no behavior change in production today.

### Implementation

1. **`setAgentContext(client, agentId, role, opts)`** (`lib/db.js`) gains two opts:
   - `user` — a UUID string; sets `app.user` via `set_config(..., true)`
   - `orgIds` — array of UUID strings, joined as CSV; sets `app.org_ids`

   Both are validated by the canonical 8-4-4-4-12 UUID regex at the boundary — a
   malformed value throws before `set_config` runs, so the GUC can never hold a
   half-poisoned string that `tenancy.visible()` would either error on or silently
   coerce.

2. **`withAgentScope(token, opts)`** forwards `user`/`orgIds` through to
   `setAgentContext` on both the Postgres and PGlite paths.

3. **`withBoardScope(boardTokenOrAuth, { principal })`** accepts an already-resolved
   principal (the same object `lib/tenancy/scope.js:resolvePrincipal()` returns and
   `withViewer()` already produces in `autobot-inbox/src/api.js`). Routes that want
   the DB-level backstop pass it explicitly:
   ```js
   const { principal } = await withViewer(req);
   const q = await withBoardScope(req.auth, { principal });
   try {
     // q's transaction has app.user + app.org_ids + app.role='board' set
   } finally { await q.release(); }
   ```
   `withBoardScope` deliberately does NOT auto-resolve the principal — that would
   introduce a cyclic import (`lib/db` → `lib/tenancy/scope` → `lib/db`) and conflate
   identity verification with tenancy resolution. Callers without a principal get
   the existing behavior (GUCs unset → `tenancy.visible()` fails closed for every
   row, the deny-by-default posture P1 mandates).

4. **Migration 190** plants SELECT policies USING `tenancy.visible(NULL::uuid, owner_org_id)`
   on the 11 tables that migration 134 stamped with `owner_org_id`. ENABLE ROW LEVEL
   SECURITY, **not** FORCE — see "Why ENABLE-only (deferred FORCE)" below.

5. **Migration 191** restores `SECURITY DEFINER` + pinned `search_path` + the caller-identity
   assertion on `claim_next_task`. Migration 159 (`fleet-runner-routing`) had silently
   dropped these by recreating the function with a new signature; `test/migration-123.test.js`
   has been failing on `main` ever since. This restoration is technically separable from
   the tenancy work but shipped together because both rely on the same RLS substrate
   becoming load-bearing under PR-B-2.

6. **`test/tenancy-gucs.test.js`** pins the GUC contract: round-trip through Postgres,
   `tenancy.visible()` returns the right boolean for {empty, matching, non-matching}
   GUCs, malformed UUIDs reject at the boundary, omitting `user`/`orgIds` leaves the
   GUCs unset (P1 deny-by-default). All 11 assertions run on PGlite.

### Why ENABLE-only (deferred FORCE)

Two prerequisites must hold before any FORCE migration is safe in production:

- **PR-B-2 (pool role flip).** Today the pool connects as Supabase's
  `postgres.<project>` superuser, which bypasses RLS regardless of ENABLE/FORCE state.
  Only when `AUTOBOT_AGENT_DB_PASSWORD` is set does the pool flip to the unprivileged
  `autobot_agent` role. This is opt-in via env, gated on the operator.
- **STAQPRO-531-rls route audit.** The TODO at `autobot-inbox/src/api.js:213` enumerates
  the routes that issue board-user queries against agent-keyed tables (`agent_graph.*`,
  `inbox.messages`). Every one of those routes must call
  `withBoardScope(req.auth, { principal })` before its queries — naked `query()` calls
  return 0 rows under FORCE.

Shipping FORCE on the tenant-owner tables without both prerequisites would lock the
runtime out of its own data. Shipping the policies as ENABLE-only is safe because the
service role still bypasses, and gives the test suite a real `pg_policies` row to
assert on (the presence check in `tenancy-gucs.test.js (11)`).

## The remaining path to FORCE

The next change in this thread, **not in this PR**, lands the actual enforcement:

1. **Operator opt-in to PR-B-2** — set `AUTOBOT_AGENT_DB_PASSWORD` in the Railway env
   so the pool flips to `autobot_agent`. RLS starts enforcing under ENABLE.
2. **Wrap the STAQPRO-531-rls routes** — convert each handler enumerated at
   `api.js:213` to use `await withBoardScope(req.auth, { principal })`. The pattern
   is documented inline; the helper is already shipped.
3. **Verify zero-row regression** — board UI smoke + the existing
   `staqpro-531-viewer-scoping.test.js` parity suite must pass before the FORCE flip.
4. **Migration to FORCE** — one ALTER per table, with a verify-block that raises if
   the FORCE did not apply (the pattern migration 126 uses for the agent-keyed
   tables). Rollback is `NO FORCE` + `DROP POLICY tenancy_visible_select_*`.

## Consequences

- **Positive.** The DB-level predicate is now wired end-to-end and dormant. A future
  PR that flips the pool role + wraps the audit routes converts ADR-012's "two-layer
  defense" from aspirational to actual without further plumbing work.
- **Positive.** The recurring tenancy bug class (#432, #442, #455) becomes a CI-detectable
  failure pattern once enforcement is live — an unscoped query against a tenant table
  returns 0 rows instead of leaking, and the affected feature breaks before the bug
  reaches production.
- **Neutral.** No production behavior change today. Every test that didn't already
  exercise the GUCs sees identical results.
- **Cost.** ~70 LoC in `lib/db.js`, one new migration (190), one restoration migration
  (191), one test file (`tenancy-gucs.test.js`, 11 assertions).
