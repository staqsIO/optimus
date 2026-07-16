# 007 — Meeting-Note Hierarchy: a meeting identity layer + org/personal dedup

> Feature spec for a meeting-note data hierarchy that deduplicates the same
> real-world meeting across sources (Gemini Notes on Drive, TLDv, MCP/manual) and
> across scopes (a person's private note vs the org's shared capture). Builds on
> Feature 004 (artifact registry), Feature 005 (capture sources), and the
> meeting-fingerprint primitive shipped in migration 151 (Feature 003).
> Status: **BUILT 2026-06-04 — decisions D1–D4 resolved 2026-06-03 (Carlos ✓);
> Q1–Q3 refined against the live code 2026-06-03 (Carlos ✓) — see "Refinements".
> Shipped: migration 157 (`content.meetings` + `artifacts.meeting_id` +
> `fingerprint_aliases`), `lib/content/meetings.js` (upsert / D4 primaries /
> promotion / Q1 upgrade sweep), `lib/content/calendar-reconciler.js` (3a),
> `lib/rag/participants/normalize.js` (3b), watcher + TLDv + HTTP `meeting`
> threading (3c/3d; TLDv artifact write opt-in via `TLDV_OWNER_ORG_ID`),
> `/api/meeting-registry` + promote, board `/meetings/registry` page, tests
> (`test/meeting-hierarchy.test.js`, 13 green). D4 precedence made CONFIGURABLE
> 2026-06-08: migration 161 (`content.meeting_source_prefs`),
> `lib/content/meeting-prefs.js` (resolve user→org→system + re-pick sweep),
> GET/PATCH `/api/meeting-registry/source-precedence`, Source-priority editor on
> the registry page, `test/meeting-source-prefs.test.js` (11 green); also fixed a
> latent bug — the registry `/:id` + `/promote` routes had no `routeKeyFor` entry
> (unreachable over HTTP). Residuals R1–R3 still open for Liotta/board;
> decomposition item 6 (doc-body attendee parsing, manual merge) deferred.**

## Context

Three capture paths already land meeting content, and none of them know they are
talking about the same meeting:

- **Gemini Notes via Drive** — `content.artifacts` (kind `transcript`/`summary`),
  per-org, through Feature 005's `pollCaptureSources()`. Multi-tab Google Doc
  (Notes + Transcript), title like "Q3 Sync — Notes by Gemini".
- **TLDv API** — `pollTldvTranscripts()` (`src/tldv/poller.js`), direct transcript
  fetch, different title and slightly different wording for the *same* call.
- **MCP / `optimus` CLI / manual** — Feature 004 path, ad-hoc, often a *personal*
  capture (`owner_id` set) before anyone files an org copy.

A meeting's **identity** already exists as a string: migration 151's
`source_meeting_id` = `calendar_event_id` when present, else
`sha256(15-min-rounded start | sorted participant emails | normalized title)`.
But that primitive only anchors *signals* (`agent_graph.signals`) and *derived
action items* (`inbox.human_tasks.dedup_key`). The **notes themselves have no
meeting-level grouping**:

- The same call captured via Gemini-on-Drive *and* TLDv becomes **two unrelated
  artifacts** — different titles → different `identity_key` (`sha256(owner_id |
  title)`), different wording → different `content_hash`. The 004/005 dedup
  (`identity_key` per-tenant, `content_hash` per-artifact) cannot collapse them
  because it keys on title+bytes, not meeting identity.
- The same call captured by **Carlos personally** and by **UMB's shared folder**
  becomes two artifacts in two scopes with no link between them — the board sees
  apparent duplicates, and there is no consent-respecting way to promote the
  personal note into the org's shared record.

This feature introduces the **missing identity layer**: a first-class meeting
entity that groups artifacts, deduplicates within a scope, and *links* (never
silently merges) the same meeting across the personal↔org boundary.

## User stories

- **As a board member**, the Gemini transcript and the TLDv transcript of the same
  call show up as **one meeting** with two source captures — not two duplicate
  rows I have to reconcile.
- **As Carlos**, my private pre-meeting note and UMB's shared capture of the same
  call are recognized as the same meeting; the board shows "also captured at org
  level" rather than two unrelated artifacts — and my private note's contents are
  **never** silently exposed to the org.
- **As an org owner**, I can **promote** a personal meeting note to the org's
  shared record in one explicit action; the personal copy is marked superseded
  (lineage kept), and the org record now owns the artifacts.
