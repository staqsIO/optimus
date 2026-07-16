---
title: Meeting Actions → Linear (v0.2 — Linear-first)
status: Draft
owner: Isaias
date: 2026-05-20
supersedes: meeting-actions-to-kanban.md (v0.1)
related: meeting-actions-to-kanban-v0.2-tech-spec.md
---

# PRD: Meeting Actions → Linear (v0.2)

## 0. Why this rewrite

v0.1 shipped a custom `/board` kanban for meeting-derived human tasks. After a week of dogfooding it's clear the surface fights the team:

- Board members already live in **Linear**. Asking them to learn `/board` doubles their daily kanban surface.
- The custom card has fewer affordances than Linear (no comments, no relationships, no embedded files, no mobile app, no notifications).
- The value Optimus needs to deliver isn't "another kanban" — it's **routing the right meeting follow-ups into the tool you already use**, and **knowing when the human is done so the agent can pick up next steps**.

v0.2 pivots: Linear becomes the primary human surface. Optimus pushes promoted tasks into Linear with the LLM picking every field, and pulls Linear changes so the rest of the agent organisation knows the human's state. `/board` stays as a thin operator console for the relevance gate ("Is this ours?") and for tasks Optimus has chosen not to push.

## 1. The four value statements

1. **Easy to use** — Linear is already used by the board. Zero new UI to learn for tasks once they're synced.
2. **Push tasks to Linear** — when a meeting signal becomes a human task, the LLM chooses status, project, title, description, assignee, labels, and priority, and creates the issue in Linear.
3. **Pull state from Linear** — when a board member moves the issue, closes it, or signals "ready for Optimus", the rest of the agent organisation hears about it.
4. **Guardrail prompt** — the board can write plain-English rules that constrain LLM decisions (when to push to triage vs. in-progress, who to assign by default, what to never assign, etc.). The LLM consults the guardrail before deciding.

## 2. Users

- **Board members (Dustin, Eric, Isaias).** Live in Linear. After v0.2 they should only open `/board` for proposed-band cards ("Is this ours?") and for governance review.
- **Strategist agent (Phase 2).** Reads pulled state to drive priority recommendations.
- **Executor agents.** Read pulled "ready for Optimus" signals to pick up follow-up work (e.g. draft a doc, schedule a meeting, create a sub-ticket).

## 3. Surfaces

| Page | Today | After v0.2 |
|------|-------|-----------|
| **Linear** (external) | Used for engineering tickets | Becomes the primary surface for **all** meeting-derived human tasks |
| `/board` | Six-lane custom kanban with full task lifecycle | Trimmed to two roles: (a) the "Is this ours?" proposed-band, (b) read-only mirror of Linear-synced tasks for governance audit |
| `/today` | Meetings + morning brief + mentions + obligations | Adds "Today in Linear" section pulled from Linear (issues assigned to me, in active states) |
| **Settings** (new, or extension of `/governance`) | n/a | Adds **Guardrail Prompt** editor and **Linear Mapping** section |
| `/meetings` | Signals snippets | Each meeting card shows "N tasks → Linear" with deep-links to the created issues |

## 4. Push to Linear — the LLM picks everything

When a signal clears the relevance gate (score ≥ 0.6, or operator answers "yes" on a proposed-band card), Optimus runs a **push enrichment** LLM call. The call's job: produce a complete Linear issue payload, ready to create.

### What the LLM decides

- **Title** — concise (≤ 80 chars), action-oriented, no transcript jargon.
- **Description** — Markdown body with: 1–2 sentence context, the source quote with timestamp, a deep-link back to the meeting, who said it, the next-action hint, and a footer line "Created by Optimus from meeting <id>".
- **Project** — picks from the team's Linear projects (active only). The LLM receives the project list and short descriptions and selects one or null.
- **Assignee** — picks from the team's Linear members. Resolves spoken names ("Eric to do…") to Linear user ids. If the assignee is ambiguous or external, the LLM picks the speaker as fallback or leaves it null with a comment explaining why.
- **State (status)** — picks from the team's workflow states: `Backlog`, `Triage`, `Todo`, `In Progress`, etc. Default mapping:
  - Clear, owned, ready-to-start → `Todo`
  - Ambiguous, needs human glance → `Triage`
  - Already underway in the conversation ("I'm working on this") → `In Progress`
  - Decision recorded in the meeting, not a follow-up → `Done` (closed at creation)
  - Low-confidence relevance band (proposed) → `Triage` with the relevance question in the description
