---
title: "ADR-027: Google Calendar Mirror in Postgres"
description: "Why /calendar reads scheduled events from a synced Postgres mirror, with DB-backed multi-account watches, instead of live-calling Google or keying off an env var"
---

# ADR-027: Google Calendar Mirror in Postgres

**Date**: 2026-05-12
**Status**: Accepted
**Related**: ADR-001 (Metadata-Only Email Storage), ADR-008 (Adapter Pattern), ADR-026 (Contacts ARE Persons)

## Context

The Board's `/calendar` page renders a 6×7 month grid plus a per-day right-rail panel that unions meetings, signals, and significant emails. Before STAQPRO-327, future cells were intentionally empty because we had nothing scheduled to put there. Bringing Google Calendar in had two requirements:

1. **Future days populate** — each cell needs a count of scheduled events without per-cell round-trips.
2. **Past days enrich** — show *was scheduled* alongside *was recorded* (TL;DV / Gemini Notes), even when the recording is missing.

Two implementation options:

| Option | Approach | Trade-off |
|--------|----------|-----------|
| Live-fetch | Call `events.list` from `/api/calendar/months` and `/api/calendar/day` | Always fresh, no schema, but 42 cells × N accounts = many API calls per page load; Google rate limits start hurting fast. No way to do server-side count joins. |
| Postgres mirror | Sync events into `inbox.calendar_events` on a poll, query locally | One LEFT JOIN in the existing union. Future-proofs `ical_uid` dedupe vs `content.documents`. Adds a poller and migration. |

A secondary decision is how to authenticate. Drive already uses a service account with domain-wide delegation (DWD); reusing the same SA for Calendar avoids extending the per-user OAuth scope and the re-consent flow that implies. The trade-off is that DWD requires an admin to add the Calendar scope to the SA's delegated-scope list, but that's a one-time operator task rather than a per-user friction.

A tertiary decision: should the set of synced calendars live in env vars or the database? An env var (`CALENDAR_ACCOUNT_EMAIL`) shipped first as Phase 3, but the board can't manage that without a deploy. STAQPRO-327's follow-up migrated configuration to `inbox.calendar_watches`, mirroring `inbox.drive_watches` from `sql/001-baseline`.

## Decision

Mirror Google Calendar into `inbox.calendar_events`. Authenticate via the existing Drive service account + DWD with `calendar.readonly` added to its delegated scopes. Manage watches via `inbox.calendar_watches`, exposed through `/api/calendar/watches*` and a Settings UI section. Sync is one-way Google → Postgres.

