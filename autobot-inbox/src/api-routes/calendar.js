/**
 * Calendar surface — the Board's month-grid view of what happened on each day.
 *
 *   GET /api/calendar/months  — per-day event counts across a date range, used
 *                               to render badges on day cells without loading
 *                               the full event list for every day.
 *
 *   GET /api/calendar/day     — full unioned event list for a single day, used
 *                               by the right-rail panel when a day is clicked.
 *
 * Event sources unified:
 *   - meeting     : content.documents (tldv/gemini) + voice memos via inbox.messages
 *   - signal_due  : inbox.signals.due_date on that day, unresolved
 *   - signal_fired: inbox.signals.created_at on that day, type in (commitment,
 *                   decision, action_item)
 *   - email       : inbox.messages channel='email' that have ≥1 extracted signal
 *                   (filters list noise — only "consequential" emails surface)
 *   - gcal_event  : inbox.calendar_events (STAQPRO-327, populated by
 *                   src/calendar/poller.js per watch in inbox.calendar_watches).
 *                   Excludes status='cancelled'. Past + future. v2 dedupe vs
 *                   `content.documents` (TL;DV/Gemini) via ical_uid is a
 *                   follow-up.
 *
 * Per SPEC §12: cross-schema reads only, no cross-schema FKs. The unions here
 * document the same envelope/extraction layering as the meetings list.
 */

import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

// "Real" meeting time per source:
//   - tldv: metadata.happenedAt is set correctly by the poller/webhook
//   - gemini (Drive): the watcher does NOT set metadata.happenedAt, so the
//     fallback to created_at lands on the file-creation moment (often hours
//     after the meeting ended, when Gemini saves the Notes doc). However the
//     title reliably embeds the actual meeting time, e.g.
//       "Dev Daily Touch Base - 2026/05/07 13:00 PDT - Notes by Gemini"
//   - voice memos / drive uploads: rely on metadata.happenedAt or created_at
//
// The expression below prefers parsed-title-time for Gemini docs, then the
// metadata.happenedAt (when ISO-prefixed; legacy rows have JS Date.toString()
// that PG can't cast), then created_at as last resort. The TZ alternation is
// limited to abbreviations PG reliably resolves; unknown TZs fall through.
const HAPPENED_AT_EXPR = `
  COALESCE(
    CASE
      WHEN (d.source = 'gemini' OR (d.source = 'drive' AND d.format = 'gemini'))
       AND d.title ~ '[0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT)'
      THEN (
        replace(
          (regexp_match(
            d.title,
            '([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT))'
          ))[1],
          '/', '-'
        )
      )::timestamptz
      ELSE NULL
    END,
    CASE WHEN d.metadata->>'happenedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         THEN (d.metadata->>'happenedAt')::timestamptz
         ELSE NULL END,
    d.created_at
  )
`;

const MEETING_DOC_PREDICATE = `
  d.deleted_at IS NULL
  AND (
    d.source IN ('tldv','gemini')
    OR (d.source = 'drive' AND d.format IN ('tldv','gemini'))
  )
`;

const NOTABLE_SIGNAL_TYPES = ['commitment', 'decision', 'action_item'];