- **Priority** — Linear's 0–4 scale, mapped from the meeting signal urgency.
- **Labels** — picks from the team's existing label set (the LLM does not invent new labels). At minimum applies the `optimus` label so the team can filter "what did the agent push".
- **Due date** — only if the meeting transcript explicitly committed to one.

### The guardrail prompt

Before every push, the LLM receives the **board's guardrail prompt** (configured in Settings, see §6) prepended to the system prompt. The guardrail can say things like:

- "Never assign issues to external contacts. If the obligor is external, assign to whoever invited them."
- "If the project is StaqsPro and the assignee is Eric, default state to In Progress."
- "Vendor-related tasks always go to the 'Vendor follow-ups' project."
- "If the source quote contains a dollar amount, mark priority Urgent."

The guardrail is plain English. No DSL. The LLM is responsible for following it. If it can't follow a rule, it writes a comment on the created issue explaining why.

### Push outcomes

The push either:
- **Succeeds** — Linear returns an issue id and URL. Optimus writes those onto `inbox.human_tasks.linear_issue_id`, `linear_issue_url`, `linear_synced_at`. The `/board` card now shows a Linear chip with the issue identifier and a click-through.
- **Skipped** — the LLM decided the task isn't ready (e.g. truly ambiguous, missing critical context). Stays on `/board` in the proposed band with a one-line "Not pushed because: …" reason. The operator can manually trigger push from the card.
- **Fails** — network/Linear error. Retried with exponential backoff up to 3 times, then surfaced on `/board` with an error chip the operator can click to retry.

Push is **never blocking**. The card always appears on `/board` first; push happens out-of-band within 60 seconds.

## 5. Pull from Linear — the agent organisation hears the human

Optimus subscribes to Linear webhooks for the team. When the human acts in Linear, three events matter:

### 5.1 State transition

Any issue created by Optimus (carries the `optimus` label or `linear_issue_id` matches an `inbox.human_tasks` row) that moves between states triggers:

- The matching `human_tasks` row's `status` is updated to mirror the Linear state.
- `last_feedback` is appended (`linear_state_change` verb) with the new state, the actor, and the timestamp.
- If the new state is **terminal** (`Done`, `Canceled`, `Duplicate`), Optimus emits a `human_task.completed` event on `pg_notify`. Downstream agents can subscribe (e.g. the responder agent might draft a "thanks, got it" reply to the meeting attendee who requested the action).

### 5.2 "Ready for Optimus" signal

The board's bidirectional contract: when the human wants Optimus to take over, they have two equivalent ways to signal it:

- Move the issue to a Linear state mapped to "ready for Optimus" (configured in Settings, default = a custom state named `Ready for Optimus`).
- Comment on the issue with `@optimus` and any free-text instruction.

Either signal triggers Optimus to:
- Append the comment (or the state-change context) to the original meeting signal's processing queue.
- Wake the orchestrator agent with a "human input received" event.
- The orchestrator decides what to do next based on the issue body + the human's note (e.g. create a sub-task, draft an email, schedule a meeting).

### 5.3 Comments and edits

Any comment or field edit by the human is mirrored into `feedback_history` so Optimus's calibration loop sees it. The LLM's push-time decisions can be retuned weekly using this signal — if the human consistently changes the title after push, the title-generation prompt gets a correction nudge.

## 6. The Guardrail Prompt — operator-configurable LLM constraints

A new **Settings → LLM Guardrails** page (or panel inside the existing `/governance` route) exposes:

- **Push guardrail** — a free-text editor (Markdown supported). Limit ~2000 characters. Prepended to the push LLM's system prompt.
- **Pull guardrail** — same shape, for the pull-side LLM (which decides how to interpret `@optimus` comments and orchestrator wake-ups).
- **Mapping editor** — for each Linear workflow state, declare the corresponding `human_tasks.status` (`inbox`, `todo`, `in_progress`, `blocked`, `review`, `done`, `not_for_us`). Default mapping pre-filled from the team's workflow.
- **Ready-for-Optimus state** — dropdown to pick which Linear state means "ready for Optimus". Default = `Ready for Optimus` (created automatically if missing).
- **Default project / assignee fallbacks** — for when the LLM can't pick.

Every guardrail change is versioned (append-only) so the calibration loop can attribute behaviour shifts to specific prompt edits. A `?` icon shows recent examples of LLM decisions and lets the operator click "this was wrong" to feed correction examples into the next prompt revision.

