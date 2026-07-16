# Optimus Onboarding Round-Out — Strategy

**Status:** Draft for board + team review
**Date:** 2026-06-02
**Author:** Eric (with Claude)
**Audience:** Staqs team, UMB Advisors, Keenan (Parslee)
**Source material:** Keenan/Parslee call (2026-06-02), Staqs team call (2026-06-02), Matt Van Horn "Every Agentic Engineering Hack I Know (June 2026)"

---

## TL;DR

Optimus is "very close but always a bit off." Two conversations this week made the
fix legible. Keenan's working method (a **dual-loop** with a **context-isolated
verifier**) and Matt Van Horn's hack list are the *operating system* underneath
modern agentic work — and they map almost one-to-one onto Optimus's own primitives.

The strategy is **one unified loop**: the team adopts a standardized agentic
**method**; Optimus **captures** its artifacts via an MCP server; and Optimus's own
product loops are rebuilt on the **same primitives** (plan-first, *more loops*,
context-isolated verification). We onboard **two orgs at once** — **Staqs**
(development-heavy) and **UMB Advisors** (advisory) — over a **shared brain**
(knowledge base + transcript ingestion + signals).

> Threaded principle, per Eric: **"always more loops."** Every unit of agent work
> gets nested verification against upfront success criteria, by a verifier that
> never saw the implementation, before it's marked done.

---

## 0. Review consensus (Liotta · Linus · Neo, 2026-06-02)

All three reviewers reached **SHIP-WITH-CHANGES**: the direction is sound; close
these holes in the spec *before* writing code. None block M0.

**Shared BLOCKER — go-live gate.** Today the DB pool connects as the Postgres
**superuser**, so **RLS is bypassed** (`lib/db.js` logs "RLS is BYPASSED" at boot);
cross-org isolation is currently *application-level only* (`visibleClause`) and has
leaked twice this month (STAQPRO-588, 596). **No real UMB confidential data enters
the shared brain until the PR-B/263 flip lands (non-superuser `autobot_agent` pool)
AND `autobot-inbox/scripts/verify-tenancy-live.mjs` passes Dustin-as-UMB.** M0–M2
build and test against **synthetic orgs**; real-data go-live is hard-gated. This is
a gate, not a guardrail note.

**Agreed pre-implementation edits (folded into §5, feature spec 003, and the plan):**
- **Ownership derives from the token, never from a parameter.** Remove `owner_scope`
  (and any `owner_org_id`/`owner_user_id`) from MCP write-tool schemas; the backend
  rejects ownership params and derives org from the JWT principal. (Linus BLOCKER 1.)
- **`createFlowCore` is not tenant-safe today** — no `owner_org_id` stamp, no authz
  gate, non-atomic DAG-validate-then-delete. Stamp org from principal, restrict
  creation to `role: 'board'`, wrap in a transaction — preconditions for the
  create-via-API path, not follow-ups. (Linus BLOCKER 2.)
- **Ingest is a cost/G10 bypass** — caller controls the dedup key. Server-derive
  `sourceId` (content hash) + per-user daily ingest cap; verify G8/Model-Armor fires
  on the MCP path. (Linus BLOCKER 3; mirrors the feed-poller 602 storm.)
- **`ingest.js` does not import owner-stamp today** — wiring it is explicit M1 work,
  not a free proxy; ~65 agent-runtime writes still fall through to the single-org
  Staqs DEFAULT and will mis-stamp UMB-as-Staqs. (Liotta.)
- **One enforcement artifact makes "same primitives" real** — a persisted
  `success_criteria` record `{ target:{kind,locator}, assertions[], oracle }`
  referenced by both dev `work_items` and product `flow_executions`. Empty criteria
  must HARD-FAIL the verifier, not pass. (Neo; see §2 and M3.)
- **Split M3** — dev "more loops" SOP ships in M0; the *reusable product verifier
  primitive* defers to post-M4, gated on a measured flow-failure rate. Fix the flaky
  Jamie runner directly, not as a framework. (Liotta + Neo.)
- **Demote M4's pattern read-path** — provenance UX only this cycle; pattern→planner
  blocked until RLS enforces and `origin_org` is verified (else single-org Staqs
  patterns contaminate UMB context). (Liotta + Linus.)