function parseQueryParams(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * GET /api/calendar/months
 *
 * Returns per-day event counts for the requested range. The grid uses these
 * to put a small total-count badge on each day cell — clicking a cell hits
 * /api/calendar/day for the full breakdown.
 *
 * Query params:
 *   start (required) YYYY-MM-DD — inclusive, treated as local-tz midnight
 *   end   (required) YYYY-MM-DD — exclusive, treated as local-tz midnight
 *   email (optional)            — when set, scope meetings to days the user
 *                                 attended (matches /api/today/meetings logic)
 *
 * Range is capped at 100 days to keep the query bounded; UIs only need a
 * couple months at a time.
 *
 * Returns: { days: [{ date, meetings, signals_due, signals_fired, emails, total }] }
 */
export async function listCalendarMonthsCore(queryFn, params, principal = null, gcalEmailScope = null) {
  const start = params.start;
  const end = params.end;
  if (!isIsoDate(start) || !isIsoDate(end)) {
    return { error: 'start and end must be YYYY-MM-DD' };
  }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (!(startDate < endDate)) {
    return { error: 'start must be before end' };
  }
  const dayCount = Math.round((endDate - startDate) / 86400000);
  if (dayCount > 100) {
    return { error: 'range too large (max 100 days)' };
  }

  const email = (params.email || '').trim().toLowerCase();
  const values = [start, end];
  let participantFilter = '';
  if (email) {
    values.push(email);
    participantFilter = `
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
        WHERE LOWER(p->>'email') = $${values.length}
      )`;
  }

  // STAQPRO-608: scope the gcal events CTE (inbox.calendar_events, owner_org_id
  // added by mig 148) fail-closed. The other CTEs read tables owned by separate
  // 608 work items; only the calendar_events read is scoped here. The
  // signal_fired CTE already reserves $${values.length + 1} for NOTABLE_SIGNAL_TYPES
  // (pushed at the end), so the visibleClause placeholders begin one slot later.
  const gcalScope = visibleClause(principal, {
    ownerOrgCol: 'ce.owner_org_id',
    startIndex: values.length + 2,
  });

  // OPT-126: per-member calendar scoping. gcalEmailScope is an array of
  // account_emails the viewer may see (own + explicitly included teammates),
  // or null for unfiltered (agent JWT / legacy callers). Empty array → no
  // gcal rows (fail-closed for unidentified viewers). Placeholder lands
  // after NOTABLE_SIGNAL_TYPES and the visibleClause params (push order below).
  let gcalEmailFilter = '';
  if (Array.isArray(gcalEmailScope)) {
    const idx = values.length + 2 + gcalScope.params.length;
    gcalEmailFilter = `AND LOWER(ce.account_email) = ANY($${idx}::text[])`;
  }

  const sql = `
    WITH days AS (
      SELECT generate_series(
        $1::date,
        ($2::date - INTERVAL '1 day')::date,
        INTERVAL '1 day'
      )::date AS d
    ),
    meeting_counts AS (
      SELECT (${HAPPENED_AT_EXPR})::date AS d, COUNT(*)::int AS n
      FROM content.documents d
      WHERE ${MEETING_DOC_PREDICATE}
        AND ${HAPPENED_AT_EXPR} >= $1::date
        AND ${HAPPENED_AT_EXPR} <  $2::date
        ${participantFilter}
      GROUP BY 1
    ),
    voice_memo_counts AS (
      SELECT m.received_at::date AS d, COUNT(*)::int AS n
      FROM inbox.messages m
      WHERE m.channel = 'webhook'
        AND 'webhook:voice_memo' = ANY(m.labels)
        AND m.received_at >= $1::date
        AND m.received_at <  $2::date
      GROUP BY 1
    ),
    signal_due_counts AS (
      SELECT s.due_date::date AS d, COUNT(*)::int AS n
      FROM inbox.signals s
      WHERE s.resolved = false
        AND s.due_date IS NOT NULL
        AND s.due_date >= $1::date
        AND s.due_date <  $2::date
      GROUP BY 1
    ),
    signal_fired_counts AS (
      SELECT s.created_at::date AS d, COUNT(*)::int AS n
      FROM inbox.signals s
      WHERE s.signal_type = ANY($${values.length + 1}::text[])
        AND s.created_at >= $1::date
        AND s.created_at <  $2::date
      GROUP BY 1
    ),
    email_counts AS (
      SELECT m.received_at::date AS d, COUNT(DISTINCT m.id)::int AS n
      FROM inbox.messages m
      JOIN inbox.signals s ON s.message_id = m.id
      WHERE m.channel = 'email'
        AND m.received_at >= $1::date
        AND m.received_at <  $2::date
      GROUP BY 1
    ),
    -- Distinct on COALESCE(ical_uid, gcal_event_id) keeps the same meeting
    -- from being double-counted when multiple watched accounts attend it.
    gcal_event_counts AS (
      SELECT ce_day::date AS d, COUNT(*)::int AS n
      FROM (
        SELECT DISTINCT ON (COALESCE(ce.ical_uid, ce.gcal_event_id))
          ce.start_at AS ce_day
        FROM inbox.calendar_events ce
        WHERE ce.status <> 'cancelled'
          AND ${gcalScope.sql}
          ${gcalEmailFilter}
          AND ce.start_at >= $1::date
          AND ce.start_at <  $2::date
        ORDER BY COALESCE(ce.ical_uid, ce.gcal_event_id), ce.start_at ASC
      ) sub
      GROUP BY 1
    )
    SELECT
      to_char(days.d, 'YYYY-MM-DD') AS date,
      COALESCE(mc.n, 0) + COALESCE(vmc.n, 0) AS meetings,
      COALESCE(sd.n, 0)                       AS signals_due,
      COALESCE(sf.n, 0)                       AS signals_fired,
      COALESCE(ec.n, 0)                       AS emails,
      COALESCE(gc.n, 0)                       AS gcal_events,
      COALESCE(mc.n, 0) + COALESCE(vmc.n, 0)
        + COALESCE(sd.n, 0) + COALESCE(sf.n, 0)
        + COALESCE(ec.n, 0) + COALESCE(gc.n, 0) AS total
    FROM days
    LEFT JOIN meeting_counts      mc  ON mc.d  = days.d
    LEFT JOIN voice_memo_counts   vmc ON vmc.d = days.d
    LEFT JOIN signal_due_counts   sd  ON sd.d  = days.d
    LEFT JOIN signal_fired_counts sf  ON sf.d  = days.d
    LEFT JOIN email_counts        ec  ON ec.d  = days.d
    LEFT JOIN gcal_event_counts   gc  ON gc.d  = days.d
    ORDER BY days.d ASC
  `;

  values.push(NOTABLE_SIGNAL_TYPES);
  values.push(...gcalScope.params);
  if (Array.isArray(gcalEmailScope)) {
    values.push(gcalEmailScope.map((e) => String(e).toLowerCase()));
  }
  const { rows } = await queryFn(sql, values);
  return { days: rows };
}

/**
 * GET /api/calendar/day
 *
 * Returns every event we know about for a single day, ordered by time.
 *
 * Query params:
 *   date  (required) YYYY-MM-DD
 *   email (optional) — when set, scope meetings to days the user attended.
 *                      Email-significance and signal events are not scoped
 *                      yet; per-account email scoping is a follow-up.
 *
 * Each event has shape:
 *   { kind, id, time, title, subtitle, link_to, meta }
 *
 * link_to is the path the frontend should navigate to on click. It is null
 * when no detail surface exists yet (e.g. a signal that wasn't extracted from
 * a meeting).
 */
export async function getCalendarDayCore(queryFn, params, principal = null, gcalEmailScope = null) {
  const date = params.date;
  if (!isIsoDate(date)) return { error: 'date must be YYYY-MM-DD' };

  const email = (params.email || '').trim().toLowerCase();
  const dayStartTs = Date.parse(`${date}T00:00:00Z`);
  const dayEndTs = dayStartTs + 86_400_000;
  // Postgres does the +1 day in the WHERE clauses below via ::date + INTERVAL.
  // TZ caveat: ::date casts use server TZ (UTC). For sandboxed prod this is
  // close enough; per-caller TZ offset is a follow-up.

  // ── Meetings ───────────────────────────────────────────────────────────
  const meetingValues = [date];
  let meetingEmailFilter = '';
  if (email) {
    meetingValues.push(email);
    meetingEmailFilter = `
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
        WHERE LOWER(p->>'email') = $${meetingValues.length}
      )`;
  }

  const meetingSql = `
    SELECT
      d.id            AS document_id,
      d.source        AS source,
      d.source_id     AS source_id,
      d.title         AS title,
      d.participants  AS participants,
      ${HAPPENED_AT_EXPR} AS happened_at,
      m.id            AS message_id
    FROM content.documents d
    LEFT JOIN inbox.messages m
      ON m.channel = 'webhook'
     AND m.channel_id = d.source_id
    WHERE ${MEETING_DOC_PREDICATE}
      AND ${HAPPENED_AT_EXPR} >= $1::date
      AND ${HAPPENED_AT_EXPR} <  ($1::date + INTERVAL '1 day')
      ${meetingEmailFilter}
    ORDER BY ${HAPPENED_AT_EXPR} ASC
  `;
  const { rows: meetingRows } = await queryFn(meetingSql, meetingValues);

  // Voice memos land in inbox.messages, not content.documents — pull them in
  // alongside so the day view shows everything the user "talked through".
  const { rows: voiceMemoRows } = await queryFn(
    `
    SELECT
      m.id            AS message_id,
      m.subject       AS title,
      m.from_name     AS speaker,
      m.received_at   AS received_at
    FROM inbox.messages m
    WHERE m.channel = 'webhook'
      AND 'webhook:voice_memo' = ANY(m.labels)
      AND m.received_at >= $1::date
      AND m.received_at <  ($1::date + INTERVAL '1 day')
    ORDER BY m.received_at ASC
    `,
    [date],
  );

  // ── Signals due / fired ────────────────────────────────────────────────
  // Pull both in one query; we'll split client-side. Each row carries the
  // parent message's webhook label so we can decide whether to deep-link to
  // /meetings?id=X (when it came from a meeting) or render inline-only.
  const { rows: signalRows } = await queryFn(
    `
    SELECT
      s.id, s.signal_type, s.content, s.due_date, s.created_at,
      s.resolved, s.direction, s.message_id,
      m.channel       AS message_channel,
      m.labels        AS message_labels
    FROM inbox.signals s
    LEFT JOIN inbox.messages m ON m.id = s.message_id
    WHERE
      (
        s.resolved = false
        AND s.due_date IS NOT NULL
        AND s.due_date >= $1::date
        AND s.due_date <  ($1::date + INTERVAL '1 day')
      )
      OR (
        s.signal_type = ANY($2::text[])
        AND s.created_at >= $1::date
        AND s.created_at <  ($1::date + INTERVAL '1 day')
      )
    ORDER BY COALESCE(s.due_date, s.created_at) ASC
    `,
    [date, NOTABLE_SIGNAL_TYPES],
  );

  // ── Google Calendar events (STAQPRO-327) ───────────────────────────────
  // DISTINCT ON (COALESCE(ical_uid, gcal_event_id)) collapses the same
  // meeting being on multiple watched accounts down to one row. Cancellations
  // are excluded — the user wants the schedule, not the audit trail.
  // STAQPRO-608: scope the calendar_events read fail-closed (mig 148 added
  // owner_org_id). Placeholders start at $2 ($1 is `date`).
  const gcalScope = visibleClause(principal, { ownerOrgCol: 'ce.owner_org_id', startIndex: 2 });
  // OPT-126: per-member scoping — same semantics as listCalendarMonthsCore.
  const gcalValues = [date, ...gcalScope.params];
  let gcalEmailFilter = '';
  if (Array.isArray(gcalEmailScope)) {
    gcalValues.push(gcalEmailScope.map((e) => String(e).toLowerCase()));
    gcalEmailFilter = `AND LOWER(ce.account_email) = ANY($${gcalValues.length}::text[])`;
  }
  const { rows: gcalRows } = await queryFn(
    `
    SELECT DISTINCT ON (COALESCE(ce.ical_uid, ce.gcal_event_id))
      ce.id, ce.account_email, ce.gcal_event_id, ce.title, ce.location,
      ce.hangout_link, ce.organizer_email, ce.attendees,
      ce.start_at, ce.end_at, ce.all_day, ce.status
    FROM inbox.calendar_events ce
    WHERE ce.status <> 'cancelled'
      AND ${gcalScope.sql}
      ${gcalEmailFilter}
      AND ce.start_at >= $1::date
      AND ce.start_at <  ($1::date + INTERVAL '1 day')
    ORDER BY COALESCE(ce.ical_uid, ce.gcal_event_id), ce.start_at ASC
    `,
    gcalValues,
  );

  // ── Significant emails (have ≥1 signal extracted) ──────────────────────
  const { rows: emailRows } = await queryFn(
    `
    SELECT DISTINCT ON (m.id)
      m.id, m.subject, m.from_name, m.from_address, m.received_at,
      m.thread_id,
      (SELECT COUNT(*)::int FROM inbox.signals s WHERE s.message_id = m.id) AS signal_count
    FROM inbox.messages m
    WHERE m.channel = 'email'
      AND m.received_at >= $1::date
      AND m.received_at <  ($1::date + INTERVAL '1 day')
      AND EXISTS (SELECT 1 FROM inbox.signals s WHERE s.message_id = m.id)
    ORDER BY m.id, m.received_at ASC
    `,
    [date],
  );

  // ── Shape into a unified event stream ──────────────────────────────────
  const events = [];

  for (const r of meetingRows) {
    const sourceLabel =
      r.source === 'tldv' ? 'TL;DV'
      : r.source === 'gemini' ? 'Google Meet'
      : 'Recording';
    const participants = Array.isArray(r.participants) ? r.participants : [];
    const speakerNames = participants
      .map((p) => p?.name || p?.email)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    events.push({
      kind: 'meeting',
      id: r.message_id || r.document_id,
      time: r.happened_at,
      title: r.title || 'Untitled meeting',
      subtitle: speakerNames ? `${sourceLabel} · ${speakerNames}` : sourceLabel,
      link_to: r.message_id ? `/meetings?id=${encodeURIComponent(r.message_id)}` : null,
      meta: { source: r.source, document_id: r.document_id },
    });
  }

  for (const r of voiceMemoRows) {
    events.push({
      kind: 'meeting',
      id: r.message_id,
      time: r.received_at,
      title: r.title || 'Voice memo',
      subtitle: r.speaker ? `Voice memo · ${r.speaker}` : 'Voice memo',
      link_to: `/meetings?id=${encodeURIComponent(r.message_id)}`,
      meta: { source: 'voice_memo' },
    });
  }

  for (const r of signalRows) {
    const dueTs = r.due_date ? Date.parse(r.due_date) : NaN;
    const createdTs = r.created_at ? Date.parse(r.created_at) : NaN;
    const isDueToday = !r.resolved
      && Number.isFinite(dueTs)
      && dueTs >= dayStartTs && dueTs < dayEndTs;
    const isFiredToday = NOTABLE_SIGNAL_TYPES.includes(r.signal_type)
      && Number.isFinite(createdTs)
      && createdTs >= dayStartTs && createdTs < dayEndTs;
    const fromMeeting = Array.isArray(r.message_labels)
      && (r.message_labels.includes('webhook:tldv')
          || r.message_labels.includes('webhook:gemini')
          || r.message_labels.includes('webhook:voice_memo'));
    const linkTo = fromMeeting && r.message_id
      ? `/meetings?id=${encodeURIComponent(r.message_id)}`
      : null;

    if (isDueToday) {
      events.push({
        kind: 'signal_due',
        id: r.id,
        time: r.due_date,
        title: r.content,
        subtitle: `Due · ${r.signal_type.replace('_', ' ')}${r.direction ? ` · ${r.direction}` : ''}`,
        link_to: linkTo,
        meta: { signal_type: r.signal_type, direction: r.direction },
      });
    }
    // Skip the "fired" entry when the same signal already shows as "due" today —
    // avoids the same row appearing twice in the panel.
    if (isFiredToday && !isDueToday) {
      events.push({
        kind: 'signal_fired',
        id: `fired:${r.id}`,
        time: r.created_at,
        title: r.content,
        subtitle: `Extracted · ${r.signal_type.replace('_', ' ')}`,
        link_to: linkTo,
        meta: { signal_type: r.signal_type, direction: r.direction },
      });
    }
  }

  for (const r of gcalRows) {
    const attendees = Array.isArray(r.attendees) ? r.attendees : [];
    const others = attendees
      .filter((a) => a && a.self !== true && a.resource !== true)
      .map((a) => a.displayName || a.email)
      .filter(Boolean);
    const subtitleParts = [];
    if (r.location) subtitleParts.push(r.location);
    if (others.length > 0) {
      const head = others.slice(0, 3).join(', ');
      const more = others.length > 3 ? ` +${others.length - 3}` : '';
      subtitleParts.push(`${head}${more}`);
    } else if (r.organizer_email) {
      subtitleParts.push(r.organizer_email);
    }
    events.push({
      kind: 'gcal_event',
      id: r.id,
      time: r.start_at,
      title: r.title || '(no title)',
      subtitle: subtitleParts.join(' · ') || 'Calendar',
      // Open the event in Google Calendar in a new tab. raw_event is
      // available on the row but we don't strictly need it for the link —
      // gcal supports an `eid` deep-link, but a generic /calendar/event?eid=
      // path requires a base64 of (eventId + ' ' + calendarId). Keeping
      // null until we want to invest in that.
      link_to: r.hangout_link || null,
      meta: {
        end_at: r.end_at,
        all_day: r.all_day,
        status: r.status,
        organizer_email: r.organizer_email,
        gcal_event_id: r.gcal_event_id,
        account_email: r.account_email,
      },
    });
  }

  for (const r of emailRows) {
    events.push({
      kind: 'email',
      id: r.id,
      time: r.received_at,
      title: r.subject || '(no subject)',
      subtitle: `Email · ${r.from_name || r.from_address}${r.signal_count > 0 ? ` · ${r.signal_count} signal${r.signal_count === 1 ? '' : 's'}` : ''}`,
      link_to: null, // no inbox detail page yet — surfaced for context only
      meta: { thread_id: r.thread_id, signal_count: r.signal_count },
    });
  }

  events.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return ta - tb;
  });

  return { date, events };
}

