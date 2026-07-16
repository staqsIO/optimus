/**
 * Google Calendar poller (STAQPRO-327, Phase 3).
 *
 * Two entry points:
 *   - pollCalendarEvents() — periodic 5-min sweep over a rolling
 *     short-window (default 14 days back, 90 days forward).
 *   - backfillCalendarEvents({ lookbackDays }) — one-shot historic
 *     pass back to May 2025. Use scripts/backfill-calendar.js to invoke.
 *
 * Both share `upsertCalendarEvent` so they stay byte-for-byte consistent
 * on dedup, attendee resolution, and the inbox.calendar_events row shape.
 *
 * Multi-account: watches are stored in inbox.calendar_watches (migration
 * 114). Each tick iterates every is_active=true row. The Phase 3 first
 * cut used CALENDAR_ACCOUNT_EMAIL env var; that's kept as a fallback to
 * seed a single watch when no row exists, so existing deploys don't
 * silently stop polling.
 *
 * Idempotent at two layers:
 *   - inbox.calendar_events UNIQUE(account_email, gcal_event_id).
 *   - We compute a contentHash over the mutable fields and skip the row
 *     update when nothing has changed.
 *
 * Env vars:
 *   CALENDAR_ACCOUNT_EMAIL   — Optional fallback when no DB watches exist.
 *   CALENDAR_POLL_INTERVAL_MS — Live poll interval (default 5 min).
 */

import { createHash } from 'crypto';
import { query, withAgentScope } from '../db.js';
import { listCalendarEvents } from './api.js';
import { resolveAndUpsert } from '../../../lib/rag/participants/resolver.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

const FALLBACK_ACCOUNT_EMAIL = process.env.CALENDAR_ACCOUNT_EMAIL || '';

// OPT-166 P2e-E4: attendee resolution reads + writes signal.contacts, whose
// SELECT policy is org-keyed (`tenancy.visible(NULL, owner_org_id)`) and whose
// write policy is org-scoped (`visible(..., false)`, allow_system=FALSE). Under
// the RLS pool-flip a bare query would black-hole the reads (every attendee
// resolves as unresolved) and hard-fail the writes (42501). Calendar ingestion
// is single-tenant → CURRENT_ORG_ID (Staqs internal). Org scope, NOT system
// scope (system does not satisfy the FALSE write policy) → this file is NOT a
// withSystemScope caller (the ratchet is unaffected). INERT today (superuser
// bypasses RLS).
const CALENDAR_RESOLVE_AGENT_ID = 'calendar-poller';

