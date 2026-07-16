# Object Model Decision: Engagement / Project / Proposal Lifecycle (M2 gate)

> Liotta architecture recommendation, 2026-06-02. Resolves Open Question #2 in
> `spec/features/003-meeting-to-work.md`. Status: **ACCEPTED** — Eric ✓ 2026-06-02
> (Linda: brand-kit literal values still pending, non-blocking). Clarifications
> (proposal-optional, projects-have-issues, List/Board view) folded in below.

## TL;DR / Recommendation

**ONE durable object, not two.** Extend the existing `engagements.engagements`
row with a deal/delivery **status lifecycle** and an `owner_org_id`. Do **NOT**
create a `projects` table. "Proposal" stays exactly where it is (a document in
`content.drafts` for the *sendable* artifact; `engagements.proposals` for
*ingested source material*). Execution attaches by stamping `engagement_id` into
the existing `agent_graph.work_items` / `campaigns` DAG via `metadata` — no new
join table in M2.

**The team's "proposal becomes a project" hypothesis is half-wrong and is a
BLOCKER if taken literally.** See "Contrarian take" below.

---

## What actually exists today (cited)

| Object | Table | Lifecycle / shape | Role |
|---|---|---|---|
| Engagement | `engagements.engagements` (mig 115, 116) | `status: draft → active → archived`; `kind: website/mobile_app/api/other`; `is_master` singleton | "One client project we are scoping → one living .md spec." NOT a CRM deal. |
| Ingested doc | `engagements.proposals` (mig 115) | `kind: draft/finalized/note`; FK→engagement | Raw source material (RFPs, call notes) feeding the living spec. **This is NOT the sendable proposal.** |
| Living spec | `engagements.specs` + `spec_sections` (mig 115) | versioned, pinnable, human+`synth` edits | The tightening .md spec — the durable deliverable artifact. |
| Sendable proposal/contract | `content.drafts` (`content_type='contract'`) | — | The document that goes out for signature. |
| Signature | `signatures.signature_requests` (mig 054) | `pending → in_progress → completed/declined/expired/cancelled`; soft-ref `draft_id` | Acceptance event = "won". |
| Execution unit | `agent_graph.work_items` (baseline) | `created→…→completed`; `type: directive/workstream/task/subtask`; self-ref `parent_id`; `metadata JSONB` | The task DAG. **No engagement/project FK today.** |
| Campaign | `agent_graph.campaigns` (baseline) | 1:1 `work_item_id`; budget envelope | A budgeted autonomous run hung off one work_item. |
| Graph node | Neo4j `:Project` (`lib/graph/schema.js`) | `REQUIRE p.locator IS UNIQUE`; `origin_org` indexed | Already a Project concept in the KG, keyed by *locator* (string), org-tagged. |

**Two critical, decision-changing facts:**

1. The word "engagement" is **already taken** and already means "the project we
   scope and deliver." There is no separate deal object. Adding a `projects`
   table would create a *third* Project concept (alongside the Neo4j `:Project`
   node and the namespaced `/api/projects` wiki route flagged in mig 115's own
   header comment). That is naming chaos, not a model.

2. **`engagements.engagements` never got `owner_org_id`.** Mig 134/138/148
   stamped `agent_graph`, `inbox`, voice/calendar — but the `engagements` schema
   is unscoped. M2 creates engagements/contracts "on behalf of" an org, so this
   is a **hard precondition and a latent leak** (same class as 588/596).

---

## Decision

### 1. One object or two? → ONE row, status lifecycle.

`engagement` IS the durable container. "project" is **not a new object** — it is
the post-acceptance *state* of the same engagement. Replace the
`draft/active/archived` status with a lifecycle that spans the full arc:

```
prospect → proposed → won → active → closed
                              ↘ lost (terminal, from prospect|proposed)
                              ↘ archived (terminal, admin)
```