Concretely (as shipped in PR #210 and PR #211):

- **Auth**: `src/drive/service-auth.js#getCalendarClient(userEmail)` — same SA used for Drive, scope list extended with `calendar.readonly`. Workspace admin adds the scope to the SA's DWD entry once.
- **Storage**: `inbox.calendar_events`, keyed `UNIQUE(account_email, gcal_event_id)`. `ical_uid` indexed when present for later cross-calendar dedupe. `status` ∈ `{'confirmed','tentative','cancelled'}` — cancelled rows stay (audit trail of "was on the calendar, then dropped"). Mutable fields hashed into `raw_event.__hash` for skip-on-no-change.
- **Watches**: `inbox.calendar_watches(account_email, calendar_id)` is the source of truth for what to poll. `CALENDAR_ACCOUNT_EMAIL` env var stays as a fallback only when the table is empty, so first-deploy behavior doesn't silently degrade.
- **Sync**: `src/calendar/poller.js`. Live poll: rolling [-14d, +90d] window every 5 min (`CALENDAR_POLL_INTERVAL_MS`). Backfill: `scripts/backfill-calendar.js` or `POST /api/calendar/watches/backfill`, capped at 400 days back. Per-page error containment mirrors the STAQPRO-325 TLDv fix.
- **Surface**: `/api/calendar/months` adds a `gcal_events` count column (collapsed across watches via `DISTINCT ON (COALESCE(ical_uid, gcal_event_id))`); `/api/calendar/day` adds a `gcal_event` kind. Frontend renders a 5th emerald `Calendar` chip on day cells and a "Calendar" group at the top of the right-rail panel, separate from the violet "Meetings" group.

## Alternatives Considered

| Alternative | Why not |
|-------------|---------|
| Per-user OAuth on the existing Gmail token | Each account would need re-consent for `calendar.readonly`; the friction defeats the goal of "all board members' calendars" being one toggle away. SA+DWD scales with workspace admin policy instead. |
| Live-fetch on every API call | Rate limits + per-cell latency. No way to compute month-grid badges in one query. |
| Push notifications via `events.watch` | Channels expire after ≤1 month, require a public webhook URL, and add a moving part. 5-min polling is sufficient for a board calendar UI. |
| Env-var-only configuration | Phase 3 first cut; failed the "manageable by board, not engineers" bar. Moved to `inbox.calendar_watches`. |
| Store in `content.calendar_events` | Considered but rejected — `inbox` is where incoming time-shaped records live (`inbox.messages`, `inbox.signals`). Calendar events match that semantic. |
| Roll gcal events into the existing `meetings` count | Loses the scheduled-vs-recorded distinction. A cancelled meeting has a calendar entry but no recording; collapsing them hides that. Emerald chip stays separate. |

## Consequences

**Positive**

- One JOIN extends the existing `/api/calendar/months` and `/api/calendar/day` unions — no new round-trip patterns.
- Future days populate; the calendar surface is finally complete.
- `ical_uid` is captured (indexed when present), so a future pass can dedupe past-day double-counts against `content.documents` without a schema change.
- DB-backed `inbox.calendar_watches` lets the board add/remove calendars from the Settings UI without a deploy.
- 5-minute poll cadence aligns with Drive/TLDv; the orchestrator already has the timer pattern.

**Negative**

- Cancelled events stay forever (intentional — see audit-trail rationale), so `inbox.calendar_events` grows monotonically. A retention pass is a follow-up if volume becomes a problem.
- Service-account DWD is a workspace-admin coupling — onboarding a new Workspace tenant requires their admin to delegate the SA. Documented in the PR #210 deploy checklist.
- The same physical meeting on N watched calendars stores N rows. `DISTINCT ON (COALESCE(ical_uid, gcal_event_id))` in the read paths collapses them, but storage grows linearly with watch count.

**Neutral**

- Read-only by design. Creating / RSVP'ing to events is out of scope. If/when agents need to write, that's a separate ADR with G5 reversibility implications.

## Affected Files

- `autobot-inbox/sql/113-calendar-events.sql` — `inbox.calendar_events` table, indexes, `touch_updated_at` trigger.
- `autobot-inbox/sql/114-calendar-watches.sql` — `inbox.calendar_watches` table (multi-account, UI-managed).
- `autobot-inbox/src/drive/service-auth.js` — `getCalendarClient(userEmail)` helper sharing the Drive SA + DWD path.
- `autobot-inbox/src/calendar/api.js` — paginated `events.list` wrapper with per-page error containment.
- `autobot-inbox/src/calendar/poller.js` — `upsertCalendarEvent`, `pollCalendarEvents`, `backfillCalendarEvents`, `isCalendarBackfillRunning`.
- `autobot-inbox/scripts/backfill-calendar.js` — CLI driver mirroring `backfill-tldv.js`.
- `autobot-inbox/src/index.js` — wires `pollCalendarEvents` into startup (5-min interval, 25s delay).
- `autobot-inbox/src/api-routes/calendar.js` — `gcal_event_counts` CTE on `/months`, `gcal_event` kind on `/day`, `/watches` CRUD + `/watches/backfill` endpoints.
- `board/src/app/calendar/page.tsx` — `gcal_event` in `EventKind`/`KIND_META`, emerald `CountChip`, future days clickable, "Calendar" group renders first, external `link_to` opens in new tab.
- `board/src/app/settings/page.tsx` — Calendar Watches admin block.