- **As a search/RAG consumer**, "what happened in the Q3 UMB sync" returns one
  canonical meeting with its best transcript + summary, not N fragments.

## What to build

### Layer 1 — `content.meetings` parent entity  [Decision D2]

A new table — the identity layer that sits **above** `content.artifacts`. One row
per **(scope, meeting)**, where scope = `(owner_org_id, owner_id)`:

```
content.meetings
  id                       UUID PK
  meeting_fingerprint      TEXT NOT NULL   -- migration-151 formula, reused verbatim
  fingerprint_confidence   TEXT            -- 'calendar' | 'derived' | 'weak' (see Q1)
  title                    TEXT            -- normalized display title
  started_at               TIMESTAMPTZ     -- 15-min-rounded window anchor
  participants             JSONB           -- sorted participant emails (identity input)
  calendar_event_id        TEXT            -- when known (inbox.calendar_events linkage)
  owner_org_id             UUID NOT NULL   -- NO DEFAULT; tenancy boundary (P1)
  owner_id                 UUID            -- board_members.id; NULL = org-shared scope
  primary_transcript_id    UUID            -- → content.artifacts (deterministic pick, Q-precedence)
  primary_summary_id       UUID            -- → content.artifacts
  status                   TEXT DEFAULT 'active'  -- 'active' | 'superseded' | 'archived'
  superseded_by            UUID            -- → content.meetings (promotion lineage)
  created_by / created_at / updated_at
```

**Dedup-within-scope (the core invariant):**

```
UNIQUE (owner_org_id, COALESCE(owner_id, '00000000-...'), meeting_fingerprint)
```

Same fingerprint + same scope → **one** meeting row. Implemented as a unique
expression index (PGlite-safe, inline). A second capture of the same call in the
same scope upserts onto this row and attaches its artifact as a child — it does
**not** mint a new meeting.

**Cross-scope discovery (the linkage, not a merge):**

```
INDEX (meeting_fingerprint)   -- non-unique; the only cross-scope join key
```

Two rows can share a `meeting_fingerprint` across scopes (Carlos-personal +
UMB-org). They stay **separate rows**. The link is surfaced **only where
`tenancy.visible()` already permits** the viewer to see both — i.e. a user who is
a member of the org seeing their own personal copy and the org copy. Cross-*org*
links are never surfaced (tenancy isolation: one org cannot learn another org's
meeting exists). This is the privacy-safe framing of "link, don't merge."

### Layer 2 — artifacts become children of a meeting  [Decision D2]

```
ALTER TABLE content.artifacts
  ADD COLUMN IF NOT EXISTS meeting_id UUID;   -- → content.meetings(id); NULL for non-meeting artifacts
CREATE INDEX ... ON content.artifacts (meeting_id) WHERE meeting_id IS NOT NULL;
```

`createArtifact()` (`lib/content/create-artifact.js`) gains an **optional**
`meeting` argument: `{ fingerprint, title, startedAt, participants,
calendarEventId, confidence }`. When `kind ∈ {transcript, summary}` and `meeting`
is supplied, the core, **inside the existing atomic transaction**:

1. `upsertMeeting(scope, meeting)` — upsert on the within-scope unique key,
   returns `meeting_id`.
2. stamps `artifacts.meeting_id = meeting_id` on the new/updated artifact.
3. recomputes the meeting's `primary_transcript_id` / `primary_summary_id` by
   **source precedence** (D4) — no human in the loop.

Crucially, the *existing* 004/005 dedup is unchanged and complementary:
identical bytes still collapse to one version via `content_hash`; this layer adds
grouping *above* it. Re-polls stay idempotent.

### Layer 3 — within-scope multi-source transcripts  [Decision D4]

One meeting legitimately has **multiple transcript artifacts** (Gemini Notes,
TLDv, manual) — we do not destroy any source capture. We pick a deterministic
**primary** by source precedence so reads/RAG get one canonical answer. The
ordering is **configurable per-org and per-user** (migration 161,
`content.meeting_source_prefs`); the **system default** when nothing is set:

```
Gemini Notes (curated summary + action items) > TLDv (full verbatim) > manual/MCP > other
```

