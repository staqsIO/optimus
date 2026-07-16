# PRD: Meeting Actions → Human Kanban

**Status:** Draft v0.2
**Owner:** Isaias
**Date:** 2026-05-14 (revised post-`main` sync)
**Branch:** `main` — kanban surface (`/board`, `lanes.js`) already shipped on main; this PRD lights it up with meeting-derived human tasks.

**Related docs (pre-existing on main):**

- `.docs/signal-pipeline-architecture.md` — 2-stage signal model: `inbox.signals` is the *processed extraction* layer written by `executor-triage`. This PRD's pipeline is a Stage-2-sibling: extraction → promotion → human_tasks. We do not introduce a new ingestion path; we read from `inbox.signals`.
- `engagements/` (migrations 115–116, `lib/engagements/`, `/board/src/app/engagements/`) — *client project scoping* concept. **Not** meeting-task tracking. Disambiguation: human_tasks may optionally carry an `engagement_id` for project context, but they are not stored inside the engagements schema.

---

## 1. Problem Statement

The meeting pipeline (voice memos, tl;dv, Gemini Meet) already extracts
structured signals — `action_item`, `commitment`, `decision`, `request`, `info` —
into `inbox.signals` (see `lib/adapters/meeting-prompt.js`). Those signals
*surface* on `/meetings`, but they don't *go anywhere*. A real follow-up
("Eric to update the Jetson setup next sprint") sits in a snippet card and
decays.

Two concrete problems today:

1. **Relevance is missing.** Meetings happen with vendors, prospects, friends.
   Half the extracted action items are not work that anyone in Optimus is
   actually going to do. The pipeline classifies *what* a signal is, never
   *whether it's ours*.
2. **There's no place to land.** `agent_graph.work_items` is the agent task
   DAG — its `assigned_to` references `agent_configs(id)`, not a human contact.
   The kanban at `/board` shows action_proposals and needs_attention, not
   meeting-derived human tasks.

### What Success Looks Like

- An action item that mentions a board member or a tracked contact lands on
  the human kanban with status, owner, priority, and due date — autofilled.
- Items that aren't ours never reach the board (visibly logged in `/meetings`,
  collapsed to "Not for us").
- When the AI is unsure of *one specific field*, the board sees a single
  inline question ("Who owns this?" with 3 buttons) — never a form.
- Skip / Later / Done / Not for me become first-class feedback that retrains
  relevance and field-guess models over time.

---

## 2. Users

### Primary: Board (Dustin, Eric, Isaias)
They run meetings. They want commitments tracked without spending 10 minutes
filling out a task form per meeting. They will *accept or correct* AI guesses
— they will not author tasks from scratch.

### Secondary: Strategist agent (Phase 2)
Once the kanban has a steady stream of human tasks with skip/done feedback,
Strategist gets a labeled dataset for priority and assignee inference — and
later for *suggesting* the next move on stalled cards.

### Non-User: Executor agents
This kanban is for **human-owned** work. Executor tasks remain in
`agent_graph.work_items`. The two task surfaces live next to each other on
`/board` but are distinct rows in distinct tables.

---

## 3. Scope

### In Scope (this PRD)

- New table `inbox.human_tasks` (name TBD — `signal_tasks`?) — human-owned task
  cards, separate from `agent_graph.work_items`. See §5 for schema.
- Signal-to-task pipeline: when `inbox.signals` rows of type
  `action_item | commitment | decision | request` are created from a meeting,
  a relevance gate runs; passing signals promote to `human_tasks`.
- AI autofill for: assignee, due date, priority, size, project/area, type,
  next action hint, confidence. See §6.
- Kanban UI on `/board` (existing route) gains a "Tasks" data source alongside
  proposals and needs_attention. Card actions: **Done · Skip · Later · Not for me**
  (the four-button feedback model the user described).
- Inline single-field questions on cards that need exactly one piece of
  information ("Who owns this?", "When?"). One question, 3-4 button options,
  free-text fallback.
- Human-feedback triggers (§7) — when to push a card into the "Needs you"
  lane regardless of column.
- Forward-compatibility for Linear two-way sync (§9). Store IDs now, sync
  later.

### Out of Scope (this PRD)

- Linear sync itself. We design for it; we don't build it.
- LLM-driven *execution* of tasks (the "automated actions" the user mentioned
  for later). We collect skip/done feedback; we don't yet act.
