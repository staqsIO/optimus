/**
 * Weekly action-item recap: Saturday 00:00 local, one email per board member
 * summarising the just-completed work week's tl;dv meetings they attended,
 * grouped by meeting with timestamped action items.
 *
 * Data flow:
 *   content.documents (source='tldv', participants contains member email)
 *     -> meeting_action_items cache (LLM extraction; Haiku)
 *     -> grouped HTML formatted to match the tl;dv "AI Insights" layout
 *     -> Gmail users.messages.send FROM member's own account TO their own email
 *     -> weekly_recaps_sent (unique on week_start + recipient_email)
 *
 * Env vars:
 *   WEEKLY_RECAP_ENABLED     — 'true' to enable
 *   WEEKLY_RECAP_HOUR_LOCAL  — hour-of-day to fire on Saturday (default: 0)
 */

import { writeFileSync } from 'fs';
import { google } from 'googleapis';
import { query } from '../db.js';
import { getAuthForAccount } from '../gmail/auth.js';
import { createLLMClient, callProvider, computeCost } from '../../../lib/llm/provider.js';
import { getConfig } from '../../../lib/config/loader.js';

const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
const RECAP_SUBJECT_PREFIX = 'Your action items from last week\'s meetings';

// Bounded concurrency for the per-meeting LLM extraction. Small on purpose:
// enough to overlap network round-trips without tripping provider rate limits.
// Override via WEEKLY_RECAP_EXTRACT_CONCURRENCY (clamped to 1..8).
const RECAP_EXTRACT_CONCURRENCY = Math.min(
  8,
  Math.max(1, parseInt(process.env.WEEKLY_RECAP_EXTRACT_CONCURRENCY || '4', 10) || 4)
);

/**
 * Map `items` through async `fn` with at most `limit` in flight at once.
 * Results are returned in the SAME order as `items` regardless of completion
 * order, so downstream ordering (e.g. grouped recap HTML) is preserved.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  // Fail-fast (Linus review of #517 / #518): once any worker's fn throws, stop
  // the sibling workers from pulling NEW items off the queue. Promise.all
  // rejects on the first throw, but without this flag the other in-loop workers
  // keep draining `items` to completion — extra LLM calls + cache writes for
  // meetings the old strict-serial loop would never have reached. We can't
  // cancel a call already in flight (fn has no AbortSignal), so this bounds the
  // wasted work to at most the (limit-1) calls already awaiting when the first
  // failure lands, instead of the whole remaining queue.
  let failed = false;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err; // preserve the reject-on-first-error contract
      }
    }
  });
  await Promise.all(workers);
  return results;
}

let _modelsConfig = null;
function loadModelsConfig() {
  if (_modelsConfig) return _modelsConfig;
  _modelsConfig = getConfig('agents').models;
  return _modelsConfig;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract action items for a tl;dv document. Cached on inbox.meeting_action_items.
 * @param {string} documentId
 * @param {{ rawText: string, title: string }} meeting
 * @returns {Promise<Array<{person: string, action: string, timestamp: string}>>}
 */
export async function extractActionItemsForDocument(documentId, meeting) {
  const cached = await query(
    `SELECT items FROM inbox.meeting_action_items WHERE document_id = $1`,
    [documentId]
  );
  if (cached.rows.length > 0) return cached.rows[0].items;

  const llm = createLLMClient(EXTRACTION_MODEL, loadModelsConfig());
  const system = `You extract action items from meeting transcripts. Return ONLY a JSON array — no prose, no markdown fences.

Each item has three string fields:
  - "person": the person responsible (first name + last initial if present, else first name)
  - "action": the action phrased as "to <verb> <object>" (e.g. "to send the contract to Josh")
  - "timestamp": the transcript timestamp in mm:ss or hh:mm:ss format where the commitment was made

Rules:
- Only include explicit commitments, not hypotheticals or past actions.
- One item per commitment. Do not combine multiple actions into one.
- If a commitment has no clear timestamp, use "00:00".
- If no action items are present, return [].`;

  const user = `Meeting title: ${meeting.title}

Transcript:
${meeting.rawText.slice(0, 90_000)}`;

  const resp = await callProvider(llm, {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4096,
    temperature: 0,
  });

  let items = [];
  try {
    const cleaned = resp.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      items = parsed
        .filter(x => x && typeof x.person === 'string' && typeof x.action === 'string')
        .map(x => ({
          person: String(x.person).slice(0, 120),
          action: String(x.action).slice(0, 500),
          timestamp: String(x.timestamp || '00:00').slice(0, 12),
        }));
    }
  } catch (err) {
    console.warn(`[weekly-recap] Failed to parse extraction output for ${documentId}: ${err.message}`);
  }

  await query(
    `INSERT INTO inbox.meeting_action_items (document_id, items, model, extracted_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (document_id) DO UPDATE
       SET items = EXCLUDED.items, model = EXCLUDED.model, extracted_at = now()`,
    [documentId, JSON.stringify(items), EXTRACTION_MODEL]
  );

  const cost = computeCost(resp.inputTokens, resp.outputTokens, loadModelsConfig()[EXTRACTION_MODEL]);
  console.log(
    `[weekly-recap] Extracted ${items.length} items from ${documentId} (${resp.inputTokens}+${resp.outputTokens} tok, $${cost.toFixed(4)})`
  );
  return items;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Start of the current work week (Monday 00:00 UTC) relative to `now`.
 * When the scheduler fires on Saturday, this returns the Monday of that
 * same week; combined with a 7-day window this yields Mon→Sun recap,
 * but only Mon–Fri will actually have meetings by Saturday morning.
 */
