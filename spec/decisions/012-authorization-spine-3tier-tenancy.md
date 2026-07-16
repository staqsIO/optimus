# ADR-012: The Authorization Spine — 3-Tier Tenancy (user → org → org-to-org) with One Resolution Predicate

**Date**: 2026-05-30
**Status**: Accepted by Eric (2026-05-31) — pending Dustin co-review (security boundary + schema change → both board members must review per root CLAUDE.md)
**Issue**: STAQPRO-531 (cross-tenant contacts leak), STAQPRO-540 (ADR-009 `/api/ops` open door), STAQPRO-564 (PR-B non-superuser pool flip)
**Supersedes in part**: ADR-002 (see §"Reconciling ADR-002")
**Relates to**: ADR-007 (federation), ADR-009 (proxy boundary), ADR-017 (permission_grants)

---

## 1. The leak, stated precisely

`GET /api/contacts` (`autobot-inbox/src/api.js:3324`) is `SELECT … FROM signal.contacts ORDER BY last_received_at DESC LIMIT 200` with **no WHERE clause**. The only gate is `mayReadOrgShared(viewer)` (api.js:374), which returns `true` for **any** identified board member. Dustin logs in → resolves to a real `board_members.id` → `mayReadOrgShared=true` → sees Eric's 200 most-recent contacts. ADR-009 already documented that this is not one route: `resolveViewerEmails`/`mayReadOrgShared` have **zero references** in `api-routes/*.js`; only ~5 of ~195 registrations are viewer-scoped.

**Why it has been "fixed" for a month without holding:** every fix deferred actual scoping to RLS (`TODO(STAQPRO-531-rls): … once PR-B / 126-force-rls lands`). RLS has never enforced a single row because (a) the pool connects as Supabase `postgres` **superuser** (always RLS-exempt) and (b) the policies key on `current_agent_id()` — agent-to-agent isolation, which has **no concept of org**. The fix was architecturally parked behind a pool-role flip (PR-B / STAQPRO-564) that is high-risk and never scheduled. **The trap is the deferral itself.** This ADR's central rule: **app-layer scoping is PRIMARY and ships on the superuser pool TODAY; RLS is defense-in-depth added AFTER PR-B, sharing the same predicate so the two cannot diverge.**

## 2. Root cause is a governance fact, not a code fact (reconciling ADR-002)

ADR-002 ("individual install over multi-tenant") said each user gets their own database/instance — so no `principal_id` retrofit is ever needed. **The board violated ADR-002 the moment it invited Dustin, Kevin, et al. into the one shared Optimus instance.** We are de-facto multi-tenant on a schema that assumed single-tenant. We are not going to deploy a separate Postgres per board member (the org is one coordinating substrate — task graph, RAG, governance — that is the *product*). So ADR-002's conclusion is **superseded for the Optimus org backend**: we add the tenancy dimension ADR-002 hoped to avoid. ADR-002's *reasoning* (retrofit is the hardest thing you can do to a running system) is correct and is exactly why this ADR is foundation-first and ruthlessly staged.

## 3. The three tiers (board decisions, designed-to)

- **Tier 1 — user**: a person's own data (their drafts, their inbox-derived signals, their RAG docs). Identity anchor already exists: `agent_graph.board_members` + board JWT (`github_username`).
- **Tier 2 — org**: data shared *within* an org, gated by the member's role in that org. **Multi-org membership**: one person belongs to MANY orgs with a DIFFERENT role per org → a `memberships(user, org, role)` junction, never `org_id` on the user.
- **Tier 3 — org-to-org**: governed cross-org sharing = federation (ADR-007). One org grants another a *scoped, revocable* capability. Reconciled with `lib/audit/capability-receipt.js`: the **grant** is the persisted authorization; the **receipt** is the signed exercise record of that grant. **Do not build the runtime for this yet** (§9).

---

## 4. Data model (DDL-level)

New schema `tenancy` (own schema = clean RLS ownership, no cross-schema FK per SPEC §12 — we reference by UUID, validated in app layer, FKs only within `tenancy`).

### 4.1 Orgs and users

