# Feature Spec: Close the Obligation Loop

**ID:** 010
**Status:** Approved
**Author:** Eric Gang (via Claude)
**Created:** 2026-06-14
**Last updated:** 2026-06-14
**Related ADRs:** ADR-008 (signal→action bridge / reversibility), ADR-013 (signal taxonomy)
**Related Linear:** OPT-56 (bridge go-live), OPT-44 (completion-detection, currently inert), OPT-158 (bridge draft/executor context fix) — new issues TBD

---

## 1. Summary

Optimus extracts obligations from email, meetings, and other signals and lists them on the **Today** surface — but the loop dead-ends there. Obligations are flat, unclickable text; there's no way to open one, see its source, act on it, or draft a reply from it. Email reply drafts mostly aren't produced. And nothing notices when an obligation has actually been *satisfied* — items rot on the list until a human manually clears them or a staleness window drops them. This feature closes the loop: it makes the obligation surface an actionable workspace, produces useful email drafts, and lets the system infer (and propose, then eventually auto-apply) that an obligation is done — so the board's open-obligation list reflects reality with minimal manual upkeep.

## 2. Motivation

The Today screenshot (2026-06-14) shows the symptom: a wall-of-text Morning Brief and 23 "Open Obligations" as inert lines, six of them stale since 2026-06-08, with no affordance to do them or learn more. This is governance theater — the same failure mode ADR-011 diagnosed for the old `/governance` queue (work goes there to *wait*). Three principles are implicated:

- **P6 (familiar interfaces for humans):** a list you can't click or act on doesn't adapt to how a board member works.
- **P3 (transparency by structure):** an obligation should expose its provenance (which email/meeting created it) as a side effect of existing, not require a hunt.
- **P5 (measure before you trust):** auto-resolution must be earned — proposed and measured before it silently closes things.

The board explicitly asked for: (a) clickable, do-able obligations with read-more/source access, (b) email drafts, and (c) automatic satisfaction inference "without a manual telling."

## 3. User Stories

