import chalk from 'chalk';
import { query, withSystemOrgScope } from '../../db.js';
import { normalize } from '../../rag/normalizers/index.js';
import {
  extractFromTldvSegments,
  extractFromTldvMeeting,
  extractFromEmailParticipantStrings,
} from '../../rag/participants/extractors.js';
import { resolveAndUpsert } from '../../rag/participants/resolver.js';
import { fetchMeeting } from '../../tldv/api.js';
import { CURRENT_ORG_ID } from '../../../../lib/tenancy/scope.js';

// OPT-166 P2e: resolveAndUpsert writes signal.contacts and the follow-up UPDATE
// writes content.documents — both carry the same mig-200 org-scoped write policy
// (FOR ALL, allow_system=false), so a bare `query` would hard-fail with 42501
// post-RLS-flip. This is a manual CLI (single-tenant), so scope both writes to
// CURRENT_ORG_ID — the org mig 134's DEFAULT stamps on new rows. INERT
// today: the app connects as a BYPASSRLS superuser, so RLS is inert until flip.
const BACKFILL_AGENT_ID = 'backfill-participants';

// Run `fn(exec)` with `exec` org-scoped via withSystemOrgScope — reachable under
// REQUIRE_AGENT_JWT=true (this CLI holds no JWT principal), unlike the old
// withAgentScope path which threw for a plain-string id under enforcement and
// fell back to unscoped writes → 42501 post-flip. FAIL CLOSED: no bare-`query`
// fallback — a scope that can't open must not degrade to unscoped signal.contacts
// / content.documents writes. The tl;dv roster re-fetch happens in
// buildRawParticipants BEFORE this is called, so the wrapped body is pure DB
// work — the transaction never spans network I/O.
async function withBackfillOrgScope(fn) {
  const scoped = await withSystemOrgScope(BACKFILL_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

const TLDV_API_KEY = process.env.TLDV_API_KEY || '';
const TLDV_FETCH_DELAY_MS = Number(process.env.TLDV_FETCH_DELAY_MS || '200');
const tldvMeetingCache = new Map(); // meetingId → { invitees, organizer } | null

/**
 * Backfill participants on existing content.documents.
 *
 * Flags (space-separated, e.g. `backfill-participants --source tldv --limit 50 --dry-run`):
 *   --source <tldv|email|all>   default: all
 *   --limit  <N>                default: 500
 *   --force                     recompute even when participants are already set
 *   --dry-run                   don't write anything
 *
 * Drive backfill is intentionally NOT handled here — the original payload never
 * captured owners/collaborators, so the only path is a Drive API re-fetch which
 * belongs in a dedicated job.
 */
export async function backfillParticipantsCommand(args = []) {
  const flags = parseFlags(args);
  const source = flags.source || 'all';
  const limit = parseInt(flags.limit || '500', 10);
  const force = flags['force'] === true;
  const dryRun = flags['dry-run'] === true;

  if (!['all', 'tldv', 'email', 'drive'].includes(source)) {
    console.log(chalk.red(`Unknown --source ${source}. Expected tldv, email, drive, or all.`));
    return;
  }

  console.log(chalk.bold(`\n  Backfill participants`));
  console.log(`  source=${source}  limit=${limit}  force=${force}  dryRun=${dryRun}`);
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Drive-ingested tl;dv transcripts live as source='drive' with format='tldv',
  // so the selector queries across source OR format='tldv' to catch them.
  const params = [];
  let whereClause;
  if (source === 'all') {
    whereClause = `(source IN ('tldv', 'email', 'drive') OR format = 'tldv')`;
  } else if (source === 'tldv') {
    // --source tldv means "everything shaped like a tl;dv transcript", regardless
    // of whether it came in via the tldv webhook/poller or via the Drive watcher.
    whereClause = `(source = 'tldv' OR format = 'tldv')`;
  } else {
    params.push(source);
    whereClause = `source = $${params.length}`;
  }
  if (!force) {
    // participants defaults to '[]'::jsonb; empty array = not yet backfilled
    whereClause += ` AND (participants = '[]'::jsonb OR participants IS NULL)`;
  }
  params.push(limit);

  const docs = await query(
    `SELECT id, source, title, format, raw_text, metadata
     FROM content.documents
     WHERE ${whereClause}
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  if (docs.rows.length === 0) {
    console.log(chalk.yellow('  No documents to backfill.'));
    return;
  }

  console.log(chalk.cyan(`  Processing ${docs.rows.length} document(s)...\n`));

  const counts = { processed: 0, skipped: 0, withParticipants: 0, contactsWritten: 0 };
  for (const doc of docs.rows) {
    try {
      const raw = await buildRawParticipants(doc);
      if (!raw || raw.length === 0) {
        counts.skipped++;
        continue;
      }

      if (dryRun) {
        counts.processed++;
        counts.withParticipants += raw.length;
        console.log(chalk.gray(`  [dry] ${doc.source.padEnd(6)} ${short(doc.title)} — ${raw.length} participant(s)`));
        continue;
      }

      const accountId = doc.metadata && typeof doc.metadata === 'object'
        ? doc.metadata.accountId || doc.metadata.account_id || null
        : null;
      const records = await withBackfillOrgScope(async (exec) => {
        const resolved = await resolveAndUpsert(raw, { accountId }, exec);
        await exec(
          `UPDATE content.documents SET participants = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(resolved), doc.id]
        );
        return resolved;
      });

      counts.processed++;
      counts.withParticipants += records.length;
      counts.contactsWritten += records.filter(r => r.contact_id).length;
      if (counts.processed % 25 === 0) {
        console.log(chalk.gray(`  ... ${counts.processed}/${docs.rows.length}`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`  [warn] ${doc.id}: ${err.message}`));
    }
  }

  console.log();
  console.log(chalk.bold('  Summary'));
  console.log(`    processed:         ${counts.processed}`);
  console.log(`    skipped (no data): ${counts.skipped}`);
  console.log(`    participants seen: ${counts.withParticipants}`);
  console.log(`    contacts written:  ${counts.contactsWritten}`);
  if (dryRun) console.log(chalk.cyan('    (dry run — nothing persisted)'));
}