The guardrail is also surfaced read-only on the bottom of every pushed Linear issue's description: "Pushed under guardrail revision #7" — so any board member can audit what rule the LLM was operating under when the issue was created.

## 7. What `/board` becomes — both surfaces in parallel

**Decision:** `/board` keeps full kanban functionality. Linear and `/board` operate as two equally-supported views on the same `inbox.human_tasks` rows. Board members pick whichever surface fits their workflow at any moment.

Why both: Linear is canonical for board members already deep in Linear; `/board` stays the right home for proposed-band gate decisions, for governance auditors who can't access Linear, and for any operator who prefers a tighter board+meeting context. Forcing one or the other would break someone's flow.

Inside `/board` everything from the original v0.2 plan still ships:

- **Six-lane kanban** with project chip, engagement chip, tags, needs-human banner on every card.
- **Lifecycle menu** on each card (Start, Block, Unblock, Send to review, Return to todo) — translates to Linear state changes via push.
- **Card-details panel** — opens on click; edits to title / description / due date / priority / size / tags / project / assignee push through to Linear.
- **Filters** — view (Mine/Humans/Agents/All) + project + size + signal-meeting.
- **Linear chip** on every pushed card with the issue id and a click-through to Linear.

The two surfaces share one canonical state: `inbox.human_tasks`. Edits made on either surface propagate to the other through the push/pull pipeline (see Tech Spec §6 for conflict resolution).

`/board` adds two Linear-specific affordances on top of the v0.1 lanes:

- **Proposed lane** — cards in the 0.3–0.6 relevance band wait for the operator to answer "Is this ours?". Yes → triggers push to Linear. No → terminal `not_for_us`.
- **Not-pushed bin** — cards where push failed or the push LLM declined. Operator can force-push or terminate.

## 8. What `/today` does

- "**My Tasks**" — fetched from `inbox.human_tasks` (which mirrors Linear after push). Renders the logged-in board member's active tasks. Each row carries the Linear chip and a click-through; edits go through the same push pipeline.
- "**Today in Linear**" — secondary section, pulled live from Linear via the existing client. Issues assigned to the operator that are not represented in `human_tasks` (i.e. not Optimus-originated). Read-only, links out only.
- "**Quick Wins**" — `size ∈ {quick, small}` from `human_tasks`. Mirrored to Linear with the `optimus-quick-win` label so the same view is recoverable in Linear.
- "**Proposed**" — badge counter linking to `/board?view=proposed` if there are uncleared proposed-band cards.

## 8b. Existing tasks — what happens on cutover

When v0.2 ships, the `inbox.human_tasks` table already holds rows from v0.1. None of them have a Linear issue. The integration handles them as follows:

- **No automatic push for existing rows.** They keep working on `/board` exactly as today. The two-tier trigger (auto ≥ 0.8, confirm 0.6–0.8) applies only to **new** tasks promoted after v0.2 is live.
- **Operator-driven backfill.** A new **Settings → Backfill to Linear** panel shows the existing rows broken down by status, relevance band, and age. The operator picks a filter (e.g. "active only · relevance ≥ 0.8 · last 30 days"), previews the rows that would push, then clicks **Push selected**. Selected rows enter the same push queue as new tasks; the same rate limiter applies.
- **Terminal rows stay local.** `done`, `skipped`, `not_for_us` rows never push, regardless of operator selection. The terminal verdict is the audit record; replaying it as a Linear issue would only add noise.
- **Re-runnable.** The operator can backfill in waves (e.g. "active first, then propose the rest tomorrow"). Each wave is one click.
- **Visible in feedback history.** Every backfilled row gets a `linear_push` entry tagged `backfill=true` so the calibration loop can separate backfill behaviour from steady-state.

Why operator-driven instead of auto-everything:

- A 200-row backlog landing in Linear in one batch burns rate budget and creates noise for whoever else is already in Linear.
- The two-tier rule was designed for the streaming case; applying it to old rows conflates "new, fresh" with "old, possibly stale".
- The operator knows which tasks are still alive; the system doesn't.

## 9. Out of Scope