function thisWeekMondayStart(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();             // Sun=0, Mon=1, …, Sat=6
  const daysSinceMonday = (day + 6) % 7;  // Mon→0, Tue→1, …, Sun→6
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

async function fetchMeetingsForMember(email, windowStart, windowEnd) {
  const result = await query(
    `SELECT d.id, d.title, d.raw_text, d.participants,
            d.metadata->>'happenedAt' AS happened_at,
            d.metadata->>'url' AS tldv_url
       FROM content.documents d
      WHERE d.source = 'tldv'
        AND COALESCE((d.metadata->>'happenedAt')::timestamptz, d.created_at) >= $2
        AND COALESCE((d.metadata->>'happenedAt')::timestamptz, d.created_at) <  $3
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(d.participants) p
          WHERE lower(p->>'email') = lower($1)
        )
      ORDER BY COALESCE((d.metadata->>'happenedAt')::timestamptz, d.created_at) ASC`,
    [email, windowStart.toISOString(), windowEnd.toISOString()]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// HTML formatting
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatMeetingDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  });
}

function buildRecapHtml({ recipientName, meetings }) {
  const sections = meetings.map(m => {
    const rows = m.items.map(it => `
      <tr>
        <td style="padding:6px 0;color:#222;font-size:14px;line-height:1.4;">
          <strong>${escapeHtml(it.person)}</strong> ${escapeHtml(it.action)}
          <span style="color:#999;font-size:12px;margin-left:6px;">${escapeHtml(it.timestamp)}</span>
        </td>
      </tr>`).join('');
    const dateLine = formatMeetingDate(m.happened_at);
    const titleHtml = m.tldv_url
      ? `<a href="${escapeHtml(m.tldv_url)}" style="color:#1a73e8;text-decoration:none;">${escapeHtml(m.title)}</a>`
      : escapeHtml(m.title);
    return `
      <table style="width:100%;border-collapse:collapse;margin:0 0 32px 0;">
        <tr><td style="padding-bottom:4px;font-size:16px;font-weight:600;color:#111;">${titleHtml}</td></tr>
        <tr><td style="padding-bottom:10px;font-size:13px;color:#666;">Meeting Date: ${escapeHtml(dateLine)}</td></tr>
        ${rows}
      </table>`;
  }).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;">
  <div style="max-width:680px;margin:0 auto;">
    <h1 style="font-size:20px;font-weight:600;color:#111;margin:0 0 4px 0;">AI Insights across meetings</h1>
    <p style="font-size:14px;color:#666;margin:0 0 24px 0;">${escapeHtml(recipientName ? `${recipientName}, your` : 'Your')} action items from last week's meetings</p>
    ${sections || '<p style="color:#999;font-size:14px;">No meetings with action items this week.</p>'}
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function buildMimeMessage({ from, to, subject, html }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ];
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + html).toString('base64url');
}

