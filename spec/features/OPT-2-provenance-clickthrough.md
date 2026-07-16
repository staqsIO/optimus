# OPT-2 — M4 Board Provenance Click-Through

**Status:** DESIGN (ready to implement — frontend build next)
**Surface:** Board Workstation (`board/`, port 3200, board.staqs.io)
**Design principles:** P3 (transparency by structure), P6 (familiar interfaces for humans)
**Data already exists:** migrations 127 + 151 + 157 shipped provenance columns. No new migrations needed for the minimal slice.

---

## 1. The Provenance Graph

The meeting-to-work classifier (mig 151, `lib/runtime/meeting-classifier.js`) stamps provenance IDs through the entire chain. The full graph of linked entities:

```
calendar event (calendar_event_id)
        │
        ▼
   [meeting]  ─── source_meeting_id (stable identity key)
        │              agent_graph.signals.source_meeting_id
        │              inbox.human_tasks.signal_meeting_id
        │
        ├──▶  signal  (agent_graph.signals)
        │       │  signal_id → inbox.human_tasks.signal_id
        │       │  work_item_id → agent_graph.work_items.id   [mig 127]
        │       │  origin = 'meeting'
        │       ▼
        │    email / slack message  (inbox.messages)
        │       └── message_id → inbox.signals.message_id
        │
        ├──▶  human task / board card  (inbox.human_tasks)
        │       │  signal_meeting_id = source_meeting_id      [mig 151]
        │       │  signal_id → inbox.signals (triage path)
        │       │  dedup_key = source_meeting_id + sha256(action)
        │       │  origin = 'meeting'
        │       ▼
        │    Linear ticket  (autobot-inbox/src/flow-wrappers/create-ticket.js)
        │       └── linear_issue_id → inbox.human_tasks.linear_issue_id
        │
        ├──▶  engagement  (inbox.engagements / inbox.engagement_proposals)
        │       │  source_meeting_id (via lib/engagements/synth.js)
        │       │  engagement_id → content.drafts.engagement_id
        │       ▼
        │    draft / email  (content.drafts → inbox.messages outbound)
        │
        └──▶  KB artifact  (content.documents)
                source = 'transcript' | 'tldv' | 'gemini'
                meeting_fingerprint → meeting identity  [mig 157]
```

**Key join column:** `source_meeting_id` (TEXT) is the stable identity key across all entities. It equals `calendar_event_id` when available; otherwise a deterministic hash of (15-min-rounded start + sorted participant emails + normalized title).

**Entity table map:**

| Entity | Table | Join column | Notes |
|---|---|---|---|
| Meeting / transcript | `content.documents` | `meeting_fingerprint` (mig 157) | RAG source |
| Calendar event | `inbox.calendar_events` | `calendar_event_id` | linked via source_meeting_id |
| Signal (meeting.received) | `agent_graph.signals` | `source_meeting_id`, `origin='meeting'` | mig 151 |
| Signal (obligation/triage) | `inbox.signals` | `work_item_id`, `occurred_at` | mig 127 |
| Board task / card | `inbox.human_tasks` | `signal_meeting_id` | mig 151 |
| Linear ticket | `inbox.human_tasks` | `linear_issue_id` | via create-ticket.js |
| Engagement | `inbox.engagements` | `source_meeting_id` (synth.js) | |
| Draft / email | `content.drafts` | `engagement_id` | mig 125 link |
| KB artifact | `content.documents` | `source_id` (transcript hash) | |

---

## 2. The Board UX — "Follow the Flow"

### 2.1 Core Interaction Pattern

Every entity on the board that has provenance data shows a **"Trace" button** (or a small chain-link icon). Clicking it opens a **Provenance Panel** — a side drawer that renders the causal chain for that entity as a vertical timeline:

```
[Meeting] Sales call — UMB × Staqs (Jun 11, 2026)
    ↓  generated 3 tasks
[Signal] "Send revised proposal" (meeting.received)
    ↓  bridged to
[Task] "Send revised proposal to UMB" (board card #4821)
    ↓  spawned
[Ticket] STAQPRO-842 — Draft UMB proposal rev 2
    ↓  triggered
[Engagement] UMB Advisors — Q3 Proposal
    ↓  produced
[Draft] Email to dustin@umbadvisors.com (Jun 12, 2026)
```

Each row in the chain is a clickable link to the entity's own board page (Today card, /signals detail, /issues detail, /artifacts, etc.).

### 2.2 Entry Points (where "Trace" appears)

| Board Surface | Entry point | Provenance lookup |
|---|---|---|
| `/today` — task card | Chain icon on card | `human_tasks.signal_meeting_id` → up |
| `/signals` — signal row | Chain icon | `agent_graph.signals.source_meeting_id` → up/down |
| `/issues` — Linear ticket | Chain icon | `human_tasks.linear_issue_id` → up to meeting |
| `/drafts` — draft card | Chain icon | `content.drafts.engagement_id` → `engagements.source_meeting_id` → up |
| `/calendar` — event detail | "View derived work" | `calendar_event_id` → `source_meeting_id` → all downstream |
| `/artifacts` — transcript | "See what this produced" | `content.documents.meeting_fingerprint` → downstream |