- **Linear projects creation from Optimus** — Optimus picks existing projects only. Creating a new project is a human action.
- **Multi-team support** — v0.2 ships against a single `LINEAR_TEAM_ID`. Multi-team is v0.3.
- **Cycle / milestone assignment** — the LLM picks state, project, assignee, priority, labels. Cycle and milestone are deferred.
- **Re-push after edit** — once an issue is in Linear, the human owns it. Optimus does not re-push title/description changes back into Linear based on later signals. (It does append comments for clarification context.)
- **Comments from Optimus** — Optimus can write comments on issues it created (for context, for "couldn't follow guardrail rule X"), but does not respond to non-`@optimus` comments unless asked.

## 10. Open Questions

1. **Auto-push vs. confirm-push.** Should auto-promoted (relevance ≥ 0.6) tasks push to Linear immediately, or wait for one operator tap "send to Linear"? *Leaning auto-push for ≥ 0.8, confirm-push for 0.6–0.8.*
2. **What `optimus` label looks like.** Single label, or a label per task type (`optimus:action`, `optimus:decision`, `optimus:request`)? *Leaning single + task-type as sub-label.*
3. **How to handle Linear's projectless team.** Some teams don't use projects. *Leaning: leave project null, surface the gap in Settings.*
4. **Conflict resolution: human edits title while Optimus is mid-push retry.** Linear is source of truth; Optimus retries against the human's title.
5. **Where does the guardrail editor live — under `/governance`, under `/settings`, or as a top-level link?** *Leaning under `/governance` since it's a policy surface.*
6. **Per-meeting-source guardrail overrides.** Different rules for tl;dv vs. Gemini Meet? *Leaning defer to v0.3.*

## 11. Success Criteria

v0.2 exits when:

- **Push success rate ≥ 95%** over 100 promoted tasks (LLM produces a valid Linear payload that Linear accepts).
- **Pull latency ≤ 30 seconds P95** from human action in Linear to `human_tasks.status` reflecting the change.
- **Round-trip parity ≥ 98%** — a change made on `/board` lands in Linear within 30s P95 (and vice versa), with no observable state divergence after a 24h soak test.
- **Guardrail change → behaviour change** is observable: editing the guardrail to "vendor tasks go to the Vendor project" results in the next 5 vendor tasks landing there. If the LLM ignores the guardrail more than 20% of the time, prompt engineering rework is required before exit.
- **"Ready for Optimus" round-trip** is closed: 80% of issues moved to that state get an Optimus action within 5 minutes.
- **Both surfaces shipped without regression** — every v0.1 `/board` feature still works, plus the new Linear chip / lifecycle menu / details panel.

## 12. Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| LLM picks the wrong project / assignee → board distrusts the integration | High | High | Guardrail prompt is the steering wheel; show a `?` over every LLM decision; one-click "this was wrong" → correction example into next prompt. |
| Linear API rate limits hit during meeting backlog backfill | Medium | Medium | Queue pushes with concurrency = 4 and a token-bucket rate limiter. Replay-safe. |
| Webhook delivery flaps → state drifts | Medium | High | Periodic reconciliation job (every 10 min) compares `human_tasks.linear_issue_id` rows against Linear's GraphQL state for the team. Fills gaps. |
| Guardrail prompt becomes a 5000-word policy doc nobody can audit | Medium | Medium | Hard cap 2000 chars. Versioning + diff view. "Examples generated under this prompt" shown next to the editor. |
| Operator can't tell if `/board` proposed-band has new items because they're in Linear all day | High | Medium | Daily morning email digest of proposed-band counts. Slack DM if proposed > 10. |
| Two-way edits conflict (operator edits in Linear while Optimus is updating) | Medium | Medium | Linear is canonical. Optimus reads-before-write on every push retry; never overwrites a field changed by a human. |

## 13. Author's Thoughts

- **The Linear pivot is correct because the kanban was never the point.** The point was "meeting follow-ups don't decay". Pushing them into the tool the board already opens is a higher-leverage delivery mechanism than building a perfect custom kanban.
- **The guardrail prompt is the actual product.** Without it the integration is "Optimus dumps issues into Linear, board ignores them". With it, the board has a steering wheel that takes minutes to adjust and shifts agent behaviour immediately. The calibration loop runs on `feedback_history` + "this was wrong" clicks; weekly the guardrail gets a suggested revision the board can accept or reject.
- **The relevance gate stays the most expensive part of the system to get right.** Linear is loud — pushing 40 vendor action items per week makes the team turn off webhooks. Spend disproportionately on the gate's calibration, especially during the first month after v0.2 ships.
- **`/board` becomes a thin governance lens, not a workspace.** Don't add features there. If a board member asks for a feature on `/board`, ask if it should be on Linear instead — the answer is almost always yes.