/** OPT-126: true iff this viewer may manage (add/remove/backfill) a watch.
 *  Mirrors mayManageAccount (api.js) — adminBypass (agent JWT) always may;
 *  otherwise the watch's account_email must be one of the viewer's own
 *  resolved emails. Unidentified viewers are denied (fail-closed). Watches
 *  have no shared/org-infra class: every watch belongs to whoever's
 *  workspace email it polls. */
export function mayManageWatch(viewer, watch) {
  if (!watch) return false;
  if (viewer?.adminBypass) return true;
  const emails = viewer?.emails || [];
  if (emails.length === 0) return false;
  return emails.includes(String(watch.account_email || '').toLowerCase());
}

// TODO(opt-166-p3): mixed principal — mayManageWatch() above has an explicit
// `if (viewer?.adminBypass) return true;` branch: a verified agent-JWT caller
// is granted full manage rights over every account's calendar watch,
// bypassing the emails-match check entirely. The GET routes' own comments
// document the same design ("null → unfiltered (agent JWT adminBypass...)").
// This is concrete, in-code proof that calendar.js is intentionally
// agent-reachable, not board-only. withBoardScope(req.auth) throws for any
// req.auth.role !== 'board', so wrapping any handler in this file (months,
// day, watches GET/POST/remove/backfill) would break that documented agent
// path — not INERT. Left unwrapped pending per-route reachability
// confirmation; this is the largest deviation from the route matrix's "SURE"
// confidence in this batch.
export function registerCalendarRoutes(routes, { withViewer, resolveViewerEmails } = {}) {
  // STAQPRO-608: resolve the tenancy principal for the calendar_events reads
  // (months grid + day panel). null principal → visibleClause 'FALSE' → zero
  // gcal rows, never an unscoped read. The non-calendar_events unions in those
  // cores are scoped by their own 608 work items.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // OPT-126: viewer resolution for per-member calendar scoping + watch
  // ownership. Injected from api.js (same helper the accounts routes use)
  // to avoid an import cycle. Absent (legacy tests) → null viewer.
  const resolveViewer = async (req) => {
    if (!resolveViewerEmails) return null;
    try {
      return await resolveViewerEmails(req);
    } catch {
      return null;
    }
  };

  // OPT-126: which account_emails may this request's gcal reads cover?
  //   - null  → unfiltered (agent JWT adminBypass, or registration without the
  //             helper — org boundary still enforced by visibleClause)
  //   - []    → no gcal rows (unidentified viewer, fail-closed)
  //   - [...] → viewer's own emails + ?include= teammates, where each include
  //             must match an existing watch's account_email IN THE VIEWER'S
  //             ORG (owner_org_id ∈ principal.readOrgIds; legacy NULL-org rows
  //             allowed, matching mig-148 backfill semantics). visibleClause on
  //             calendar_events.owner_org_id remains the second, independent
  //             org gate on the events themselves (Linus, OPT-126 review:
  //             validate at the source, don't lean on the downstream backstop).
  const resolveGcalEmailScope = async (req, params, viewer, principal) => {
    if (!resolveViewerEmails) return null;
    if (!viewer) return [];
    if (viewer.adminBypass) return null;
    const own = (viewer.emails || []).map((e) => String(e).toLowerCase());
    const include = String(params.include || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (include.length === 0) return own;
    const viewerOrgIds = principal?.readOrgIds || [];
    const r = await query(
      `SELECT DISTINCT LOWER(account_email) AS e
         FROM inbox.calendar_watches
        WHERE LOWER(account_email) = ANY($1::text[])
          AND (owner_org_id = ANY($2::uuid[]) OR owner_org_id IS NULL)`,
      [include, viewerOrgIds],
    );
    return [...new Set([...own, ...r.rows.map((x) => x.e)])];
  };

  routes.set('GET /api/calendar/months', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const params = parseQueryParams(req);
    const viewer = await resolveViewer(req);
    const emailScope = await resolveGcalEmailScope(req, params, viewer, principal);
    return listCalendarMonthsCore(query, params, principal, emailScope);
  });

  routes.set('GET /api/calendar/day', async (req) => {
    const principal = await resolvePrincipalFor(req);
    const params = parseQueryParams(req);
    const viewer = await resolveViewer(req);
    const emailScope = await resolveGcalEmailScope(req, params, viewer, principal);
    return getCalendarDayCore(query, params, principal, emailScope);
  });

  // STAQPRO-327 — multi-account calendar watch management.
  // OPT-126: viewer-scoped (OPT-115 sibling). Default mode lists only the
  // watches the viewer owns (their connected/board emails); `?scope=org` is a
  // read-only legend for the shared Calendar page — every watch, minimal
  // fields, error text redacted for watches you don't own.

  routes.set('GET /api/calendar/watches', async (req) => {
    const params = parseQueryParams(req);
    const viewer = await resolveViewer(req);

    if (params.scope === 'org') {
      // Identified board members + internal callers only; bare secret → [].
      if (!viewer || (!viewer.adminBypass && !viewer.ownerId)) return { watches: [] };
      const r = await query(
        `SELECT id, account_email, calendar_id, label, is_active,
                last_poll_at, last_error, created_at
           FROM inbox.calendar_watches
          ORDER BY created_at DESC`,
      );
      const own = (viewer.emails || []).map((e) => String(e).toLowerCase());
      return {
        watches: r.rows.map((w) => {
          const mine = viewer.adminBypass
            || own.includes(String(w.account_email || '').toLowerCase());
          return {
            ...w,
            mine,
            // Error detail can carry auth/internal specifics — keep the
            // message for your own watches, a bare marker for teammates'.
            last_error: mine ? w.last_error : (w.last_error ? 'sync error' : null),
          };
        }),
      };
    }

    // Manage mode: only your own watches. Unidentified viewer → empty.
    if (!viewer) return { watches: [] };
    if (viewer.adminBypass) {
      const r = await query(
        `SELECT id, account_email, calendar_id, label, is_active,
                last_poll_at, last_error, created_at
           FROM inbox.calendar_watches
          ORDER BY created_at DESC`,
      );
      return { watches: r.rows };
    }
    const emails = (viewer.emails || []).map((e) => String(e).toLowerCase());
    if (emails.length === 0) return { watches: [] };
    const r = await query(
      `SELECT id, account_email, calendar_id, label, is_active,
              last_poll_at, last_error, created_at
         FROM inbox.calendar_watches
        WHERE LOWER(account_email) = ANY($1::text[])
        ORDER BY created_at DESC`,
      [emails],
    );
    return { watches: r.rows };
  });

  routes.set('POST /api/calendar/watches', async (req, body) => {
    const accountEmail = String(body?.account_email || '').trim().toLowerCase();
    const calendarId = String(body?.calendar_id || 'primary').trim();
    const label = String(body?.label || '').trim() || `${accountEmail} (${calendarId})`;
    if (!accountEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
      return { error: 'account_email must be a valid email address' };
    }
    if (!calendarId) {
      return { error: 'calendar_id required (use "primary" for the default calendar)' };
    }
    // OPT-126: you connect your OWN calendars. The watch email must be one of
    // the viewer's resolved emails (board email or connected account). A
    // secondary calendar_id under your own email is fine — DWD polls it as you.
    const viewer = await resolveViewer(req);
    if (!mayManageWatch(viewer, { account_email: accountEmail })) {
      throw Object.assign(
        new Error('Forbidden: you can only add watches for your own connected email addresses'),
        { statusCode: 403 },
      );
    }
    try {
      const r = await query(
        `INSERT INTO inbox.calendar_watches (account_email, calendar_id, label, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (account_email, calendar_id)
           DO UPDATE SET label = EXCLUDED.label, is_active = true
         RETURNING id, account_email, calendar_id, label, is_active, last_poll_at, last_error, created_at`,
        [accountEmail, calendarId, label],
      );
      return { watch: r.rows[0] };
    } catch (err) {
      return { error: `Failed to add watch: ${err.message}` };
    }
  });

  routes.set('POST /api/calendar/watches/remove', async (req, body) => {
    const id = String(body?.id || '');
    if (!id) return { error: 'id required' };
    // OPT-126: viewer-first → fetch → 404 → 403 → mutate (the dispatcher only
    // upgrades HTTP status for THROWN errors — same contract as the accounts
    // mutate handlers).
    const viewer = await resolveViewer(req);
    const existing = await query(
      `SELECT id, account_email FROM inbox.calendar_watches WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) {
      throw Object.assign(new Error('Watch not found'), { statusCode: 404 });
    }
    if (!mayManageWatch(viewer, existing.rows[0])) {
      throw Object.assign(
        new Error('Forbidden: watch belongs to another board member'),
        { statusCode: 403 },
      );
    }
    await query(`DELETE FROM inbox.calendar_watches WHERE id = $1`, [id]);
    return { ok: true, deleted: id };
  });

  // Trigger a backfill for a single watch (or all when no filter is given).
  // Async-fires; caller polls GET /api/calendar/watches for last_poll_at.
  routes.set('POST /api/calendar/watches/backfill', async (req, body) => {
    const { backfillCalendarEvents, isCalendarBackfillRunning } =
      await import('../calendar/poller.js');
    if (isCalendarBackfillRunning()) {
      return { ok: false, error: 'A calendar backfill is already running.' };
    }
    const viewer = await resolveViewer(req);
    let accountEmail;
    let calendarId;
    if (body?.id) {
      const r = await query(
        `SELECT account_email, calendar_id FROM inbox.calendar_watches WHERE id = $1`,
        [body.id],
      );
      if (r.rows.length === 0) {
        throw Object.assign(new Error('Watch not found'), { statusCode: 404 });
      }
      if (!mayManageWatch(viewer, r.rows[0])) {
        throw Object.assign(
          new Error('Forbidden: watch belongs to another board member'),
          { statusCode: 403 },
        );
      }
      accountEmail = r.rows[0].account_email;
      calendarId = r.rows[0].calendar_id;
    } else if (body?.account_email) {
      accountEmail = String(body.account_email).trim().toLowerCase();
      if (!mayManageWatch(viewer, { account_email: accountEmail })) {
        throw Object.assign(
          new Error('Forbidden: you can only backfill your own calendars'),
          { statusCode: 403 },
        );
      }
      calendarId = body.calendar_id ? String(body.calendar_id) : undefined;
    } else if (!viewer?.adminBypass) {
      // OPT-126: the no-filter "backfill everything" form is internal-only.
      throw Object.assign(
        new Error('Forbidden: specify a watch id to backfill'),
        { statusCode: 403 },
      );
    }
    const lookbackDays = Math.min(400, Math.max(1, Number(body?.lookback_days) || 90));
    // Fire-and-forget; the response confirms acceptance.
    backfillCalendarEvents({ accountEmail, calendarId, lookbackDays })
      .then((res) => console.log(`[calendar-backfill] route-triggered done: ${JSON.stringify(res)}`))
      .catch((err) => console.error(`[calendar-backfill] route-triggered failed: ${err.message}`));
    return { ok: true, started: true, accountEmail: accountEmail || 'all', lookbackDays };
  });
}
