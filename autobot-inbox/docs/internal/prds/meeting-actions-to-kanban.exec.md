# Meeting Actions → Kanban (Executive Brief)

**One-liner:** Every action item and decision we surface from a meeting lands
on a board with a known owner, due date, and priority — already filled in.
Humans confirm with one tap, not a form.

**Status:** Proposal · **Owner:** Isaias · **Date:** 2026-05-14

---

## The Problem in One Paragraph

We already extract action items, decisions, and requests from every voice
memo, tl;dv recording, and Gemini Meet transcript. Today they sit on the
meeting page and decay — there's no place to *do* anything with them. Worse,
half of them aren't even ours (vendors, prospects, friends). We need a kanban
that shows only the work we actually own, with the boring fields already
guessed, so the board's job is to confirm — not to type.

---

## What Changes for the User

### The board sees a kanban populated *for* them, not by them

Every meeting now produces task cards. Each card arrives with:

- **A clear title** (one short sentence, in the voice of an instruction)
- **An owner**, when we can tell who said they'd do it
- **A due date**, when one was mentioned
- **A priority** (urgent / high / normal / low)
- **A size** (quick / small / medium / large)
- **A "next step" hint** — the literal first thing to do
- **A receipt** — the exact quote from the transcript, one click away

If a field isn't obvious, we leave it blank and *ask* — never guess.

### Cards are tapped, not edited

Every card has four buttons. That is the entire interaction model.

| Tap | Meaning | Sends us |
|-----|---------|----------|
| **Done** | I did it | "Your guesses were good" |
| **Skip** | I see it, I'm not acting | "Right item, wrong moment" |
| **Later** | Snooze it (today / this week / next week) | "Right item, wrong priority" |
| **Not for me** | This wasn't ours | "Your relevance was wrong" |

Every tap is a training signal. The kanban gets smarter every week without
anyone "training" it.

### When something is missing, we ask exactly one question

If the AI is unsure of one thing — say, who owns the task — the card shows a
single question with three buttons:

> *Who owns this?*  
> **[ Eric ]   [ Isaias ]   [ Dustin ]   [ Other contact… ]**

No forms. No modals. One field, one answer, one tap. The card commits the
answer and that question disappears.

### Things that don't belong never reach the board

Action items from external speakers, vendor commitments, friend chatter —
filtered out before they hit the kanban. They're not lost: the meeting page
shows "12 actions filtered out — expand to review." But the board only sees
work it could plausibly own.

### The board never has to *hunt* for what needs them

A card that's been quiet too long, has no owner, is urgent, or is due soon
floats up into a "Needs you" lane on its own. The thresholds are
configurable. The board reacts; it doesn't audit.

### Telling human work apart from agent work

The board shows both human tasks (this proposal) and agent tasks (already
live today) on the same kanban. Two glanceable distinctions:

- **The assignee chip on every card** — initials for humans (`EG`, `IV`,
  `DP`), agent glyph for bots (`⌬ architect`). One look tells you who owns
  it.
- **A subtle left-border color** — warm for human-owned, cool for
  agent-owned. Reuses our existing color language.

At the top of the board, a one-tap filter:

> **[ Mine ]   [ Humans ]   [ Agents ]   [ All ]**

Default view is `Humans` for board members. `Mine` shows only cards
assigned to you. The choice persists. Filters change *which cards are
shown*, never *which lanes exist* — the structure stays predictable.

---

## What This Replaces

| Today | After this |
|-------|-----------|
| Meeting actions sit in a snippet card on `/meetings`, get forgotten | They land on a board with an owner and a due date |
| If someone wants to track a follow-up, they paste it into Linear/Notes manually | The pipeline does it; the board confirms |
| Vendor and friend action items pollute the same surface as ours | A relevance gate filters before anything reaches the board |
| Asking the board to fill a 7-field form ends in zero engagement | One question, one tap |

---

## Out of Scope (on Purpose)

- **AI doing the tasks.** This release tracks human follow-ups. Automation
  comes after we've collected enough Done/Skip data to know what's worth
  automating.
- **Two-way Linear sync.** Designed for in the schema; built in a later
  phase. The same task table will sync to Linear without redesign.
- **Decisions as work.** A decision is a *record*, not a follow-up. We log
  them in a separate "Decisions" lane (already-done from creation). If a
  decision needs propagation, the board promotes it manually.

---

## Success in 30 Days

- Every action item from every meeting either becomes a card or is visibly
  filtered (no silent drops).
- Median time from meeting end to board taking *any* action on a card is
  under 24 hours.
- "Not for me" rate on auto-promoted cards drops below 20% in the first two
  weeks (calibration loop), under 10% by week four.
- Zero cards reach the board with *every* field blank. At least one field
  is always autofilled.

---

## Risks Worth Naming

| Risk | What we do about it |
|------|---------------------|
| The board sees too much noise and ignores the kanban | Conservative relevance defaults; weekly "skipped vs accepted" calibration report; per-meeting summary of what was filtered |
| The board doesn't trust the AI guesses | Every card shows a confidence indicator; the original transcript quote is one click away; editing a guess is itself a training signal |
| The four-tap UX feels mechanical | Capped at one inline question per card; never blocks the card; can always defer answering |

---

## The Build (Headline Only)

Four weeks, single feature flag, ~1,300 lines of code.

- **Week 1** — pipeline + storage
- **Week 2** — AI field-filling + API
- **Week 3** — kanban UI on the existing `/board` page
- **Week 4** — feedback loop polish + calibration tooling

No new services, no new infrastructure, no new dependencies.

---

## How the Magic Works (Technical Appendix)

For executives who have time, or in case it comes up in the room.

### The pipeline (3 stages, all already-running infra)

1. **Extract** — every transcript already runs through a meeting-aware
   classifier (tl;dv, Gemini Meet, voice memos all share one path). It
   produces structured signals: action items, commitments, decisions,
   requests, info. This stage is unchanged.
2. **Filter (the relevance gate)** — a small, cheap classifier scores each
   signal 0.0–1.0 based on: *is the obligor someone we know?*, *was the
   speaker someone we know?*, *does the topic match an active project?*,
   plus a low-weight LLM tiebreaker. Score ≥0.6 → board. 0.3–0.6 → board
   with a "Is this ours?" question. <0.3 → meeting page only.
3. **Enrich** — one batched language-model call per surviving signal fills
   the autofill fields (owner, size, priority, next-step hint, tags) in a
   single round-trip. Roughly 1¢ per meeting at current usage.

### Why a new task table, not the agent task graph?

The agent task graph (`work_items`) is built for *agent* work — its assignee
field references agent identities, its status set encodes runtime concerns
(retry counts, timeouts, quarantine). Human tasks belong to humans and have
a different lifecycle (Skip, Later, Not-for-me — concepts no agent has).
The two coexist on the same `/board` page but are distinct rows in distinct
tables, joined at the API layer.

### Why the four-button feedback model is the real product

The kanban is the surface, but the *value* is the feedback loop. Every tap
produces a labeled training row: was the AI right about owner? priority?
relevance? After ~100 entries the system can re-tune its own weights. After
~1,000 entries the relevance gate becomes our highest-quality signal for
which meetings deserve attention at all. The kanban is a Trojan horse for
a relevance model.

### Forward-compatible with Linear

The task schema already includes Linear ID, URL, and last-synced fields.
They're unused today. When two-way sync ships in a later phase, no migration
is needed — just the sync worker.

### Boring infrastructure

Postgres table, two indexes, one trigger. No queue, no new service. Fits
the existing pattern: extract → store → surface → feedback. P4 of the
constitution: novelty is for the org model, not the plumbing.
