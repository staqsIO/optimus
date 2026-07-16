/**
 * RAG search API routes.
 *
 * Provides both raw chunk search and synthesized RAG completion.
 * The completion endpoint retrieves relevant chunks then passes them
 * to Haiku for answer synthesis with citations.
 */

import { query } from '../db.js';
import { searchChunks, retrieveContext } from '../rag/retriever.js';
import { getEmbeddingInfo } from '../rag/embedder.js';
import { ragSearchOptionsFromRequest, retrieverScopeWithOrg } from './document-access.js';
import { createLogger } from '../../../lib/logger.js';
import OpenAI from 'openai';
const log = createLogger('api/search');

const WEEKDAY_TO_INDEX = new Map([
  ['sunday', 0], ['sun', 0],
  ['monday', 1], ['mon', 1],
  ['tuesday', 2], ['tue', 2], ['tues', 2],
  ['wednesday', 3], ['wed', 3],
  ['thursday', 4], ['thu', 4], ['thurs', 4],
  ['friday', 5], ['fri', 5],
  ['saturday', 6], ['sat', 6],
]);

function getLocalDateParts(date, timezoneOffsetMinutes = date.getTimezoneOffset()) {
  const shifted = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function localToUtcIso(year, month, day, hour, minute, second, ms, timezoneOffsetMinutes) {
  const utcMs = Date.UTC(year, month, day, hour, minute, second, ms) + timezoneOffsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

function parseHour(rawHour, ampm) {
  let h = Number(rawHour);
  if (!Number.isFinite(h)) return null;
  if (ampm) {
    const mer = ampm.toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
  }
  if (h < 0 || h > 23) return null;
  return h;
}

export function parseTemporalRange(queryText, now = new Date(), timezoneOffsetMinutes = now.getTimezoneOffset()) {
  const q = String(queryText || '').toLowerCase();
  const hasToday = /\btoday\b|\bthis morning\b|\bthis afternoon\b|\btonight\b/.test(q);
  const hasYesterday = /\byesterday\b/.test(q);
  const hasTomorrow = /\btomorrow\b/.test(q);
  const hasThisWeek = /\bthis week\b/.test(q);
  const hasLastWeek = /\blast week\b/.test(q);
  const hasThisMonth = /\bthis month\b/.test(q);
  const hasPast24h = /\b(last|past)\s+24\s*(hours|hrs|h)\b/.test(q);
  const sinceTime = q.match(/\bsince\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const betweenTime = q.match(/\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+and\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const sinceWeekday = q.match(/\bsince\s+(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat|sunday|sun)\b/);
  const sinceYesterday = /\bsince\s+yesterday\b/.test(q);
  const sinceToday = /\bsince\s+today\b/.test(q);
  const lastWeekday = q.match(/\blast\s+(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat|sunday|sun)\b/);
  const thisWeekday = q.match(/\bthis\s+(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat|sunday|sun)\b/);
  const isoDate = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const local = getLocalDateParts(now, timezoneOffsetMinutes);

  if (isoDate?.[1]) {
    const m = isoDate[1].match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const from = localToUtcIso(y, mo, d, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(y, mo, d + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: isoDate[1],
      from,
      to,
      type: 'date',
    };
  }

  if (betweenTime && hasToday) {
    const h1 = parseHour(betweenTime[1], betweenTime[3] || betweenTime[6] || null);
    const m1 = Number(betweenTime[2] || '0');
    const h2 = parseHour(betweenTime[4], betweenTime[6] || betweenTime[3] || null);
    const m2 = Number(betweenTime[5] || '0');
    if (h1 != null && h2 != null && m1 >= 0 && m1 < 60 && m2 >= 0 && m2 < 60) {
      const from = localToUtcIso(local.year, local.month, local.day, h1, m1, 0, 0, timezoneOffsetMinutes);
      const to = localToUtcIso(local.year, local.month, local.day, h2, m2, 59, 999, timezoneOffsetMinutes);
      return {
        label: `between ${betweenTime[1]}${betweenTime[2] ? `:${betweenTime[2]}` : ''}${betweenTime[3] ? ` ${betweenTime[3]}` : ''} and ${betweenTime[4]}${betweenTime[5] ? `:${betweenTime[5]}` : ''}${betweenTime[6] ? ` ${betweenTime[6]}` : ''} today`,
        from,
        to,
        type: 'between_time_today',
      };
    }
  }

  if (sinceTime) {
    const h = parseHour(sinceTime[1], sinceTime[3] || null);
    const m = Number(sinceTime[2] || '0');
    if (h != null && m >= 0 && m < 60) {
      const from = localToUtcIso(local.year, local.month, local.day, h, m, 0, 0, timezoneOffsetMinutes);
      return {
        label: `since ${sinceTime[1]}${sinceTime[2] ? `:${sinceTime[2]}` : ''}${sinceTime[3] ? ` ${sinceTime[3]}` : ''}`,
        from,
        to: now.toISOString(),
        type: 'since_time_today',
      };
    }
  }

  if (sinceYesterday) {
    const from = localToUtcIso(local.year, local.month, local.day - 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    return { label: 'since yesterday', from, to: now.toISOString(), type: 'since_yesterday' };
  }
  if (sinceToday) {
    const from = localToUtcIso(local.year, local.month, local.day, 0, 0, 0, 0, timezoneOffsetMinutes);
    return { label: 'since today', from, to: now.toISOString(), type: 'since_today' };
  }
  if (sinceWeekday?.[1]) {
    const target = WEEKDAY_TO_INDEX.get(sinceWeekday[1]) ?? null;
    if (target != null) {
      const delta = (local.weekday - target + 7) % 7;
      const targetDay = local.day - delta;
      const from = localToUtcIso(local.year, local.month, targetDay, 0, 0, 0, 0, timezoneOffsetMinutes);
      return { label: `since ${sinceWeekday[1]}`, from, to: now.toISOString(), type: 'since_weekday' };
    }
  }

  if (hasPast24h) {
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      label: 'past 24 hours',
      from: from.toISOString(),
      to: now.toISOString(),
      type: 'past_24h',
    };
  }

  if (hasToday) {
    const from = localToUtcIso(local.year, local.month, local.day, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(local.year, local.month, local.day + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'today',
      from,
      to,
      type: 'today',
    };
  }

  if (hasYesterday) {
    const to = localToUtcIso(local.year, local.month, local.day, 0, 0, 0, 0, timezoneOffsetMinutes);
    const from = localToUtcIso(local.year, local.month, local.day - 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'yesterday',
      from,
      to,
      type: 'yesterday',
    };
  }
  if (hasTomorrow) {
    const from = localToUtcIso(local.year, local.month, local.day + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(local.year, local.month, local.day + 2, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'tomorrow',
      from,
      to,
      type: 'tomorrow',
    };
  }
  if (hasThisWeek) {
    const day = local.weekday; // Sun=0
    const diffToMonday = (day + 6) % 7;
    const fromDay = local.day - diffToMonday;
    const from = localToUtcIso(local.year, local.month, fromDay, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(local.year, local.month, fromDay + 7, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'this week',
      from,
      to,
      type: 'this_week',
    };
  }
  if (hasLastWeek) {
    const day = local.weekday;
    const diffToMonday = (day + 6) % 7;
    const thisMondayDay = local.day - diffToMonday;
    const from = localToUtcIso(local.year, local.month, thisMondayDay - 7, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(local.year, local.month, thisMondayDay, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'last week',
      from,
      to,
      type: 'last_week',
    };
  }
  if (hasThisMonth) {
    const from = localToUtcIso(local.year, local.month, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    const to = localToUtcIso(local.year, local.month + 1, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
    return {
      label: 'this month',
      from,
      to,
      type: 'this_month',
    };
  }
  if (lastWeekday?.[1]) {
    const target = WEEKDAY_TO_INDEX.get(lastWeekday[1]) ?? null;
    if (target != null) {
      const delta = ((local.weekday - target + 7) % 7) || 7;
      const targetDay = local.day - delta;
      const from = localToUtcIso(local.year, local.month, targetDay, 0, 0, 0, 0, timezoneOffsetMinutes);
      const to = localToUtcIso(local.year, local.month, targetDay + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
      return { label: `last ${lastWeekday[1]}`, from, to, type: 'last_weekday' };
    }
  }
  if (thisWeekday?.[1]) {
    const target = WEEKDAY_TO_INDEX.get(thisWeekday[1]) ?? null;
    if (target != null) {
      const diffToMonday = (local.weekday + 6) % 7;
      const mondayDay = local.day - diffToMonday;
      const targetDay = mondayDay + ((target + 6) % 7);
      const from = localToUtcIso(local.year, local.month, targetDay, 0, 0, 0, 0, timezoneOffsetMinutes);
      const to = localToUtcIso(local.year, local.month, targetDay + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
      return { label: `this ${thisWeekday[1]}`, from, to, type: 'this_weekday' };
    }
  }

  // "N days/weeks/months/years ago" — relative windows. Words spelled out
  // (a/an/one/two/…/ten) map to numbers so "a week ago" works as well as
  // "1 week ago". Week windows span the full calendar week N weeks back;
  // month/year windows span the full calendar month/year.
  const relative = q.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\s+ago\b/);
  if (relative) {
    const n = parseCountWord(relative[1]);
    const unit = relative[2];
    if (n > 0) {
      if (unit === 'day') {
        const from = localToUtcIso(local.year, local.month, local.day - n, 0, 0, 0, 0, timezoneOffsetMinutes);
        const to = localToUtcIso(local.year, local.month, local.day - n + 1, 0, 0, 0, 0, timezoneOffsetMinutes);
        return { label: `${n} day${n === 1 ? '' : 's'} ago`, from, to, type: 'n_days_ago' };
      }
      if (unit === 'week') {
        // Week window = 7 days ending N*7 days before today (so "2 weeks ago"
        // covers the full week that ended 14 days back).
        const fromDay = local.day - n * 7;
        const toDay = fromDay + 7;
        const from = localToUtcIso(local.year, local.month, fromDay, 0, 0, 0, 0, timezoneOffsetMinutes);
        const to = localToUtcIso(local.year, local.month, toDay, 0, 0, 0, 0, timezoneOffsetMinutes);
        return { label: `${n} week${n === 1 ? '' : 's'} ago`, from, to, type: 'n_weeks_ago' };
      }
      if (unit === 'month') {
        const from = localToUtcIso(local.year, local.month - n, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
        const to = localToUtcIso(local.year, local.month - n + 1, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
        return { label: `${n} month${n === 1 ? '' : 's'} ago`, from, to, type: 'n_months_ago' };
      }
      if (unit === 'year') {
        const from = localToUtcIso(local.year - n, 0, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
        const to = localToUtcIso(local.year - n + 1, 0, 1, 0, 0, 0, 0, timezoneOffsetMinutes);
        return { label: `${n} year${n === 1 ? '' : 's'} ago`, from, to, type: 'n_years_ago' };
      }
    }
  }

  return null;
}

const WORD_TO_NUM = new Map([
  ['a', 1], ['an', 1], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
]);
function parseCountWord(s) {
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  return WORD_TO_NUM.get(String(s).toLowerCase()) || 0;
}

/**
 * Detect ordinal-position queries ("my last meeting", "next to last call",
 * "3rd most recent meeting"). Returns the zero-based index of which document
 * to pick when meetings are sorted newest-first, or null if no ordinal intent.
 *
 * Only fires for meeting-shaped queries — looks for `meeting|call|conversation`
 * combined with positional phrasing. Doesn't hijack generic queries.
 */
export function extractOrdinalIntent(queryText) {
  const q = String(queryText || '').toLowerCase();
  if (!/\b(meeting|call|conversation|sync|chat|1:1|one[- ]on[- ]one)\b/.test(q)) return null;

  // IMPORTANT: check specific ordinals (Nth, next-to-last, second-most-recent)
  // BEFORE the generic "last meeting" pattern — otherwise "next to last meeting"
  // gets hijacked by "last meeting" at the tail.

  // "Nth most recent", "Nth to last" for N = 3..10
  const nth = q.match(/\b(third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th)[- ](to[- ]last|most[- ]recent|latest)\b/);
  if (nth) {
    const map = { third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, sixth: 5, '6th': 5, seventh: 6, '7th': 6, eighth: 7, '8th': 7, ninth: 8, '9th': 8, tenth: 9, '10th': 9 };
    return { index: map[nth[1]], label: `${nth[1]} ${nth[2].replace(/-/g, ' ')}` };
  }

  // "next to last", "next-to-last", "second to last", "2nd to last"
  if (/\bnext[- ]to[- ]last\b/.test(q) || /\b(second|2nd)[- ]to[- ]last\b/.test(q)) {
    return { index: 1, label: 'next to last' };
  }
  // "second most recent", "2nd most recent", "second latest"
  if (/\b(second|2nd)[- ](most[- ]recent|latest)\b/.test(q)) {
    return { index: 1, label: '2nd most recent' };
  }

  // Generic "my/the last/latest/most recent meeting" → index 0.
  // Skip when a temporal modifier follows ("last week", "last Monday").
  if (/\b(my\s+(last|latest|most\s+recent)|(the\s+)?(last|latest|most\s+recent))\s+(meeting|call|conversation|sync|chat|1:1|one[- ]on[- ]one)\b/.test(q)) {
    if (/\blast\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/.test(q)) {
      return null;
    }
    return { index: 0, label: 'most recent' };
  }

  return null;
}

export function extractMeetingIntent(queryText) {
  const q = String(queryText || '');
  if (!/\bmeeting\b/i.test(q)) return null;

  const stop = new Set([
    'what', 'was', 'were', 'discussed', 'in', 'the', 'a', 'an', 'meeting', 'today', 'yesterday', 'tomorrow',
    'this', 'last', 'week', 'did', 'do', 'we', 'about', 'for', 'on', 'at', 'to', 'of', 'and', 'with', 'from',
  ]);
  const tokens = q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !stop.has(t) && t.length > 2);
  const quotedPhrases = [...q.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((m) => (m[1] || m[2] || '').trim().toLowerCase())
    .filter((s) => s.length > 2);

  return {
    isMeetingQuery: true,
    requiredTokens: [...new Set(tokens)].slice(0, 6),
    quotedPhrases,
  };
}

/**
 * Build the per-chunk haystack the meeting-intent filter matches against.
 * Includes the chunk text AND every signal we can pull from the document
 * envelope: title, participant names/emails/domains, and any
 * metadata.organization tag. Without this, a meeting titled "Weekly Sync"
 * whose only "formul8" signal is a `@formul8.ai` attendee never matches a
 * "formul8 meeting" query because chunk bodies rarely repeat the org name.
 */
function buildMeetingHaystack(chunk) {
  const parts = [chunk.text || ''];
  const md = chunk.metadata || {};
  if (md.document_title) parts.push(String(md.document_title));
  if (md.organization || md.document_organization) {
    parts.push(String(md.organization || md.document_organization));
  }
  const participants = Array.isArray(md.document_participants)
    ? md.document_participants
    : Array.isArray(md.participants)
      ? md.participants
      : [];
  for (const p of participants) {
    if (!p) continue;
    if (p.name) parts.push(String(p.name));
    if (p.email) {
      const email = String(p.email);
      parts.push(email);
      // Pull the local-part and the domain stem separately so a token like
      // "formul8" matches "@formul8.ai" without needing the TLD attached.
      const at = email.indexOf('@');
      if (at > 0) {
        const domain = email.slice(at + 1);
        parts.push(domain);
        const dot = domain.indexOf('.');
        if (dot > 0) parts.push(domain.slice(0, dot));
      }
    }
  }
  // Speakers from the chunker (TLDv preset) — already in metadata, but
  // explicit so the future migration to typed metadata doesn't silently
  // regress this filter.
  if (Array.isArray(md.speakers)) parts.push(md.speakers.join(' '));
  return parts.join(' ').toLowerCase();
}

function filterChunksByMeetingIntent(chunks, intent) {
  if (!intent?.isMeetingQuery) return chunks;
  if ((!intent.requiredTokens || intent.requiredTokens.length === 0) && (!intent.quotedPhrases || intent.quotedPhrases.length === 0)) {
    return chunks;
  }
  return (chunks || []).filter((chunk) => {
    const hay = buildMeetingHaystack(chunk);
    const phrasePass = (intent.quotedPhrases || []).every((p) => hay.includes(p));
    const tokenHits = (intent.requiredTokens || []).reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
    const minTokenHits = (intent.requiredTokens || []).length >= 3 ? 2 : 1;
    return phrasePass && (intent.requiredTokens || []).length > 0 ? tokenHits >= minTokenHits : phrasePass;
  });
}

/**
 * Find content.documents whose envelope (title / participants / metadata.
 * organization) matches the meeting-intent tokens within a temporal range.
 *
 * This is the "anchor" before vector search: when a user says "the formul8
 * meeting today" we resolve to specific document IDs by structured match
 * first, then scope the chunk search to just those docs. That way the
 * vector path doesn't have to make "formul8" semantically resemble the
 * transcript body — it only has to find the most relevant chunks within
 * an already-anchored meeting.
 *
 * Tokens match against, in order of preference:
 *   - title (case-insensitive substring)
 *   - participants[].name (substring)
 *   - participants[].email (substring — covers `bob@formul8.ai`)
 *   - metadata->>'organization' (substring)
 *
 * Returns an array of document IDs scored by how many tokens hit, capped
 * at maxDocs. Empty array when nothing matches — caller falls through to
 * the standard vector path.
 */
export async function findMeetingDocsByIntent(tokens, temporalRange, opts = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  if (!temporalRange?.from || !temporalRange?.to) return [];
  const maxDocs = Math.max(1, Math.min(20, opts.maxDocs || 8));

  // Lowercase + dedupe; the SQL match is case-insensitive on title/email/org,
  // but participant names are stored as-typed so we ILIKE everywhere.
  const cleanTokens = [...new Set(tokens.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean))]
    .slice(0, 6);
  if (cleanTokens.length === 0) return [];

  const params = [cleanTokens, temporalRange.from, temporalRange.to, maxDocs];
  // Filter on when the meeting ACTUALLY HAPPENED, not when the doc was
  // ingested. A recent TLDv backfill drops 100+ months-old transcripts
  // into content.documents with today's created_at — filtering on
  // created_at would lump them all into "yesterday" and crowd out the
  // meeting that genuinely happened yesterday.
  //
  // metadata->>'happenedAt' has two formats in the wild:
  //   - ISO8601 (modern poller + backfill scripts) — castable
  //   - JS Date.toString() (legacy rows) — NOT castable, PG raises 22007
  // Guard the cast with a regex, fall back to created_at when missing.
  //
  // hits = count of distinct tokens hitting ANY of:
  //   - title substring
  //   - any participant name OR email substring
  //   - metadata.organization substring
  // hits>0 filtered in JS rather than via HAVING (scalar subquery, no
  // GROUP BY needed).
  const sql = `
    SELECT d.id, hits
    FROM (
      SELECT
        d.id,
        COALESCE(
          CASE WHEN d.metadata->>'happenedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
               THEN (d.metadata->>'happenedAt')::timestamptz
               ELSE NULL END,
          d.created_at
        ) AS happened_at,
        (
          SELECT COUNT(*)::int FROM unnest($1::text[]) t
          WHERE lower(COALESCE(d.title, '')) LIKE '%' || t || '%'
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(d.participants, '[]'::jsonb)) p
               WHERE lower(COALESCE(p->>'name', '')) LIKE '%' || t || '%'
                  OR lower(COALESCE(p->>'email', '')) LIKE '%' || t || '%'
             )
             OR lower(COALESCE(d.metadata->>'organization', '')) LIKE '%' || t || '%'
        ) AS hits
      FROM content.documents d
      WHERE d.deleted_at IS NULL
        AND (
          d.source IN ('tldv','gemini')
          OR (d.source = 'drive' AND d.format IN ('tldv','gemini'))
        )
    ) d
    WHERE hits > 0
      AND happened_at >= $2::timestamptz
      AND happened_at <  $3::timestamptz
    ORDER BY hits DESC, happened_at DESC
    LIMIT $4
  `;

  try {
    const { rows } = await query(sql, params);
    return rows.map((r) => r.id);
  } catch (err) {
    log.warn(`findMeetingDocsByIntent failed: ${err.message}`);
    return [];
  }
}

function extractSignificantTerms(queryText) {
  const stop = new Set([
    'what', 'was', 'were', 'how', 'did', 'does', 'do', 'the', 'a', 'an', 'with', 'about', 'from', 'into', 'over',
    'meeting', 'call', 'go', 'went', 'today', 'yesterday', 'tomorrow', 'this', 'last', 'week', 'month', 'since',
    'between', 'and', 'for', 'our', 'their', 'there', 'have', 'has', 'had',
  ]);
  return String(queryText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t))
    .slice(0, 8);
}

function hasSufficientEvidence(queryText, chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  const terms = extractSignificantTerms(queryText);
  const top = chunks.slice(0, 3);
  const best = top[0];
  const bestScore = Number(best?.rerankScore ?? best?.similarity ?? 0);
  const titleOrText = (chunk) =>
    `${chunk?.metadata?.document_title || ''} ${chunk?.text || ''} ${JSON.stringify(chunk?.metadata || {})}`.toLowerCase();

  if (terms.length > 0) {
    const coveredTerms = new Set();
    for (const chunk of top) {
      const hay = titleOrText(chunk);
      for (const term of terms) {
        if (hay.includes(term)) coveredTerms.add(term);
      }
    }
    const coverageRatio = coveredTerms.size / terms.length;
    if (coverageRatio < 0.5) return false;
  }

  // Participant-anchored retrieval is pinned to the right documents by name
  // match against content.documents.participants, so low cosine similarity
  // between chunk text and the meta-question ("how did the meeting go") is
  // expected and not a signal of poor evidence. Skip the bestScore floor.
  const anchored = top.some(ch => ch?.metadata?.participant_anchored === true);
  if (anchored) return true;

  if (bestScore < 0.35) return false;
  return true;
}

function fallbackSummaryFromCitations(citations) {
  const top = (citations || []).slice(0, 5);
  if (top.length === 0) return null;
  return [
    'OpenAI synthesis unavailable. Top relevant passages:',
    ...top.map((c) => `- ${String(c.text || '').trim()}`),
  ].join('\n');
}

/**
 * Ordinal retrieval: handle queries like "my last meeting", "next to last
 * call", "3rd most recent meeting". Orders tl;dv documents newest-first by
 * happenedAt (falling back to created_at), applies participant + owner + class
 * filters, picks the Nth document, and synthesizes over its chunks.
 *
 * Returns the same response shape as the normal /api/search path, or null if
 * the Nth document doesn't exist (caller falls through to vector search).
 */
async function runOrdinalRetrieval({ queryText, ordinalIntent, ownerId, includeOrgWide, sharedDocumentsOnly, maxClassification }) {
  const { detectParticipantsInQuery } = await import('../../../lib/rag/query-participants.js');

  let participantFilterIds = [];
  let queryCandidateNames = [];
  try {
    const detected = await detectParticipantsInQuery(queryText);
    if (detected.filterIds.length > 0) participantFilterIds = detected.filterIds;
    else if (detected.boostIds.length > 0) participantFilterIds = detected.boostIds;
    queryCandidateNames = detected.candidates?.names || [];
  } catch { /* non-fatal */ }

  // When the query named a single person but resolved to multiple contacts,
  // we'll need to disambiguate in the answer so the user can see which
  // contact was picked and which alternatives exist.
  const isAmbiguous = participantFilterIds.length > 1 && queryCandidateNames.length === 1;
  let candidateContacts = [];
  if (isAmbiguous) {
    try {
      // signal.contacts.id is TEXT (gen_random_uuid()::text), not UUID — use
      // text[] here or Postgres errors with "operator does not exist: text = uuid".
      const rows = await query(
        `SELECT id, name, email_address FROM signal.contacts WHERE id = ANY($1::text[])`,
        [participantFilterIds]
      );
      candidateContacts = rows.rows;
    } catch (err) {
      log.warn(`disambiguation contact lookup failed: ${err.message}`);
    }
  }

  const params = [];
  const filters = [
    `(source = 'tldv' OR format = 'tldv')`,
    `deleted_at IS NULL`,
    `sanitized = true`,
  ];
  if (ownerId) {
    params.push(ownerId);
    if (sharedDocumentsOnly) {
      filters.push(`owner_id IS NULL`);
    } else if (includeOrgWide) {
      filters.push(`(owner_id = $${params.length}::uuid OR owner_id IS NULL)`);
    } else {
      filters.push(`owner_id = $${params.length}::uuid`);
    }
  } else if (sharedDocumentsOnly) {
    filters.push(`owner_id IS NULL`);
  }
  params.push(maxClassification);
  filters.push(`classification IN (
    CASE $${params.length} WHEN 'PUBLIC' THEN 'PUBLIC' WHEN 'INTERNAL' THEN 'PUBLIC' WHEN 'CONFIDENTIAL' THEN 'PUBLIC' WHEN 'RESTRICTED' THEN 'PUBLIC' END,
    CASE $${params.length} WHEN 'INTERNAL' THEN 'INTERNAL' WHEN 'CONFIDENTIAL' THEN 'INTERNAL' WHEN 'RESTRICTED' THEN 'INTERNAL' ELSE NULL END,
    CASE $${params.length} WHEN 'CONFIDENTIAL' THEN 'CONFIDENTIAL' WHEN 'RESTRICTED' THEN 'CONFIDENTIAL' ELSE NULL END,
    CASE $${params.length} WHEN 'RESTRICTED' THEN 'RESTRICTED' ELSE NULL END
  )`);
  if (participantFilterIds.length > 0) {
    params.push(participantFilterIds);
    filters.push(`EXISTS (
      SELECT 1 FROM unnest($${params.length}::uuid[]) fid
      WHERE participants @> jsonb_build_array(jsonb_build_object('contact_id', fid::text))
    )`);
  }
  params.push(ordinalIntent.index);

  // happenedAt is sometimes stored as JS Date.toString() ("Fri Apr 17 2026
  // 16:00:00 GMT+0000 (Coordinated Universal Time)") instead of ISO, which
  // Postgres rejects on ::timestamptz. Only cast when it looks ISO-shaped;
  // otherwise fall back to created_at.
  const sql = `SELECT id, title, source, created_at, participants,
                      COALESCE(
                        CASE WHEN metadata->>'happenedAt' ~ '^\\d{4}-\\d{2}-\\d{2}'
                             THEN (metadata->>'happenedAt')::timestamptz
                             ELSE NULL END,
                        created_at
                      ) AS sort_ts
               FROM content.documents
               WHERE ${filters.join(' AND ')}
               ORDER BY sort_ts DESC
               OFFSET $${params.length} LIMIT 1`;

  const docResult = await query(sql, params);
  if (docResult.rows.length === 0) return null;
  const doc = docResult.rows[0];

  const chunksResult = await query(
    `SELECT id, text, token_count, metadata FROM content.chunks
     WHERE document_id = $1 ORDER BY chunk_index LIMIT 40`,
    [doc.id]
  );
  if (chunksResult.rows.length === 0) return null;

  // Normalize participants once — the pg driver may return JSONB as a parsed
  // array or as a raw JSON string depending on pooler config. Used below both
  // for the chunk header and for the disambiguation pickedIds.
  const docParticipantArray = coerceJsonArray(doc.participants);
  const participants = docParticipantArray;
  const participantHeader = participants.length > 0
    ? `[Participants: ${participants.map(p => p?.name || p?.email).filter(Boolean).slice(0, 10).join(', ')}]`
    : null;

  const chunks = chunksResult.rows.map((r) => ({
    text: participantHeader ? `${participantHeader}\n${r.text}` : r.text,
    similarity: 1.0, // ordinal match is precise — not a semantic score
    documentId: doc.id,
    metadata: {
      ...(r.metadata || {}),
      document_title: doc.title,
      document_source: doc.source,
      document_created_at: doc.created_at,
      document_participants: participants,
      ordinal_index: ordinalIntent.index,
      retrieval_mode: 'ordinal',
    },
  }));

  // Build a short picked-document description for the synthesizer so it has
  // one more grounding cue than the [Participants: …] chunk header alone.
  const pickedSummaryParts = [doc.title].filter(Boolean);
  if (doc.source) pickedSummaryParts.push(`source=${doc.source}`);
  const pickedDescription = pickedSummaryParts.join(' · ');

  // Surface the meeting's extracted decisions / commitments / action items
  // alongside the transcript chunks — same idea as the full pipeline path.
  const signalChunks = await fetchMeetingSignalChunks([doc.id]);
  const augmentedChunks = signalChunks.length > 0 ? [...signalChunks, ...chunks] : chunks;
  const synthesized = await synthesizeAnswer(queryText, augmentedChunks, null, {
    participantAnchored: participantFilterIds.length > 0,
    pickedDescription,
  });
  const fallbackAnswer = fallbackSummaryFromCitations(chunks.slice(0, 5).map(c => ({ text: c.text })));

  // Build a disambiguation preamble when "last meeting with X" matched
  // multiple contacts for a single query name. Tells the user which one was
  // picked for this result, and lists the alternatives with their email
  // domain so they can re-query with a qualifier.
  const pickedIds = docParticipantArray
    .map(p => p?.contact_id)
    .filter(Boolean);
  const disambiguation = isAmbiguous
    ? buildDisambiguation(queryCandidateNames[0], candidateContacts, pickedIds, 'the most recent meeting')
    : '';

  const finalAnswer = synthesized?.answer || fallbackAnswer;

  return {
    answer: disambiguation + (finalAnswer || ''),
    citations: chunks.slice(0, 5).map(c => ({
      text: c.text.slice(0, 200),
      similarity: c.similarity,
      documentId: c.documentId,
      metadata: c.metadata,
    })),
    chunks,
    tokens: synthesized?.tokens,
    project: null,
  };
}

/**
 * Coerce a column value that might be a JS array OR a JSON string into an
 * actual array. The `pg` driver normally parses JSONB on the way out, but
 * certain pooler configurations (Supabase PgBouncer transaction mode with
 * pgbouncer=true) can return it as raw text. Handle both silently.
 */
function coerceJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

/**
 * When a single query name (e.g. "Glenn") resolved to multiple signal.contacts,
 * build a one-paragraph preamble that tells the user which one the result is
 * about and lists the alternatives with their email domain. Users re-query
 * with a qualifier ("meeting with Glenn Fell") to get a specific person.
 *
 * @param {string} queryName — the single name from detectParticipantsInQuery.candidates.names
 * @param {Array<{id: string, name: string|null, email_address: string}>} candidateContacts — all matches
 * @param {string[]} pickedIds — contact_ids present on the document(s) we're about to return
 * @param {string} pickedLabel — e.g. "the most recent meeting" or "these results"
 * @returns {string} preamble text (empty if not ambiguous)
 */
function buildDisambiguation(queryName, candidateContacts, pickedIds, pickedLabel) {
  if (!queryName || !Array.isArray(candidateContacts) || candidateContacts.length < 2) return '';
  const pickedSet = new Set(pickedIds || []);
  const picked = candidateContacts.filter(c => pickedSet.has(c.id));
  const alternatives = candidateContacts.filter(c => !pickedSet.has(c.id));
  if (picked.length === 0 || alternatives.length === 0) return '';

  const fmt = (c) => {
    const domain = c.email_address?.split('@')[1];
    return domain ? `${c.name || c.email_address} (${domain})` : (c.name || c.email_address);
  };
  const pickedStr = picked.map(fmt).join(', ');
  const altStr = alternatives.map(fmt).join(', ');
  const exampleAlt = alternatives[0].name || alternatives[0].email_address;
  return `Note: "${queryName}" matched ${candidateContacts.length} contacts. Showing ${pickedLabel} with ${pickedStr}. Other matches: ${altStr}. Re-run with a full name (e.g. "meeting with ${exampleAlt}") to get a specific person.\n\n`;
}

/**
 * Pull extracted signals (commitments / decisions / action items / etc)
 * for the meetings the search just retrieved, and shape them into
 * synthetic chunks the synthesizer can cite alongside transcript text.
 *
 * Signals live in inbox.signals keyed on inbox.messages.id. Meeting
 * documents come in via channel='webhook' with channel_id = doc.source_id,
 * so the join is: signals → messages → documents on
 * (m.channel = 'webhook' AND m.channel_id = d.source_id).
 *
 * Returns one synthetic chunk per document with a short, structured
 * "Decisions / Commitments / Action items" body. Empty array when no
 * signals were extracted from any of the docs — caller leaves chunks
 * untouched.
 */
export async function fetchMeetingSignalChunks(documentIds) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) return [];
  const uniqIds = [...new Set(documentIds.filter(Boolean))];
  if (uniqIds.length === 0) return [];

  let rows;
  try {
    const result = await query(
      `
      SELECT
        d.id            AS document_id,
        d.title         AS title,
        s.signal_type   AS signal_type,
        s.content       AS content,
        s.direction     AS direction,
        s.due_date      AS due_date,
        s.resolved      AS resolved,
        s.created_at    AS created_at
      FROM content.documents d
      JOIN inbox.messages m
        ON m.channel = 'webhook'
       AND m.channel_id = d.source_id
      JOIN inbox.signals s
        ON s.message_id = m.id
      WHERE d.id = ANY($1::uuid[])
      ORDER BY d.id, s.signal_type, s.created_at ASC
      `,
      [uniqIds],
    );
    rows = result.rows;
  } catch (err) {
    log.warn(`fetchMeetingSignalChunks failed: ${err.message}`);
    return [];
  }

  if (rows.length === 0) return [];

  // Group by document, then by signal_type, building one synthetic chunk per
  // document. Cap per-type to avoid blowing the context window when a meeting
  // produced dozens of action items.
  const PER_TYPE_CAP = 10;
  const TYPE_LABELS = {
    decision: 'Decisions',
    commitment: 'Commitments',
    action_item: 'Action items',
    deadline: 'Deadlines',
    request: 'Requests',
    approval_needed: 'Approvals needed',
    question: 'Open questions',
    introduction: 'Introductions',
    info: 'Notes',
  };
  // Render order — most decision-y first.
  const TYPE_ORDER = ['decision', 'commitment', 'action_item', 'deadline', 'approval_needed', 'request', 'question', 'introduction', 'info'];

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.document_id)) {
      byDoc.set(r.document_id, { title: r.title, byType: new Map() });
    }
    const docBucket = byDoc.get(r.document_id);
    if (!docBucket.byType.has(r.signal_type)) docBucket.byType.set(r.signal_type, []);
    docBucket.byType.get(r.signal_type).push(r);
  }

  const out = [];
  for (const [docId, { title, byType }] of byDoc) {
    const lines = [`Meeting signals — ${title || docId}`];
    let added = 0;
    for (const t of TYPE_ORDER) {
      const items = byType.get(t);
      if (!items || items.length === 0) continue;
      lines.push('');
      lines.push(`${TYPE_LABELS[t] || t}:`);
      for (const it of items.slice(0, PER_TYPE_CAP)) {
        const prefix = it.direction ? `[${it.direction}] ` : '';
        const due = it.due_date ? ` (due ${new Date(it.due_date).toISOString().slice(0, 10)})` : '';
        const resolved = it.resolved ? ' ✓' : '';
        lines.push(`- ${prefix}${it.content}${due}${resolved}`);
        added++;
      }
      if (items.length > PER_TYPE_CAP) {
        lines.push(`- … ${items.length - PER_TYPE_CAP} more ${TYPE_LABELS[t]?.toLowerCase() || t}`);
      }
    }
    if (added === 0) continue;
    out.push({
      // Synthetic chunk: high similarity so it ranks alongside the best
      // transcript chunks during synthesis. retrieval_mode tags the source
      // so downstream UI can render it distinctly if it wants to.
      text: lines.join('\n'),
      similarity: 0.95,
      documentId: docId,
      metadata: {
        document_title: title,
        retrieval_mode: 'meeting_signals',
        signal_count: added,
      },
    });
  }
  return out;
}

async function synthesizeAnswer(queryText, chunks, temporalRange, opts = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.RAG_SEARCH_OPENAI_MODEL || 'gpt-4o-mini';
  const context = chunks
    .slice(0, 8)
    .map((c, i) => `[#${i + 1}] score=${Number(c.similarity || 0).toFixed(3)}\n${c.text}`)
    .join('\n\n---\n\n');
  const temporalInstruction = temporalRange
    ? `The user asked a time-scoped query (${temporalRange.label}). Use ONLY evidence from that time window. If none exists, say so clearly.`
    : 'Use only evidence in the provided passages.';

  // When retrieval was participant-anchored (query named a specific person and
  // we filtered/picked docs by their presence in the participants list), the
  // document-is-the-right-meeting fact is already proven by structured metadata.
  // The LLM shouldn't require the chunk text to also discuss that person by
  // name. Silent attendees are real.
  const participantInstructions = [];
  if (opts.participantAnchored) {
    participantInstructions.push(
      'The retrieval was anchored to participant membership — the document(s) supplied DO correspond to meetings attended by the person(s) named in the question. Treat that as verified; do NOT say "no matching meeting was found" just because the chunk text does not mention the named person directly. Describe what the meeting was about using the chunk content.',
    );
  }
  if (opts.pickedDescription) {
    participantInstructions.push(`Picked document: ${opts.pickedDescription}.`);
  }

  const response = await client.chat.completions.create({
    model,
    max_tokens: 700,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'You answer questions from retrieved internal documents. Be concise and precise. Never invent facts. Cite uncertainty explicitly.',
      },
      {
        role: 'user',
        content: [
          `Question: ${queryText}`,
          temporalInstruction,
          ...participantInstructions,
          'Summarize the answer in 3-8 bullet points, then add a one-line confidence statement.',
          opts.participantAnchored
            ? 'If the passages genuinely contain no substantive content, say the meeting yielded little recorded discussion — do NOT say "no matching meeting was found" because the meeting itself is confirmed.'
            : 'If the query asks for a specific meeting and evidence is insufficient, clearly say no matching meeting was found in retrieved data.',
          `Passages:\n${context}`,
        ].join('\n\n'),
      },
    ],
  });
  const text = response.choices?.[0]?.message?.content?.trim() || '';
  if (!text) return null;
  return {
    answer: text,
    tokens: {
      input: response.usage?.prompt_tokens || 0,
      output: response.usage?.completion_tokens || 0,
    },
  };
}

// TODO(opt-166-p3): mixed principal / out of this batch's minimal-scope
// mandate — this file has no requireBoard()/withViewer() scaffolding at all.
// Tenancy here runs through a separate mechanism (`ragSearchOptionsFromRequest`
// + `retrieverScopeWithOrg` from document-access.js), and the enforced-table
// touchpoints (resolveProjectDocuments, runOrdinalRetrieval,
// fetchMeetingSignalChunks, GET /api/search/stats) live inside helper
// functions that take a bare `queryFn`/`query`, not `req` — there is no
// `req.auth` available at the call site to hand to withBoardScope(), and
// GET /api/search/stats has zero auth guard today. Wrapping correctly would
// require threading req.auth through several layers of nested helpers, which
// is a larger refactor than this batch's mandate. Left unwrapped pending a
// dedicated follow-up.
export function registerSearchRoutes(routes) {
  async function resolveProjectDocuments(projectSlug) {
    const projectR = await query(
      `SELECT id, slug, name FROM agent_graph.projects WHERE slug = $1`,
      [projectSlug]
    );
    if (projectR.rows.length === 0) {
      const e = new Error('Project not found');
      e.statusCode = 404;
      throw e;
    }
    const project = projectR.rows[0];
    const docsR = await query(
      `SELECT pm.entity_id AS document_id
       FROM agent_graph.project_memberships pm
       LEFT JOIN content.documents d ON d.id::text = pm.entity_id
       WHERE pm.project_id = $1
         AND pm.entity_type = 'document'
         AND d.deleted_at IS NULL`,
      [project.id]
    );
    return {
      project,
      documentIds: docsR.rows.map((r) => r.document_id),
    };
  }

  // POST /api/search — Full RAG pipeline: query rewrite → vector + graph → rerank → synthesize
  // Uses retrieveContext() which includes reranking, query rewriting, and graph search.
  routes.set('POST /api/search', async (req, body) => {
    const { query: queryText, matchCount, minSimilarity, raw } = body || {};
    if (!queryText) return { error: 'query is required' };
    const projectSlug = body?.projectSlug ? String(body.projectSlug).trim() : null;
    const projectOnly = body?.projectOnly === true;
    // Caller-supplied participant scope (e.g. /contacts/[id] page).
    // Bypasses auto-detection in retrieveContext when present.
    const participantIds = Array.isArray(body?.participantIds)
      ? body.participantIds.filter(id => typeof id === 'string' && id.length > 0)
      : null;

    const so = ragSearchOptionsFromRequest(req, body || {});
    if (so.error) {
      throw Object.assign(new Error(so.error), { statusCode: 403 });
    }
    // Worktree 1 (RAG tenancy hardening): derive the retriever scope arg
    // from the same auth context. retrieverScopeWithOrg throws with
    // statusCode 400/401/403 on unresolvable scope — translate to the
    // route's standard error envelope by re-throwing as-is. Phase-2: it also
    // attaches readOrgIds so match_chunks fails closed on owner_org_id.
    const retrieverScope = await retrieverScopeWithOrg(req, body || {});
    let projectContext = null;
    if (projectSlug) {
      projectContext = await resolveProjectDocuments(projectSlug);
      if (projectOnly && projectContext.documentIds.length === 0) {
        return {
          answer: null,
          chunks: [],
          message: `No documents are attached to project "${projectContext.project.name}" yet.`,
          project: {
            slug: projectContext.project.slug,
            name: projectContext.project.name,
            mode: 'project_only',
            document_count: 0,
          },
        };
      }
    }
    const documentIds = projectOnly ? projectContext?.documentIds : null;
    const timezoneOffsetMinutes = Number.isFinite(Number(body?.timezoneOffsetMinutes))
      ? Number(body.timezoneOffsetMinutes)
      : new Date().getTimezoneOffset();
    const now = body?.nowIso ? new Date(String(body.nowIso)) : new Date();
    const temporalRange = parseTemporalRange(queryText, Number.isNaN(now.getTime()) ? new Date() : now, timezoneOffsetMinutes);
    const meetingIntent = extractMeetingIntent(queryText);
    const ordinalIntent = extractOrdinalIntent(queryText);

    // Ordinal precheck: "my last meeting", "next to last", "3rd most recent".
    // Order tl;dv documents by happenedAt DESC (falling back to created_at),
    // optionally narrowed by participant and owner, pick the Nth, synthesize
    // over its chunks. Bypasses vector search because the user specified a
    // position, not a topic.
    if (ordinalIntent && !raw) {
      const result = await runOrdinalRetrieval({
        queryText,
        ordinalIntent,
        ownerId: so.ownerId,
        includeOrgWide: so.includeOrgWide,
        sharedDocumentsOnly: so.sharedDocumentsOnly,
        maxClassification: so.maxClassification || 'INTERNAL',
      });
      if (result) return result;
      // Fall through to standard pipeline if ordinal path found no docs.
    }

    // Raw mode: skip reranking/synthesis, return raw vector search results
    if (raw) {
      const result = await searchChunks(queryText, {
        matchCount: matchCount || 30,
        minSimilarity,
        ownerId: so.ownerId,
        includeOrgWide: so.includeOrgWide,
        sharedDocumentsOnly: so.sharedDocumentsOnly,
        documentIds,
        temporalRange,
        ...(participantIds && participantIds.length > 0 ? { participantFilter: participantIds } : {}),
      }, retrieverScope);
      const rawChunks = filterChunksByMeetingIntent(result?.chunks || [], meetingIntent);
      return {
        chunks: rawChunks,
        model: result?.model,
        project: projectContext
          ? {
              slug: projectContext.project.slug,
              name: projectContext.project.name,
              mode: projectOnly ? 'project_only' : 'project_plus_kb',
              document_count: projectContext.documentIds.length,
            }
          : null,
      };
    }

    // For strict meeting+time queries, anchor on documents whose envelope
    // (title / participants / metadata.organization) matches the intent
    // tokens BEFORE running vector search. When the anchor returns docs we
    // narrow the chunk search to just those documentIds and skip the
    // meeting-intent token filter — the doc itself already matched. When
    // it returns nothing we still do the broad chunk search + token filter
    // as before, so a query referencing a meeting we don't have envelope
    // data for still has a chance via transcript-body tokens.
    let meetingAnchorIds = null;
    if (meetingIntent?.isMeetingQuery && temporalRange && (meetingIntent.requiredTokens || []).length > 0) {
      const anchored = await findMeetingDocsByIntent(meetingIntent.requiredTokens, temporalRange);
      if (anchored.length > 0) meetingAnchorIds = anchored;
    }

    if (meetingIntent?.isMeetingQuery && temporalRange) {
      const precheck = await searchChunks(queryText, {
        matchCount: Math.max(20, Number(matchCount) || 30),
        minSimilarity,
        ownerId: so.ownerId,
        includeOrgWide: so.includeOrgWide,
        sharedDocumentsOnly: so.sharedDocumentsOnly,
        documentIds: meetingAnchorIds || documentIds,
        temporalRange,
      }, retrieverScope);
      const precheckChunks = meetingAnchorIds
        ? (precheck?.chunks || [])
        : filterChunksByMeetingIntent(precheck?.chunks || [], meetingIntent);
      if (precheckChunks.length === 0) {
        return {
          answer: null,
          chunks: [],
          message: `No relevant documents found for ${temporalRange.label} matching that meeting. Calendar integration is not configured in this runtime, so this result is based only on ingested knowledge documents.`,
          project: projectContext
            ? {
                slug: projectContext.project.slug,
                name: projectContext.project.name,
                mode: projectOnly ? 'project_only' : 'project_plus_kb',
                document_count: projectContext.documentIds.length,
              }
            : null,
        };
      }
    }

    // Full pipeline: rewrite → search → graph → rerank → synthesize.
    // Pass meetingAnchorIds (resolved above) as documentIds when the
    // envelope-match anchor found a meeting — this scopes the broader
    // pipeline (lexical, graph, rerank) to the right meeting too, and
    // suppresses the token re-filter on the output since the doc has
    // already passed the intent.
    log.info(`Search: "${queryText.slice(0, 80)}"${participantIds?.length ? ` [scoped to ${participantIds.length} participant(s)]` : ''}${meetingAnchorIds ? ` [meeting-anchored: ${meetingAnchorIds.length} doc(s)]` : ''}`);
    const context = await retrieveContext(queryText, {
      ownerId: so.ownerId,
      includeOrgWide: so.includeOrgWide,
      sharedDocumentsOnly: so.sharedDocumentsOnly,
      maxClassification: so.maxClassification || 'INTERNAL',
      documentIds: meetingAnchorIds || documentIds,
      temporalRange,
      ...(participantIds && participantIds.length > 0 ? { participantFilter: participantIds } : {}),
    }, retrieverScope);

    const filteredChunks = meetingAnchorIds
      ? (context?.chunks || [])
      : filterChunksByMeetingIntent(context?.chunks || [], meetingIntent);
    const filteredCitations = (context?.citations || []).filter((c) =>
      filteredChunks.some(
        (ch) =>
          ch.documentId === c.documentId &&
          (ch.text.startsWith(c.text || '') || (c.text || '').startsWith(ch.text.slice(0, 120)))
      )
    );

    if (!context || filteredCitations.length === 0) {
      const calendarHint =
        'Calendar integration is not configured in this runtime, so this result is based only on ingested knowledge documents.';
      return {
        answer: null,
        chunks: [],
        message: temporalRange
          ? `No relevant documents found for ${temporalRange.label}${meetingIntent?.isMeetingQuery ? ' matching that meeting' : ''}. ${calendarHint}`
          : 'No relevant documents found',
        project: projectContext
          ? {
              slug: projectContext.project.slug,
              name: projectContext.project.name,
              mode: projectOnly ? 'project_only' : 'project_plus_kb',
              document_count: projectContext.documentIds.length,
            }
          : null,
      };
    }

    if (!hasSufficientEvidence(queryText, filteredChunks)) {
      return {
        answer: null,
        chunks: [],
        message: 'Search found only weak or indirect matches, so no answer was returned. Try using a more specific meeting title, participant name, or date range.',
        project: projectContext
          ? {
              slug: projectContext.project.slug,
              name: projectContext.project.name,
              mode: projectOnly ? 'project_only' : 'project_plus_kb',
              document_count: projectContext.documentIds.length,
            }
          : null,
      };
    }

    // If any retrieved chunk is participant-anchored, tell the synthesizer
    // so it doesn't bail out with "no matching meeting found" when the
    // chunks are about business content rather than the named person's own words.
    const anyParticipantAnchored = (filteredChunks || []).some(
      (c) => c?.metadata?.participant_anchored === true || c?.metadata?.participant_match === true
    );

    // Surface extracted signals (decisions / commitments / action items)
    // for the meetings we just retrieved. They give the synthesizer the
    // structured "what did we decide / commit to" answer without forcing
    // it to re-derive from transcript prose.
    const meetingDocIds = [...new Set((filteredChunks || []).map((c) => c?.documentId).filter(Boolean))];
    const signalChunks = await fetchMeetingSignalChunks(meetingDocIds);
    const augmentedChunks = signalChunks.length > 0
      ? [...signalChunks, ...filteredChunks]
      : filteredChunks;

    const synthesized = await synthesizeAnswer(queryText, augmentedChunks, temporalRange, {
      participantAnchored: anyParticipantAnchored,
    });
    const fallbackAnswer = fallbackSummaryFromCitations(filteredCitations);

    // Disambiguate when the query named a single person that matched multiple
    // contacts (e.g. two Glenns). Gather contact_ids actually present on the
    // returned citations and compare with what the query resolved to.
    let disambiguation = '';
    try {
      const { detectParticipantsInQuery } = await import('../../../lib/rag/query-participants.js');
      const detected = await detectParticipantsInQuery(queryText);
      const resolvedIds = detected.filterIds.length > 0 ? detected.filterIds : detected.boostIds;
      const queryNames = detected.candidates?.names || [];
      if (resolvedIds.length > 1 && queryNames.length === 1) {
        // signal.contacts.id is TEXT, not UUID — casting to text[] avoids a
        // silent "operator does not exist: text = uuid" error that swallowed
        // the disambiguation note.
        const contactRows = await query(
          `SELECT id, name, email_address FROM signal.contacts WHERE id = ANY($1::text[])`,
          [resolvedIds]
        );
        const pickedIds = new Set();
        for (const c of filteredChunks) {
          for (const p of coerceJsonArray(c?.metadata?.document_participants)) {
            if (p?.contact_id) pickedIds.add(p.contact_id);
          }
        }
        disambiguation = buildDisambiguation(
          queryNames[0],
          contactRows.rows,
          [...pickedIds],
          'these results',
        );
      }
    } catch { /* non-fatal — skip the note */ }

    const composedAnswer = disambiguation + (synthesized?.answer || fallbackAnswer || '');

    return {
      answer: composedAnswer || null,
      citations: filteredCitations,
      chunks: filteredChunks,
      tokens: synthesized?.tokens || context.tokens,
      project: projectContext
        ? {
            slug: projectContext.project.slug,
            name: projectContext.project.name,
            mode: projectOnly ? 'project_only' : 'project_plus_kb',
            document_count: projectContext.documentIds.length,
          }
        : null,
    };
  });

  // GET /api/search/stats — search system health
  routes.set('GET /api/search/stats', async () => {
    const info = getEmbeddingInfo();
    const docCount = await query('SELECT count(*) as c FROM content.documents WHERE deleted_at IS NULL');
    const chunkCount = await query('SELECT count(*) as c FROM content.chunks WHERE embedding IS NOT NULL');
    return {
      documents: parseInt(docCount.rows[0]?.c || 0),
      embeddedChunks: parseInt(chunkCount.rows[0]?.c || 0),
      embeddingProvider: info,
      ready: !!info && parseInt(chunkCount.rows[0]?.c || 0) > 0,
    };
  });
}
