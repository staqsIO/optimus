# SEAMS.md — The Capture → Link Edge Map

**Version:** 1.0.0 · **Last updated:** 2026-05-30

Ephor captures raw signal (messages, meetings, documents) and *links* it into
actionable structure (work items, obligations, projects, drafts). The value is
in the **seams** — the edges where one subsystem's output becomes another's
input. This document maps each seam: its **source**, the **transform**, the
**destination**, and **the file that owns it**.

Every file/function reference below was verified against the repo on 2026-05-30.
When you change one of these owners, update this file (P3 — transparency by
structure).

```
            ┌──────────── capture ────────────┐      ┌──────── link ────────┐
 messages ─▶│ signal-detector ─▶ inbox.signals │─────▶│ signal-action-bridge │─▶ work_items
            └──────────────────────────────────┘      └──────────────────────┘
 signals ───────────────────────────────────────────▶ HT_LIVE_PREDICATE ─────▶ obligations (human_tasks)
 entities ──────────────────────────────────────────▶ relationship-inferrer ─▶ Person/Project edges (Neo4j)
 proposals ─────────────────────────────────────────▶ gated queue (status=blocked + human_task) ─▶ flow
```

---

## Seam 1 — messages → work_items

The core capture→action loop. Ambient extraction on every qualifying agent
message, then a reversibility-classified bridge into the task graph.

| | |
|---|---|
| **Source** | `inbox.messages` (an agent message flows through the runtime). |
| **Transform** | **Capture:** `signal-detector` runs as a post-message hook (P3 — capture by structure, not by an agent choosing to call a tool). Phase 1 regex-extracts action items / deadlines / requests / decisions into `inbox.signals`; Phase 2 upserts email-shaped identifiers into `signal.contacts`. **Link:** `signal-action-bridge` classifies each signal by **reversibility** (ADR-008 §2): *reversible* → spawn a `status='created'` work_item an executor runs immediately (no board card); *irreversible* → spawn the work_item **and** a visible `inbox.human_tasks` card. `content_hash` gives at-most-once dedup (P1, deterministic infrastructure). |
| **Destination** | `agent_graph.work_items` (via `createWorkItem` in `lib/runtime/state-machine.js`); for gated items, also `inbox.human_tasks`. |
| **Owner** | `lib/runtime/signals/signal-detector.js` → `lib/runtime/signals/signal-action-bridge.js`. Both have re-export shims at `lib/runtime/signal-detector.js` and `lib/runtime/signal-action-bridge.js` (relocated under `signals/` in STAQPRO-560). Bridge reuses `extractObligor` from `signal-task-promoter.js`; schema columns added by `autobot-inbox/sql/127-signal-action-bridge.sql`. |

---

## Seam 2 — signals → obligations

Signals are a telemetry layer; obligations are the human-facing, relevance-gated
slice of them. The gate is what keeps a Sept-2024 obligation from leading every
view forever.

| | |
|---|---|
| **Source** | `inbox.human_tasks` (obligations materialized from signals), joined to `inbox.messages`. |
| **Transform** | `HT_LIVE_PREDICATE` — a SQL predicate that filters human-tasks to the *live, resolvable* set and sorts overdue-first, replacing the previous behaviour where stale obligations dominated. It is composed once and reused across every obligation count and list query (owe / waiting / overdue / due-this-week) so all views agree on "what's live." |
| **Destination** | `/api/today` and the morning-brief endpoint — the obligation counts and lists the Board Workstation renders. |
| **Owner** | `autobot-inbox/src/api.js` — `HT_LIVE_PREDICATE` is defined once (grep the symbol name rather than a line number, which drifts) and consumed by the obligation count subqueries (`owe_count`/`waiting_count`/`overdue_count`/`due_this_week`) and the today/brief reads (ADR-008 Stream A). |

---

## Seam 3 — entities → projects

Materializes the people/projects graph from flat Postgres signal data so
strategist/responder agents can score relationship strength.

| | |
|---|---|
| **Source** | Postgres: `inbox.messages` (thread co-participants), `content.documents.participants`, and the `MEMBER_OF` edges already maintained by the graph sync handler. Read-only against Postgres. |
| **Transform** | `relationship-inferrer` — an hourly job (registered via `ServiceScheduler`) that resolves participants to `contact_id`s via `signal.contact_identities`, then MERGEs deterministic, idempotent edges into Neo4j: `THREADED_WITH`, `PARTICIPATED_WITH`, and `COLLABORATED_ON` (Person↔Project↔Person). Edge weights are count + `lastAt`; capped at `TOP_K_PER_PERSON=20`, skipping pairs stale > `STALE_AFTER_DAYS=365`. |
| **Destination** | Neo4j CRM graph — `(:Person)`, `(:Project)`, `(:Organization)` nodes and their edges. The canonical entity-type registry for these labels is `lib/graph/schema.js` (see `lib/graph/OWNERSHIP.md`). |
| **Owner** | `lib/graph/relationship-inferrer.js`. Node upserts (`signal.contacts → :Person`, `signal.organizations → :Organization`, `signal.contact_projects → :Project`) are owned by `lib/graph/sync.js`. |

---

## Seam 4 — proposals → flow

How a proposed unit of irreversible work becomes visible to humans before it
acts — the governance seam. Mirrors Seam 1's "gated" branch.

| | |
|---|---|
| **Source** | An irreversible proposed action — typically a signal the bridge classified as *gated*, or an engagement/contract proposal. |
| **Transform** | The **gated queue**: a proposal lands as a `status='blocked'` work_item **plus** a visible `inbox.human_tasks` card. A blocked work_item *alone* is intentionally invisible to humans — `guard-check.js` only blocks an **agent's claim** of it (Linus blocker #1, ADR-008). The human_task card is what surfaces it into the flow for board approval; the irreversible step still hits the existing `guardCheck` / `checkDraftGates` downstream. |
| **Destination** | The Board Workstation governance / today flow (the human approval surface), and on approval, the executor pipeline. |
| **Owner** | `lib/runtime/signals/signal-action-bridge.js` (gated-branch work_item + human_task creation) and `lib/runtime/guard-check.js` (claim-time enforcement). Precedent for the atomic claim → create work_item → provenance pattern: `lib/contracts/spawn-work-items.js`. |

---

## Cross-cutting invariants

- **Parameterized queries only** at every seam (P2/P4) — no string interpolation
  into SQL.
- **Dedup is infrastructure, not prompt** — `content_hash` gives at-most-once
  bridging (P1).
- **Provenance is a side effect of operating** (P3) — every bridged item records
  its source; logging is not an agent opt-in.
- **Tenancy scopes through the message** — extracted signals FK to
  `inbox.messages(id)`; the tenant id is `ownerId` (→ `board_members.id`),
  resolved upstream from `work_item.account_id`.

## See also

- `lib/graph/OWNERSHIP.md` — who owns deal/entity types (`lib/graph` vs `lib/engagements`).
- `TOOLKIT.md` — the shared agent set.
- ADR-008 — reversibility-gated governance (the model behind Seams 1 and 4).
