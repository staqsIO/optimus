// lib/content/meetings.js — Feature 007: the meeting identity layer over
// content.artifacts (migration 157).
//
// SERVER-INTERNAL-ONLY (same rule as create-artifact.js): every function here
// takes ownership as an EXPLICIT, TRUSTED argument. Never wire these to an HTTP
// route that derives owner from a request body — the HTTP edge derives the owner
// from the verified token / a board-validated row BEFORE calling in.
//
// Identity: meeting_fingerprint IS the computeSourceMeetingId() string
// (lib/runtime/meeting-identity.js) — `cal:` > `mtg:` > `src:`. It equals the
// source_meeting_id migration 151 stamps on agent_graph.signals, so the meeting
// row is the hub existing signals/tasks already reference by string.
//
// Dedup semantics (Feature 007 D3):
//   - WITHIN a scope (owner_org_id, owner_id-or-org-shared): upsert on the
//     uq_meetings_scope_fingerprint expression index — one row per meeting.
//   - ACROSS scopes: same fingerprint, separate rows, linked by query only.
//     No silent merge (P1). Promotion (personal -> org) is explicit + audited.

import { query, withTransaction } from '../db.js';
import { computeSourceMeetingId } from '../runtime/meeting-identity.js';
import { resolveCalendarEventId } from './calendar-reconciler.js';
import { attendeeEmailsOf } from '../rag/participants/normalize.js';
import { resolveSourcePrecedence } from './meeting-prefs.js';

// The sentinel the unique expression index folds NULL owner_id to (migration 157).
const ORG_SHARED_SENTINEL = '00000000-0000-0000-0000-000000000000';

// Q1 confidence tiers: which identity tier fired + input quality. Gates auto-merge
// (a 'weak' row never upserts onto a 'derived'/'calendar' row because its
// fingerprint differs; the rank is used so re-captures never DOWNGRADE a row).
const CONFIDENCE_RANK = { calendar: 3, derived: 2, weak: 1 };

// D4 primary pick is by source precedence, now CONFIGURABLE per-org/per-user
// (Feature 007). The ordered list lives in content.meeting_source_prefs and is
// resolved per meeting scope by resolveSourcePrecedence(); recomputePrimariesTx
// ranks with array_position over it. System default (when no pref is set):
// SYSTEM_DEFAULT_PRECEDENCE = drive (Gemini) > tldv > mcp — see meeting-prefs.js.

/**
 * Derive the meeting fingerprint + confidence from identity inputs.
 *
 * confidence:
 *   'calendar' — a real or reconciled calendar_event_id (the `cal:` tier).
 *   'derived'  — `mtg:` hash from REAL attendee emails (TLDv invitees, calendar).
 *   'weak'     — `mtg:` hash from doc-owner emails only, or the `src:` fallback.
 *                Callers signal this via participantsAreAttendees=false.
 *
 * @returns {{fingerprint: string, confidence: string}|null} null when nothing
 *   identifying was supplied (caller should skip meeting linkage, not throw).
 */
export function deriveMeetingIdentity({
  calendarEventId = null,
  title = '',
  startTime = null,
  participantEmails = [],
  fallbackId = null,
  participantsAreAttendees = true,
} = {}) {
  const fingerprint = computeSourceMeetingId({
    calendarEventId, title, startTime, participantEmails, fallbackId,
  });
  if (!fingerprint) return null;
  let confidence = 'weak';
  if (fingerprint.startsWith('cal:')) confidence = 'calendar';
  else if (fingerprint.startsWith('mtg:') && participantsAreAttendees
           && Array.isArray(participantEmails) && participantEmails.length > 0) {
    confidence = 'derived';
  }
  return { fingerprint, confidence };
}

/**
 * Upsert a meeting row within the caller's transaction (the within-scope dedup).
 *
 * ON CONFLICT on the scope expression index: a re-capture refreshes metadata,
 * never downgrades confidence, and fills calendar_event_id/started_at/participants
 * when the new capture knows more than the row does (COALESCE keeps prior values).
 *
 * @param {object} client - pg client inside an open transaction
 * @returns {Promise<{id: string, fingerprint: string}>}
 */
