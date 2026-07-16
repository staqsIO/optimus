# 003 — Meeting to Work (discern and delegate)

> Feature spec for the M2 milestone of the Onboarding Round-Out (see
> `spec/strategy-onboarding-roundout.md`). Status: **DESIGN — awaiting board sign-off
> on the engagement-vs-project vocabulary and org-precedence rules before
> implementation.**

## Context

A meeting happens and Optimus ingests the transcript, but there is no reliable step
that **discerns and delegates** — the gap Eric named repeatedly on the 2026-06-02
team call. Today a transcript becomes KB chunks and ambient signals, but it does not
reliably become (a) curated knowledge *and* (b) delegated work (Linear tickets +
board tasks + engagement/contract triggers). Provenance is tracked only at the
engagement-proposal level (`lib/engagements/synth.js`), not at the signal level, so
a user on the board cannot trace a signal back to the meeting that produced it.

Two adjacent problems compound it:
- **Double-capture.** The same meeting is captured by multiple attendees, and by
  TLDV *and* Google Meet/Gemini, producing duplicate transcripts. There is no
  cross-source dedup and no source-preference switch.
- **Org ambiguity.** With two orgs sharing one brain (Staqs, UMB Advisors),
  generated artifacts (proposals/contracts) need an explicit "on behalf of" entity
  (Stacks / UMB / Formulate), and org-level queries need a precedence rule.

This builds on Daniel's flows + signals system (merged 2026-06-01):
`lib/runtime/flow-engine.js`, the flow-natives in
`autobot-inbox/agents/flow-agents/` (`classify_text`, `extract_entities`,
`summarize`), the signal pipeline (`signal-detector`, `signal-task-promoter`,
`signal-action-bridge`), and `autobot-inbox/src/api-routes/flows.js`.

### Design principle (from the agentic-engineering method)

Feed the **raw** transcript and extract against full context (KB + prior plans),
rather than pre-summarizing. Keep the raw artifact alongside normalized chunks
(see the MCP `ingest_transcript` tool, M1). Pre-digesting throws away the signal the
classifier needs.

## User stories

- **As a meeting attendee**, when a meeting is ingested, I want Optimus to classify
  it and produce the right outputs (KB facts, action items, follow-ups,
  engagement/contract triggers) so I don't hand-triage every transcript.
- **As any team member**, I want one canonical record per meeting even when several
  of us recorded it (TLDV + Meet), so the brain is not polluted with duplicates.
- **As a board user**, I want to click from a signal to its source meeting, the
  calendar event, the generated ticket, and any draft/email, so I can follow the
  flow of information in one place.
- **As a proposal author**, I want to pick (or have detected) which org the work is
  on behalf of, so branding and entity are correct.

## What to build

1. **`meeting.received` signal type** wired into `agent_graph.signals`, emitted when a
   transcript finishes ingestion (hook off `lib/rag/ingest.js` for
   `source in {transcript, tldv, gemini}`).
2. **Cross-source dedup, pre-extraction.** Collapse the same meeting (multiple
   attendees and/or TLDV+Meet) to one canonical record using a stable
   meeting-identity key (calendar event id + time window + participant set), mirror
   of the canonical-key fix used for the feed-poller (`canonicalUrlKey()` pattern).
   A per-org/per-user **source-preference switch** (TLDV | Meet | both) decides which
   transcript wins when more than one exists.
