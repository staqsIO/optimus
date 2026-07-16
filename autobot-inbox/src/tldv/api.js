/**
 * TLDv public API client.
 * Ported from brain-rag src/lib/tldv-api.ts
 *
 * Auth: x-api-key header
 * Docs: https://doc.tldv.io/
 *
 * Env vars:
 *   TLDV_API_KEY      — Required for TLDv polling
 *   TLDV_API_BASE_URL — Override base URL (default: https://pasta.tldv.io)
 */

const DEFAULT_BASE = 'https://pasta.tldv.io';

function getBaseUrl() {
  return (process.env.TLDV_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

// STAQPRO-325 backfill hardening: a single transcript timeout was killing
// the entire historic run. Two changes:
//   1. Bump the timeout from 15s → 30s. Older meetings have multi-MB
//      transcripts; 15s was tuned for the live poller's small windows.
//   2. Catch network / abort errors here so they surface as `{ok:false,
//      status:0}` to the caller. Previously `tldvFetch` could throw
//      synchronously inside `ingestTldvMeeting`, bringing down the whole
//      backfill loop on one bad meeting.
async function tldvFetch(apiKey, path) {
  const url = `${getBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // AbortError, network failure, DNS, etc. — never let one meeting's
    // transient API hiccup kill the surrounding loop.
    return { ok: false, status: 0, body: `fetch_error: ${err?.name || 'unknown'}: ${err?.message || ''}`.slice(0, 500) };
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, status: res.status, body: `read_error: ${err?.message || ''}`.slice(0, 500) };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
}

/**
 * Fetch paginated meetings list. TLDv uses 1-based pages.
 * @param {string} apiKey
 * @param {number} page - 1-based page index
 * @param {number} pageSize
 * @returns {Promise<{ ok: true, page: { page: number, pages: number, total: number, results: Array } } | { ok: false, status: number, body: string }>}
 */
export async function fetchMeetingsPage(apiKey, page = 1, pageSize = 10) {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const result = await tldvFetch(apiKey, `/v1alpha1/meetings?${qs}`);
  if (!result.ok) return result;
  return { ok: true, page: result.data };
}

/**
 * Fetch transcript for a meeting. Returns 404 if not ready yet.
 * @param {string} apiKey
 * @param {string} meetingId
 * @returns {Promise<{ ok: true, transcript: { data: Array<{ speaker?: string, text: string, startTime?: number, endTime?: number }> } } | { ok: false, status: number, body: string }>}
 */
export async function fetchTranscript(apiKey, meetingId) {
  const result = await tldvFetch(apiKey, `/v1alpha1/meetings/${encodeURIComponent(meetingId)}/transcript`);
  if (!result.ok) return result;
  return { ok: true, transcript: result.data };
}

/**
 * Fetch a single meeting's full metadata (name, invitees, organizer, url, …).
 * Separate from fetchTranscript because tl;dv exposes the attendee roster on
 * the meeting object, not the transcript body — and that roster is the only
 * reliable source for silent or phone-joined participants whose speaker labels
 * get redacted.
 *
 * @param {string} apiKey
 * @param {string} meetingId
 * @returns {Promise<{ ok: true, meeting: { id, name, happenedAt, duration, invitees?: Array<{name?:string,email?:string}>, organizer?: {name?:string,email?:string}, url?: string } } | { ok: false, status: number, body: string }>}
 */
export async function fetchMeeting(apiKey, meetingId) {
  const result = await tldvFetch(apiKey, `/v1alpha1/meetings/${encodeURIComponent(meetingId)}`);
  if (!result.ok) return result;
  return { ok: true, meeting: result.data };
}
