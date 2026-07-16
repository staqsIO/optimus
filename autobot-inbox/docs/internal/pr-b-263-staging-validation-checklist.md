# PR-B (STAQPRO-263) — Staging-Validation Checklist & Pre-Flip Gate

> **STAQPRO-564.** Sign-off gate that MUST be green before flipping the production Postgres
> pool from the `postgres.<project>` SUPERUSER to the non-superuser `autobot_agent` role
> (STAQPRO-263, "PR-B"). Until that flip, **all RLS is dead code** — superuser bypasses RLS.
>
> Audited HEAD: `main` @ `3c4f23d`. Generated 2026-06-02.

## Flip mechanism

Setting the `AUTOBOT_AGENT_DB_PASSWORD` env var causes `lib/db.js:98 applyAutobotAgentRole`
to rewrite the pool connection string to log in as `autobot_agent` (non-superuser). Until set,
the pool is Supabase `postgres.<project>` superuser and **all RLS in 001-baseline and
mig 126 is dead code.** Both the flip (env) and FORCE (mig 126) must be live for isolation
to bite; either lever reverts.

---

## 1. GRANT completeness audit — **BLOCKER-class gaps found**

The role and grants already exist in `autobot-inbox/sql/001-baseline.sql:2714-2825` (idempotent,
role-guarded). But the grant set was frozen at baseline and **does not match what current code
does.** Schema usage census (FROM/INTO/UPDATE/JOIN across `lib/`, `autobot-inbox/src/`, `agents/`):

| Schema | Code refs | Baseline grant to `autobot_agent` | Gap |
|---|---|---|---|
| agent_graph | 1158 | USAGE, S/I/U, seq USAGE, **DELETE REVOKED** | **DELETE gap** |
| inbox | 405 | USAGE, S/I/U, seq USAGE, **DELETE REVOKED** | **DELETE gap** |
| content | 249 | USAGE, **SELECT only** | **No INSERT/UPDATE/DELETE** — 70+ write sites |
| signal | 156 | USAGE, S/I/U, seq USAGE | DELETE gap (`deals`, `contacts`, `contact_tags`) |
| signatures | 79 | **NONE** | **No USAGE, no table grants at all** |
| voice | 68 | USAGE, S/I/U, seq USAGE | DELETE gap (`profiles`, `voice_prints`, `unenrolled_speakers`) |
| autobot_value | 23 | NONE | **No grant** |
| autobot_distrib | 21 | NONE | **No grant** |
| autobot_finance | 17 | NONE | **No grant** |
| autobot_comms | 15 | NONE | **No grant** |
| autobot_public | 4 | USAGE + SELECT | OK (read-only) |
| tenancy | 3 | **NONE** | **No grant** (visibleClause parity, scope resolution) |
| engagements | (defined) | NONE | No grant |

**Confirmed write-site violations against grants:**
- **content** (SELECT-only): `INSERT`/`UPDATE` on `content.drafts` (18), `content.documents` (12),
  `content.research_sources` (8), `content.wiki_pages` (6), `content.counterparties` (5),
  `content.chunks` (3), etc. → **every content writer (executor-contract, content-atomizer,
  rd-feed-poller, wiki compiler) 500s on flip.**
- **DELETE REVOKED on agent_graph + inbox**, but code runs `DELETE FROM agent_graph.{work_items,
  action_proposals, token_revocations, project_memberships, issue_triage_log,
  gateway_rate_limits, board_chat_sessions, board_chat_messages, flow_definitions}` and
  `DELETE FROM inbox.{messages, signals, accounts, sync_state, drive_watches, calendar_watches}`.
- **signatures (no grant at all):** 79 refs. Contract/e-sign flows → schema USAGE denied.
- **autobot_comms/finance/distrib/value, tenancy, engagements:** no grant → any agent touching
  these 500s.

**Fix:** a NEW idempotent migration (do NOT hand-apply) inside the existing
`IF EXISTS pg_roles autobot_agent` guard:
1. `GRANT USAGE` on `content, signatures, tenancy, engagements, autobot_comms, autobot_finance,
   autobot_distrib, autobot_value`.
2. `GRANT SELECT, INSERT, UPDATE, DELETE` on ALL TABLES in those schemas (scope DELETE per census).
3. **DELETE on agent_graph/inbox:** either un-REVOKE + add RLS DELETE policies, **or** route deletes
   through SECURITY DEFINER functions (preferred — keeps the append-only audit invariant for
   `state_transitions`/`task_events`, which must stay no-delete).
4. `GRANT USAGE ON ALL SEQUENCES` for every write schema.
5. **`ALTER DEFAULT PRIVILEGES`** for the migration-runner role on ALL write schemas (baseline only
   covers agent_graph/inbox/voice/signal) — without this, **every future migration's new tables
   silently lack grants**, re-creating this failure on the next deploy. This is the durable fix.
