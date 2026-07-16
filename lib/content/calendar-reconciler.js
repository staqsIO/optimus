// lib/content/calendar-reconciler.js — Feature 007 item 3a: the cross-source bridge.
//
// TLDv and Gemini-on-Drive captures of the SAME call cannot hash-match by
// participants (TLDv carries real invitee emails; the Drive path carries Google
// Doc owner metadata) — the only reliable cross-source meeting identity is
// `calendar_event_id`. TLDv exposes it intermittently; Gemini-on-Drive never.
// This module RECOVERS it: given a capture's envelope (start time, title,
// attendee emails), find the matching inbox.calendar_events row. A match
// upgrades the meeting to the `cal:` fingerprint tier, at which point captures
// from every source converge on one content.meetings row per scope.
//
// Thresholds (R2, P5 "measure before you trust"): explicit constants, exported
// for tests, conservative to start. Near-misses are LOGGED (not accepted) so the
// floor can be tuned on real evidence instead of guessed. Ambiguity fails closed:
// two candidates too close together → no match (better unlinked than false-merged).
//
// Cross-schema NOTE: reads inbox.calendar_events at the APP layer (no cross-schema
// FK, SPEC §12) — same pattern as lib/runtime/meeting-classifier.js → inbox.human_tasks.

import { query as defaultQuery } from '../db.js';
import { normalizeTitle } from '../runtime/meeting-identity.js';

// Accept floor for the combined score; tune on logged near-misses (R2).
export const ACCEPT_SCORE = 0.6;
// Two candidates within this margin of each other = ambiguous → fail closed.
export const AMBIGUITY_MARGIN = 0.15;
// Score band [NEAR_MISS_FLOOR, ACCEPT_SCORE) is logged for threshold tuning.
export const NEAR_MISS_FLOOR = 0.4;
// Candidate window around the capture's start time. Gemini filename times and
// TLDv happenedAt both jitter vs the calendar slot; ±30min bounds the scan.
export const WINDOW_MINUTES = 30;

// Gemini Notes filename decoration: "<real title> - 2026/05/07 13:00 PDT - Notes
// by Gemini" (see src/drive/gemini-title.js). Strip the time segment + suffix so
// the remaining string is comparable with the calendar event's summary.
const GEMINI_SUFFIX_RE = /\s*[-–—]?\s*notes\s+by\s+gemini\s*$/i;
const EMBEDDED_TIME_RE = /\s*[-–—]?\s*\d{4}[/-]\d{2}[/-]\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{3,4}\s*/;

/** Strip note-taker decoration + embedded timestamps from a captured title. */
export function cleanMeetingTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(GEMINI_SUFFIX_RE, '')
    .replace(EMBEDDED_TIME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-set Jaccard similarity over normalized titles. 0..1. */
export function titleSimilarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Attendee-email overlap: |intersection| / |smaller set|. null when either side is empty. */
export function attendeeOverlap(aEmails, bEmails) {
  const a = new Set((aEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean));
  const b = new Set((bEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean));
  if (a.size === 0 || b.size === 0) return null;
  let inter = 0;
  for (const e of a) if (b.has(e)) inter++;
  return inter / Math.min(a.size, b.size);
}

function scoreCandidate({ title, attendeeEmails }, event) {
  const titleSim = titleSimilarity(title, event.title || '');
  const eventEmails = (Array.isArray(event.attendees) ? event.attendees : [])
    .map((att) => att?.email)
    .filter(Boolean);
  if (event.organizer_email) eventEmails.push(event.organizer_email);
  const overlap = attendeeOverlap(attendeeEmails, eventEmails);
  // Title-only capture (Gemini): the title IS the evidence. With attendees on
  // both sides, split the weight — either axis alone can't fake a match.
  const score = overlap == null ? titleSim : 0.5 * titleSim + 0.5 * overlap;
  return { score, titleSim, overlap };
}

/**
 * Recover the calendar_event_id for a capture that lacks one.
 *
 * @param {object} args
 * @param {string|Date} args.startTime       - capture's meeting start (required; no time → no match)
 * @param {string} args.title                - capture's title (cleaned or raw; cleaned again here)
 * @param {string[]} [args.attendeeEmails]   - HUMAN attendee emails (bots pre-stripped)
 * @param {Function} [args.queryFn]          - injectable for tests
 * @returns {Promise<{calendarEventId: string, icalUid: string|null, score: number,
 *   titleSim: number, overlap: number|null}|null>} null = no confident match (fail closed)
 */
export async function resolveCalendarEventId({
  startTime,
  title,
  attendeeEmails = [],
  queryFn = defaultQuery,
} = {}) {
  if (!startTime) return null;
  const startMs = startTime instanceof Date ? startTime.getTime() : Date.parse(String(startTime));
  if (!Number.isFinite(startMs)) return null;
  const cleanTitle = cleanMeetingTitle(title);
  if (!cleanTitle && (!attendeeEmails || attendeeEmails.length === 0)) return null;

  const startIso = new Date(startMs).toISOString();
  const res = await queryFn(
    `SELECT gcal_event_id, ical_uid, title, organizer_email, attendees, start_at
       FROM inbox.calendar_events
      WHERE status != 'cancelled'
        AND start_at BETWEEN $1::timestamptz - ($2 || ' minutes')::interval
                         AND $1::timestamptz + ($2 || ' minutes')::interval`,
    [startIso, String(WINDOW_MINUTES)]
  );
  const candidates = res.rows || [];
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((ev) => ({ event: ev, ...scoreCandidate({ title: cleanTitle, attendeeEmails }, ev) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (best.score < ACCEPT_SCORE) {
    if (best.score >= NEAR_MISS_FLOOR) {
      // R2: the tuning signal. Logged, never accepted.
      console.log(
        `[calendar-reconciler] near-miss: "${cleanTitle}" vs "${best.event.title}" ` +
        `score=${best.score.toFixed(2)} (titleSim=${best.titleSim.toFixed(2)}, ` +
        `overlap=${best.overlap == null ? 'n/a' : best.overlap.toFixed(2)}) — below floor ${ACCEPT_SCORE}`
      );
    }
    return null;
  }
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    // Two calendar events both plausibly match → fail closed (false-merge is the
    // expensive failure; an unlinked weak meeting can still be upgraded later).
    console.log(
      `[calendar-reconciler] ambiguous: "${cleanTitle}" matches "${best.event.title}" ` +
      `(${best.score.toFixed(2)}) and "${second.event.title}" (${second.score.toFixed(2)}) — no match`
    );
    return null;
  }

  return {
    calendarEventId: best.event.gcal_event_id,
    icalUid: best.event.ical_uid || null,
    score: best.score,
    titleSim: best.titleSim,
    overlap: best.overlap,
  };
}