- `prospect`  — meeting happened, relationship/deal exists, nothing sent.
- `proposed`  — a sendable proposal/contract (content.drafts) is out / in signature.
- `won`       — signature_requests.status='completed' flips it (event-driven).
- `active`    — execution underway (work_items attached).
- `closed`    — delivered/billed out.
- `lost`/`archived` — terminal.

Keep `draft`/`active`/`archived` working via a **status-value migration**, not a
new column (map `draft→prospect`, keep `active`, `archived`). Old CHECK widens.

### 2. Where each thing sits

- **Engagement** = the row. Carries `status` + `owner_org_id` + `kind`.
- **`engagements.proposals`** = ingest material (unchanged; feeds the spec).
- **Sendable proposal/contract** = `content.drafts` (unchanged). Link it to the
  engagement with a soft ref **the way it's already done**: a TEXT
  `engagement_id` in the draft's existing `metadata`/columns — no cross-schema FK
  (SPEC §12). Acceptance = a `signature_requests` completion → flips engagement
  to `won`.
- **Execution DAG** = `work_items` + `campaigns`, attached by writing
  `engagement_id` into `work_items.metadata` (JSONB already exists). The
  engagement's top-level `directive` work_item is the anchor; subtasks inherit
  via `parent_id`. **No `work_items.engagement_id` column in M2** — metadata is
  enough to render "what work belongs to this engagement," and avoids a baseline
  migration on the hottest table in the system.

### 3. 10x-leverage model vs brute force

| | Brute force (reject) | 10x (recommend) |
|---|---|---|
| Objects | new `projects` table + `engagement→project` FK + sync triggers | **0 new tables.** 1 status enum widen + 1 `owner_org_id` column |
| Proposal link | new `proposals↔projects` join | reuse `content.drafts` soft-ref + `signatures` completion event |
| Execution link | new `project_work_items` join table | reuse `work_items.metadata.engagement_id` (JSONB, indexed via GIN if needed) |
| "Won" transition | manual status field someone forgets to set | **event-driven**: `signature_requests → completed` flips it. State can't drift. |

The leverage insight: **acceptance is already a recorded, hash-chained event**
(`signatures.signature_events`). Don't model "won" as a field a human sets — make
it a *materialized consequence* of the signature event. Evented core, dumb edges.

### 4. Advisory (UMB) vs dev (Staqs) — one model, `kind` discriminates.

They do **not** need different shapes. Both are an engagement with a client, a
living spec, and an owner_org. The difference is **how `status` advances**, not
the schema:

- **Staqs (dev):** `won → active` spawns `work_items`/`campaigns`. Project-shaped.
- **UMB (advisory):** may sit in `active` indefinitely with *no* work_items —
  the "execution" is the human board-comment loop (per the strategy doc's
  Advisory track). Relationship-shaped. Same row, zero work_items attached.

Add `kind: 'advisory'` to the existing CHECK so an advisory engagement isn't
mislabeled `website/api`. That's the *only* advisory-specific schema change.

---

## Contrarian take / BLOCKER

**"A proposal becomes a project" is wrong as a data model and will cause a
double-object bug.** The proposal is a *document* (`content.drafts`); it does not
"become" anything — it gets *signed*, and the signature *transitions the
engagement*. If you literally build "proposal → project," you create a `projects`
table whose lifecycle duplicates `engagements.status`, then need triggers to keep
them in sync, then hit the exact naming collision mig 115 already warned about
(`/api/projects` + Neo4j `:Project`). The correct sentence is:

> **"An engagement is *won* when its proposal is signed, and *active* when work
> attaches."** Engagement is the noun; proposal and project are its document and
> its state.