### 2.3 Board Surface It Lives On

Primary home: a new `GET /api/provenance/:meeting_id` endpoint (or inline expansion on existing entity endpoints) that returns the full chain as a structured JSON tree. The board drawer consumes this.

No new dedicated page — the Provenance Panel is a universal side drawer (a pattern already used for signal detail and agent activity). Triggered from any entity that has a `source_meeting_id` / `signal_meeting_id` / `meeting_fingerprint` set.

---

## 3. Existing Data / Endpoints That Back It

### 3.1 Data (already in prod)

- `agent_graph.signals.{source_meeting_id, origin}` — mig 151, shipped
- `inbox.human_tasks.{signal_meeting_id, origin, dedup_key}` — mig 151, shipped
- `inbox.signals.{work_item_id, occurred_at, bridged_at}` — mig 127, shipped
- `content.meetings.{meeting_fingerprint, fingerprint_confidence, primary_transcript_id}` — mig 157, shipped
- `lib/content/meetings.js` — `computeSourceMeetingId()`, meeting identity resolution
- `lib/runtime/meeting-identity.js` — meeting dedup and canonical key computation

### 3.2 Endpoints (existing, can be extended)

- `GET /api/signals` — already queries `agent_graph.signals`; add `source_meeting_id` filter
- `GET /api/tasks` (human_tasks) — add `signal_meeting_id` to response
- `GET /api/drafts` — already returns `engagement_id`
- `GET /api/calendar/events` (board calendar routes) — add `source_meeting_id` join

**New endpoint needed:** `GET /api/provenance/:source_meeting_id` — assembles the chain across all entity tables into one response. This is the only new backend work.

### 3.3 What Does Not Exist Yet

- The `/api/provenance/:id` endpoint (new, ~80 LOC)
- The board Provenance Panel component (new React drawer, ~150 LOC)
- The "Trace" / chain icon on existing entity cards (~5–10 LOC per card, ~6 surfaces)

---

## 4. Minimal First Slice

Implement in this order:

**Slice A — Backend provenance query (no UI)**
`GET /api/provenance/:source_meeting_id`
Returns: `{meeting, signals[], tasks[], tickets[], engagements[], drafts[]}` — each array is the list of entities linked to this meeting identity.
Test: query against a known `source_meeting_id` from a prod meeting and verify all linked entities appear.

**Slice B — Today page task card**
Add a chain icon to `/today` task cards where `signal_meeting_id IS NOT NULL`. Clicking opens the Provenance Panel (minimal: just the JSON tree rendered as a bulleted list, no fancy timeline). This is the highest-traffic surface and the most immediately useful.

**Slice C — Calendar event detail**
`/calendar` event detail page: "View derived work" → Provenance Panel. Entry point: `calendar_event_id` → join to `source_meeting_id`.

**Slice D — Remaining surfaces**
`/signals`, `/issues`, `/drafts`, `/artifacts` — add chain icon + Provenance Panel as a polish pass once A–C are live and the panel component is stable.

---

## 5. Self-Improvement Loop (Observe-Only)

The M4 ticket also includes "begin the observe-only self-improvement loop." This is distinct from the click-through and is scoped here as a design note only:

The provenance chain makes the input→output path explicit and measurable. The observe-only loop is:

1. **Signal:** a board user clicks "Trace" → the panel renders → the user navigates to the source meeting or a downstream ticket.
2. **Measurement:** log the click path as a `board_interaction` event (entity type, provenance depth navigated, time to find the target).
3. **Consolidation:** the Architect agent's nightly briefing includes `provenance_navigation_rate` (fraction of task cards with provenance that were traced) as a P5 metric.
4. **Gate:** once `provenance_navigation_rate ≥ 0.3` sustained over 7 days, the chain is trusted enough to expose cross-meeting roll-up views (not in this ticket).

No agent autonomy changes. No new DB tables. Interaction events are appended to the existing `state_transitions` or a lightweight `board_events` log (TBD in implementation).

---

## 6. Acceptance Criteria

- [ ] `GET /api/provenance/:source_meeting_id` returns a structured chain for at least one prod meeting with downstream tasks + a ticket
- [ ] `/today` task card shows chain icon when `signal_meeting_id IS NOT NULL`
- [ ] Clicking chain icon opens Provenance Panel showing the causal chain
- [ ] Each chain node is a link to the entity's own board page
- [ ] Panel renders in < 300ms (single DB query, indexed on `source_meeting_id`)
- [ ] Panel gracefully degrades when chain is partial (only some entities exist)

---

## 7. Out of Scope (This Ticket)

- Cross-meeting roll-up views ("all work from this week's meetings")
- Writing provenance back from the board (the chain is read-only in the UI)
- Provenance for non-meeting entities (email-only signals without a meeting)
- The agents.md compiler (OPT-83 companion — separate issue)
- Enforcement of provenance stamping on new classifier runs (covered by mig 151 dedup_key constraint at DB layer — already enforced)