- Bulk editing UI, swimlanes, calendar views, mobile.
- Cross-meeting consolidation ("you keep saying you'll do X, here are all the
  times you said it") — interesting but separate.

### Explicitly Deferred

- **Decisions as tasks.** A decision is a *record*, not work — unless the
  decision implies follow-up communication. v0.1 stores decisions as a
  separate "Decisions" lane (terminal/done from day one); a decision can spawn
  a child task only via explicit board action. Revisit when usage shows the
  ratio.
- **Info signals.** Never become tasks. Stay attached to the meeting record;
  feed the RAG. Out of scope here entirely.

---

## 4. The "Is this ours?" Relevance Gate

The single highest-leverage piece of this PRD. Cheap to get wrong, expensive
in board-attention if we promote 30 vendor action items per week.

### Decision: gate with a small classifier, not promote-then-filter.

Three signals combine into a `relevance` score 0.0–1.0:

| Signal | Weight | Source |
|--------|-------:|--------|
| Obligor matches a known person (board member, tracked contact, our team) | 0.5 | `inbox.contacts`, `agent_graph.board_members`, name resolution from meeting-prompt |
| Speaker is a known person (i.e. this was *our* meeting, not a shared recording) | 0.2 | Same as above |
| Domain matches an Optimus project/product | 0.2 | `agent_graph.projects` + meeting `domain` field already on signals |
| LLM relevance classifier ("would this go on Optimus's todo list?") | 0.1 tiebreak | Cheap Haiku call on the signal content + obligor + speakers |

Thresholds:

- `>= 0.6` → auto-promote to `human_tasks` in column `inbox`.
- `0.3 – 0.6` → promote to `human_tasks` but column `proposed` (shows a
  single inline question: "Is this ours?" → Yes / No / Defer).
- `< 0.3` → do **not** promote. Log on the signal as `relevance_skipped`
  with the score, so `/meetings` can show "12 actions filtered out" with an
  expand affordance.

**Why a gate vs. a flag:** Promote-then-filter clogs the board. The board
should only show what we plausibly own. Filtered-out signals stay queryable
on the meeting itself — nothing is *lost*, just not *fronted*.

**Calibration plan:** Land the weights above as defaults. Every Skip /
Not-for-me action logs (signal, score, was_promoted, reason). Re-tune
monthly until skip rate < 10% in the auto-promote bucket.

---

## 5. Schema

New migration `117-human-tasks.sql` (current head is 116). New table —
`inbox.human_tasks`:

```sql
CREATE TABLE inbox.human_tasks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Provenance (the audit trail back to the meeting)
  signal_id       TEXT REFERENCES inbox.signals(id) ON DELETE SET NULL,
  message_id      TEXT,                              -- meeting message
  source_quote    TEXT,                              -- exact verbatim from transcript
  source_ts       TEXT,                              -- "[MM:SS]" timestamp in transcript

  -- Content (user's requested fields)
  title           TEXT NOT NULL,
  description     TEXT,
  due_date        DATE,
  priority        TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent','high','normal','low')),
  size            TEXT
    CHECK (size IS NULL OR size IN ('quick','small','medium','large')),

  -- Assignment — humans, not agents
  assignee_contact_id  TEXT,                         -- FK conceptually to inbox.contacts(id)
  assignee_label       TEXT,                         -- display label if unresolved
  assignee_confidence  NUMERIC(3,2),                 -- 0.00–1.00

  -- Kanban state
  status          TEXT NOT NULL DEFAULT 'inbox'
    CHECK (status IN (
      'inbox',          -- just promoted, awaiting board glance
      'proposed',       -- AI relevance unsure; awaiting "is this ours?"
      'todo',           -- accepted, ready to start
      'in_progress',
      'blocked',
      'later',          -- snoozed (with snoozed_until)
      'review',
      'done',
      'skipped',        -- terminal; "I'm not doing this" (not a quality verdict)
      'not_for_us'      -- terminal; relevance feedback
    )),
  snoozed_until   TIMESTAMPTZ,

  -- AI-autofilled enrichment (see §6)
  task_type       TEXT
    CHECK (task_type IS NULL OR task_type IN ('action','decision_followup','request','blocker')),
  project_id      TEXT,                              -- agent_graph.projects(id) logically
  engagement_id   UUID,                              -- engagements.engagements(id) logically; optional client-project scope
  tags            TEXT[] NOT NULL DEFAULT '{}',
  next_action_hint TEXT,                             -- "Send draft email to X", "Create Linear ticket"
  related_contact_ids TEXT[] NOT NULL DEFAULT '{}',

  -- Confidence + relevance trail
  relevance_score    NUMERIC(3,2),
  extraction_confidence NUMERIC(3,2),

  -- Feedback (powers retraining + the four-button UX)
  last_feedback      TEXT
    CHECK (last_feedback IS NULL OR last_feedback IN ('done','skip','later','not_for_me','edited')),
  last_feedback_at   TIMESTAMPTZ,
  feedback_history   JSONB NOT NULL DEFAULT '[]',    -- append-only

  -- Linear two-way sync (designed now, used later)
  linear_issue_id    TEXT,
  linear_issue_url   TEXT,
  linear_synced_at   TIMESTAMPTZ,

  -- Generic
  created_by      TEXT NOT NULL DEFAULT 'meeting_pipeline',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX human_tasks_by_status_priority
  ON inbox.human_tasks (status, priority, due_date NULLS LAST)
  WHERE deleted_at IS NULL;
CREATE INDEX human_tasks_by_assignee
  ON inbox.human_tasks (assignee_contact_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX human_tasks_by_signal
  ON inbox.human_tasks (signal_id);
```

**Why a new table, not `agent_graph.work_items`?**

- `assigned_to` on work_items FKs `agent_configs(id)` — it can't hold a contact.
- The work_items status set encodes agent-runtime concepts (`timed_out`,
  `output_quarantined`, `retry_count`). Human kanban states are different.
- Per SPEC §12: schemas are isolated. Human tasks are inbox-domain (extracted
  from messages); agent tasks are agent_graph-domain (assigned to agents).
  Cross-schema reads are fine when we want a unified board view — joins
  happen at the API layer.

**Why not extend `inbox.signals`?** Signals are *what was said*; tasks are
*what we're doing about it*. Conflating them means a skipped task and an
unresolved signal share a row, and the relevance feedback corrupts the
extraction record. Two tables, FK between them.

---

## 6. AI-Autofilled Fields

The user asked: beyond status / name / description / due date / assignee /
priority / size, what else should AI fill so the human just confirms?

Recommended autofill set, ordered by value-per-board-second:

| Field | Why | How |
|-------|-----|-----|
| **`source_quote` + `source_ts`** | Trust. The board can verify the extraction in one click instead of re-listening. | Already in transcript; lift verbatim during signal extraction. |
| **`assignee_contact_id`** + `assignee_confidence` | Most expensive field for a human to set. | Match obligor name against `inbox.contacts` + `agent_graph.board_members`. If multi-match or no-match → leave NULL, show "Who owns this?" inline question. |
| **`task_type`** | Drives lane placement and lets us separate decisions from actions. | LLM already classifies signal type — map 1:1. |
| **`project_id`** | Lets the board filter by initiative ("just show me StaqsPro work"). | LLM call with the list of active projects as context; pick one or NULL. |
| **`priority`** | Skipping this default-to-`normal` and only setting `urgent` when warranted is more useful than guessing. | Heuristic: explicit urgency words + due_date proximity + speaker is exec → `urgent`. Otherwise `normal`. |
| **`size`** | The number the board most often *doesn't bother filling*. AI doing it = pure win even if rough. | LLM micro-call: "quick (<30min), small (<2h), medium (half day), large (multi-day)". Mediocre accuracy is fine. |
| **`due_date`** | Already extracted as `deadline` signal when stated. | Lift from sibling signal; otherwise NULL. Don't invent. Calendar context (migrations 113/114 `calendar_events`) resolves relative dates ("by Friday" → meeting was Tuesday → this Friday). |
| **`next_action_hint`** | Reduces "I picked this up but what was I supposed to do?" friction. Massive ergonomic win. | LLM: "What is the literal first concrete step?" — 1 line. |
| **`tags`** | Lightweight grouping without a project. | LLM: 0–3 short lowercase tags. Keep vocabulary uncontrolled v0.1; cluster later. |
| **`related_contact_ids`** | "This decision affects the Acme deal — link the deal page." | Entity-resolution pass on transcript (you already have `inbox.contacts` resolution from 009/018/081). |
| **`extraction_confidence`** | Lets the UI dim low-confidence cards visually. | LLM self-rating, 0.0–1.0. |
| **`description`** | Should be 1–2 sentences of context, not a duplicate of `title`. | LLM: "what's the why, in one line". Distinct from `source_quote`. |

**Fields NOT autofilled (deliberate):**

- `status` — always starts `inbox` or `proposed`. Lifecycle is human-driven.
- `snoozed_until` — only set when the board picks "Later".

---

## 7. Quick Feedback UX

The user's core request: *one question at a time, not a form.* This is the
P6 (familiar interfaces for humans) instantiation for the kanban.

### The four card actions

Every card shows: **Done · Skip · Later · Not for me**. These are not just
state transitions — each is a labeled training signal.

| Action | State change | Training signal |
|--------|--------------|-----------------|
| **Done** | → `done` | extraction quality + relevance both correct |
| **Skip** | → `skipped` | "I see it, I'm not acting" — relevance OK, not actionable now |
| **Later** | → `later` (asks: today / this week / next week / pick) | priority guess was too high |
| **Not for me** | → `not_for_us` | **relevance** was wrong — retrains the gate |

Per-action snippet is optional free text (matches the existing
`needs_attention_log.acknowledgment_reason` precedent from migration 111).

### Inline single-field questions

When the card is missing exactly one high-value field, the card body shows a
single inline question with 3–4 buttons + free-text fallback. Examples:

- *Who owns this?* → `[Eric] [Isaias] [Dustin] [Other contact…]`
- *When?* → `[Today] [This week] [Next week] [No deadline] [Custom…]`
- *How big?* → `[Quick] [Small] [Medium] [Large]`
- *Is this ours?* (relevance gate at 0.3–0.6 only) → `[Yes] [No] [Defer]`

Rule: **at most one inline question per card at a time.** If two fields are
missing, ask the higher-leverage one first (assignee > due > size).

### Why this UX

Forms collapse engagement to zero — we've seen that in `/today` and
`/inbox`. Single-tap actions on the same surface as the content stay above
the friction floor.

### Telling agent cards apart from human cards

The `/board` surface shows three kinds of work today (proposals, attention,
agent work_items) and we're adding a fourth (human_tasks). The board needs
to glance at any card and know who owns it without reading.

**Identification — assignee chip + left-border accent.**

- Top-left of every card: a fixed-position **assignee chip**.
  - Human: colored initials circle (`EG`, `IV`, `DP`) or contact avatar —
    warm tone palette.
  - Agent: monogram glyph + short agent slug (`⌬ architect`,
    `⌬ executor-code`) — cool tone palette.
  - Unassigned human: dashed `?` circle, amber-tinted (always paired with
    the "Who owns this?" inline question).
- 2px left-border accent on the card — amber for human-owned, blue for
  agent-owned. Reuses the existing `emphasis: 'human'` convention from
  the current `/board` page so it feels native.
- No `HUMAN`/`AGENT` text badges — the avatar carries the signal.

**Filter — top-of-board segmented control.**

```
[ Mine ]   [ Humans ]   [ Agents ]   [ All ]
  3          12           47          62
```

- Default = `Humans` for logged-in board members (matches the surface
  this PRD lights up). Default = `All` for staff/admin views.
- `Mine` = human cards assigned to the logged-in board member.
- Counts update live as cards move.
- Selection persists in URL (`?view=humans`) and localStorage — shareable
  filtered views, sticky across sessions.
- Filters affect *population*, not *columns*. Same lanes either way.
  Empty lanes show "Empty" as today.

**Why not separate swimlanes (humans top, agents bottom)?** Doubles the
vertical scroll, halves per-card real estate, and forces a layout the
board navigates even when they only care about one type. The segmented
control gives the same separation with one tap and no layout cost.

---

## 8. Human-Feedback Triggers

When a card is "Needs you" — moves into the amber lane on `/board`,
independent of its column. All thresholds are configurable in
`config/board.json` (or wherever; out of scope to design now):

| Trigger | Default | Rationale |
|---------|--------:|-----------|
| Stalled in current state | 7 days | "Stuck" deserves a poke. Per-state overrides: `proposed` → 2 days, `in_progress` → 5 days. |
| No assignee | 24 hours after creation | Either an assignee or an active "Who owns this?" inline question — never silent. |
| Priority = urgent | immediately | Urgent cards never sit in `inbox`. |
| Due date approaching | 3 days out | Configurable per-priority (urgent: 5 days, low: 1 day). |
| AI extraction confidence < 0.5 | immediately | Promote the inline "Is this right?" question instead of trusting the autofill. |
| Speaker said "you" without naming a person | immediately | Almost always an unresolved assignment — ask once. |

All triggers feed a single computed column on `/board` API responses:
`needs_human: { trigger: '...', since: timestamp, hint: '...' }`. UI just
renders that.

---

## 9. Linear Sync (Forward Compatibility)

Not built in v0.1. Designed for, so we don't repaint later.

- Schema already has `linear_issue_id`, `linear_issue_url`, `linear_synced_at`.
- Phase 1 (this PRD): NULL on every row. No sync.
- Phase 2 (later PRD): bidirectional sync via Linear MCP — `human_tasks.id`
  ↔ `linear_issue_id`. Conflict resolution: last-write-wins per field,
  except `status` which uses Linear when present (Linear has more granular
  workflows).
- Sync direction *write-to-Linear* is the easier half; we can ship that
  first.

---

## 10. Build Plan

### 10.1 Sequencing

```
Week 1 — Pipeline + schema
  1. Migration 117-human-tasks.sql (Postgres table + indexes)
  2. Signal-to-task promoter in lib/runtime/ — triggered by inbox.signals
     INSERT, runs the relevance gate, writes human_tasks rows
  3. Relevance gate v0: rule-based scoring (no LLM call yet)
  4. Backfill script: re-run on existing meeting signals to seed the board

Week 2 — Autofill + API
  5. AI enrichment pass: assignee resolution, task_type, size, next_action_hint
     (one combined Haiku call per task)
  6. /api/human-tasks endpoints (list, update status, record feedback)
  7. needs_human computed column

Week 3 — Board UI
  8. /board page: add "Tasks" data source to computeLanes()
  9. Card component: four-button action row + state transitions
  10. Inline question component (single field, 3-4 button options + free text)

Week 4 — Feedback loop + polish
  11. feedback_history persistence + analytics view
  12. Relevance calibration: weekly report of skip rate per bucket
  13. Empty state, animations, keyboard shortcuts (j/k/done/skip)
```

### 10.2 LOC Budget

| Component | LOC | Notes |
|-----------|----:|-------|
| Migration | ~80 | Table + indexes + comments |
| Promoter (relevance gate + insert) | ~200 | lib/runtime/signal-task-promoter.js |
| Autofill enrichment | ~150 | Single LLM call, structured output |
| API routes | ~180 | List + update + feedback |
| Kanban card + actions UI | ~250 | React, extends existing /board page |
| Inline question component | ~120 | Reusable across card variants |
| Tests | ~300 | Promoter logic, gate calibration, API |
| **Total** | **~1280** | |

---

## 11. Integration Points

### 11.1 Upstream

- `lib/adapters/meeting-prompt.js` — no changes; signals it emits already
  carry everything we need. We may add a `source_quote` and `source_ts`
  field to the signal schema to lift the verbatim cleanly (one-line prompt
  change).
- `inbox.signals` — per `.docs/signal-pipeline-architecture.md`, this is
  the *processed extraction* table (written by `executor-triage`, Stage 2
  of the 2-stage model). Our promoter is a Stage-2-sibling: it watches
  for INSERT of `action_item | commitment | request` signals on meeting
  messages and writes `inbox.human_tasks` rows. **No new ingestion path
  is introduced** — we consume the existing extraction stream.

### 11.2 Downstream

- `/board` route shipped on `main`. `lanes.js` defines a fixed
  agent-shaped lane set per ADR-003:
  `needs_you · created · assigned · in_progress · review · completed`.
  Human-task statuses *map onto* this lane contract — we do NOT add new
  lane ids. ADR-003 is the route contract; changing it breaks the
  /board API shape.

  Mapping (human_tasks.status → lane):
  | human_tasks.status | Lane |
  |---|---|
  | `inbox`, `proposed` (low-confidence or unassigned) | `needs_you` |
  | `inbox` (autofilled, awaiting glance) | `created` |
  | `todo`, `later` | `assigned` |
  | `in_progress`, `blocked` | `in_progress` |
  | `review` | `review` |
  | `done` | `completed` |
  | `skipped`, `not_for_us` | filtered out of board (queryable on `/meetings`) |

  The kind discriminator (`card.kind = 'human_task'` alongside existing
  `work_item / proposal / attention`) is what drives the visual
  identification described in §7. Filters (Mine / Humans / Agents / All)
  also act on `card.kind`, not on the lane.

- `/meetings` page gets two new affordances: "X actions promoted to board",
  "Y actions filtered out (expand)".

### 11.3 Future (out of scope, designed for)

- Linear MCP server (`mcp__claude_ai_Linear`) — already available in this
  workspace. Phase 2 PRD.
- Strategist agent — once `feedback_history` has 100+ entries, it gets a
  labeled relevance/priority dataset.

---

## 12. Success Criteria

### v0.1 Exit Gate

- 100% of `action_item | commitment | request` signals from new meetings
  produce a row (promoted or `relevance_skipped`-logged).
- Median time-to-classification (board sees + takes any of the four actions)
  < 24 hours during the first calibration week.
- Skip rate (`skipped` + `not_for_us`) in the auto-promote bucket
  (`relevance >= 0.6`) < 20% after 2 weeks of feedback. < 10% after 4 weeks.
- Zero cards reach `inbox` column with all of {assignee, due, priority, size}
  un-set — at least one is always autofilled.
- No human-task row is *silently* stuck > 7 days (the trigger lane catches
  it).

---

## 13. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Relevance gate promotes noise → board ignores the kanban | High | High | Conservative defaults; per-meeting summary "X promoted, Y filtered" so board can audit; weekly calibration report. |
| AI autofill is wrong often enough that board distrusts it | Medium | High | Show `extraction_confidence`; never autofill `status`; "edit" feedback retrains; track edit-rate as a quality signal (mirrors M3/M4 from migration 093). |
| Decisions get treated as actionable and clutter the board | Medium | Medium | v0.1 explicit: decisions go to a `done`-from-creation Decisions lane unless the board promotes them. |
| Schema diverges from Linear data model → painful sync later | Medium | Medium | Use Linear's vocabulary where possible (priority levels, size = estimate). Phase 2 PRD reviews schema before sync build. |
| Inline question UX feels like a chore after the novelty | Low | Medium | Cap at one question per card; "skip the question" never penalized; can dismiss without answering. |

---

## 14. Open Questions

1. **Where do decisions live?** Same table with `task_type='decision_followup'`
   and `status='done'` on creation, or a separate `inbox.meeting_decisions`
   table? *Leaning same table, status=done, separate lane.*
2. **Multi-assignee?** "Eric and Isaias to review the deck." v0.1 picks
   primary obligor; v0.2 may need a `co_assignees TEXT[]`. *Leaning defer.*
3. **Subtasks?** Decompose "Daniel to fix voice assistant + redeploy"
   into two cards? *Leaning no — keep one card, use checkboxes inside
   description if the board wants subtasks.*
4. **Should the relevance gate be configurable per meeting source?**
   tl;dv meetings = high-relevance; Gemini Meet recordings shared by
   prospects = low-relevance default. *Probably yes, simple bias term
   per `webhook:<source>` label.*
5. **Snooze granularity.** Today / this week / next week — enough? Or
   pick-a-date always available? *Both: 3 buttons + custom.*
6. **Skip vs Not-for-me distinction.** Both terminal, both feedback. The
   board may not bother distinguishing. *Worth A/B-ing: collapse to one
   button "Pass" with optional reason, or keep two for cleaner training
   signal? Currently leaning two.*

---

## 15. Author's Thoughts (out-of-band)

Three things worth flagging before we build:

- **The relevance gate is the whole game.** Field autofill quality, UX
  polish, Linear sync — none of that matters if the board is shown 40
  vendor action items per week. Spend disproportionately on the gate's
  calibration loop (the weekly skip-rate report is not optional).
- **The schema separation (human_tasks vs work_items) feels right but is a
  bet.** It costs one join when we want a unified "everything Optimus is
  doing" view. The alternative — overloading work_items with an
  `assigned_contact_id` column — would couple human kanban state to agent
  runtime state forever. Two tables, FK at the meeting layer, joined at
  the API.
- **The four-button card + single inline question is the actual product.**
  Everything else is plumbing. If we ship a beautiful pipeline and a
  five-field edit form, the board uses it for two days and stops. The
  feedback signal we care about — "this guess was right / wrong" — only
  exists if every interaction is one tap.