```sql
CREATE SCHEMA IF NOT EXISTS tenancy;

CREATE TABLE tenancy.orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,           -- 'staqs', 'consulting-futures', 'frontpoint'
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users are board_members. We do NOT fork identity. tenancy.users is a thin
-- view/alias so policies + joins read against one canonical id.
-- board_members.id IS the user id, full stop.
CREATE VIEW tenancy.users AS
  SELECT id AS user_id, github_username, display_name, email, is_active
  FROM agent_graph.board_members;
```

`signal.organizations` (the CRM table, migration 080) is **NOT** `tenancy.orgs`. CRM org = "which company is this contact from." Tenancy org = "who owns/governs this data." They are different axes; do not merge them. (A future nicety: link `signal.organizations.tenancy_org_id` for self-org contacts, but that is cosmetic, not the boundary.)

### 4.2 Membership (user × org × role) — the heart

```sql
CREATE TABLE tenancy.memberships (
  user_id    UUID NOT NULL,                   -- = board_members.id (validated in app)
  org_id     UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)               -- one role per (user,org); multi-org = many rows
);
CREATE INDEX memberships_org_idx ON tenancy.memberships(org_id) WHERE is_active;
```

### 4.3 RBAC — roles → permissions, scope-aware resolution

**Contrarian call (see §8): we do NOT build a `roles`/`permissions`/`role_permissions` data-driven RBAC engine yet.** With 4 roles and N≈3 orgs, a data-driven permission matrix is pure ceremony. Roles are an **enum + a code-level capability table**:

```js
// lib/tenancy/rbac.js  (the ONLY place role→capability lives)
export const ROLE_CAPS = {
  owner:  { read:'org', write:'org',  manageMembers:true,  grantFederation:true  },
  admin:  { read:'org', write:'org',  manageMembers:true,  grantFederation:false },
  member: { read:'org', write:'own',  manageMembers:false, grantFederation:false },
  viewer: { read:'own', write:'none', manageMembers:false, grantFederation:false },
};
```

`read:'org'` means "may read org-shared rows for orgs where this user holds this role." `read:'own'` means "own rows only." This resolves the same way at user and org scope; org-to-org adds the federation-grant branch (§4.4). When (if) a fourth role-distinction or per-resource grant is genuinely needed, promote this constant to a table — the resolution predicate (§5) does not change, only its `ROLE_CAPS` lookup does. **`agent_graph.permission_grants` (ADR-017) is untouched: it gates agent→tool access, an orthogonal axis. Do not overload it with user/org-data RBAC.**

### 4.4 Org-to-org federation grants (Tier 3 — schema only, no runtime yet)