- **US-1 (actionable Today):** As a **board member**, I want to **click an open obligation and see its full context (source email/meeting, who it involves, when it's due) and act on it inline** (do it, draft a reply, mark done, snooze, "not mine"), so that **I can clear obligations from the surface I already look at, instead of context-switching to find them.**
- **US-2 (drafts that exist):** As a **board member**, I want **inbound requests that warrant a reply to arrive as ready-to-review draft replies in my voice**, so that **responding is a one-glance approve/edit instead of writing from scratch.**
- **US-3 (satisfaction inference — suggest):** As the **system (Reviewer/Strategist tier)**, I want to **detect when a later email, meeting, or signal indicates an open obligation was satisfied and propose closing it (with evidence)**, so that **the board's list reflects what's actually done without manual bookkeeping.**
- **US-4 (satisfaction inference — auto, earned):** As a **board member**, I want **high-confidence, measured satisfaction detection to eventually close obligations automatically**, so that **the list stays true with near-zero upkeep — but only after the inference has proven accurate.**
- **US-5 (legible brief):** As a **board member**, I want the **Morning Brief and obligation list grouped and prioritized (by person, urgency, or blocker), each item linking to its detail**, so that **I can triage in seconds instead of parsing prose.**

## 4. Acceptance Criteria

### US-1 acceptance
- [ ] Given an open obligation on Today, when the board member clicks it, then a detail view opens showing its source (the originating email thread or meeting), the people involved, due/created dates, and the obligation text.
- [ ] Given the detail view, when the board member chooses an action (done / snooze / later / not-for-me / draft reply), then the obligation's state changes accordingly and the Today list reflects it on next render.
- [ ] Given an obligation sourced from an email, when the board member opens it, then they can reach the actual source thread (read-more) without leaving for another tool.

### US-2 acceptance
- [ ] Given an inbound message that triage classifies as warranting a response, when the pipeline runs, then a draft reply is created and visible on the Drafts surface (subject to the policy chosen in Q1).
- [ ] Given a created draft, when the board member views it, then it is a draft (never auto-sent) and shows which obligation/message it answers.
- [ ] Given the Drafts surface, when drafts exist, then the count/badge reflects them (the surface is not silently empty when work is pending).

### US-3 acceptance
- [ ] Given an open obligation and a later signal (email/meeting/event) that satisfies it, when the inference runs, then the system records a *proposed* resolution with cited evidence (the satisfying signal) and a confidence score.
- [ ] Given a proposed resolution, when the board member reviews it, then they can accept (closes the obligation) or reject (keeps it open and records the correction).
- [ ] Given a rejected proposal, when a similar pattern recurs, then the rejection is available as training/feedback signal (not silently discarded).

### US-4 acceptance
- [ ] Given a `request`/`action_item` obligation, when a reply that satisfies the ask is detected, then it auto-closes with the reply cited as evidence.
- [ ] Given a `commitment` obligation tied to a meeting, when its calendar event exists and is RSVP'd, then it auto-closes with the calendar event cited as evidence.
- [ ] Given any `legal`-domain obligation, when satisfaction is inferred, then it is **never** auto-closed — it is only ever proposed (US-3) and requires explicit human acceptance.
- [ ] Given satisfaction inference has met a measured accuracy threshold over a defined window, when a new high-confidence (deterministic) match occurs in an auto-close-eligible class, then the obligation auto-closes with an audit record (proposer, evidence, confidence) and is reversible.
- [ ] Given an auto-closed obligation, when it was closed in error, then there is a one-action way to reopen it, and the reopen is recorded.

### US-5 acceptance
- [ ] Given the Today surface, when it renders, then obligations are grouped/sorted by a meaningful axis (e.g., person, urgency, or blocking-relationship) rather than arbitrary order.
- [ ] Given the Morning Brief, when it references an obligation or person, then that reference links to the corresponding detail.

## 5. Scope

### In scope
- Making the existing Today obligation rows clickable with a detail view and inline actions, using the obligation actions that already exist.
- Click-through from an obligation to its source email thread / meeting.
- A policy change so inbound requests warranting a reply produce drafts (the exact policy is Q1).
- A satisfaction-inference capability that proposes obligation closures with cited evidence and confidence, surfaced for accept/reject.
- A measured path from suggest-mode to auto-close (US-4), gated on accuracy.
- Reconciling the obligation data model so the surface the board sees and the resolution writes operate on the same source of truth (see Q3).
- Grouping/prioritization + linkable references in the Morning Brief.

### Out of scope (explicitly)
- Auto-*sending* email (drafts only; sends remain governed by existing gates — never part of this feature).
- Changing the reversibility classifier or the bridge's autonomous/gated routing rules (ADR-008) beyond the draft policy.
- New external channels or sources beyond email/meeting/signals already ingested.
- A full redesign of Today's visual language (this is interaction + data, not a rebrand).
- Cross-org / federated obligation views.

## 6. Constraints & Non-Functional Requirements

- **Constitutional gates affected:** G5 (reversibility — drafts not sends; auto-close must be reversible), G3/G7 (drafts still pass tone/precedent gates), G11 (auto-close should leave a retrospective/audit trail). Satisfaction auto-close is a new autonomous action and must respect the autonomy posture.
- **Design principles invoked:** P3 (provenance by structure), P5 (measure before auto-close), P6 (human-familiar surface), P1 (deny-by-default: auto-close off until earned).
- **Performance:** click-through and detail must be interactive (no multi-second waits); inference runs off the hot path (scheduled/async), must not raise tick latency.
- **Security:** respect existing per-viewer scoping (a board member sees only their obligations / shared ones); no new PII surfaces; classification filters honored.
- **Cost:** satisfaction inference is the only new LLM cost — must be cost-capped and run batched/scheduled, not per-keystroke.
- **Audit:** every proposed/accepted/rejected/auto-closed resolution emits an audit event with evidence, proposer, and confidence.

## 7. Dependencies

- **Upstream:** OPT-158 (executor context fix) — already shipped; unblocks the bridge draft path. The obligation action API and per-viewer scoping already exist.
- **Upstream (NEW, blocking US-3/US-4):** an **ADR for "obligations on the task graph as single source of truth"** (Q3 resolution) — must be written and board-approved before the satisfaction-inference / resolution work, since it defines what gets written and surfaced. Actionability (US-1) and draft policy (US-2) can proceed in parallel without it.
- **Downstream:** a trustworthy auto-close (US-4) depends on US-3 suggest-mode running long enough to measure accuracy.
- **External:** calendar RSVP status (for the commitment auto-close rule, Q2) — already ingested via the calendar integration.

## 8. Open Questions

### Resolved — board decisions (Eric, 2026-06-14)

- [x] **Q1 (draft policy) — RESOLVED: draft for triage `needs_response`, broadly.** Investigation clarified that "empty Drafts" is largely correct-by-design: replying directly in Gmail resolves the obligation upstream (poller `gmail_reply_detected`) so no stale draft is generated, and the draft list also hides acted-on / low-tone / failed-gate drafts. The lever is the **tier gate** (unknown senders never drafted). Decision: generate drafts for anything triage marks as needing a response, not just `inner_circle`/`active` tiers; accept that fast Gmail replies will supersede many (that's fine — the upstream resolution stays). Keep tone/precedent gates and never auto-send.
- [x] **Q2 (auto-close autonomy) — RESOLVED: tiered, deterministic-first.** Auto-close rules: (a) **answered** → close (a reply that satisfies the ask closes request/action-item obligations); (b) **calendar-RSVP'd commitments** → a meeting commitment whose event exists and is RSVP'd closes; (c) **legal → never auto-close** (always requires a response/human). Deterministic evidence (reply detected, calendar RSVP) may auto-close; ambiguous/semantic matches stay in suggest-mode. *Note:* this extends today's reply-resolution, which currently **excludes** persistent types (commitment/deadline/approval-needed) — see Q6.
- [x] **Q3 (single source of truth) — RESOLVED: unify obligations onto the task graph / "issues board."** One source of truth, the agent task graph (work_items), which SPEC §3 already designates as the single source of truth for agent coordination and which projects to the issues board (Linear). The current split (raw extraction store, board-card store, task-graph store) collapses toward work_items: obligations are promoted into the task graph, the board surfaces them, resolution writes them, and they can appear as Linear issues. **This is an architectural change requiring an ADR in `spec/decisions/` (see Dependencies) — it reshapes US-1/US-3/US-4 and must be settled before the resolution work.**

### Still open

- [ ] **Q6 (reply-closes-commitment nuance):** A reply in a thread does not prove *you did the thing you committed to* — for `commitment` obligations, "answered" is weaker evidence than for `request`/`action_item`. Per Q2, commitments close on calendar-RSVP, not merely on a reply. Confirm: should a non-meeting commitment (e.g., "I'll send the deck") require deliverable evidence (e.g., an attachment/send detected) rather than any reply?
- [ ] **Q4 (inference inputs):** Which signals count as satisfaction evidence — same-thread replies only, or also new meetings, calendar events, and cross-thread mentions? Broader = more coverage but more false positives.
- [ ] **Q5 (grouping axis):** What is the primary grouping/sort for US-5 — by person, by urgency/due, or by blocking-relationship (the Morning Brief already reasons about blockers)?

## 9. Alternatives Considered

- **Alt A — Leave Today read-only, act elsewhere:** rejected because it's the exact context-switch pain the board flagged; the action API already exists, so wiring it in is cheap.
- **Alt B — Auto-close obligations immediately on any signal match:** rejected because unmeasured auto-resolution violates P5 and risks silently closing live obligations; suggest-mode-first earns the trust.
- **Alt C — Reuse OPT-44 completion-detector for satisfaction:** rejected because it operates on the task graph (work item lifecycle), not obligations, and is inert; obligation satisfaction is a distinct problem.
- **Alt D — Draft for all senders unconditionally:** rejected (at least as default) because the prior audit showed it generates ignored noise; Q1 exists to choose the right middle.

## 10. Rollout & Risk

- **Rollout plan:** phased and independently shippable. (1) Today actionability (frontend wiring) — low risk, ship first. (2) Draft policy change — flag-controlled, reversible config. (3) Satisfaction inference — suggest-mode behind a flag, measured, then a separate decision to enable auto-close. Data-model reconciliation (Q3) sequenced before US-3/US-4 correctness work.
- **Reversibility:** actionability and draft-policy are config/UI and instantly revertible. Suggest-mode writes proposals only (no destructive state). Auto-close must be individually reversible (reopen) and globally killable via flag.
- **Blast radius if it breaks:** actionability bug = degraded Today UX (list still readable). Draft-policy too-loose = draft noise (annoying, not dangerous; no sends). Satisfaction inference false-positive in suggest-mode = a bad proposal the human rejects; in auto-mode = a wrongly-closed obligation (hence the earned-trust gate + reopen).

## 11. Success Metrics

(30 days after each phase ships — P5.)

- **Actionability:** % of obligations cleared *from the Today surface* (vs. elsewhere/never); time-to-first-action on a new obligation drops.
- **Stale backlog:** count of obligations older than 7 days trends down (today: 6 stale of 23).
- **Drafts:** # of draft replies produced and the board's accept/edit rate (target: drafts that get used, not ignored — the metric the original tier gate optimized for).
- **Satisfaction inference:** precision of proposed closures (accept rate) in suggest-mode; only promote to auto-close when precision clears the Q2 bar. Post-auto, false-close (reopen) rate stays below threshold.

---

## Review & Acceptance Checklist

- [x] Title is concrete (not "improve X")
- [x] All user stories follow the As/I want/so that format
- [x] Every user story has ≥ 1 acceptance criterion
- [x] Acceptance criteria are observable from outside the code
- [x] "Out of scope" section is non-empty
- [x] At least one open question is listed
- [x] No tech-stack / file-path / schema-column decisions leaked into the spec (kept to behavior; data-model split referenced as a decision, not a schema)
- [x] Constitutional gates and design principles are cited
- [x] Success metrics are concrete and measurable
- [x] Rollout / reversibility plan is stated

## Sign-off

- [x] Author (Claude, on Eric's behalf)
- [x] Board reviewer — Eric + Dustin, 2026-06-14 (Q1/Q2/Q3 decided; ADR-020 accepted). Q4/Q5/Q6 tracked on the Linear issues.
- [ ] Engineering reviewer