6. `GRANT ... ON ALL TABLES` is a one-shot snapshot — the grant migration must run AFTER all
   table-creating migrations (highest migration number), or be re-run.

> Authored as draft: see GRANT-gap migration PR (STAQPRO-263 prerequisite).

---

## 2. STAQPRO-307 transaction-local SET trap — **MITIGATED in code, two policy families**

Prod is the Supabase **transaction pooler (6543)**. `set_config(key, val, true)` / `SET LOCAL` only
persists inside an explicit `BEGIN..COMMIT`; on a transaction pooler a session-level `SET` is
worthless (connection is handed to another txn).

**(A) Agent-keyed via session GUC `app.agent_id`** — the trap surface. `001-baseline.sql:1396
current_agent_id() = current_setting('app.agent_id', true)`. The 7 FORCE-RLS tables (mig 126) use
this. The GUC is set only via `set_config(..., true)` at `lib/db.js:558-567` (transaction-local).
Mitigation present and correct: `withAgentScope` (`lib/db.js:780-815`) wraps
`BEGIN → setAgentContext → fn() → COMMIT`; PGlite path does the same; trap documented at
`lib/db.js:761-772`.

> **TRAP:** any path that calls `setAgentContext()` WITHOUT an enclosing `BEGIN/COMMIT`, or issues an
> RLS-dependent query on a *different* pooled connection than the one that ran `set_config`, sees
> `app.agent_id = NULL` → `current_agent_id()` NULL → **agent sees ZERO of its own
> work_items/events; orchestrator claim loop silently starves (no error).** Pre-flip: grep every
> `setAgentContext(` call site outside `withAgentScope`; confirm none issue RLS-table queries
> outside a transaction. The single-statement-`query()` autocommit pattern in `api.js` is the danger
> zone if anyone adds an agent-keyed read there.

**(B) Tenant-keyed via `owner_org_id` COLUMN** — NOT a GUC, pooler-safe. `lib/tenancy/scope.js:96
visibleClause()` injects parameterized `owner_org_id IN (...)`. No `current_setting`/`set_config`.
This is the correct, pooler-immune pattern the live tenancy boundary (588/596) depends on.
Mechanisms (A) and (B) are independent — the org boundary holds regardless of the GUC trap; agent
isolation (A) is the new fragile surface this flip activates.

> **Note on STAQPRO-590 RLS policies:** they reuse `tenancy.visible()`, which reads `app.user` +
> `app.org_ids` GUCs that **no code currently sets**. Until wired (via `set_config(..., true)` inside
> the request txn), those policies fail **closed** (zero rows). Wire that in PR-B or just before the
> enforce flip — see PR #320.

---

## 3. Per-agent-tier staging smoke plan

Run staging with `AUTOBOT_AGENT_DB_PASSWORD` set; exercise each tier's representative DB ops.
Watch for `permission denied for {schema|table|sequence}` AND silent empty-result starvation (mech A).

| Tier / subTier | Agents | Representative DB ops | At-risk on flip |
|---|---|---|---|
| Orchestrator/core | orchestrator | `claim_next_task()`, work_items I/U, task_events | SECURITY DEFINER ok; GUC starvation if scope not wrapped |
| Orchestrator/campaign,workshop | claw-campaigner, claw-workshop | work_items, action_proposals I/U, budgets | ok |
| Strategist/core | strategist | `UPDATE inbox.messages`, signals read | inbox UPDATE ok; **inbox DELETE if any** |
| Architect/core | architect | reads across agent_graph, briefings | read-only mostly |
| Executor/intake | executor-intake | `UPDATE inbox.messages` | ok |
| Executor/triage | executor-triage, issue-triage | inbox messages U, issue_triage_log (**DELETE!**) | **issue_triage_log DELETE revoked** |
| Executor/responder | executor-responder | action_proposals INSERT | ok |
| Executor/ticketing | executor-ticket | action_proposals, linear ingest | ok |
| Executor/research | executor-research | **content.research_sources/documents/chunks I/U/DELETE** | **content write DENIED** |
| Executor/engineering | executor-coder/-blueprint/-redesign/-writer, content-atomizer, **executor-contract** | **content.drafts I/U; signatures.\*** | **content write + signatures USAGE DENIED** |
| Reviewer/core | reviewer | action_proposals UPDATE | ok |
| External/nemoclaw | nemoclaw-* | API-only, no task-graph write | n/a |