// Run `fn(exec)` with `exec` org-scoped (app.org_ids=[CURRENT_ORG_ID]); fall
// back to bare `query` if the scope can't open (only under REQUIRE_AGENT_JWT,
// OFF today) so pre-flip behaviour is unchanged. The scope wraps the whole
// resolve+upsert — its internals are pure DB + JS (no network await), so no
// transaction ever spans I/O.
async function withCalendarOrgScope(fn) {
  let scoped;
  try {
    scoped = await withAgentScope(CALENDAR_RESOLVE_AGENT_ID, { orgIds: [CURRENT_ORG_ID] });
  } catch (err) {
    console.warn(`[OPT-166 P2e-E4 SCOPE-UNAVAILABLE] withAgentScope(${CALENDAR_RESOLVE_AGENT_ID}) threw: ${err.message} — resolving unscoped`);
    return fn(query);
  }
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Active watches to poll on each tick. Reads inbox.calendar_watches; falls
 * back to the env var when the table is empty so first-deploy behavior
 * doesn't silently degrade. Returns [{accountEmail, calendarId, watchId}].
 */
async function loadActiveWatches() {
  try {
    const r = await query(
      `SELECT id, account_email, calendar_id
         FROM inbox.calendar_watches
        WHERE is_active = true
        ORDER BY created_at ASC`,
    );
    if (r.rows.length > 0) {
      return r.rows.map((row) => ({
        watchId: row.id,
        accountEmail: row.account_email,
        calendarId: row.calendar_id || 'primary',
      }));
    }
  } catch (err) {
    // Table may not exist yet (pre-migration-114 deploys). Fall through
    // to the env-var fallback below.
    if (!String(err?.message || '').includes('does not exist')) {
      console.warn(`[calendar] load watches failed: ${err.message}`);
    }
  }
  if (FALLBACK_ACCOUNT_EMAIL) {
    return [{ watchId: null, accountEmail: FALLBACK_ACCOUNT_EMAIL, calendarId: 'primary' }];
  }
  return [];
}

async function markWatchPolled(watchId, errorMessage) {
  if (!watchId) return;
  try {
    await query(
      `UPDATE inbox.calendar_watches
          SET last_poll_at = now(),
              last_error = $2
        WHERE id = $1`,
      [watchId, errorMessage || null],
    );
  } catch {
    // Non-critical — diagnostics only.
  }
}

// Live poller looks at a sliding window. 14 days back captures meetings
// that were rescheduled or cancelled after we last saw them; 90 days
// forward populates the day-grid for upcoming planning.
const LIVE_LOOKBACK_DAYS = 14;
const LIVE_LOOKAHEAD_DAYS = 90;

// Backfill safety: cap the window we'll walk in one call. Default to
// ~14 months back which covers Eric's TLDv corpus (May 2025 → today).
const BACKFILL_MAX_LOOKBACK_DAYS = 400;

/**
 * SHA-256 over the mutable fields of an event. Skip the UPDATE when this
 * matches what's already in the DB.
 */
function eventContentHash(ev) {
  const slim = {
    title: ev.summary || null,
    description: ev.description || null,
    location: ev.location || null,
    hangoutLink: ev.hangoutLink || null,
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    status: ev.status || null,
    organizer: ev.organizer?.email || null,
    attendees: (ev.attendees || []).map((a) => ({
      email: a.email,
      responseStatus: a.responseStatus,
      optional: !!a.optional,
      organizer: !!a.organizer,
      self: !!a.self,
      resource: !!a.resource,
    })),
  };
  return createHash('sha256').update(JSON.stringify(slim)).digest('hex').slice(0, 16);
}

/**
 * Resolve attendees to signal.contacts and return the attendee JSONB
 * payload we'll store on the calendar_events row. Each attendee carries
 * contact_id when we matched them.
 */
async function resolveAttendees(attendees, accountEmail, happenedAt) {
  if (!Array.isArray(attendees) || attendees.length === 0) return [];
  const rawParticipants = attendees
    .filter((a) => a?.email)
    .map((a) => ({
      email: String(a.email).toLowerCase(),
      name: a.displayName || null,
      role: a.organizer ? 'organizer' : 'attendee',
    }));
  let resolved = [];
  try {
    resolved = await withCalendarOrgScope((exec) =>
      resolveAndUpsert(rawParticipants, {
        accountId: null,           // calendar_events isn't FK'd to inbox.accounts
        at: happenedAt || new Date().toISOString(),
      }, exec),
    );
  } catch (err) {
    // Don't let attendee resolution crash event ingestion — record the
    // attendees without contact_ids and move on.
    console.warn(`[calendar] attendee resolve failed (${accountEmail}): ${err.message}`);
    resolved = [];
  }
  const byEmail = new Map(resolved.map((r) => [r.email?.toLowerCase(), r]));
  return attendees.map((a) => {
    const r = a?.email ? byEmail.get(String(a.email).toLowerCase()) : null;
    return {
      email: a.email || null,
      displayName: a.displayName || null,
      responseStatus: a.responseStatus || null,
      optional: !!a.optional,
      organizer: !!a.organizer,
      self: !!a.self,
      resource: !!a.resource,
      contact_id: r?.contact_id || null,
    };
  });
}

/**
 * Upsert a single Google Calendar event into inbox.calendar_events.
 * Idempotent: returns 'unchanged' when the contentHash matches what's
 * already stored.
 *
 * @returns {Promise<{status: 'ingested'|'updated'|'unchanged'|'skipped'|'errors', reason?: string}>}
 */
export async function upsertCalendarEvent(ev, { accountEmail }) {
  const gcalEventId = ev?.id;
  if (!gcalEventId) return { status: 'skipped', reason: 'no_event_id' };

  // Calendar all-day events use start.date (YYYY-MM-DD) instead of
  // start.dateTime. Convert to a midnight ISO so the start_at column
  // (TIMESTAMPTZ) accepts it. Same for end.
  const startRaw = ev.start?.dateTime || ev.start?.date || null;
  const endRaw = ev.end?.dateTime || ev.end?.date || null;
  if (!startRaw) return { status: 'skipped', reason: 'no_start_time' };
  const allDay = !ev.start?.dateTime;
  const startAt = allDay ? `${ev.start.date}T00:00:00Z` : startRaw;
  const endAt = endRaw ? (allDay ? `${ev.end.date}T00:00:00Z` : endRaw) : null;

  const status = ev.status === 'cancelled' || ev.status === 'tentative'
    ? ev.status
    : 'confirmed';

  const contentHash = eventContentHash(ev);

  // Fast-path: did the event change at all since we last saw it?
  const existing = await query(
    `SELECT id, raw_event->>'__hash' AS prev_hash
       FROM inbox.calendar_events
      WHERE account_email = $1 AND gcal_event_id = $2`,
    [accountEmail, gcalEventId],
  );
  if (existing.rows.length > 0 && existing.rows[0].prev_hash === contentHash) {
    return { status: 'unchanged' };
  }

  const attendeesPayload = await resolveAttendees(ev.attendees, accountEmail, startAt);

  // Pack the contentHash into raw_event under a reserved key so we don't
  // need a separate column.
  const rawWithHash = { ...ev, __hash: contentHash };

  const result = await query(
    `INSERT INTO inbox.calendar_events (
       account_email, gcal_event_id, ical_uid, title, description, location,
       hangout_link, start_at, end_at, all_day, organizer_email,
       attendees, status, source, raw_event
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'gcal', $14)
     ON CONFLICT (account_email, gcal_event_id) DO UPDATE
       SET ical_uid = EXCLUDED.ical_uid,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           location = EXCLUDED.location,
           hangout_link = EXCLUDED.hangout_link,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           all_day = EXCLUDED.all_day,
           organizer_email = EXCLUDED.organizer_email,
           attendees = EXCLUDED.attendees,
           status = EXCLUDED.status,
           raw_event = EXCLUDED.raw_event
     RETURNING (xmax = 0) AS inserted`,
    [
      accountEmail,
      gcalEventId,
      ev.iCalUID || null,
      ev.summary || null,
      ev.description || null,
      ev.location || null,
      ev.hangoutLink || null,
      startAt,
      endAt,
      allDay,
      ev.organizer?.email || null,
      JSON.stringify(attendeesPayload),
      status,
      JSON.stringify(rawWithHash),
    ],
  );
  const inserted = result.rows[0]?.inserted === true;
  return { status: inserted ? 'ingested' : 'updated' };
}

/**
 * Live poll: iterates every active watch in inbox.calendar_watches and
 * polls a rolling window for each. Wired into ServiceScheduler at the
 * product entry point. Idempotent / safe to overlap with backfills.
 */
export async function pollCalendarEvents() {
  const watches = await loadActiveWatches();
  const summary = {
    watches: watches.length,
    scanned: 0,
    ingested: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    skipped: 0,
  };
  if (watches.length === 0) {
    return { ...summary, reason: 'no_active_watches' };
  }
  const now = Date.now();
  const timeMin = new Date(now - LIVE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(now + LIVE_LOOKAHEAD_DAYS * 86_400_000).toISOString();

  for (const watch of watches) {
    const stats = { scanned: 0, ingested: 0, updated: 0, unchanged: 0, errors: 0, skipped: 0 };
    const result = await runPollWindow({
      accountEmail: watch.accountEmail,
      calendarId: watch.calendarId,
      timeMin,
      timeMax,
      stats,
    });
    const errMsg = result.ok ? null : result.body || `status_${result.status}`;
    await markWatchPolled(watch.watchId, errMsg);
    for (const k of Object.keys(stats)) summary[k] = (summary[k] || 0) + stats[k];
  }
  if (summary.ingested > 0 || summary.updated > 0 || summary.errors > 0) {
    console.log(`[calendar] Poll complete: ${JSON.stringify(summary)}`);
  }

  // Feature 007 (Q1 upgrade): newly-synced calendar events are exactly when a
  // 'weak' meeting (a Drive drop the reconciler couldn't match before) becomes
  // matchable. Best-effort + bounded; a sweep failure never fails the poll.
  if (summary.ingested > 0 || summary.updated > 0) {
    try {
      const { upgradeWeakMeetings } = await import('../../../lib/content/meetings.js');
      await upgradeWeakMeetings({ limit: 25 });
    } catch (err) {
      console.warn(`[calendar] weak-meeting upgrade sweep failed: ${err.message}`);
    }
  }
  return summary;
}

let backfillRunning = false;

/**
 * One-shot historic pass. Walks events from `lookbackDays` ago up to
 * `lookaheadDays` from now. Without `accountEmail`, runs across every
 * active watch. With one provided, only that watch.
 *
 * @param {object} opts
 * @param {number} [opts.lookbackDays=400]
 * @param {number} [opts.lookaheadDays=14]
 * @param {string} [opts.accountEmail] — restrict to a single watched account
 * @param {string} [opts.calendarId]   — restrict to a single calendar within that account
 */
export async function backfillCalendarEvents(opts = {}) {
  if (backfillRunning) return { ok: false, error: 'backfill_already_running' };
  const lookbackDays = Math.min(BACKFILL_MAX_LOOKBACK_DAYS, Number(opts.lookbackDays) || 400);
  const lookaheadDays = Math.max(0, Number(opts.lookaheadDays) || 14);

  let watches = await loadActiveWatches();
  if (opts.accountEmail) {
    watches = watches.filter(
      (w) => w.accountEmail === opts.accountEmail
        && (!opts.calendarId || w.calendarId === opts.calendarId),
    );
    if (watches.length === 0) {
      // Allow ad-hoc backfill without a DB watch row (script invocation
      // before UI has been used to add the calendar).
      watches = [{
        watchId: null,
        accountEmail: opts.accountEmail,
        calendarId: opts.calendarId || 'primary',
      }];
    }
  }
  if (watches.length === 0) {
    return { ok: false, error: 'no_active_watches' };
  }

  const summary = {
    watches: watches.length,
    scanned: 0,
    ingested: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    skipped: 0,
    perWatch: [],
  };
  backfillRunning = true;
  try {
    const now = Date.now();
    const timeMin = new Date(now - lookbackDays * 86_400_000).toISOString();
    const timeMax = new Date(now + lookaheadDays * 86_400_000).toISOString();
    for (const watch of watches) {
      const stats = { scanned: 0, ingested: 0, updated: 0, unchanged: 0, errors: 0, skipped: 0 };
      console.log(`[calendar-backfill] starting ${watch.accountEmail}/${watch.calendarId} timeMin=${timeMin} timeMax=${timeMax}`);
      const res = await runPollWindow({
        accountEmail: watch.accountEmail,
        calendarId: watch.calendarId,
        timeMin,
        timeMax,
        stats,
      });
      summary.perWatch.push({
        accountEmail: watch.accountEmail,
        calendarId: watch.calendarId,
        ok: res.ok,
        ...stats,
        error: res.ok ? null : res.body || `status_${res.status}`,
      });
      for (const k of ['scanned', 'ingested', 'updated', 'unchanged', 'errors', 'skipped']) {
        summary[k] += stats[k];
      }
      await markWatchPolled(watch.watchId, res.ok ? null : res.body || `status_${res.status}`);
      console.log(`[calendar-backfill] ${watch.accountEmail}/${watch.calendarId} done: ${JSON.stringify(stats)}`);
    }
    const ok = summary.perWatch.every((watch) => watch.ok);
    return { ok, stats: summary };
  } finally {
    backfillRunning = false;
  }
}

export function isCalendarBackfillRunning() {
  return backfillRunning;
}

async function runPollWindow({ accountEmail, calendarId, timeMin, timeMax, stats }) {
  return listCalendarEvents({
    accountEmail,
    calendarId: calendarId || 'primary',
    timeMin,
    timeMax,
    onPage: async (events) => {
      for (const ev of events) {
        let outcome;
        try {
          outcome = await upsertCalendarEvent(ev, { accountEmail });
        } catch (err) {
          console.warn(`[calendar] upsert crashed for event=${ev?.id} (${accountEmail}): ${err.message}`);
          outcome = { status: 'errors', reason: 'upsert_threw' };
        }
        stats.scanned += 1;
        stats[outcome.status] = (stats[outcome.status] || 0) + 1;
      }
    },
  });
}