Resolution is **per meeting scope**: a personal meeting reads the user override
→ org default → system default; an org-shared meeting reads org default → system
default. `recomputePrimariesTx` ranks the meeting's active artifacts by
`array_position` over the resolved ordering (an unranked source sorts last), so a
change at either level re-picks correctly without the levels knowing about each
other — and saving a preference re-picks existing meetings in the affected scope.
Board members set the org default (`requireBoardHuman`); any member sets their own
override. `primary_transcript_id` / `primary_summary_id` point at the winner.
Identical content across sources still collapses via `content_hash` (no spurious
versions); genuinely different captures coexist under the one meeting, primary
chosen, the rest retained and queryable.

### Layer 4 — explicit personal→org promotion  [Decision D3]

A board-managed action (`POST /api/meetings/:id/promote { toOrgId }`,
`requireBoard`, owner-stamped — mirrors the 005/619-A pattern):

1. Upsert the org-scoped meeting (same `meeting_fingerprint`, `owner_id = NULL`).
2. Re-own the personal meeting's artifacts to the org meeting (re-point
   `meeting_id`; re-stamp `owner_org_id`, clear `owner_id`) — a tenancy change, so
   it runs through the trusted-owner core, never a request body (005's leak-class
   rule).
3. Mark the personal meeting `status='superseded'`, `superseded_by = <org meeting
   id>`. **Lineage, not deletion** (P3 — append-only/auditable).

No automatic promotion. Silence ≠ consent (P1).

## Acceptance

- [ ] The same call captured via Gemini-on-Drive **and** TLDv resolves to **one**
  `content.meetings` row with **two** child transcript artifacts — **via a recovered
  `calendar_event_id`** (the reconciler), since the two sources carry disjoint
  participant emails and cannot hash-match. `primary_transcript_id` is set by
  precedence; re-polling either source is an idempotent no-op.
- [ ] When no `calendar_event_id` can be recovered, a Gemini-on-Drive capture lands
  as a `weak`-confidence meeting that does **not** false-merge onto a `derived`/
  `calendar` row; a later calendar backfill that recovers the id **upgrades and
  merges** it.
- [ ] A personal capture (`owner_id` set) and an org capture (`owner_id` NULL) of
  the same fingerprint produce **two** meeting rows linked by
  `meeting_fingerprint`; a member viewer sees the "also at org level" link; a
  **different org's** viewer sees neither (verified via `verify-tenancy-live.mjs`).
- [ ] `POST /api/meetings/:id/promote` re-owns artifacts to the org meeting and
  marks the personal one `superseded` with a `superseded_by` pointer; the personal
  note's contents were never visible to the org before promotion.
- [ ] A raw transcript file dropped in Drive with **no** structured metadata still
  ingests, with `fingerprint_confidence='weak'` and no false-merge onto an
  unrelated meeting (Q1 behavior).
- [ ] Existing 004/005 dedup unchanged: `identity_key` per-tenant and
  `content_hash` per-artifact still hold; meeting grouping is purely additive.
- [ ] `npm run test:ci` green. Linus on the upsert-in-transaction path, the
  cross-scope visibility predicate, and the promotion re-own.

## Decisions (resolved 2026-06-03 — Carlos ✓)

- **D1. Meeting identity = the existing `computeSourceMeetingId()` output, reused
  verbatim** — `lib/runtime/meeting-identity.js`, the 3-tier string
  `cal:{calendarEventId}` > `mtg:{sha256(15-min window | sorted lowercased emails |
  normalized title)[:32]}` > `src:{fallbackId}`. No new identity formula; no new
  helper. **`content.meetings.meeting_fingerprint` IS that string** — therefore it
  equals the `source_meeting_id` already stamped on `agent_graph.signals` and the
  `signal_meeting_id` on `inbox.human_tasks` (migration 151). The meeting row
  becomes the **canonical hub those rows already point at by string** — existing
  meeting signals and derived action-items associate to the new entity by exact
  match, no backfill of those tables required.
- **D2. Hierarchy = new `content.meetings` parent** (not a bare grouping column).
  `meeting → artifact → version`. Artifacts gain a nullable `meeting_id` FK.
- **D3. Personal↔org = link + explicit promotion, never auto-merge.** Same
  fingerprint across scopes → separate rows linked by fingerprint, surfaced only
  within existing tenancy visibility; promotion is an explicit, audited,
  supersede-not-delete action.
- **D4. Within-scope multi-source = one meeting, many transcript artifacts,
  deterministic primary by source precedence** — now **configurable per-org and
  per-user** (migration 161; system default Gemini > TLDv > manual, set
  2026-06-08). Resolution is user → org → system, computed per meeting scope;
  saving a preference re-picks existing meetings. Identical bytes still collapse
  via `content_hash`.

