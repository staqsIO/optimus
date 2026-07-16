// STAQPRO-536: pure sync-health assessment for Google Calendar watches.
//
// The calendar poller writes `last_poll_at` / `last_error` per watch (columns
// added in migration 114). The board previously had no signal when a
// service-account poll stalled or errored, so calendar ingestion could fail
// silently. This module derives the health classification used by the
// /calendar sync-health banner. It is deliberately framework-free so it can be
// unit-tested in the `node` vitest environment without rendering React.
//
// Calendar uses a domain-wide-delegated service account (calendar.readonly),
// not a per-user OAuth grant — so a failure here is an admin remediation, never
// a per-user reconnect. The banner copy reflects that; this module only
// classifies.

export interface CalendarWatch {
  id: string;
  account_email: string;
  calendar_id: string;
  label: string;
  is_active: boolean;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
  /** OPT-126: present in `?scope=org` responses — true when the watch belongs
   *  to the requesting viewer. For non-mine watches `last_error` is redacted
   *  to the bare marker "sync error" (still truthy for classification). */
  mine?: boolean;
}

// A watch whose newest successful poll is older than this is treated as stale.
export const STALE_POLL_MS = 30 * 60 * 1000; // 30 minutes

export interface SyncHealth {
  errored: CalendarWatch[];
  stale: CalendarWatch[];
}

/**
 * Classify active calendar watches into `errored` (last_error set) and `stale`
 * (no successful poll, or last poll older than STALE_POLL_MS). Inactive watches
 * are ignored — they are not expected to be polling.
 *
 * @param watches  watch rows from /api/calendar/watches
 * @param now      injectable clock (ms epoch) for deterministic tests
 */
export function assessSyncHealth(
  watches: CalendarWatch[],
  now: number = Date.now(),
): SyncHealth {
  const errored: CalendarWatch[] = [];
  const stale: CalendarWatch[] = [];
  for (const w of watches) {
    if (!w.is_active) continue;
    if (w.last_error) {
      errored.push(w);
      continue;
    }
    const pollMs = w.last_poll_at ? Date.parse(w.last_poll_at) : NaN;
    if (!w.last_poll_at || Number.isNaN(pollMs) || now - pollMs > STALE_POLL_MS) {
      stale.push(w);
    }
  }
  return { errored, stale };
}