**Second BLOCKER (tenancy, gates real data):** `engagements` has no
`owner_org_id`. Per feature-spec 003's go-live gate and the 588/596 lessons, M2
must stamp it **from the JWT principal, never a body param**, and the live served
path must be verified with `verify-tenancy-live.mjs` (Staqs vs UMB). Cross-org
joint meetings use the **primary-org + shared-visibility** rule (Open Q #1) — the
engagement is single-owner; shared visibility is an edge, not a second owner.

---

## Minimal migration (M2 build) vs defer

**Build in M2 (one migration, ~30 lines):**
1. `ALTER TABLE engagements.engagements` — widen `status` CHECK to
   `prospect/proposed/won/active/lost/closed/archived`; migrate `draft→prospect`.
2. Add `kind='advisory'` to the `kind` CHECK.
3. Add `owner_org_id UUID` + backfill Staqs + `SET DEFAULT` (mirror mig 134's
   exact pattern) + `proposals`/`specs` inherit via engagement (no own column;
   they're already CASCADE-scoped by FK).
4. App layer: stamp `owner_org_id` from principal in `createEngagement`
   (`lib/engagements/db.js`); scope `listEngagements` with `visibleClause` from
   `lib/tenancy/scope.js` (fail-closed).
5. Event wiring: on `signature_requests → completed`, flip the linked
   engagement to `won` (resolve link via `draft_id → content.drafts.metadata.engagement_id`).

**Defer (not M2):**
- A real `work_items.engagement_id` column + GIN index — only when "show all work
  for engagement X" is a measured hot query. Metadata read is fine at N=2 orgs.
- `engagements.proposals.owner_org_id` — redundant; FK-CASCADE from engagement.
- Neo4j `:Project`↔engagement reconciliation — read-path, gated on RLS flip
  (same gate as M4 patterns).
- Billing/invoice object — out of scope; that's the Phase 3 Finance project.

## Success criteria (acceptance for this decision)

- Zero new tables; `git diff --stat` on M2 shows one new SQL migration touching
  only the `engagements` schema.
- `createEngagement` rejects an `owner_org_id` in the payload (test) and derives
  it from the principal.
- Signing a proposal flips its engagement to `won` with no human action (test).
- `verify-tenancy-live.mjs`: ingest-as-Staqs, list-as-UMB → 0 engagements.
- An advisory engagement with 0 work_items renders correctly (no dev assumptions).

## Clarifications (Eric, 2026-06-02)

These refine the model above; fold into spec-003 Open Question #2.

1. **A proposal is OPTIONAL — never a gate.** A project (an `active` engagement) can
   exist with **zero proposals**. The proposal is a document that hangs off the
   engagement (0..N: zero, one, or many — re-proposals/amendments), not a precursor
   that "becomes" the project. Concretely:
   - Engagement creation does NOT require a proposal.
   - The state machine must allow `prospect → active` and **create-as-active**
     directly, without passing through `proposed` or a signed document.
   - Signature-completion auto-flipping to `won` is the *happy path*, not the only
     path; status may also be set directly.
   - This is the decisive argument against "proposal becomes a project": a project
     with no proposal proves the proposal can't be the thing that becomes it. The
     **engagement is the spine; the proposal is an optional artifact.**

2. **Projects have ISSUES (Linear's model); "board" is just one view of them.** The
   product's unit of work is an **issue** (Linear vocabulary). A `project` (active
   engagement) **has issues**; an issue belongs to a project, or stands alone on the
   global list. Issues render in a **switchable view: List ⇄ Board (Kanban)** — same
   data, user toggles, exactly like Linear. The Board view groups by issue status
   (`created → assigned → in_progress → review → completed`, plus `NEEDS YOU` =
   human-tasks).
   - **Storage stays `agent_graph.work_items`.** "Issue" is the product-facing name
     for a work_item — rename the **label / route / component only**, NOT the table.
     The whole task graph + the in-flight tenancy program depend on `work_items`; a
     table rename is high-cost, zero-leverage (Liotta's reuse ethos).
   - **Project issues** = `work_items` filtered by engagement (`metadata.engagement_id`).
     The **global Issues list/board is the cross-project aggregate** — a view, not a
     new table. Today's `/board` is that global view; it gains a List⇄Board toggle and
     is renamed "Issues."
   - Advisory engagements (`kind='advisory'`, 0 issues) show an empty issues list.