export async function upsertMeetingTx(client, {
  fingerprint,
  confidence = 'weak',
  title = null,
  startedAt = null,
  participants = [],
  calendarEventId = null,
  ownerOrgId,
  ownerId = null,
  createdBy = null,
}) {
  if (!ownerOrgId) throw new Error('upsertMeetingTx: ownerOrgId is required (no silent default)');
  if (!fingerprint) throw new Error('upsertMeetingTx: fingerprint is required');
  const rank = CONFIDENCE_RANK[confidence] ? confidence : 'weak';

  const res = await client.query(
    `INSERT INTO content.meetings
       (meeting_fingerprint, fingerprint_confidence, title, started_at,
        participants, calendar_event_id, owner_org_id, owner_id, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (owner_org_id, COALESCE(owner_id, '${ORG_SHARED_SENTINEL}'::uuid), meeting_fingerprint)
       DO UPDATE SET
         -- Never downgrade confidence; a better capture upgrades the row.
         fingerprint_confidence = CASE
           WHEN (CASE EXCLUDED.fingerprint_confidence WHEN 'calendar' THEN 3 WHEN 'derived' THEN 2 ELSE 1 END)
              > (CASE content.meetings.fingerprint_confidence WHEN 'calendar' THEN 3 WHEN 'derived' THEN 2 ELSE 1 END)
           THEN EXCLUDED.fingerprint_confidence
           ELSE content.meetings.fingerprint_confidence END,
         title             = COALESCE(content.meetings.title, EXCLUDED.title),
         started_at        = COALESCE(content.meetings.started_at, EXCLUDED.started_at),
         calendar_event_id = COALESCE(content.meetings.calendar_event_id, EXCLUDED.calendar_event_id),
         -- Prefer the richer participant set (a later capture often knows more).
         participants = CASE
           WHEN jsonb_array_length(EXCLUDED.participants) > jsonb_array_length(content.meetings.participants)
           THEN EXCLUDED.participants
           ELSE content.meetings.participants END,
         updated_at = now()
     RETURNING id, meeting_fingerprint`,
    [
      fingerprint, rank, title, startedAt,
      JSON.stringify(Array.isArray(participants) ? participants : []),
      calendarEventId, ownerOrgId, ownerId, createdBy,
    ]
  );
  return { id: res.rows[0].id, fingerprint: res.rows[0].meeting_fingerprint };
}

/**
 * Recompute the meeting's canonical pointers (D4) within the caller's txn.
 * Runs on every meeting-linked artifact write, so a new version or a new source
 * automatically re-picks — deterministic, no human in the loop.
 */
export async function recomputePrimariesTx(client, meetingId) {
  // D4 precedence is CONFIGURABLE (Feature 007): resolve the ordered source list
  // for THIS meeting's scope (user override → org default → system default) and
  // rank by array_position — lower index = higher priority, an unranked source
  // sorts last (array_position → NULL → NULLS LAST). The resolution reads the
  // meeting's own (owner_org_id, owner_id), so org-shared and personal meetings
  // each get the right ordering with no app-side branching.
  const meta = (await client.query(
    `SELECT owner_org_id, owner_id FROM content.meetings WHERE id = $1`, [meetingId]
  )).rows[0];
  if (!meta) return;
  const { precedence } = await resolveSourcePrecedence(
    (sql, params) => client.query(sql, params), meta.owner_org_id, meta.owner_id || null
  );

  await client.query(
    `UPDATE content.meetings m SET
       primary_transcript_id = (
         SELECT a.id FROM content.artifacts a
          WHERE a.meeting_id = m.id AND a.kind = 'transcript' AND a.status = 'active'
          ORDER BY array_position($2::text[], a.source_system) ASC NULLS LAST, a.updated_at DESC
          LIMIT 1),
       primary_summary_id = (
         SELECT a.id FROM content.artifacts a
          WHERE a.meeting_id = m.id AND a.kind = 'summary' AND a.status = 'active'
          ORDER BY array_position($2::text[], a.source_system) ASC NULLS LAST, a.updated_at DESC
          LIMIT 1),
       updated_at = now()
     WHERE m.id = $1`,
    [meetingId, precedence]
  );
}

