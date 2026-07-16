/**
 * Gemini Notes filename parser.
 *
 * Gemini auto-saves meeting Notes docs into Drive with a title that embeds
 * the actual meeting time, e.g.
 *   "Dev Daily Touch Base - 2026/05/07 13:00 PDT - Notes by Gemini"
 *
 * The Drive watcher and the calendar backfill both reach for this so the
 * `metadata.happenedAt` we store reflects the meeting moment rather than
 * the (much later) file-creation moment.
 *
 * Variants supported:
 *   - "YYYY/MM/DD HH:MM <TZ>"
 *   - "YYYY-MM-DD HH:MM <TZ>"
 *   (24-hour clock; <TZ> is one of the abbreviations in TZ_UTC_OFFSET_HOURS)
 *
 * If a title doesn't match, callers fall back to existing logic
 * (metadata.happenedAt, created_at, etc.). The backfill script reports
 * unmatched titles so this list can be extended on real evidence.
 */

// North American + UTC abbreviations Gemini emits in practice. We resolve
// to fixed UTC offsets rather than relying on Date.parse(<abbrev>), which
// is engine-dependent (V8 supports it, but it isn't standardized).
//
// DST caveat: PDT/EDT/MDT/CDT are the daylight forms, P/E/M/CST the standard
// forms. The title carries whichever was in effect at meeting time, so we
// just trust it — no DST inference here.
export const TZ_UTC_OFFSET_HOURS = {
  PDT: -7, PST: -8,
  EDT: -4, EST: -5,
  MDT: -6, MST: -7,
  CDT: -5, CST: -6,
  UTC: 0, GMT: 0,
};

const TZ_LIST = Object.keys(TZ_UTC_OFFSET_HOURS).join('|');
const GEMINI_TITLE_TIME_RE = new RegExp(
  '(\\d{4})[/-](\\d{2})[/-](\\d{2})\\s+(\\d{1,2}):(\\d{2})\\s+(' + TZ_LIST + ')',
);

/**
 * Pulls the actual meeting time out of a Gemini Notes filename.
 * Returns an ISO 8601 string when matched, null otherwise.
 */
export function parseGeminiTitleTime(title) {
  if (!title) return null;
  const m = title.match(GEMINI_TITLE_TIME_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, tz] = m;
  const offset = TZ_UTC_OFFSET_HOURS[tz];
  if (offset == null) return null;
  const sign = offset <= 0 ? '-' : '+';
  const abs = String(Math.abs(offset)).padStart(2, '0');
  const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:00${sign}${abs}:00`;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}