3. **Classifier flow** built from existing flow-natives: `meeting.received` →
   `classify_text` (informational vs action-bearing) → `extract_entities`
   (action items, dates, names, commitments) → routes to:
   - **KB facts** → curated KB entry (not just raw chunks),
   - **Tasks** → Linear ticket(s) + board task via flow wrappers
     (`create-ticket.js`),
   - **Follow-ups** → board/today items,
   - **Engagement/contract triggers** → `lib/engagements/` entry points.
   Manual flow-assignment first (assign a meeting to a flow on the board), then an
   auto path once the catalog of flows is trusted (Daniel's staged plan).
   - **Informational path is explicit:** a purely informational meeting produces
     **KB-only, zero tickets**. Over-delegation (noise tickets) is the failure mode
     to guard against — it is the "always a bit off" symptom.
   - **Idempotency / no double-create (Neo).** An action item the ambient
     `signal-detector` already caught must not be re-created by this classifier.
     Key derived work on `source_meeting_id + normalized-action-hash` and **dedup at
     promotion** (in `signal-task-promoter`), not only at ingest.
   - **Edited-transcript supersede.** A re-ingested/edited transcript is a *new*
     `sourceId` but the *same* canonical meeting-identity → **update/close prior
     derived work**, do not duplicate.
4. **Signal-level provenance.** Stamp `source_meeting_id` (and `origin: meeting`) on
   every signal/ticket/task derived from a meeting, so the board can build the
   click-through lineage (consumed by M4).
5. **Org "on behalf of" selector** on engagement/proposal/contract creation
   (Stacks / UMB / Formulate), defaulting via `auto-build.js` `matchOrganization()`
   when confident, stamping `owner_org_id` through `lib/tenancy/owner-stamp.js`.
   **"Overridable" means a board-UI selection that goes through a `withViewer`-scoped
   API call — NOT a caller-supplied org in the write payload.** The backend ignores
   any `owner_org_id`/`owner_scope` in the body and derives org from the principal
   (Linus). A **cross-org single meeting** (Staqs↔UMB joint call: one event id,
   participants in both orgs) is stamped **primary-org + a shared-visibility edge**,
   per the decision below — never silently to whoever ingested first.
6. **Agent-buildable + inspectable flows** (carry-over gaps from Daniel's system,
   needed for adoption): a create-via-API path so a Claude agent can author a flow,
   a JSON view/editor, and a delete (hard or explicit archive) — so the team can
   tweak agent-authored flows on the board. **Precondition (Linus BLOCKER 2):
   `createFlowCore` must first be made tenant-safe** — stamp `owner_org_id`/
   `owner_user_id` from a `withViewer`-resolved principal (today it stamps neither,
   `created_by` defaults to `'api'`), restrict creation to `role:'board'` (403
   otherwise), and run DAG-validate-then-persist **inside one transaction** (today's
   validate-then-DELETE-on-failure is non-atomic). Confirm `flow_definitions` (mig 037,
   predates mig-134) actually has `owner_org_id`.

## Acceptance

- [ ] A raw test transcript containing one decision, one action item, and one
      follow-up produces: exactly one canonical KB record (dedup holds against a
      simulated TLDV+Meet double-capture), one Linear ticket + board task, and a
      follow-up item — each stamped with `source_meeting_id`.
- [ ] `meeting.received` signal fires once per canonical meeting, not once per
      attendee/source.
- [ ] Source-preference switch is honored (only the preferred source's transcript
      drives extraction when both exist).
- [ ] **Classifier-vs-detector overlap:** an action item the ambient signal-detector
      already caught yields **one** ticket, not two (idempotency key holds at promotion).
- [ ] **Informational meeting** yields **zero tickets, KB-only**.
- [ ] **Edited-transcript re-ingest** supersedes prior derived tickets (no duplicates).
- [ ] Proposal/contract creation records the correct "on behalf of" org; override is
      via board-UI only — an `owner_org_id`/`owner_scope` in the write payload is
      **ignored** (verified by test).
- [ ] **Cross-org single meeting** is stamped primary-org + shared-visibility edge;
      neither org silently loses it and neither sees the other's private content.
- [ ] A flow can be created via API by an agent, viewed as JSON, edited, and
      deleted on the board. **A non-`board` token is rejected with 403** (test).
- [ ] Provenance fields are present on all meeting-derived records (verified by
      test), enabling the M4 click-through.
- [ ] **Multi-principal isolation (mandatory, lesson from 588):** ingest as Staqs,
      query as a UMB principal → zero rows; ingest as UMB → row stamped UMB's UUID,
      not Staqs's. The data-layer gate being green is NOT sufficient — assert the
      live served path with both principals.
- [ ] Tests run under `npm run test:ci`; tenancy verified with
      `autobot-inbox/scripts/verify-tenancy-live.mjs` (Staqs vs UMB scoping).

> **Go-live gate (review consensus, blocking real data).** This milestone builds and
> tests against **synthetic orgs**. Real UMB confidential meeting data must not enter
> the shared brain until the PR-B/263 RLS flip lands (non-superuser pool) and
> `verify-tenancy-live.mjs` passes Dustin-as-UMB. Today RLS is bypassed (superuser
> pool); isolation is application-level only and has leaked twice (588, 596).

## Decisions (resolved 2026-06-02 — Eric ✓; Carlos to own data-model details)

1. **Cross-org single meeting** — RESOLVED. Stamp `owner_org_id` = the **ingesting
   user's org** (primary); mark the record **shared-readable by both orgs** via a
   `shared_with_org_ids[]` edge. Staqs↔UMB is self-federation (N=1.5, both are us),
   so cross-org meetings default to **shared-visible**; a single-org meeting = just
   that org, no sharing. Read-side: `visibleClause` honors org membership ∪
   `shared_with_org_ids`. (Leak surface — gated on the RLS flip.)
2. **Engagement vs Project** — RESOLVED by **ADR-015** (Accepted, Eric ✓): ONE object
   — `engagements.engagements` is the spine; "project" = its `active` state (no new
   table); proposal is an **optional** 0..N document (a project can exist with zero
   proposals); projects **have issues** ("issue" = product name for `work_item`, table
   NOT renamed) shown in a switchable **List ⇄ Board** view; `kind` = `project`|`advisory`.
3. **Org-vs-personal precedence** — RESOLVED. **Additive union, specificity-ranked:**
   at org scope you see org-shared ∪ your personal rows; on duplicates, the more
   specific (personal) ranks above org-shared. A merge/sort rule, not a gate — matches
   the existing 3-tier `lib/tenancy/scope.js` visibility (user ∪ org ∪ shared).
4. **Dedup identity key** — RESOLVED. Canonical key = **`calendar_event_id` when
   present**; ad-hoc fallback = `hash(15-min-rounded start window + sorted participant
   emails + normalized title)`. Same canonical-key pattern as the feed-poller fix.
   **Source-preference switch** (`What to build` #2) — RESOLVED: **per-user setting
   with an org default**; default = ingest both sources but collapse to one canonical
   record (preferred source's transcript wins as the body when both exist).

### Still open
5. **Auto vs manual classification cutover.** What confidence/coverage bar before we
   flip the classifier from manual flow-assignment to automatic? (Tune during M2.)
6. **Time-bounded KB coupling between orgs** (Eric's "fuse two brains for a project,
   then decouple") — later research spike; security/privacy review required.