/**
 * Explicit personal -> org promotion (Feature 007 Layer 4, D3).
 *
 * TRUSTED CALLERS ONLY: toOrgId/actorId must come from the verified board token
 * at the HTTP edge — never a request body. The personal copy is superseded with
 * a lineage pointer (P3: never delete); its artifacts are re-owned to the org
 * meeting (a tenancy change: owner_org_id re-stamped, owner_id cleared).
 *
 * @returns {Promise<{ok: boolean, orgMeetingId?: string, movedArtifacts?: number, reason?: string}>}
 */
export async function promoteMeeting({ meetingId, toOrgId, actorId = null }) {
  if (!meetingId) throw new Error('promoteMeeting: meetingId is required');
  if (!toOrgId) throw new Error('promoteMeeting: toOrgId is required (trusted, board-validated)');

  return withTransaction(async (client) => {
    const cur = await client.query(
      `SELECT * FROM content.meetings WHERE id = $1 FOR UPDATE`, [meetingId]
    );
    const personal = cur.rows[0];
    if (!personal) return { ok: false, reason: 'not_found' };
    if (!personal.owner_id) return { ok: false, reason: 'already_org_shared' };
    if (personal.status === 'superseded') return { ok: false, reason: 'already_superseded' };
    if (String(personal.owner_org_id) !== String(toOrgId)) {
      // Promotion stays inside the meeting's own org (a member sharing their
      // personal copy with THEIR org). Cross-org moves are a different feature.
      return { ok: false, reason: 'org_mismatch' };
    }

    // Upsert the org-shared peer (owner_id NULL) for the same fingerprint.
    const org = await upsertMeetingTx(client, {
      fingerprint: personal.meeting_fingerprint,
      confidence: personal.fingerprint_confidence,
      title: personal.title,
      startedAt: personal.started_at,
      participants: personal.participants || [],
      calendarEventId: personal.calendar_event_id,
      ownerOrgId: toOrgId,
      ownerId: null,
      createdBy: actorId,
    });

    // Re-own the personal meeting's artifacts to the org meeting. owner_org_id is
    // unchanged by the org_mismatch guard above; owner_id clears to org-shared.
    const moved = await client.query(
      `UPDATE content.artifacts
          SET meeting_id = $1, owner_id = NULL, updated_at = now()
        WHERE meeting_id = $2`,
      [org.id, meetingId]
    );

    // Supersede the personal copy — lineage, not deletion (P3).
    await client.query(
      `UPDATE content.meetings
          SET status = 'superseded', superseded_by = $1,
              primary_transcript_id = NULL, primary_summary_id = NULL,
              updated_at = now()
        WHERE id = $2`,
      [org.id, meetingId]
    );

    await recomputePrimariesTx(client, org.id);
    return { ok: true, orgMeetingId: org.id, movedArtifacts: moved.rowCount ?? 0 };
  });
}

/**
 * Q1 upgrade sweep: try to recover a calendar_event_id for 'weak' meetings
 * (Drive drops with no real attendee envelope). On a confident reconciler match:
 *   - a `cal:` peer already exists in the same scope → MERGE: re-point the weak
 *     row's artifacts to the peer, alias the old fingerprint onto the peer (so
 *     migration-151 signals stamped with it still join the hub), supersede the
 *     weak row (lineage, not deletion — P3).
 *   - no peer → RE-KEY: the row itself upgrades to the `cal:` fingerprint,
 *     keeping its old fingerprint in fingerprint_aliases.
 *
 * Best-effort + bounded; wired to run after calendar syncs (new calendar events
 * are exactly when upgrades become possible). Per-meeting transaction so one
 * conflict cannot wedge the sweep.
 *
 * @returns {Promise<{scanned: number, upgraded: number, merged: number}>}
 */
