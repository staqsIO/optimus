/**
 * Google Calendar API thin wrapper (STAQPRO-327).
 *
 * Authenticated via service-account JWT + domain-wide delegation
 * (see src/drive/service-auth.js → getCalendarClient).
 *
 * Endpoint reference: https://developers.google.com/calendar/api/v3/reference/events
 *
 * Env vars: GOOGLE_SERVICE_ACCOUNT_KEY (shared with Drive).
 */

import { getCalendarClient } from '../drive/service-auth.js';

/**
 * List events for a calendar in a time window. Paginates internally — callers
 * provide an async per-page handler. We use the events.list endpoint
 * (singleEvents=true) so recurring events come back expanded into one row
 * per occurrence, which is what the Board day-grid wants.
 *
 * Resilient by design: any per-page error short-circuits with `{ok:false}`
 * rather than throwing, so a single bad page in a multi-month backfill
 * doesn't kill the whole run.
 *
 * @param {object} opts
 * @param {string} opts.accountEmail   — calendar owner (e.g. 'eric@staqs.io')
 * @param {string} [opts.calendarId='primary']
 * @param {string} opts.timeMin        — ISO datetime; events with start >= this
 * @param {string} [opts.timeMax]      — ISO datetime; events with start < this
 * @param {number} [opts.maxResults=250] — Google caps at 2500
 * @param {(events: object[]) => Promise<void>} opts.onPage — called per page
 * @returns {Promise<{ok: true, scanned: number} | {ok: false, status: number, body: string}>}
 */
export async function listCalendarEvents({
  accountEmail,
  calendarId = 'primary',
  timeMin,
  timeMax,
  maxResults = 250,
  onPage,
}) {
  if (!accountEmail) {
    return { ok: false, status: 0, body: 'accountEmail required' };
  }
  let client;
  try {
    client = getCalendarClient(accountEmail);
  } catch (err) {
    return { ok: false, status: 0, body: `auth_error: ${err.message}` };
  }

  let pageToken;
  let scanned = 0;
  let pageCount = 0;
  do {
    let res;
    try {
      res = await client.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: true,    // Keep cancelled events so we can see "this was on the calendar, then dropped".
        pageToken,
      });
    } catch (err) {
      // Network / 4xx / 5xx all land here in the googleapis client.
      return {
        ok: false,
        status: err?.code || 0,
        body: `events.list_error: ${err?.message || ''}`.slice(0, 500),
      };
    }
    pageCount += 1;
    const items = res.data?.items || [];
    scanned += items.length;
    if (items.length > 0) {
      try {
        await onPage(items);
      } catch (err) {
        // Caller's per-page handler shouldn't be allowed to crash the
        // whole list iteration — same defense-in-depth pattern as the
        // TLDv backfill (STAQPRO-325 fix).
        return {
          ok: false,
          status: 0,
          body: `onPage_threw: ${err?.message || ''}`.slice(0, 500),
        };
      }
    }
    pageToken = res.data?.nextPageToken;
  } while (pageToken);

  return { ok: true, scanned, pages: pageCount };
}