**Smoke checklist (staging, as `autobot_agent`):**
- [ ] Each tier executes its representative read AND write with **zero** `permission denied`.
- [ ] Orchestrator claim loop processes a seeded work_item (GUC + SECURITY DEFINER under FORCE).
- [ ] A content-writer INSERTs a `content.drafts` row (proves §1 content gap fixed).
- [ ] A contract send touches `signatures.*` without USAGE error.
- [ ] An agent reading its own `work_items` returns >0 (no GUC starvation).
- [ ] `GET /api/health` returns **200 / 9-of-9** (`api.js:463`).
- [ ] `API_SECRET=… node autobot-inbox/scripts/verify-tenancy-live.mjs <staging>` passes all 4
      assertions: bare→0, victim→0 Staqs rows, control>0, overlap=0, plus the 596 `/api/today/*` checks.

---

## 4. Rollback plan

Mig 126 documents both levers. Concrete:

**Before the flip (prep):**
- [ ] Keep the superuser URL in Railway as `DATABASE_URL_SUPERUSER` (NO code/env ref to this name
      exists yet — add it manually). Keep `DATABASE_URL` itself unchanged. The flip is driven by
      *adding* `AUTOBOT_AGENT_DB_PASSWORD`, not by editing `DATABASE_URL`.

**Rollback (fastest → cleanest):**
1. **Unset `AUTOBOT_AGENT_DB_PASSWORD`** in Railway → `applyAutobotAgentRole` (`lib/db.js:98`)
   no-ops, pool reverts to superuser, RLS-by-role bypass returns.
   `railway up --service autobot-inbox-api --detach`. ~3-5 min.
2. If FORCE itself is implicated: `ALTER TABLE <each of the 7> NO FORCE ROW LEVEL SECURITY;`
   (RLS stays ENABLED; only FORCE dropped). Either lever alone reverts.
3. Verify: `GET /api/health` 200/9-of-9 + `verify-tenancy-live.mjs` green.

**Blast radius:**
- **Best case (most likely): permission-denied 500s** on ungranted schemas → loud, fail-CLOSED,
  ~5 min env-swap recovery, **no data loss.**
- **Silent case: GUC starvation** (mech A) — agents see empty work sets, no errors. Detect via the
  "drafts go silent" ladder (work_items completing but `llm_invocations` ~0).
- **Worst case: a wrongly-written RLS policy fail-OPENs.** This is why **STAQPRO-590's tightened
  policies land AFTER the flip is proven** — flip first with permissive write policies +
  SELECT-side enforcement, prove no breakage, then narrow.

---

## 5. Go / No-Go gate — ALL must be true

- [ ] **GRANT-gap migration written, idempotent, merged, applied to staging** — content I/U/D,
      signatures USAGE+grants, tenancy/engagements/autobot_* grants, sequence USAGE on all write
      schemas, DELETE resolution on agent_graph/inbox, and **ALTER DEFAULT PRIVILEGES on every write
      schema** for the migration runner.
- [ ] **Staging pool running as `autobot_agent`** and all 20 agents' reads+writes pass with zero
      permission-denied (§3).
- [ ] **No un-wrapped `setAgentContext` call site** issues an RLS-table query outside a transaction
      (§2 audit complete; GUC starvation ruled out).
- [ ] **`GET /api/health` = 200 / 9-of-9** on staging as `autobot_agent`.
- [ ] **`verify-tenancy-live.mjs` passes all assertions** on staging as `autobot_agent`.
- [ ] **`DATABASE_URL_SUPERUSER` rollback creds confirmed in Railway** and env-swap rollback rehearsed.
- [ ] **Mig 126 FORCE confirmed applied** in staging (the 7 tables show `relforcerowsecurity=true`).
      The load-bearing proof is **real Postgres staging, never PGlite/CI** (PGlite makes
      `autobot_agent` SUPERUSER and bypasses RLS).
- [ ] **STAQPRO-590 (tightened policies) explicitly deferred to AFTER** this flip is proven stable in
      prod (avoids fail-OPEN worst case landing un-validated), AND the `app.user`/`app.org_ids` GUC
      wiring is in place so 590 doesn't black-hole reads.
- [ ] **G10/spend + dead-man-switch unaffected** confirmed (same pool).

**Key file references:** grants `001-baseline.sql:2714-2825`; FORCE+write-policy patch
`126-force-rls-on-agent-keyed-tables.sql`; SECURITY DEFINER claim
`123-rls-prereq-claim-task-and-llm-invocations.sql`; GUC-trap mitigation `lib/db.js:545-567`
(`setAgentContext`), `:705-820` (`withAgentScope`), `:98` (`applyAutobotAgentRole`); column-scope
(pooler-safe) `lib/tenancy/scope.js:96` (`visibleClause`); live gate
`autobot-inbox/scripts/verify-tenancy-live.mjs`; health `autobot-inbox/src/api.js:463`.