## Refinements (Q1–Q3 — resolved against the live code 2026-06-03)

Reading the three capture paths changed the shape of the hard problem. The
key finding: **`mtg:`-hash grouping cannot bridge TLDv and Gemini-on-Drive**,
because the two paths do not share a participant representation. TLDv's
participant emails are the real meeting *invitees*
(`src/tldv/api.js` → `invitees[].email`); Gemini-on-Drive's are the Google *Doc*
`owners/lastModifyingUser/sharingUser` email addresses (`src/drive/watcher.js`
field mask) — and the doc body yields names with **no emails**. Two different
email sets → two different hashes → no grouping. Worse, the Drive/Gemini path
**does not emit `meeting.received` at all** today (only the TLDv path calls
`emitMeetingReceived`). So cross-source dedup has to hang on `calendar_event_id`,
not on participant hashing.

### Q3 (the make-or-break) → calendar reconciliation, not participant hashing

`calendar_event_id` (the `cal:` tier) is the only reliable cross-source bridge.
TLDv carries it intermittently; Gemini-on-Drive carries none. So we **recover**
it:

- **Reconciliation step** (new, shared by all capture paths): when a capture lacks
  a `calendar_event_id`, resolve one against `inbox.calendar_events` by
  `(15-min-rounded start ∩ fuzzy-title ∩ attendee-overlap)`. A match upgrades the
  meeting's fingerprint to the `cal:` tier — at which point TLDv and Gemini
  captures of the same call **converge on the same `content.meetings` row**.
  `inbox.calendar_events.ical_uid` (already stored, commented "for cross-source
  meeting merge") is the secondary bridge when both sources expose it.
- **Gemini-on-Drive must start emitting meeting identity.** Item 3 adds an
  `emitMeetingReceived`-equivalent to the Drive capture path (today it routes
  through generic `ingestDocument` with no meeting signal). It feeds the
  reconciler with: `started_at` from `parseGeminiTitleTime(filename)`
  (`src/drive/gemini-title.js`), title from the doc, and any attendee emails it
  can lift — see residual R1.
- The **shared participant normalizer** still ships (canonical
  `{email↓, name, role}` per `lib/rag/participants/extractors.js`, bots like
  `tldv@`/`meet-notes@`/Gemini notetaker stripped) — but its job is now to score
  the reconciler's attendee-overlap and to stabilise the *medium*-tier hash
  *within* a source, not to bridge across sources. Bridging is the calendar's job.

### Q1 (weak fingerprints) → confidence tiers gate auto-merge

`fingerprint_confidence` is derived from which identity tier fired AND the quality
of its inputs:

| confidence | when | merge behavior |
|---|---|---|
| `calendar` | `cal:` tier (real or reconciled `calendar_event_id`) | groups freely within scope |
| `derived` | `mtg:` hash from **real attendee emails** (TLDv invitees, calendar attendees) | groups within scope |
| `weak` | `mtg:` hash from **doc-owner emails only** (Gemini/Drive, no reconciliation match) or `src:` fallback | **never auto-merges onto a `calendar`/`derived` row**; collapses only against an exact-match `weak` row |

A `weak` row is **upgraded** (and may then merge) if a later calendar backfill
recovers a `calendar_event_id`. This makes the raw-Drive-drop case safe: it
ingests, stays its own meeting, and never false-merges onto an unrelated call.

### Q2 (edited transcript) → action-item sweep already exists; meeting layer just re-picks primary

The action-item supersede is **already implemented and wired** —
`supersedePriorTasks()` (`lib/runtime/meeting-classifier.js:183`) runs on every
classifier pass, idempotent, guarded to `created_by='meeting_classifier'` cards;
a TLDv content-hash change forces re-ingest → `emitMeetingReceived` → sweep
(test: `meeting-classifier.test.js:166`). So Q2 is **not open for action items**.
The only meeting-layer additions:

- On a **new transcript version** (`content_hash` mints a new `artifact_versions`
  row), the meeting **re-picks `primary_transcript_id`/`primary_summary_id`** by
  D4 precedence — deterministic, in the same transaction.
- **Re-emit `meeting.received`** on a new transcript version so the existing
  action-item sweep runs for *both* sources. Note: Feature 005's Drive `changes`
  cursor means an **edited Gemini doc re-appears and re-ingests automatically** —
  so this closes the edited-notes loop for Drive too, which the TLDv-only
  content-hash poll did not cover.

## Residual questions (flag for Liotta / board)

- **R1. Attendee emails from the Gemini doc body.** Gemini Notes docs usually list
  an "Attendees" section. Parsing emails from it would let the *medium*-tier hash
  match TLDv directly (a second bridge beside calendar reconciliation), but doc-body
  parsing is brittle. Worth it, or rely on calendar reconciliation alone? Lean:
  best-effort parse as a *reconciler hint* (attendee-overlap input), never as the
  sole identity.
- **R2. Reconciler match thresholds.** Exact `(rounded start, title, attendee
  overlap)` weights and the minimum score to claim a `calendar_event_id` — needs a
  small labelled set from real captures before we hard-code thresholds (P5: measure
  before you trust). Ship behind a confidence floor; log near-misses.
- **R3. Cross-org same-meeting.** Two *different* orgs legitimately capturing the
  same external call (Feature 005's multi-org-file case) compute the same
  `calendar_event_id`. Confirm the design intent — kept fully isolated (no
  cross-org link surfaced, per tenancy), which D3's "surface only where
  `tenancy.visible()` permits" already enforces. Flag only to make it explicit for
  the board.

## Decomposition (Linear — extends OPT-37 / Feature 005)

Sequenced so each item is independently shippable and testable. Items 1–2 are the
schema + core (no behavior change until a path opts in); 3 is the cross-source
payoff and the riskiest (the reconciler); 4–5 are the human surface.

1. **`content.meetings` table** (migration 157) + within-scope unique expression
   index `(owner_org_id, COALESCE(owner_id,'…'), meeting_fingerprint)` + non-unique
   `(meeting_fingerprint)` cross-scope index + `artifacts.meeting_id` column/index +
   `fingerprint_confidence` enum. Tenancy: `owner_org_id` NOT NULL no-default;
   extend `tenancy.visible()` (or a view) for the cross-scope link surface.
2. **`upsertMeeting()` + `createArtifact()` meeting hook** — import the EXISTING
   `computeSourceMeetingId()` from `lib/runtime/meeting-identity.js` (do NOT write a
   new helper); `createArtifact()` gains an optional `meeting` arg → in-transaction
   upsert on the within-scope key + `meeting_id` stamp + `primary_transcript_id`/
   `primary_summary_id` recompute by D4 precedence + confidence tagging (Q1).
   Server-internal-only, trusted owner (005 rule). Re-pick primary on a new version.
   (depends on 1)
3. **Cross-source convergence** (the payoff — Q3):
   - **3a. Calendar reconciler** — `resolveCalendarEventId({startedAt, title,
     attendees})` against `inbox.calendar_events` by rounded-start ∩ fuzzy-title ∩
     attendee-overlap (+`ical_uid` when present); upgrades a meeting to the `cal:`
     tier. Behind a confidence floor; logs near-misses (R2, P5).
   - **3b. Shared participant normalizer** — canonical `{email↓, name, role}`,
     strips note-taker bots (`tldv@`/`meet-notes@`/Gemini); feeds 3a's overlap score.
   - **3c. Emit meeting identity from the Gemini-on-Drive path** — add the
     `emitMeetingReceived`-equivalent the Drive capture path lacks today; source
     `started_at` from `parseGeminiTitleTime()`, run through 3a; pass the `meeting`
     arg to `createArtifact()`.
   - **3d. Pass the `meeting` arg from TLDv + MCP/CLI paths** (TLDv already computes
     identity via `emitMeetingReceived` — thread it into the artifact write).
   (depends on 2)
4. **`POST /api/meetings/:id/promote`** — board-managed personal→org promotion:
   re-own artifacts, supersede personal (`status`+`superseded_by`), lineage kept.
   `requireBoard`, owner-stamped, trusted-owner core. (depends on 1, 2)
5. **Board surface** — Meetings browser: one canonical meeting, source-capture
   chips, "also at org level" link, promote action. (depends on 1–4)
6. **(Later)** Gemini doc-body attendee parsing as a reconciler hint (R1);
   human "these two meetings are the same" manual-merge override for distinct
   fingerprints the reconciler missed.

> **Already done, do not rebuild:** the action-item edited-transcript supersede
> sweep (`supersedePriorTasks`, `meeting-classifier.js:183`) and the
> `source_meeting_id`/`signal_meeting_id` provenance columns (migration 151). This
> feature *reuses* them — the meeting fingerprint is the same string.