async function sendRecapEmail({ accountId, fromEmail, toEmail, subject, html }) {
  const auth = await getAuthForAccount(accountId);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildMimeMessage({ from: fromEmail, to: toEmail, subject, html });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return res.data.id;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {Date}   [opts.now]             Reference time (default: now)
 * @param {number} [opts.windowDays]      Use a rolling N-day window ending at `now` instead of Mon→Sun
 * @param {string[]} [opts.onlyEmails]    Restrict to these recipient addresses (case-insensitive)
 * @param {Array<{email:string,displayName?:string,accountId:string,memberId?:string}>} [opts.overrideRecipients]
 *                                        Bypass board_members; use this explicit recipient list instead
 * @param {boolean} [opts.dryRun]         Do not send; write HTML to /tmp/weekly-recap-<email>-<week>.html
 */
export async function sendWeeklyRecaps({
  now = new Date(),
  windowDays,
  onlyEmails,
  overrideRecipients,
  dryRun = false,
} = {}) {
  let windowStart;
  let windowEnd;
  if (windowDays && windowDays > 0) {
    windowEnd = new Date(now);
    windowStart = new Date(now.getTime() - windowDays * 86_400_000);
  } else {
    windowStart = thisWeekMondayStart(now);
    windowEnd = new Date(windowStart.getTime() + 7 * 86_400_000);
  }
  const weekStartDate = windowStart.toISOString().slice(0, 10);
  const onlyEmailsLC = onlyEmails ? new Set(onlyEmails.map(e => e.toLowerCase())) : null;

  let recipients;
  if (overrideRecipients && overrideRecipients.length > 0) {
    recipients = overrideRecipients.map(r => ({
      id: r.memberId || null,
      display_name: r.displayName || r.email,
      email: r.email,
      account_id: r.accountId,
    }));
  } else {
    const membersRes = await query(
      `SELECT bm.id, bm.display_name, bm.email,
              (SELECT a.id FROM inbox.accounts a
                WHERE a.owner_id = bm.id AND a.channel = 'email' AND a.is_active = true
                ORDER BY a.created_at ASC LIMIT 1) AS account_id
         FROM agent_graph.board_members bm
        WHERE bm.is_active = true AND bm.email IS NOT NULL`
    );
    recipients = membersRes.rows;
  }
  if (onlyEmailsLC) {
    recipients = recipients.filter(r => onlyEmailsLC.has(String(r.email).toLowerCase()));
  }

  const stats = { members: 0, meetings: 0, items: 0, sent: 0, skipped: 0, errors: 0, dryRun };

  for (const member of recipients) {
    stats.members++;
    try {
      if (!dryRun) {
        const already = await query(
          `SELECT 1 FROM inbox.weekly_recaps_sent WHERE week_start = $1 AND recipient_email = $2`,
          [weekStartDate, member.email]
        );
        if (already.rows.length > 0) {
          stats.skipped++;
          continue;
        }
      }

      if (!member.account_id) {
        console.warn(`[weekly-recap] No connected Gmail account for ${member.email}; skipping`);
        stats.skipped++;
        continue;
      }

      const meetings = await fetchMeetingsForMember(member.email, windowStart, windowEnd);
      if (meetings.length === 0) {
        stats.skipped++;
        console.log(`[weekly-recap] No meetings for ${member.email} in week starting ${weekStartDate}`);
        continue;
      }

      // Extract action items with bounded concurrency (not strictly serial, not
      // an unbounded fan-out) to respect the LLM provider's rate limits while
      // still shaving wall-clock. Original meeting order is preserved so the
      // grouped recap HTML is byte-identical to the serial version.
      const itemsPerMeeting = await mapWithConcurrency(
        meetings,
        RECAP_EXTRACT_CONCURRENCY,
        (m) => extractActionItemsForDocument(m.id, {
          rawText: m.raw_text || '',
          title: m.title || 'Untitled meeting',
        })
      );
      const enriched = [];
      meetings.forEach((m, i) => {
        const items = itemsPerMeeting[i];
        if (items.length > 0) enriched.push({ ...m, items });
      });

      if (enriched.length === 0) {
        stats.skipped++;
        console.log(`[weekly-recap] No action items for ${member.email} this week`);
        continue;
      }

      stats.meetings += enriched.length;
      stats.items += enriched.reduce((a, m) => a + m.items.length, 0);

      const html = buildRecapHtml({ recipientName: member.display_name, meetings: enriched });
      const itemCount = enriched.reduce((a, m) => a + m.items.length, 0);

      if (dryRun) {
        const safeEmail = member.email.replace(/[^a-zA-Z0-9]/g, '_');
        const path = `/tmp/weekly-recap-${safeEmail}-${weekStartDate}.html`;
        writeFileSync(path, html, 'utf-8');
        console.log(
          `[weekly-recap] DRY RUN for ${member.email}: ${enriched.length} meetings, ${itemCount} items. Preview: ${path}`
        );
        stats.sent++;
        continue;
      }

      const providerSentId = await sendRecapEmail({
        accountId: member.account_id,
        fromEmail: member.email,
        toEmail: member.email,
        subject: RECAP_SUBJECT_PREFIX,
        html,
      });

      await query(
        `INSERT INTO inbox.weekly_recaps_sent
           (week_start, recipient_email, recipient_member, sender_account_id, provider_sent_id, meetings_count, items_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (week_start, recipient_email) DO NOTHING`,
        [weekStartDate, member.email, member.id, member.account_id, providerSentId, enriched.length, itemCount]
      );

      stats.sent++;
      console.log(
        `[weekly-recap] Sent to ${member.email}: ${enriched.length} meetings, ${itemCount} items (${providerSentId})`
      );
    } catch (err) {
      stats.errors++;
      console.error(`[weekly-recap] Error for ${member.email}: ${err.message}`);
    }
  }

  console.log(
    `[weekly-recap] Week ${weekStartDate} complete: members=${stats.members} sent=${stats.sent} skipped=${stats.skipped} meetings=${stats.meetings} items=${stats.items} errors=${stats.errors}`
  );
  return { weekStart: weekStartDate, ...stats };
}

// ---------------------------------------------------------------------------
// Scheduler-friendly wrapper: runs iff today is Monday (UTC) and we're past the
// configured hour. The ServiceScheduler ticks hourly; the UNIQUE constraint on
// (week_start, recipient_email) prevents double-send inside the window.
// ---------------------------------------------------------------------------

export async function maybeSendWeeklyRecaps() {
  if (process.env.WEEKLY_RECAP_ENABLED !== 'true') return null;
  const now = new Date();
  const hour = Number(process.env.WEEKLY_RECAP_HOUR_LOCAL || 0);
  // Saturday (day 6) check in local server time; ServiceScheduler ticks hourly.
  if (now.getDay() !== 6) return null;
  if (now.getHours() < hour) return null;
  return sendWeeklyRecaps({ now });
}
