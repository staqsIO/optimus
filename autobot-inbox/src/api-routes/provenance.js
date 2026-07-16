/**
 * OPT-2 — Board provenance click-through ("follow the flow of information").
 *
 *   GET /api/provenance/:source_meeting_id
 *     — assembles the causal chain for one meeting identity:
 *         meeting → signals → tasks → tickets → calendar event.
 *
 * Provenance IDs were stamped through the chain by the meeting→work classifier
 * (migration 151, lib/runtime/meeting-classifier.js): a single stable meeting
 * identity key (Google's gcal_event_id when present, else a deterministic hash
 * of 15-min-rounded start + sorted participants + normalized title) is written
 * to agent_graph.signals.source_meeting_id AND inbox.human_tasks.signal_meeting_id.
 * That shared key is what lets the board jump task → ticket → source meeting →
 * calendar event in one click (OPT-2 / Isaias's "follow the flow").
 *
 * Tenancy (P1, fail-closed): inbox.human_tasks (owner_org_id, mig 134) and
 * inbox.calendar_events (owner_org_id, mig 148) are scoped with visibleClause.
 * agent_graph.signals has no owner_org_id; its rows are returned ONLY after the
 * access gate confirms the viewer owns an in-org task or calendar event for this
 * meeting (transitive gate — see `visible` below). When the principal is null
 * (unauthed / unit-test) visibleClause emits FALSE → zero rows, so the gate
 * fails closed and signals are never returned unscoped.
 *
 * Engagements/drafts belong to the conceptual chain (OPT-2 design §1) but
 * engagements.engagements carries no meeting-link column today, so those arrays
 * are returned empty and wired in a follow-up once an engagement→meeting key
 * exists. The board panel degrades gracefully on partial chains (design §6).
 */

import { query } from '../db.js';
import { visibleClause } from '../../../lib/tenancy/scope.js';

function meetingIdFromReq(req) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  // Exactly ['api','provenance','<id>']. Be no more permissive than the
  // routeKeyFor regex (single [^/]+ segment) — taking the last segment of a
  // deeper path would silently mis-extract the id if a sub-route is ever added.
  if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'provenance') return '';
  return decodeURIComponent(parts[2]);
}

export function registerProvenanceRoutes(routes, { withViewer } = {}) {
  // withViewer is injected by api.js (board_members ↔ viewer ↔ principal bridge).
  // When absent/throwing the principal is null → visibleClause emits FALSE →
  // zero rows, never an unscoped read.
  const resolvePrincipalFor = async (req) => {
    if (!withViewer) return null;
    try {
      return (await withViewer(req)).principal;
    } catch {
      return null;
    }
  };

  // TODO(opt-166-p3): mixed principal — unlike today.js/human-tasks.js/
  // guardrails.js, this handler has no requireBoard()-style throwing guard.
  // resolvePrincipalFor() fails OPEN to `principal = null` (not a 403) for any
  // caller withViewer can't resolve, and the handler still returns a 200
  // (visible:false) rather than erroring. withBoardScope(req.auth) throws for
  // any req.auth.role !== 'board', so wrapping unconditionally would flip a
  // currently-succeeding non-board/unauthenticated caller's 200 into a 500 —
  // not INERT. Left unwrapped pending per-caller reachability confirmation.
  routes.set('GET /api/provenance/:source_meeting_id', async (req) => {
    const meetingId = meetingIdFromReq(req);
    if (!meetingId) return { error: 'Missing source_meeting_id' };

    const principal = await resolvePrincipalFor(req);

    // ── Tasks + tickets (org-scoped: inbox.human_tasks.owner_org_id) ──────────
    const taskArgs = [meetingId];
    const tv = visibleClause(principal, {
      ownerOrgCol: 'owner_org_id',
      startIndex: taskArgs.length + 1,
    });
    taskArgs.push(...tv.params);
    const taskRows = (await query(
      `SELECT id, title, description, status, priority, task_type,
              linear_issue_id, linear_issue_url, signal_meeting_id, origin,
              engagement_id, created_at, updated_at
         FROM inbox.human_tasks
        WHERE signal_meeting_id = $1
          AND deleted_at IS NULL
          AND ${tv.sql}
        ORDER BY created_at ASC`,
      taskArgs,
    )).rows;

    // ── Calendar event (org-scoped: inbox.calendar_events.owner_org_id) ───────
    // source_meeting_id equals Google's gcal_event_id when the meeting came from
    // a calendar invite. May be absent for hash-keyed (transcript-only) meetings.
    const calArgs = [meetingId];
    const cv = visibleClause(principal, {
      ownerOrgCol: 'owner_org_id',
      startIndex: calArgs.length + 1,
    });
    calArgs.push(...cv.params);
    const calRows = (await query(
      `SELECT id, gcal_event_id, ical_uid, title, description, location,
              hangout_link, start_at, end_at, organizer_email, status
         FROM inbox.calendar_events
        WHERE gcal_event_id = $1
          AND ${cv.sql}
        ORDER BY start_at DESC
        LIMIT 1`,
      calArgs,
    )).rows;
    const calendarEvent = calRows[0] || null;

    // ── Access gate (P1): the viewer may see this meeting's chain iff they own
    // an in-org task or calendar event for it. Without an org anchor we refuse —
    // agent_graph.signals has no tenancy column, so it is gated transitively. ──
    const visible = taskRows.length > 0 || calendarEvent !== null;
    if (!visible) {
      return {
        meeting_id: meetingId,
        visible: false,
        calendar_event: null,
        signals: [],
        tasks: [],
        tickets: [],
        engagements: [],
        drafts: [],
      };
    }

    // ── Signals (meeting-origin). agent_graph.signals has no owner_org_id, so
    // it cannot be org-filtered per-row; rows are returned only after the
    // org-scoped access gate (`visible`) confirms an in-org task/calendar anchor
    // for this same meeting id.
    //
    // RESIDUAL RISK (bounded, accepted for now): source_meeting_id is globally
    // unique when it is a Google gcal_event_id, but the fallback identity is a
    // hash of (rounded start + sorted participants + normalized title). Two orgs
    // could in principle collide on a generic meeting ("Sync", same slot,
    // overlapping domains); the colliding org would then see THESE rows. The
    // exposure is minimized: only non-content metadata is selected (type,
    // adapter, origin, timestamps) — never signal payload/body. The correct
    // long-term fix is owner_org_id on agent_graph.signals (follow-up OPT-2.1).
    // Prod is single-tenant (Staqs) today, so the collision surface is currently
    // empty. tenancy:allow-unscoped — see access gate above.
    const signalRows = (await query(
      `SELECT id, signal_type, source_adapter, source_meeting_id, origin,
              project_id, created_at
         FROM agent_graph.signals
        WHERE source_meeting_id = $1
          AND origin = 'meeting'
        ORDER BY created_at ASC`,
      [meetingId],
    )).rows;

    const tickets = taskRows.filter((t) => t.linear_issue_id);

    return {
      meeting_id: meetingId,
      visible: true,
      calendar_event: calendarEvent,
      signals: signalRows,
      tasks: taskRows,
      tickets,
      // Conceptual chain continues to engagements → drafts; no meeting-link
      // column on engagements.engagements yet (OPT-2 follow-up).
      engagements: [],
      drafts: [],
    };
  });
}