```sql
CREATE TABLE tenancy.federation_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_org_id  UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  grantee_org_id  UUID NOT NULL REFERENCES tenancy.orgs(id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL,              -- 'contacts'|'rag_docs'|'signals'|...
  scope           JSONB NOT NULL DEFAULT '{}',-- {classification_ceiling:1, contact_ids:[...]}
  granted_by      UUID NOT NULL,              -- board_members.id (must hold grantFederation)
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,                -- revocation = set this; never delete (P3 audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A `federation_grant` is the **authorization** an org-to-org capability receipt (`lib/audit/capability-receipt.js`) attests against: the receipt's `grant_id` references a row here; `classification_ceiling`/`origin_org` come from this grant. This closes ADR-007's open loop (receipt envelope defined but never issued/consumed) — but **issuing/consuming stays deferred** (§9).

### 4.5 Owner labeling on tenant-scoped tables

Every tenant-scoped row needs `owner_user_id` (Tier 1) and `owner_org_id` (Tier 2). Audit of current state:

| Table | has owner_user_id today? | action |
|---|---|---|
| `inbox.accounts`, `inbox.messages`, `action_proposals` (drafts) | yes (`owner_id` UUID→board_members, mig 007) | **rename-alias** `owner_id`→`owner_user_id` semantics; add `owner_org_id` |
| `inbox.drafts`, `signal.contacts`, `projects`, `campaigns`, `work_items`, `briefings` | `owner_id` present (baseline) | add `owner_org_id`, backfill |
| `signal.signals`, `human_tasks`, `today_items` | **NONE** | add BOTH `owner_user_id` + `owner_org_id`, backfill |
| RAG `documents`/chunks | `owner_id` (mig 012) + `filter_owner_id` plumbed through `match_chunks` | add `owner_org_id`; extend `match_chunks` signature with `filter_org_id` |

**Backfill is trivial today because N=1 operational org:** every existing row's `owner_org_id` = Staqs. `owner_user_id` is already correct where present; where absent, derive from the linked account/message owner, else default to Eric. This is the ONE cheap window — do it before a second org has live data.

---

## 5. The single resolution predicate (one chokepoint, not 30)

`visible(principal, row) = own ∪ org-shared(role) ∪ federation-granted`.

### 5.1 SQL — one immutable function, one canonical WHERE fragment

```sql
-- lib/tenancy provides the GUCs: app.user (board_members.id),
-- app.org_ids (csv of orgs where user has read:'org'), app.role.
-- HARDENED per Linus pre-impl review (§11): NULLIF guards so unset GUCs fail
-- CLOSED (NULL → false), not throw on ''::uuid; SECURITY DEFINER + pinned
-- search_path so a caller's search_path cannot shadow tenancy.federation_grants
-- (same hazard class as the 2026-05-30 bootstrap SEV-1).
CREATE FUNCTION tenancy.visible(row_owner_user UUID, row_owner_org UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = tenancy, pg_catalog AS $$
  SELECT
    -- Tier 1: own  (NULLIF: unset app.user → NULL → false, never ''::uuid throw)
    row_owner_user = NULLIF(current_setting('app.user', true), '')::uuid
    -- Tier 2: org-shared, only for orgs where caller holds a read:'org' role
    OR row_owner_org = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
    -- Tier 3: federation (no-op until a grant exists; see §9)
    OR EXISTS (
      SELECT 1 FROM tenancy.federation_grants g
      WHERE g.grantee_org_id = ANY (string_to_array(NULLIF(current_setting('app.org_ids', true), ''), ',')::uuid[])
        AND g.grantor_org_id = row_owner_org
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
    );
$$;
```

> **GUC escalation note (Linus BLOCKER 3):** `app.user`/`app.org_ids` are session GUCs. On the superuser pool (in force through M-C/M-D, and until PR-B), any query in the connection can `SET app.org_ids` to escalate, and Layer B's RLS reads the GUC. Mitigations, in order: (a) Layer A (JS `visibleClause`) is the primary enforcement and derives `readOrgIds` from the verified principal in JS — **not** from the GUC — so it is not GUC-spoofable; (b) GUCs must be set with `SET LOCAL` inside a per-request transaction so they cannot persist or be reset mid-request; (c) Layer B RLS is only trusted *after* PR-B moves the pool to the non-superuser `autobot_agent` role, which cannot `SET` arbitrary session auth context. Until then, **GUC-fed RLS is not a trust boundary — Layer A is.**

### 5.2 JS — the same predicate as a query helper (PRIMARY enforcement today)

```js
// lib/tenancy/scope.js — every tenant-scoped READ goes through this.
// Returns a parameterized WHERE fragment + params. NOT string interpolation.
export function visibleClause(principal, { ownerUserCol='owner_user_id', ownerOrgCol='owner_org_id' }) {
  const orgIds = principal.readOrgIds;        // orgs where principal has read:'org'
  return {
    sql: `(${ownerUserCol} = $P
           OR ${ownerOrgCol} = ANY($Q::uuid[])
           OR EXISTS (SELECT 1 FROM tenancy.federation_grants g
                      WHERE g.grantee_org_id = ANY($Q::uuid[]) AND g.grantor_org_id = ${ownerOrgCol}
                        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())))`,
    params: { P: principal.userId, Q: orgIds },
  };
}
```

The SQL function (5.1) and JS helper (5.2) are **byte-for-byte the same three branches**. A single contract test asserts they return identical row sets against a fixture — that is the anti-divergence guarantee §6 depends on.

---

## 6. Two-layer enforcement (the crux)

**Order is non-negotiable: APP layer first and complete, THEN RLS as belt-and-suspenders.**

### Layer A — application scoping (PRIMARY, ships on the superuser pool, no PR-B dependency)
1. `withViewer(req.auth)` resolves `{ userId, readOrgIds, role }` from `board_members` + `memberships` (replaces `resolveViewerEmails`).
2. Every tenant-scoped read appends `visibleClause(principal, …)` to its WHERE. The contacts route's bare `SELECT … LIMIT 200` becomes `… WHERE ${visibleClause}`.
3. **Chokepoint, not 30 routes:** introduce `scopedQuery(principal, table, cols)` in `lib/tenancy/scope.js`; migrate the ~5 known viewer-scoped routes first, then sweep `api-routes/*.js` (ADR-009's 161 unscoped patterns) onto it. A CI grep-ratchet (like CG-1) forbids new `FROM signal.contacts|signal.signals|inbox.drafts|human_tasks` reads that don't go through `scopedQuery`.

This works **today on the superuser pool** because it is plain WHERE-clause logic — zero RLS dependency. This is the part that has been criminally deferred.

### Layer B — RLS (defense-in-depth, AFTER PR-B / STAQPRO-564 flips the pool to `autobot_agent`)
- `setAgentContext`/`withBoardScope` already set `app.role`/`app.org` GUCs (db.js:567). Extend to set `app.user` + `app.org_ids`.
- Org-aware policies: `CREATE POLICY tenant_read ON signal.contacts FOR SELECT USING (tenancy.visible(owner_user_id, owner_org_id));` — **reuses the exact §5.1 function**, so RLS and app-layer cannot diverge.
- `FORCE ROW LEVEL SECURITY` (extend migration 126's list to the tenant tables).
- Until PR-B lands, these policies are dormant (superuser-exempt) — **and that is fine, because Layer A is already enforcing.** RLS becomes the safety net that catches a future route someone forgets to scope.

---

## 7. Migration & rollout sequence (foundation-first)

1. **M-A (schema, no behavior change):** create `tenancy` schema, orgs, memberships, federation_grants, the `tenancy.visible()` function, the `tenancy.users` view. Seed 3 orgs (Staqs, Consulting Futures, FrontPoint). Seed memberships: Eric→Staqs(owner), Dustin→Consulting-Futures(owner) + Staqs(member if board wants shared board data), Kevin per board. **No reads change yet.**
2. **M-B (owner labeling + backfill):** add `owner_org_id` (+`owner_user_id` where missing) to the §4.5 tables; backfill every existing row to Staqs / its existing owner. Add NOT-NULL-with-default-then-enforce in two steps to avoid locking live writes.
3. **M-C (app-layer Layer A — THE leak fix):** ship `lib/tenancy/{scope.js,rbac.js}` + `withViewer`; convert contacts/signals/today/drafts/briefings/human_tasks reads to `scopedQuery`. **This closes the leak on the superuser pool. Ship this and the leak is gone — independent of RLS.**
4. **M-D (CI ratchet):** grep-gate forbidding unscoped reads of tenant tables; sweep ADR-009's remaining `/api/ops` surface.
5. **M-E (Layer B, gated behind PR-B/STAQPRO-564):** org-aware RLS policies + FORCE + GUC plumbing. Lands when the non-superuser pool window is scheduled. Not on the leak's critical path.

**Rollout without breaking the live single-org assumption:** because every backfilled row is owned by Staqs and Eric+Dustin are both members of the orgs they need, M-C changes *zero* visible behavior for legitimate access — it only removes Dustin's ability to read rows owned by Eric-as-Staqs that Dustin (Consulting Futures) was never a member of. If the board wants Dustin to keep seeing shared board data, add him as a Staqs `member`; that is a membership row, not a code change. This is the whole point of memberships over `org_id`-on-user.

### Exit gate (the real test — verified against PROD, not mocks)
A black-box E2E that **authenticates as Dustin's board JWT against the live backend** and asserts:
- `GET /api/contacts`, `/api/signals`, `/api/today`, `/api/drafts` return **ZERO** rows whose `owner_user_id = Eric` AND `owner_org_id ∉ Dustin.readOrgIds`.
- A control assertion: Dustin **does** see his own / his-org's rows (no over-blocking).
- Runs against prod data, **not** unit mocks against bypassed RLS (the month-long false-green). Lives at `autobot-inbox/test/tenancy-leak.e2e.test.js`; wired as a required check on the security label. **This gate, green against prod, is the definition of "fixed."**

---

## 8. Contrarian verdict on scope — what NOT to build

With N≈3 orgs and ~5 humans, **full RBAC-at-every-level is over-built.** The 10x move is recognizing the leak is **one missing WHERE clause behind one missing owner column**, not a permissions engine.

**Build now (smallest correct foundation):** orgs + memberships + owner columns + the `visible()` predicate + Layer-A app scoping. That is the entire leak fix and it is *correct*, not a patch — the predicate is the same one the full system uses; the rest extends it without rework.

**Stage / do NOT build yet:**
- **Data-driven RBAC tables** — `ROLE_CAPS` constant suffices for 4 roles. Promote to a table only when a real per-resource grant appears. Predicate unchanged.
- **RLS (Layer B)** — defense-in-depth, gated on PR-B. **Explicitly NOT on the critical path.** The month-long bug was treating RLS as the fix; it is the net, not the floor.
- **Federation runtime (Tier 3 issue/consume)** — per ADR-007, "do not build yet." We ship the *grant table* and wire the *predicate's third branch* so the schema is forward-compatible, but no receipt is issued or consumed until a real second org peer exists. The branch is a dormant `EXISTS` that matches nothing today.
- **Per-channel / per-field scoping, classification-aware org sharing** — defer; `scope` JSONB on grants reserves the room.

**Challenge to the model:** is even `memberships` over-built for N=3? No — it is the one piece that is *cheaper now than later*. The board already decided multi-org-multi-role (a person in Staqs AND Consulting Futures). `org_id`-on-user cannot express that and would force the exact retrofit ADR-002 warned against the day Dustin needs a second role. Memberships is the minimal structure that doesn't get re-cut. Everything heavier than it, defer.

---

## 9. Disposition of the 5 stale `eric/tenancy-*` branches

Each patched one route/GUC and none added the org model — they are the symptom of "no foundation, scope per-route." Verdict:

| Branch | Disposition | Why |
|---|---|---|
| `eric/tenancy-rls-enable` | **Abandon** (harvest policy SQL into M-E) | RLS-first is the trap; salvage only the policy text, re-key onto `tenancy.visible`. |
| `eric/tenancy-board-jwt` | **Salvage into M-C** | JWT→viewer resolution is exactly `withViewer`; reuse the verification glue. |
| `eric/tenancy-rag-account-scope` | **Salvage into M-B/M-C** | `filter_owner_id` plumbing is real; extend to `filter_org_id` in `match_chunks`. |
| `eric/tenancy-board-inserts-scope-fix` | **Salvage write-path** | owner-stamping on INSERT is needed so new rows get `owner_org_id`; fold into M-C. |
| `eric/tenancy-campaigns-quickbuild-scope` | **Abandon** (re-derive) | One-route patch; `scopedQuery` subsumes it. Cherry-pick nothing but the test. |
| `backup/pre-rename-tenancy-rls` | Keep as backup only | — |

Net: salvage 3 (board-jwt, rag-account-scope, board-inserts), abandon 2, harvest SQL from rls-enable. **Do not merge any as-is** — they encode the per-route-scoping anti-pattern this ADR exists to kill.

---

## 10. Decision

Build the authorization spine foundation-first: `tenancy` schema (orgs, memberships, federation_grants), owner columns with same-window backfill, and **one** resolution predicate (`tenancy.visible`) enforced **primarily in the app layer (Layer A, ships today on the superuser pool)**, with **org-aware RLS (Layer B) layered after PR-B** reusing the identical predicate. RBAC = a 4-role enum + `ROLE_CAPS` constant, not a data-driven engine. Federation (Tier 3) = schema + dormant predicate branch only; no runtime. The leak is closed by M-C and verified by an E2E that authenticates as Dustin against **prod** and asserts zero of Eric's rows — not by RLS, and not by a unit mock.

**Blunt summary of what NOT to build now:** no RBAC tables, no federation issue/consume runtime, no RLS-as-the-fix, no per-route bespoke scoping. One predicate, one chokepoint, owner columns, memberships. That is the whole job.

---

## 11. Linus pre-implementation review — required amendments (2026-05-31)

**Verdict:** approved as the *architecture basis* (predicate unification, memberships, app-layer-primary ordering are correct), **NOT** as a complete M-C build plan. The three holes below would let M-C ship with the leak half-closed — the same "panel scoped, narrative leaks" failure mode already observed. These are addenda to §6/§7; the §5.1 function is already patched above.

**BLOCKER 1 — agent-runtime reads are uncovered; the brief generator is the worst case.** §6's ratchet targets `api-routes/*.js`, but the morning-brief generator reads `signal.contacts/signals` through `lib/`/`agents/` and stores an LLM narrative in `signal.briefings`. M-C scopes the *briefing panel row* but not the *content generated from an unscoped read* — Dustin sees a row he's allowed to see whose text leaks Eric's data. **Fix:** the grep-ratchet must cover `lib/**`, `agents/**`, `autobot-inbox/src/**` — not just api-routes. The brief generator (and every agent-runtime read of a tenant table) must call `scopedQuery` with an explicit org context; since generation has no request principal, it takes a `generate-for-org` argument and uses `scopedQuery(syntheticPrincipal(orgId), …)`.

**BLOCKER 2 — `tenancy.visible` failed OPEN/threw on unset GUCs.** `''::uuid` throws; an unauthenticated/misrouted call risked an exception rather than empty result. **Fixed in §5.1** via `NULLIF(..., '')` (NULL → comparison false → fail closed).

**BLOCKER 3 — GUC escalation on the superuser pool.** Captured in the §5.1 escalation note: Layer A (JS, principal-derived) is the trust boundary; GUC-fed RLS is not trusted until PR-B; GUCs set via `SET LOCAL` in a per-request transaction.

**MAJOR amendments folded into M-C/M-D:**
- **SSE `/api/ops/events`** must be scoped per viewer-org in M-C — the real-time feed is the canal around any scoped REST panel.
- **RAG `match_chunks`**: `filter_org_id` must be **non-optional / fail-closed** (omitting it returns zero rows), not just a signature extension — else every existing caller silently leaks.
- **JOIN-bleed**: a scoped tenant table joined to the unscoped CRM `signal.organizations` leaks the joined columns. Either give CRM-display tables owner columns too, or restrict joined projections to non-sensitive fields.
- **Backfill derivation (M-B)** for `signal.signals` / `human_tasks` / `today_items` (no owner column today) must be a **named, reviewed derivation query per table**, not "else default to Eric." A wrong backfill bakes a permanent boundary no M-C code can fix without re-migration. `today_items` (board-synthesized, no reliable FK chain) is the riskiest — define its derivation explicitly or leave `owner_org_id` NULL (fail-closed) pending review.
- **Writes**: `UPDATE/DELETE … RETURNING` must also carry `visibleClause` (read-via-write class); `federation_grants` needs an app-layer INSERT guard (the "dormant" branch is live on the superuser pool).
- **MINOR**: `tenancy.visible` `SECURITY DEFINER`+`search_path` — **fixed in §5.1**. The SQL↔JS parity contract test must be **integration-level against real Postgres** (not PGlite/mocks), or BLOCKER 2's class goes undetected.

### Revised M-C definition-of-done (the leak is NOT closed until all are true)
1. `scopedQuery` enforced on tenant reads in **api-routes AND `lib/`/`agents/` runtime** (incl. the brief generator with an explicit org context); CI grep-ratchet covers all three trees.
2. `tenancy.visible` ships with the `NULLIF` guards + `SECURITY DEFINER`/pinned `search_path` (§5.1).
3. **SSE `/api/ops/events` scoped**; RAG `match_chunks` `filter_org_id` fail-closed.
4. Backfill (M-B) uses reviewed per-table derivation; ambiguous rows → NULL `owner_org_id` (fail-closed), not defaulted.
5. Exit gate (§7) green **against prod** as Dustin: zero of Eric's rows on contacts/signals/today/drafts **and** in the brief narrative; control assertion he still sees his own.

**Status remains Proposed** — Eric + Dustin must review (security boundary + schema change; supersedes part of ADR-002).
