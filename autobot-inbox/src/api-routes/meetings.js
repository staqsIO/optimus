/**
 * Meetings ingest surface.
 *
 *   GET /api/meetings  — Unified list across the three live transcript sources:
 *                        voice_memo (AssemblyAI), tldv (Drive watcher), gemini_meet
 *                        (Drive watcher). Each writes to inbox.messages with
 *                        channel='webhook' and a `webhook:<source>` label; the
 *                        label is the discriminator. Joins agent_graph.work_items
 *                        for triage status and inbox.signals for extracted
 *                        commitments/asks/decisions/etc.
 *
 *   GET /api/meetings/:id — Single meeting with full transcript, signals, and
 *                           voice-memo audio details when applicable.
 *
 * Per SPEC §12 there are no cross-schema FKs, but cross-schema reads are fine
 * — the join itself documents the envelope/extraction layering (Liotta).
 */

import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

const SUPPORTED_SOURCES = ['voice_memo', 'tldv', 'gemini_meet'];
const LABEL_BY_SOURCE = {
  voice_memo: 'webhook:voice_memo',
  tldv: 'webhook:tldv',
  gemini_meet: 'webhook:gemini',
};

function parseQueryParams(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

export async function listMeetingsCore(queryFn, params, principal) {
  const limit = Math.min(parseInt(params.limit || '50', 10), 200);
  const offset = Math.max(parseInt(params.offset || '0', 10), 0);

  const conditions = [`m.channel = 'webhook'`];
  const values = [];

  if (params.source && SUPPORTED_SOURCES.includes(params.source)) {
    values.push(LABEL_BY_SOURCE[params.source]);
    conditions.push(`$${values.length} = ANY(m.labels)`);
  } else {
    const labelArr = SUPPORTED_SOURCES.map((s) => LABEL_BY_SOURCE[s]);
    values.push(labelArr);
    conditions.push(`m.labels && $${values.length}::text[]`);
  }

  values.push(limit);
  const limitIdx = values.length;
  values.push(offset);
  const offsetIdx = values.length;

  // OPT-166 P3: deny-by-default tenant scoping (closes the HTTP-fuzz leak where a
  // bare api_secret read owner rows). Unidentified caller → principal null →
  // visibleClause 'FALSE' → zero rows; verified agent-JWT (adminBypass) → 'TRUE'
  // (cross-org, by design — see the registerMeetingsRoutes note); board viewer →
  // own+org rows. principal===undefined (unit callers with a mock db) → 'FALSE'
  // with empty params, so the existing param positions ($limit/$offset) are
  // unchanged. Params are appended AFTER limit/offset to keep those indices stable.
  const scope = visibleClause(principal, { ownerOrgCol: 'm.owner_org_id', startIndex: values.length + 1 });
  conditions.push(scope.sql);
  values.push(...scope.params);

  const sql = `
    SELECT
      m.id                              AS message_id,
      m.received_at,
      m.from_name                       AS primary_speaker,
      m.subject                         AS title,
      m.snippet                         AS transcript_snippet,
      m.labels,
      CASE
        WHEN 'webhook:voice_memo' = ANY(m.labels) THEN 'voice_memo'
        WHEN 'webhook:tldv'       = ANY(m.labels) THEN 'tldv'
        WHEN 'webhook:gemini'     = ANY(m.labels) THEN 'gemini_meet'
      END                               AS source,
      m.work_item_id,
      w.status                          AS work_item_status,
      w.title                           AS work_item_title,
      vm.tracking_id,
      vm.transcript_id,
      vm.audio_url,
      (vm.metadata->>'audioBytes')      AS audio_bytes,
      (vm.metadata->>'recordedAt')      AS recorded_at,
      (vm.metadata->>'name')            AS recording_name,
      (
        SELECT COALESCE(json_agg(s_row ORDER BY s_row.created_at), '[]'::json)
        FROM (
          SELECT id, signal_type, content, confidence, due_date, resolved,
                 direction, domain, metadata, created_at
          FROM inbox.signals
          WHERE message_id = m.id
        ) s_row
      )                                 AS extracted_signals,
      -- FR-38: count of human_tasks promoted from this meeting that made it
      -- to Linear (linear_issue_id populated). Soft-deleted rows excluded.
      (
        SELECT COUNT(*)::int
        FROM inbox.human_tasks t
        WHERE t.message_id = m.id
          AND t.deleted_at IS NULL
          AND t.linear_issue_id IS NOT NULL
      )                                 AS human_task_count
    FROM inbox.messages m
    LEFT JOIN agent_graph.work_items w ON w.id = m.work_item_id
    LEFT JOIN inbox.voice_memo_pending vm ON vm.message_id::text = m.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.received_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const { rows } = await queryFn(sql, values);
  return { meetings: rows, limit, offset };
}

export async function getMeetingCore(queryFn, messageId, principal) {
  if (!messageId) return { error: 'message_id required' };

  // OPT-166 P3: deny-by-default tenant scoping — same seam as listMeetingsCore.
  // $1=messageId, $2=label array, so the visible-clause params start at $3.
  // principal===undefined (unit callers) → 'FALSE' + empty params → the [$1,$2]
  // positions the mock-db tests assert on are unchanged.
  const scope = visibleClause(principal, { ownerOrgCol: 'm.owner_org_id', startIndex: 3 });

  const { rows } = await queryFn(
    `
    SELECT
      m.id                              AS message_id,
      m.received_at,
      m.from_name                       AS primary_speaker,
      m.subject                         AS title,
      m.snippet                         AS transcript,
      m.labels,
      CASE
        WHEN 'webhook:voice_memo' = ANY(m.labels) THEN 'voice_memo'
        WHEN 'webhook:tldv'       = ANY(m.labels) THEN 'tldv'
        WHEN 'webhook:gemini'     = ANY(m.labels) THEN 'gemini_meet'
      END                               AS source,
      m.work_item_id,
      w.status                          AS work_item_status,
      w.title                           AS work_item_title,
      w.assigned_to                     AS work_item_assigned_to,
      vm.tracking_id,
      vm.transcript_id,
      vm.audio_url,
      (vm.metadata->>'audioBytes')      AS audio_bytes,
      (vm.metadata->>'recordedAt')      AS recorded_at,
      (vm.metadata->>'name')            AS recording_name,
      vm.status                         AS voice_memo_status,
      (
        SELECT COALESCE(json_agg(s_row ORDER BY s_row.created_at), '[]'::json)
        FROM (
          SELECT id, signal_type, content, confidence, due_date, resolved,
                 direction, domain, metadata, created_at
          FROM inbox.signals
          WHERE message_id = m.id
        ) s_row
      )                                 AS extracted_signals,
      -- FR-38: human-task count for the detail view (same predicate as list).
      (
        SELECT COUNT(*)::int
        FROM inbox.human_tasks t
        WHERE t.message_id = m.id
          AND t.deleted_at IS NULL
          AND t.linear_issue_id IS NOT NULL
      )                                 AS human_task_count
    FROM inbox.messages m
    LEFT JOIN agent_graph.work_items w ON w.id = m.work_item_id
    LEFT JOIN inbox.voice_memo_pending vm ON vm.message_id::text = m.id
    WHERE m.id = $1
      AND m.channel = 'webhook'
      AND m.labels && $2::text[]
      AND ${scope.sql}
    `,
    [messageId, SUPPORTED_SOURCES.map((s) => LABEL_BY_SOURCE[s]), ...scope.params],
  );

  if (rows.length === 0) return { error: 'meeting not found' };
  return { meeting: rows[0] };
}

// Per-source meeting-time precedence (kept in sync with api-routes/calendar.js):
//   1. For gemini docs: parse the actual meeting time out of the title — the
//      Drive watcher doesn't set metadata.happenedAt, so the fallback would
//      otherwise land on the file-creation moment (hours after the meeting).
//      Title pattern: "<Name> - YYYY/MM/DD HH:MM <TZ> - Notes by Gemini".
//   2. metadata.happenedAt when it's ISO-prefixed (tldv writes ISO; older
//      rows have JS Date.toString() that PG can't cast — those fall through).
//   3. created_at as last resort.
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

/**
 * GET /api/today/meetings — meetings the logged-in user attended today, with
 * the action items and commitments extracted from each one.
 *
 * Meetings are filtered by attendee (so the viewer only sees meetings they
 * were on), but the per-meeting action items surface what *anyone* in the
 * room committed to — not just the viewer. Resolved signals are still hidden.
 *
 * Query params:
 *   email       (required unless all=1) — match against content.documents.participants[].email
 *   start_iso   (required) — start of "today" in the caller's TZ, ISO string
 *   end_iso     (required) — end of "today" in the caller's TZ, ISO string
 *   all         (optional) — when truthy, skip the email filter and return every
 *                            meeting in the window. Used for operator self-serve
 *                            testing on the sandboxed prod environment.
 *
 * Returns: { meetings: [{ id, source, title, happened_at, action_items: [...] }] }
 */
export async function listTodayMeetingsCore(queryFn, params, principal, viewer) {
  const adminBypass = !!principal?.adminBypass;
  const startIso = params.start_iso;
  const endIso = params.end_iso;
  if (!startIso || !endIso) return { error: 'start_iso and end_iso required' };

  // all=1 is an operator-testing bypass that skips the attendee filter. It is
  // honored ONLY for a verified admin (agent JWT); a request param can never let
  // a board operator widen past their own meetings (STAQPRO-596).
  const skipEmailFilter = adminBypass &&
    (String(params.all || '').toLowerCase() === '1' ||
     String(params.all || '').toLowerCase() === 'true');

  // Which attendee emails the viewer may filter on. A non-admin caller is pinned
  // to their own verified board-member emails — the request `email`/`?as=` param
  // cannot be used to view as someone else. Admins may pass an explicit email.
  //
  // NOTE on the admin path: for adminBypass callers visibleClause() returns
  // 'TRUE', so the org boundary below is intentionally lifted — a verified agent
  // (agent-JWT only; never request-spoofable) is trusted org-wide and the email
  // it passes is the ONLY filter. Do not "fix" this by re-scoping admins to an
  // org; agent tooling depends on the cross-org view. The boundary for untrusted
  // board operators is the non-admin branch + the org clause appended below.
  let emails = [];
  if (!skipEmailFilter) {
    if (adminBypass) {
      const reqEmail = (params.email || '').trim().toLowerCase();
      if (reqEmail) emails = [reqEmail];
    } else {
      emails = (viewer?.emails || [])
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean);
      // No resolved identity and not an admin → nothing to match → empty.
      if (emails.length === 0) return { meetings: [] };
    }
  }

  const values = [startIso, endIso];
  let participantFilter = '';
  if (!skipEmailFilter) {
    values.push(emails);
    participantFilter = `
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
          WHERE LOWER(p->>'email') = ANY($${values.length}::text[])
        )`;
  }

  // Hard tenant boundary: scope content.documents by owner org, fail-closed
  // (unresolved principal → 'FALSE' → zero rows). Mirrors the STAQPRO-588 fix.
  const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: values.length + 1 });
  values.push(...v.params);

  const sql = `
    WITH today_docs AS (
      SELECT
        d.id          AS document_id,
        d.source      AS source,
        d.source_id   AS source_id,
        d.title       AS title,
        d.format      AS format,
        d.metadata    AS metadata,
        d.participants,
        ${HAPPENED_AT_EXPR} AS happened_at
      FROM content.documents d
      WHERE d.deleted_at IS NULL
        AND (
          d.source IN ('tldv','gemini')
          OR (d.source = 'drive' AND d.format IN ('tldv','gemini'))
        )
        AND ${HAPPENED_AT_EXPR} >= $1::timestamptz
        AND ${HAPPENED_AT_EXPR} < $2::timestamptz
        AND ${v.sql}
        ${participantFilter}
    )
    SELECT
      td.document_id,
      td.source,
      td.source_id,
      td.title,
      td.happened_at,
      td.metadata,
      td.participants,
      -- OPT-2: the meeting's canonical source_meeting_id — the EXACT key that
      -- GET /api/provenance/:source_meeting_id matches on, so the board can open
      -- the provenance panel for this meeting. Resolved from the meeting.received
      -- signal stamped at transcript ingest (emit-meeting-received.js writes
      -- payload.document_id = content.documents.id and mig 151 lifts
      -- source_meeting_id to a column). NULL when no meeting signal exists yet
      -- (nothing to trace → the board hides the trace icon).
      -- tenancy:allow-unscoped — correlated to the already org-scoped td/document
      -- row; exposes only the id string (agent_graph.signals has no owner_org_id).
      (
        SELECT sig.source_meeting_id
          FROM agent_graph.signals sig
         WHERE sig.payload->>'document_id' = td.document_id::text
           AND sig.origin = 'meeting'
           AND sig.source_meeting_id IS NOT NULL
         ORDER BY sig.created_at DESC
         LIMIT 1
      ) AS source_meeting_id,
      m.id AS message_id,
      (
        SELECT COALESCE(json_agg(s_row ORDER BY s_row.created_at), '[]'::json)
        FROM (
          SELECT s.id, s.signal_type, s.content, s.due_date, s.confidence,
                 s.direction, s.domain, s.metadata, s.created_at
          FROM inbox.signals s
          WHERE s.message_id = m.id
            AND s.signal_type IN ('action_item','commitment','request')
            AND s.resolved = false
        ) s_row
      ) AS action_items
    FROM today_docs td
    LEFT JOIN inbox.messages m
      ON m.channel = 'webhook'
     AND m.channel_id = td.source_id
    ORDER BY td.happened_at DESC
  `;
  const { rows } = await queryFn(sql, values);
  return { meetings: rows.map(r => ({ ...r, action_items: r.action_items || [] })) };
}

/**
 * GET /api/today/meeting-attendees — distinct attendee emails across today's
 * ingested meetings. Used by the empty state on /today to suggest "view as"
 * links so an operator whose login email isn't in any meeting can still test
 * the page. Sorted by name when available, then email.
 *
 * Scope (STAQPRO-596): org-bounded via visibleClause (fail-closed) — a caller
 * only ever sees attendees of their OWN org's meetings. Within that org the list
 * is intentionally broad (every attendee, not just the viewer's own meetings):
 * it powers the within-org view-as suggestions, and is not a cross-tenant read.
 */
export async function listTodayAttendeesCore(queryFn, params, principal) {
  const startIso = params.start_iso;
  const endIso = params.end_iso;
  if (!startIso || !endIso) return { error: 'start_iso and end_iso required' };

  const values = [startIso, endIso];
  // Hard tenant boundary: only attendees of the viewer's own org's meetings are
  // listed, fail-closed (unresolved principal → zero rows). Mirrors STAQPRO-588.
  const v = visibleClause(principal, { ownerOrgCol: 'd.owner_org_id', startIndex: values.length + 1 });
  values.push(...v.params);

  const sql = `
    SELECT DISTINCT
      LOWER(p->>'email') AS email,
      MAX(p->>'name') AS name,
      COUNT(DISTINCT d.id) AS meeting_count
    FROM content.documents d,
         LATERAL jsonb_array_elements(COALESCE(d.participants,'[]'::jsonb)) p
    WHERE d.deleted_at IS NULL
      AND (
        d.source IN ('tldv','gemini')
        OR (d.source = 'drive' AND d.format IN ('tldv','gemini'))
      )
      AND ${HAPPENED_AT_EXPR} >= $1::timestamptz
      AND ${HAPPENED_AT_EXPR} < $2::timestamptz
      AND ${v.sql}
      AND p->>'email' IS NOT NULL
      AND p->>'email' <> ''
    GROUP BY LOWER(p->>'email')
    ORDER BY meeting_count DESC, email ASC
    LIMIT 25
  `;
  const { rows } = await queryFn(sql, values);
  return { attendees: rows };
}

// OPT-166 P3: all 4 routes below now resolve a tenancy `principal` via
// resolveViewer and pass it into the *Core functions, which apply
// visibleClause (deny-by-default: an unidentified caller → 'FALSE' → zero
// rows). A verified agent-JWT caller (viewer?.adminBypass) still gets the
// cross-org view by design — visibleClause returns 'TRUE' for adminBypass, and
// the STAQPRO-596 note in the *Core functions documents why ("Do not 'fix' this
// by re-scoping admins to an org; agent tooling depends on the cross-org
// view"). We deliberately do NOT wrap these in withBoardScope(req.auth): it
// throws for any req.auth.role !== 'board', which would break that agent-JWT
// path. The tenant boundary is the app-layer visibleClause, not an RLS scope —
// inbox.messages has permissive RLS (read USING(true)), so the flip alone does
// not filter it; this scoping is the only thing that closes the leak.
export function registerMeetingsRoutes(routes, { withViewer } = {}) {
  // Resolve the tenancy principal + viewer for the /today routes. withViewer is
  // injected by api.js (it owns the board_member ↔ viewer ↔ principal bridge).
  // When absent (e.g. a unit test) — or if resolution throws — reads fail closed:
  // null principal → visibleClause 'FALSE' → zero rows, never an unscoped read.
  const resolveViewer = async (req) => {
    if (!withViewer) return { principal: null, viewer: null };
    try {
      return await withViewer(req);
    } catch {
      return { principal: null, viewer: null };
    }
  };

  routes.set('GET /api/meetings', async (req) => {
    const { principal } = await resolveViewer(req);
    return listMeetingsCore(query, parseQueryParams(req), principal);
  });

  routes.set('GET /api/meetings/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const { principal } = await resolveViewer(req);
    return getMeetingCore(query, id, principal);
  });

  routes.set('GET /api/today/meetings', async (req) => {
    const { principal, viewer } = await resolveViewer(req);
    return listTodayMeetingsCore(query, parseQueryParams(req), principal, viewer);
  });

  routes.set('GET /api/today/meeting-attendees', async (req) => {
    const { principal } = await resolveViewer(req);
    return listTodayAttendeesCore(query, parseQueryParams(req), principal);
  });
}
