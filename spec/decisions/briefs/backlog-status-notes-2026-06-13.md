# Backlog Status Notes — 2026-06-13

Why certain issues are out of scope for an autonomous code pass in the current bucket.

---

## Issues excluded from autonomous implementation

### OPT-13 — Epic parent (M0–M4 milestones)

OPT-13 is the top-level epic for the onboarding / inbound spine milestones. It is a **parent container**, not a unit of work. Autonomous implementation agents operate on leaf issues with defined acceptance criteria. Passing OPT-13 to an implementer would produce undefined behavior — it would attempt to implement all child milestones in a single pass, without sequencing or inter-milestone dependency awareness.

**Correct handling**: decompose into M0–M4 leaf issues, sequence them per the Proper Path plan (Phase 1 before Phase 2, etc.), and run implementers on leaves.

### OPT-11 — Team SOP + teammate machine setup

OPT-11 is an **operations and human coordination issue**: writing standard operating procedures and configuring developer machines (tooling, environment setup, access grants). It requires human judgment about which team members need which access levels, and physical action (machine setup, account provisioning). Code agents cannot perform these steps.

**Correct handling**: Eric or Dustin completes this as a human task in a dedicated session. No code artifact is produced.

### OPT-79 — Stand up 2nd Optimus instance

OPT-79 requires provisioning a **second Railway service + Supabase project** (or equivalent), configuring environment variables, setting up DNS, and wiring it to the appropriate org. This is 2-day cloud/DB provisioning work that involves credentials, billing decisions, and infrastructure choices that require board authorization.

**Correct handling**: Eric initiates in a dedicated infrastructure session after the board has decided the hosting model (shared DB + prefixed channels per ADR-017, vs. separate DB per OPT-79's scope). Not a code-only task.

### OPT-91 — Eric: "plan in a dedicated session"

OPT-91 was explicitly tagged by Eric as requiring a dedicated planning session. The issue scope is undefined without that session. Autonomous implementation without a defined spec would be speculative and would produce artifacts that may contradict the plan Eric intends to produce.

**Correct handling**: Eric runs a planning session, produces a feature spec (`spec/features/NNN-*.md`) or Linear sub-issues, then implementers can proceed.

---

## Bucket 2 security issues — held for Eric's window

The following six issues are excluded from autonomous code passes pending Eric's explicit authorization window. They involve **database role flips and RLS migrations** that can drop the `owner_org_id DEFAULT` on tables with ~65 active agent `INSERT` calls — a broken deploy would black-hole all agent writes.

| Issue | Summary | Hold reason |
|---|---|---|
| OPT-86 | Non-superuser Postgres role (PR-B / ADR-018) | Highest-risk single change; requires staging-validation checklist + documented env-var rollback window before Railway deploy |
| OPT-84 | RLS policy activation | Depends on PR-B (OPT-86); activating RLS before the role flip is partial and creates false safety |
| OPT-85 | `owner_org_id` NOT NULL migration | Drops the DEFAULT that ~65 agent INSERTs rely on; must coordinate with agent code changes in same deploy window |
| OPT-20 | JWT-scoped agent identity | Security boundary change; requires board review of JWT claims model before implementation |
| OPT-21 | Agent data isolation (Postgres schema-level) | Schema-level restructure; cross-schema FK implications (see `content.documents.owner_id` → `agent_graph.board_members` FK, `sql/012`, already violates the no-cross-schema-FK rule) |
| OPT-68 | Tool allow-list enforcement | Requires the capability-registry model (`lib/runtime/capability-registry.js`) to be stable before enforcement is added; activating enforcement before the registry is complete would block legitimate agent actions |

**Unblock path**: Eric schedules a dedicated DB-flip window, runs the PR-B staging checklist (enumerate table GRANTs, smoke-test all agent tier DB calls in staging, confirm rollback window), then authorizes the deploy.

These issues are the **Phase 2 gate** for the Proper Path plan. Nothing in Phase 4 (bridge dry-run live) is credible until PR-B is merged and load-tested.