- **Cross-org meetings are a leak decision, not parked vocab** — a Staqs↔UMB joint
  meeting has one event id but participants in both orgs; single-valued
  `owner_org_id` stamps it to the first pusher and the other org loses it (or leaks).
  Needs an explicit primary-org + shared-visibility rule before M2. (Neo.)
- **The SOP excludes its non-terminal audience** — restructure into a shared core +
  Builder / Advisory tracks; advisory's "verifier" is the human board-comment loop.
  (Neo.)
- **Highest leverage is M2's classifier, not M1's ingest.** Capture-first is
  table-stakes (volume); the team's pain is triage. Keep M1 to days, not weeks, so
  it doesn't eat the cycle. (Liotta.)

---

## 1. What we discussed

### 1a. Keenan (Parslee.ai) — the loop architecture

- **Dual-loop.** *Inner:* implement a unit → Linus + Neo code-review → fix → repeat
  until both approve → next unit. *Outer:* after all units, a tester fires up
  browser automation against **upfront success criteria**, finds what's broken,
  sends it back into the inner loop, repeats until *all* units exist **and** all
  success gates pass.
- **Context-isolated verifier.** The most recent addition: the verifier is an
  **entirely separate context that has never seen the code** — it sees only the
  app and the scenario it's supposed to test. This is what stops the model from
  marking its own homework.
- **Success criteria up front** = where the real work goes. "What does correct
  look like?" Define it before building.
- **Closed feedback loop** (Parslee product): user clicks a button → screenshot +
  diagnostics + description → triage agent → dev agent → review agent →
  **browser automation recreates the issue *and* the fix** → loops until done →
  updates the user → ships (auto-merge + deploy; rollback is the safety net).
- **CEO-level ownership.** Don't get in the weeds. File the bug, walk away. Owners
  own projects; they don't solve them.
- **Forward-only.** Nobody reverts; you fix forward.
- **Runner agents.** Out-of-loop agent "teams" (his is named "Grace") that run
  whole sites/projects with their own dev/design sub-agents.
- **Tooling:** custom loops (not Ralph/GSD off-the-shelf); UltraCode + Claude-decides-
  workflows; Claude + Codex dual engine; "don't be too prescriptive — give agents
  room to push the idea further."

### 1b. Staqs team — where Optimus falls short

- **The disconnect:** a meeting happens and information is collected, but there's no
  reliable step that **discerns and delegates** — turning the meeting into (a)
  meaningful knowledge in the brain *and* (b) delegated work (Linear + the board).
- **UX/provenance** (Isaias): no way to follow the flow of information; you can't
  click from a signal to its source meeting → calendar → email → ticket.
- **Flows** (Daniel): a promising new system of small, single-purpose flow agents
  (extract entities, summarize, classify) chained by signals — but agents can't
  build flows yet, there's no JSON view, and no delete.
- **Meeting dedup + org/personal hierarchy** (Carlos): TLDV and Google Meet
  double-capture; same meeting attended by 5 people = 5 copies; no source
  preference; no precedence rule when an individual queries at the org level.
- **Org "on behalf of"** (Eric): proposals/contracts need to know which entity
  they're from (Stacks / UMB / Formulate) with the right branding.
- **Self-improvement** is observe-only: the Neo4j graph + pattern detection exist,
  but nothing feeds back into agent behavior.
- **Runners (Jamie):** Linear-task → laptop-runner dispatch is flaky (comment sync
  broken, tasks fail-then-retry). Goal: register teammates' spare laptops as runners.
- **Adoption:** the team is itching to use Optimus. Get them in now (hide the
  config surfaces), default them to engagements/proposals, and capture the work
  they already do in Claude/Slack.

### 1c. Matt Van Horn — the method, hack by hack

The article is the working method underneath Keenan's loops. The relevant hacks
and their Optimus analogues:

| Matt hack | Optimus / team analogue |
|---|---|
| #11 Granola the **raw** transcript → /ce-plan, don't summarize first | The meeting→work pipeline. Lesson: keep the raw artifact, extract against full context (KB + prior plans). |
| #14 Notes are your agent's KB; point agents at it via CLI/API | The MCP-server bet. Optimus = the org-level shared brain. |
| #7 Give Claude an email / remote control / work anywhere | Jamie + laptop runners, done right. |
| #16 Proof: send a plan to a non-terminal colleague; comments flow back | The board *is* the org's "Proof" — the human-readable surface over agent work (for Linda/Mike/Dustin). |
| #1/#3 plan.md first; "plan for the plan" for deep non-code work | Proposal/contract/strategy generation; team SOP. |
| #12 Human signal, not hands | Resolves Eric's "am I just a bottleneck" tension. |
| #17 Write your own skills (anything >2×) | Daniel's flow-natives = in-product skills. |
| #2/#8 The plan is the leash; more loops; sound hooks for many sessions | The "more loops" verifier; runner-fleet ergonomics. |
| #9 Claude plans, Codex builds (dual engine) | Runner throughput / "more loops." |
| #10 last30days research before plan | executor-research / `/deep-research`, upstream of planning. |

---

## 2. The unified loop

```
 TEAM METHOD            OPTIMUS (captures)         COMPOUNDS
 ───────────            ──────────────────         ─────────
 plan-first       ─►    MCP ingest            ─►   KB + graph
 voice                  meeting → work             patterns
 Claude + Codex         flows / runners            self-improve
 MORE LOOPS             context-iso verify         (closes the loop)
 human = signal         provenance / lineage
```

Same primitives on both sides. The method produces artifacts; Optimus is the
org-level "notes are your agent's KB" layer that compounds them; the more-loops
verifier is the quality backbone for both.

**Enforcement point (per Neo's review).** "Same primitives" is only real if both
sides share a *data shape*, not a metaphor. The shared artifact is a persisted
**`success_criteria`** record — `{ target: {kind: ui|cli|api, locator}, assertions[],
oracle }` — written *before* work starts and referenced by both the dev side
(`work_items`) and the product side (`flow_executions` / runner tasks). The verifier
is blind to *how* the work was built, never to *what counts as correct* — so shared
criteria are the verifier's input, not a leak. Empty `success_criteria` must
**hard-fail** the verifier (vacuous-pass = "more rubber-stamps," the opposite of the
intent). Without this record, "build once, use twice" silently becomes "build twice."

---

## 3. Two orgs, one brain

We are onboarding **two orgs with mixed goals over one shared brain.** This is the
*product reason* the multi-tenant `owner_org_id` program (ADR-012/014) has been in
flight — onboarding rides on that substrate, and **real UMB data go-live is
hard-gated on the RLS flip landing** (see §0). Until then, isolation is
application-level only and has leaked twice this month.

| | **Staqs** (dev-heavy) | **UMB Advisors** (advisory) |
|---|---|---|
| Primary surface | flows, runners, code, Linear | engagements, proposals, contracts, research |
| MCP usage | push PRDs / specs / code-context | push meeting notes / research / daily summaries |
| "on behalf of" | Stacks (and Formulate) | UMB |
| Shared substrate | **KB + transcript ingestion + signals + the dual-loop verifier — common to both** | |

Implication: the org "on behalf of" selector and the org-vs-personal precedence
question are **onboarding-critical**, not deferrable — they're how two orgs coexist
in one brain.

---

## 4. What's built vs the gaps

(Condensed; see `~/.claude/plans/take-a-read-through-optimized-wigderson.md` for file-level detail.)

| Area | Built | Key gap |
|---|---|---|
| **MCP server** (`tools/optimus-mcp/`) | 15 read tools, token auth | **Zero write tools** — no ingest/create, no ownership control (STAQPRO-581) |
| **KB ingest** (`lib/rag/ingest.js`) | transcript/tldv/gemini sources, dedup, owner stamping | not reachable from MCP; no raw-preserving extraction |
| **Flows + signals** (`lib/runtime/flow-engine.js`) | flows-as-JSON, flow-natives, signal pipeline, board builder | no delete, no agent-create path, no JSON view, no `meeting.received` signal |
| **Meeting → work** | normalizers, synth provenance | **no cross-source dedup**, no source switch, no meeting→ticket classifier |
| **Board / Today** | today/signals/pipeline pages | **no click-through provenance**, no hide-config mode |
| **Tenancy** (`lib/tenancy/scope.js`) | 3-tier visibility, owner-stamp, RLS in flight | no org "on behalf of" selector, no org-vs-personal precedence |
| **Self-improvement** (`lib/graph/`) | pattern extractor → `patterns` table | **observe-only** — never feeds back into behavior |

---

## 5. Sequenced strategy

Ordering: **fastest path to two orgs using it daily, then close the loops.** The
highest-leverage milestone is **M2's classifier** (triage is the team's pain);
M1 is necessary plumbing — keep it to days, not weeks. Build/test M0–M2 against
**synthetic orgs**; real UMB data is hard-gated on the RLS flip (§0).