async function buildRawParticipants(doc) {
  if (doc.source === 'tldv' || doc.format === 'tldv') {
    const segments = normalize(doc.raw_text || '', 'tldv');
    const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    const meetingId = meta.tldvMeetingId || meta.tldv_meeting_id || null;

    // Re-fetch the meeting object from tl;dv so silent invitees and
    // phone-joined speakers show up as participants. Speakers whose tl;dv
    // label was redacted (e.g. "+1 678-***-**47") are otherwise invisible.
    if (meetingId && TLDV_API_KEY) {
      const roster = await fetchMeetingRoster(meetingId);
      if (roster) {
        return extractFromTldvMeeting({
          segments,
          invitees: roster.invitees,
          organizer: roster.organizer,
        });
      }
    }
    return extractFromTldvSegments(segments);
  }
  if (doc.source === 'email') {
    const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    const list = Array.isArray(meta.participants) ? meta.participants : [];
    return extractFromEmailParticipantStrings(list);
  }
  return [];
}

async function fetchMeetingRoster(meetingId) {
  if (tldvMeetingCache.has(meetingId)) return tldvMeetingCache.get(meetingId);
  try {
    const res = await fetchMeeting(TLDV_API_KEY, meetingId);
    if (TLDV_FETCH_DELAY_MS > 0) await new Promise(r => setTimeout(r, TLDV_FETCH_DELAY_MS));
    if (!res.ok) {
      tldvMeetingCache.set(meetingId, null);
      return null;
    }
    const roster = {
      invitees: Array.isArray(res.meeting?.invitees) ? res.meeting.invitees : undefined,
      organizer: res.meeting?.organizer || undefined,
    };
    tldvMeetingCache.set(meetingId, roster);
    return roster;
  } catch {
    tldvMeetingCache.set(meetingId, null);
    return null;
  }
}

function short(s) {
  if (!s) return '(no title)';
  const t = String(s);
  return t.length > 48 ? t.slice(0, 45) + '…' : t;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