export async function upgradeWeakMeetings({ limit = 25, queryFn = query } = {}) {
  const { rows } = await queryFn(
    `SELECT id, meeting_fingerprint, title, started_at, participants, owner_org_id, owner_id
       FROM content.meetings
      WHERE fingerprint_confidence = 'weak'
        AND status = 'active'
        AND calendar_event_id IS NULL
        AND started_at IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit]
  );

  const stats = { scanned: rows.length, upgraded: 0, merged: 0 };
  for (const m of rows) {
    let rec;
    try {
      rec = await resolveCalendarEventId({
        startTime: m.started_at,
        title: m.title,
        attendeeEmails: attendeeEmailsOf(m.participants),
        queryFn,
      });
    } catch (err) {
      console.warn(`[meetings] upgrade sweep: reconciler failed for ${m.id}: ${err.message}`);
      continue;
    }
    if (!rec) continue;
    const newFingerprint = `cal:${rec.calendarEventId}`;

    try {
      await withTransaction(async (client) => {
        // Re-check under lock — the row may have changed since the sweep SELECT.
        const cur = (await client.query(
          `SELECT id, meeting_fingerprint, fingerprint_confidence, status
             FROM content.meetings WHERE id = $1 FOR UPDATE`, [m.id]
        )).rows[0];
        if (!cur || cur.status !== 'active' || cur.fingerprint_confidence !== 'weak') return;

        const peer = (await client.query(
          `SELECT id FROM content.meetings
            WHERE owner_org_id = $1
              AND COALESCE(owner_id, '${ORG_SHARED_SENTINEL}'::uuid)
                = COALESCE($2::uuid, '${ORG_SHARED_SENTINEL}'::uuid)
              AND meeting_fingerprint = $3
              AND id != $4
            FOR UPDATE`,
          [m.owner_org_id, m.owner_id, newFingerprint, m.id]
        )).rows[0];

        if (peer) {
          // MERGE into the existing cal: row.
          await client.query(
            `UPDATE content.artifacts SET meeting_id = $1, updated_at = now() WHERE meeting_id = $2`,
            [peer.id, m.id]
          );
          await client.query(
            `UPDATE content.meetings
                SET fingerprint_aliases = fingerprint_aliases || to_jsonb($1::text),
                    updated_at = now()
              WHERE id = $2`,
            [cur.meeting_fingerprint, peer.id]
          );
          await client.query(
            `UPDATE content.meetings
                SET status = 'superseded', superseded_by = $1,
                    primary_transcript_id = NULL, primary_summary_id = NULL,
                    updated_at = now()
              WHERE id = $2`,
            [peer.id, m.id]
          );
          await recomputePrimariesTx(client, peer.id);
          stats.merged++;
        } else {
          // RE-KEY this row up to the cal: tier; keep the old key as an alias.
          await client.query(
            `UPDATE content.meetings
                SET meeting_fingerprint = $1,
                    calendar_event_id = $2,
                    fingerprint_confidence = 'calendar',
                    fingerprint_aliases = fingerprint_aliases || to_jsonb($3::text),
                    updated_at = now()
              WHERE id = $4`,
            [newFingerprint, rec.calendarEventId, cur.meeting_fingerprint, m.id]
          );
          stats.upgraded++;
        }
      });
    } catch (err) {
      console.warn(`[meetings] upgrade sweep: tx failed for ${m.id}: ${err.message}`);
    }
  }
  if (stats.upgraded || stats.merged) {
    console.log(`[meetings] upgrade sweep: scanned=${stats.scanned} upgraded=${stats.upgraded} merged=${stats.merged}`);
  }
  return stats;
}