- **M0 — Team method baseline.** Standardize *how everyone works* so the brain gets
  high-quality artifacts from day one: shared `.claude` config + skill set,
  runner ergonomics (email/remote/Mosh), two org profiles (Staqs code vs UMB
  advisory). **Includes the dev-side "more loops" SOP** (was M3). → **Team Agentic SOP**.
- **M1 — MCP capture (keystone, extends STAQPRO-581).** Capture-first write tools:
  `ingest_document`, `push_summary`, `ingest_transcript` (raw-preserving).
  **Ownership is derived from the JWT token, never a parameter** (no `owner_scope`);
  wiring owner-stamp into `ingest.js` is explicit work. **Server-derived `sourceId`
  (content hash) + per-user daily ingest cap + verified G8 sanitize** (anti-abuse).
  Board hide-config mode. The team keeps working in Claude; Optimus compounds passively.
- **M2 — Meeting → discern → delegate (feature-spec first).** `meeting.received`
  signal + a classifier flow → {KB facts | Linear/board tasks | follow-ups |
  engagement/contract triggers}; cross-source dedup + preference switch;
  signal-level provenance; org "on behalf of" selector (board-UI, not a body param).
  **Idempotency/supersede** so the classifier doesn't double-create against the
  ambient signal-detector, and edited-transcript re-ingest supersedes prior work.
  **`createFlowCore` hardened first** (org stamp + `role:'board'` authz + transaction).
- **M3 — Product verifier primitive (DEFERRED to post-M4).** The dev-side "more
  loops" SOP ships in M0; the *reusable product verifier* (flow/runner self-verify
  against the shared `success_criteria` record, §2) defers until M2 produces real
  flows and we've **measured** a flow-failure rate worth a framework. Fix the flaky
  Jamie runner directly in the meantime — don't build a framework for one runner.
- **M4 — Provenance UX (pattern read-path deferred).** Board click-through
  (meeting↔signal↔ticket↔calendar↔email↔engagement) using M2's signal-level
  provenance. The `patterns`→planner read-path is **deferred** until RLS enforces
  and `origin_org` is verified (else single-org Staqs patterns contaminate UMB).

### Decide before M2 (promoted from parked — these are leak/tenancy decisions)
- **Cross-org single meeting** (Staqs↔UMB joint call): one event id, participants in
  both orgs, single-valued `owner_org_id`. Needs an explicit **primary-org +
  shared-visibility** rule, or the second org silently loses the meeting / it leaks.
- **Org-vs-personal precedence** — design in the M2 feature spec (Carlos).
- **Engagement vs Project vocabulary** — Eric + Linda before M2 build
  ("proposal → becomes project" is the leading model).

### Parked (flag, don't block)
- **Time-bounded KB coupling/decoupling between orgs** — research spike post-M2;
  security/privacy review required; gated on the same RLS flip.
- **VoiceRail / Parslee collaboration** — separate track (Keenan + Daniel call).

---

## 6. Deliverables

1. **This strategy doc** — `spec/strategy-onboarding-roundout.md`.
2. **Linear epic + issues** — "Optimus Onboarding Round-Out (Staqs + UMB)".
3. **Team Agentic SOP** — `autobot-inbox/docs/external/team-agentic-sop.md`.
4. **Feature spec (meeting → work)** — `spec/features/003-meeting-to-work.md`.

---

## 7. Open questions for the board

1. Confirm capture-first MCP scope for v1 (ingest before create-objects). *(Eric: yes.)*
2. Engagement vs Project vocabulary — owner: Eric + Linda.
3. Org-vs-personal data precedence rules — owner: Carlos (design spike).
4. Is time-bounded KB coupling between orgs in scope this cycle, or a later spike?
5. Do we pursue the Parslee/VoiceRail collaboration in parallel?
