import { google } from 'googleapis';
import { getAuthForAccount } from './auth.js';
import { query } from '../db.js';
import { classifyThreadState, classificationToBoardAction } from './thread-state.js';

/**
 * Auto-archive sweep: hide stale board drafts whose threads are
 * already handled in Gmail.
 *
 * Audit (2026-05-07) found 130 of 134 board drafts had no human
 * action — most because the user already replied directly in Gmail
 * or archived the thread. The Drafts page filter is `board_action
 * IS NULL`; setting `board_action = 'archived_external' | 'archived_no_reply'`
 * (migration 088) hides the row without losing the audit trail.
 *
 * Runs as part of the existing 5-min Gmail reconciler. Quota: each
 * sweep cycle reads at most BATCH_SIZE Gmail threads.
 */

const BATCH_SIZE = 30;
const SKIP_NEWER_THAN_MINUTES = 10;  // Don't sweep proposals less than 10 min old
// Bigger safety net layered on top of the 10-min "fresh" window: if a draft
// has never been surfaced to the board UI (viewed_at IS NULL), wait this
// many hours from creation before reaping even if the thread is archived in
// Gmail. Without this, fresh drafts created from a thread the user already
// archived on mobile get cleaned up before the drafts UI ever renders them
// (sql/115-drafts-viewed-gate.sql).
const UNVIEWED_GRACE_HOURS = 24;
// Once GET /api/drafts has stamped viewed_at, give the user this many hours
// to act before the sweep treats the draft as eligible. The original
// viewed-gate (f4d262f) treated any non-NULL viewed_at as an immediate
// green-light, which meant just *loading the drafts page* surfaced every
// fresh draft to the next sweep cycle for reaping — the page-load became
// a self-destruct trigger. A post-view grace gives the user a chance to
// circle back later in the day.
const VIEWED_REAP_GRACE_HOURS = 12;

// Sender tiers for which a draft is considered legitimate. Mirrors the
// opt-in predicate in agents/executor-responder/index.js — anything OUTSIDE
// this set is one we wouldn't draft today, so a historical draft from such
// a sender is illegitimate clutter and gets archived without consulting
// Gmail. Saves a Gmail thread.get round-trip per candidate too.
const DRAFTABLE_TIERS = new Set(['inner_circle', 'active']);

/**
 * Resolve the set of "user" addresses (Eric's accounts).
 * Config-driven, not hardcoded — supports adding more accounts via
 * inbox.accounts without code changes.
 */
async function resolveUserAddresses() {
  const r = await query(
    `SELECT lower(identifier) AS addr
     FROM inbox.accounts
     WHERE channel = 'email'
       AND provider IN ('gmail', 'google')
       AND is_active = true`,
    []
  );
  return new Set(r.rows.map((row) => row.addr).filter(Boolean));
}

/**
 * Find candidate proposals for the sweep: open drafts with a thread_id
 * that are old enough that we expect either a reply or an archive by now.
 */
async function findCandidates(limit) {
  // Two-stage gate (sql/115-drafts-viewed-gate.sql adds `viewed_at`):
  //   1. Unviewed drafts get UNVIEWED_GRACE_HOURS from creation before
  //      they're eligible — protects threads the user already archived
  //      on mobile.
  //   2. Viewed drafts get VIEWED_REAP_GRACE_HOURS from the moment the
  //      drafts page first rendered them — protects against the page-load
  //      → stamp → reap-on-next-cycle pattern that was nuking fresh
  //      drafts before the user could act on them.
  // A draft is eligible once EITHER grace has expired.
  const r = await query(
    `SELECT p.id                                 AS proposal_id,
            p.created_at                         AS proposal_created_at,
            m.thread_id                          AS thread_id,
            m.account_id                         AS account_id,
            COALESCE(c.tier, 'unknown')          AS sender_tier
     FROM agent_graph.action_proposals p
     JOIN inbox.messages m ON m.id = p.message_id
     LEFT JOIN signal.contacts c
            ON LOWER(c.email_address) = LOWER(m.from_address)
     WHERE p.action_type = 'email_draft'
       AND p.board_action IS NULL
       AND p.acted_at IS NULL
       AND m.thread_id IS NOT NULL
       AND p.created_at < now() - ($1 || ' minutes')::interval
       AND (
         (p.viewed_at IS NOT NULL
            AND p.viewed_at < now() - ($4 || ' hours')::interval)
         OR p.created_at < now() - ($3 || ' hours')::interval
       )
     ORDER BY p.created_at DESC
     LIMIT $2`,
    [
      String(SKIP_NEWER_THAN_MINUTES),
      limit,
      String(UNVIEWED_GRACE_HOURS),
      String(VIEWED_REAP_GRACE_HOURS),
    ]
  );
  return r.rows;
}

