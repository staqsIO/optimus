/**
 * Stable meeting-identity + action-dedup keys (STAQPRO-612).
 *
 * Pure, deterministic, offline. Mirror of the feed-poller's `canonicalUrlKey()`
 * pattern: a content-derived stable key so the same logical thing (a meeting,
 * an action item) collapses to one row no matter how many times — or from how
 * many sources — it is seen.
 *
 * Feature spec 003 §Decisions #4 (RESOLVED 2026-06-02):
 *   Canonical key = `calendar_event_id` when present; ad-hoc fallback =
 *   hash(15-min-rounded start window + sorted participant emails + normalized
 *   title). Cross-source COLLAPSE itself is 613/Carlos — here we just produce a
 *   stable id per source so derived work carries provenance.
 */

import { createHash } from 'node:crypto';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Normalize a title for hashing: lowercase, collapse whitespace, strip edges. */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize action text for dedup: lowercase, strip punctuation runs, collapse ws. */
export function normalizeActionText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Round a meeting start time to its 15-minute window start (epoch ms).
 * Tolerates clock skew / source jitter so TLDV vs Meet land in the same window.
 * Returns null when the input is not a parseable date.
 */
export function fifteenMinWindowStart(startTime) {
  if (startTime == null) return null;
  const ms = startTime instanceof Date ? startTime.getTime() : Date.parse(String(startTime));
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
}

/**
 * Compute a stable source_meeting_id.
 *
 * @param {Object} m
 * @param {string} [m.calendarEventId] - Calendar event id; wins when present.
 * @param {string} [m.title]
 * @param {string|Date|number} [m.startTime]
 * @param {string[]} [m.participantEmails]
 * @param {string} [m.fallbackId] - Last-resort stable id (e.g. the source's
 *   own meeting id / document source_id) used when neither calendar id nor
 *   enough envelope signal is available. Keeps the key deterministic instead of
 *   degrading to a random value.
 * @returns {string|null} stable id, or null if nothing identifying was supplied.
 */
export function computeSourceMeetingId({
  calendarEventId = null,
  title = '',
  startTime = null,
  participantEmails = [],
  fallbackId = null,
} = {}) {
  // 1. Canonical: calendar event id when present.
  if (calendarEventId && String(calendarEventId).trim()) {
    return `cal:${String(calendarEventId).trim()}`;
  }

  // 2. Ad-hoc fallback: hash(window + sorted participant emails + normalized title).
  const windowStart = fifteenMinWindowStart(startTime);
  const emails = (Array.isArray(participantEmails) ? participantEmails : [])
    .map((e) => String(e || '').toLowerCase().trim())
    .filter(Boolean)
    .sort();
  const normTitle = normalizeTitle(title);

  // Only hash when we have at least one envelope signal beyond an empty title.
  if (windowStart != null || emails.length > 0 || normTitle) {
    const basis = JSON.stringify({ w: windowStart, p: emails, t: normTitle });
    return `mtg:${sha256(basis).slice(0, 32)}`;
  }

  // 3. Last resort: a caller-supplied stable id (e.g. source meeting/doc id).
  if (fallbackId && String(fallbackId).trim()) {
    return `src:${String(fallbackId).trim()}`;
  }

  return null;
}

/**
 * Compute a per-action idempotency key.
 *
 * @param {string} sourceMeetingId
 * @param {string} actionText
 * @returns {string|null} `${sourceMeetingId}:${sha256(normalized action)}`,
 *   or null when either input is empty (caller must skip dedup, not invent one).
 */
export function computeDedupKey(sourceMeetingId, actionText) {
  const meeting = String(sourceMeetingId || '').trim();
  const norm = normalizeActionText(actionText);
  if (!meeting || !norm) return null;
  return `${meeting}:${sha256(norm)}`;
}