/**
 * Apply the auto-archive board_action via predicated UPDATE.
 * The WHERE board_action IS NULL AND acted_at IS NULL ensures a
 * concurrent human action wins deterministically.
 */
async function applyArchive(proposalId, action) {
  const r = await query(
    `UPDATE agent_graph.action_proposals
     SET board_action = $1, acted_at = now(), acted_by = 'gmail-reconciler'
     WHERE id = $2
       AND board_action IS NULL
       AND acted_at IS NULL
     RETURNING id`,
    [action, proposalId]
  );
  return r.rowCount;
}

/**
 * Fetch a Gmail thread with the metadata we need (no body — that would
 * be a PII concern and isn't required for state classification).
 */
async function fetchThreadMetadata(gmail, threadId) {
  const resp = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From'],
  });
  return resp?.data || null;
}

/**
 * Run one sweep cycle. Returns counts so the reconciler can log them.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit] Max proposals to sweep this cycle
 * @param {boolean} [opts.dryRun] If true, classify but don't UPDATE
 * @returns {Promise<{ swept: number, archived_external: number, archived_no_reply: number, still_open: number, errors: number }>}
 */
export async function autoArchiveSweep({ limit = BATCH_SIZE, dryRun = false } = {}) {
  const counters = {
    swept: 0,
    archived_external: 0,
    archived_no_reply: 0,
    archived_tier_override: 0,
    still_open: 0,
    errors: 0,
  };

  const userAddresses = await resolveUserAddresses();
  if (userAddresses.size === 0) return counters;

  const candidates = await findCandidates(limit);
  counters.swept = candidates.length;
  if (candidates.length === 0) return counters;

  // Tier override: any candidate whose sender tier is not draftable gets
  // archived as `archived_no_reply` without consulting Gmail. We wouldn't
  // draft this sender today, so the historical draft is illegitimate
  // clutter regardless of inbox state.
  const gmailCandidates = [];
  for (const c of candidates) {
    if (DRAFTABLE_TIERS.has(c.sender_tier)) {
      gmailCandidates.push(c);
      continue;
    }
    if (dryRun) {
      counters.archived_tier_override += 1;
      continue;
    }
    try {
      const updated = await query(
        `UPDATE agent_graph.action_proposals
         SET board_action = 'archived_no_reply',
             acted_at = now(),
             acted_by = 'gmail-reconciler:tier-override'
         WHERE id = $1
           AND board_action IS NULL
           AND acted_at IS NULL
         RETURNING id`,
        [c.proposal_id]
      );
      if (updated.rowCount > 0) counters.archived_tier_override += 1;
    } catch (err) {
      counters.errors += 1;
      console.warn(`[auto-archive] tier-override ${c.proposal_id} failed: ${err.message}`);
    }
  }

  // Remaining candidates need Gmail thread state to decide.
  // Group by account_id so we instantiate one Gmail client per account.
  const byAccount = new Map();
  for (const c of gmailCandidates) {
    if (!byAccount.has(c.account_id)) byAccount.set(c.account_id, []);
    byAccount.get(c.account_id).push(c);
  }

  for (const [accountId, group] of byAccount) {
    let gmail;
    try {
      const auth = await getAuthForAccount(accountId);
      if (!auth) {
        // Account has no working OAuth — skip entire group, count as errors
        counters.errors += group.length;
        continue;
      }
      gmail = google.gmail({ version: 'v1', auth });
    } catch (err) {
      console.warn(`[auto-archive] auth failed for account ${accountId}: ${err.message}`);
      counters.errors += group.length;
      continue;
    }

    for (const c of group) {
      try {
        const thread = await fetchThreadMetadata(gmail, c.thread_id);
        if (!thread) {
          counters.errors += 1;
          continue;
        }
        const classification = classifyThreadState(thread, userAddresses, c.proposal_created_at);
        if (classification === 'still_open') {
          counters.still_open += 1;
          continue;
        }
        const action = classificationToBoardAction(classification);
        if (!action) {
          counters.still_open += 1;
          continue;
        }
        if (dryRun) {
          if (action === 'archived_external') counters.archived_external += 1;
          else counters.archived_no_reply += 1;
          continue;
        }
        const updated = await applyArchive(c.proposal_id, action);
        if (updated > 0) {
          if (action === 'archived_external') counters.archived_external += 1;
          else counters.archived_no_reply += 1;
        }
        // updated === 0 means a concurrent human action won — that's fine, drop silently.
      } catch (err) {
        // Quota errors, network errors, missing threads — don't crash the sweep
        counters.errors += 1;
        console.warn(`[auto-archive] proposal ${c.proposal_id} sweep failed: ${err.message}`);
      }
    }
  }

  return counters;
}
