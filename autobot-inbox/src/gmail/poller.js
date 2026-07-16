import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { fetchEmailMetadata, fetchMessageLabels } from './client.js';
import { query, withSystemOrgScope } from '../db.js';
import { resolveSignalsByMessage } from '../signal/extractor.js';

/**
 * Gmail poller: incremental polling via history ID (D7: poll, not push).
 * Multi-account: polls all active email accounts sequentially with stagger.
 *
 * Loss-free fetch (Plan 017, strategy B — persistent retry set):
 * A per-message metadata fetch can fail transiently (5xx / 429 / timeout). Gmail
 * history IDs are opaque, so the cursor cannot be advanced to "just before" a
 * failed message; stalling the cursor (strategy A) is the one MED risk we must
 * avoid. Instead a failed msgId is recorded in inbox.gmail_fetch_retries and the
 * cursor advances as before. Every incremental poll drains that table with
 * bounded attempts (FETCH_RETRY_CAP): on success the message is re-fetched into
 * the pipeline and the row cleared; on cap exhaustion the drop is logged with
 * account_id + provider_msg_id — an observable, bounded drop that never stalls
 * ingestion. Re-fetch is idempotent via the existing early-dedup on inbox.messages.
 */

// Max metadata-fetch attempts before a message is dead-lettered (dropped + logged).
const FETCH_RETRY_CAP = 5;

/**
 * Record a transient metadata-fetch failure so the message is retried on a later
 * poll instead of being permanently dropped. Upsert increments the attempt count.
 * @param {string} syncKey - Account sync key (accountId or 'default')
 * @param {string} msgId - Gmail provider message ID
 * @param {Error} err - The fetch error
 */
export async function recordFetchRetry(syncKey, msgId, err) {
  await query(
    `INSERT INTO inbox.gmail_fetch_retries (account_id, provider_msg_id, attempts, last_error)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (account_id, provider_msg_id)
     DO UPDATE SET attempts = inbox.gmail_fetch_retries.attempts + 1,
                   last_error = $3, updated_at = now()`,
    [syncKey, msgId, (err?.message || String(err)).slice(0, 500)]
  );
}

async function clearFetchRetry(syncKey, msgId) {
  await query(
    `DELETE FROM inbox.gmail_fetch_retries WHERE account_id = $1 AND provider_msg_id = $2`,
    [syncKey, msgId]
  );
}

/**
 * Drain the retry set for one account: re-fetch each previously-failed message
 * with bounded attempts. Returns the INBOX-bound messages recovered this cycle.
 * On attempt-cap exhaustion the message is dropped with a structured log (no
 * throw, no stall). Exported for tests.
 * @param {string} accountId - Real account ID (may be null for env-var default)
 * @param {string} syncKey - Account sync key used to scope the retry rows
 * @returns {Promise<Array>} Recovered email metadata objects
 */
export async function processFetchRetries(accountId, syncKey) {
  const recovered = [];
  const pending = await query(
    `SELECT provider_msg_id, attempts FROM inbox.gmail_fetch_retries
     WHERE account_id = $1 ORDER BY created_at`,
    [syncKey]
  );

  for (const row of pending.rows) {
    const msgId = row.provider_msg_id;
    try {
      // Already stored since it was recorded — nothing to recover, clear the row.
      // tenancy:allow-unscoped — existence-only dedup on the globally-unique Gmail
      // provider_msg_id (returns no tenant row data); mirrors the early-dedup in
      // the incremental loop below.
      const existing = await query(
        `SELECT 1 FROM inbox.messages WHERE provider_msg_id = $1`,
        [msgId]
      );
      if (existing.rows.length > 0) {
        await clearFetchRetry(syncKey, msgId);
        continue;
      }

      const metadata = await fetchEmailMetadata(msgId, accountId);
      // Success — drop the retry row regardless of INBOX membership.
      await clearFetchRetry(syncKey, msgId);
      if (!metadata.labels?.includes('INBOX')) continue;
      recovered.push(metadata);
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      if (attempts >= FETCH_RETRY_CAP) {
        // Bounded: turn silent loss into an observable, logged drop and let the
        // retry set move past this permanently-bad message.
        console.error(
          `[poller] Dropping message after ${attempts} failed fetch attempts:`,
          { account_id: syncKey, provider_msg_id: msgId, last_error: err?.message || String(err) }
        );
        await clearFetchRetry(syncKey, msgId);
      } else {
        await recordFetchRetry(syncKey, msgId, err);
      }
    }
  }

  return recovered;
}

/**
 * Poll all active email accounts for new messages.
 * Sequential with 2s stagger to avoid rate limits.
 * @returns {Promise<Array>} All new messages across all accounts
 */
export async function pollAllAccounts() {
  const accountsResult = await query(
    `SELECT id, identifier, label FROM inbox.accounts WHERE channel = 'email' AND is_active = true AND sync_status != 'setup' AND credentials IS NOT NULL ORDER BY created_at`
  );
  const accounts = accountsResult.rows;

  if (accounts.length === 0) {
    // No active accounts — nothing to poll. Users add accounts via Settings UI.
    return [];
  }

  const allMessages = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await delay(2000); // 2s stagger between accounts

    try {
      // Update sync status
      await query(
        `UPDATE inbox.accounts SET sync_status = 'syncing', updated_at = now() WHERE id = $1`,
        [accounts[i].id]
      );

      const messages = await pollForNewMessages(accounts[i].id);
      allMessages.push(...messages);

      // Reconcile signals: detect Gmail replies/archives and auto-resolve
      await reconcileSignals(accounts[i].id);

      // Update sync status + last_sync_at
      await query(
        `UPDATE inbox.accounts SET sync_status = 'active', last_sync_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
        [accounts[i].id]
      );
    } catch (err) {
      console.error(`[poller] Error polling account ${accounts[i].label} (${accounts[i].id}):`, err.message);
      await query(
        `UPDATE inbox.accounts SET sync_status = 'error', last_error = $1, updated_at = now() WHERE id = $2`,
        [err.message.slice(0, 500), accounts[i].id]
      );
    }
  }

  return allMessages;
}

/**
 * Poll for new messages since last history ID.
 * @param {string} [accountId] - Account ID (null for env-var default)
 * @returns {Promise<Array>} Array of new email metadata objects
 */
export async function pollForNewMessages(accountId) {
  const auth = accountId ? await getAuthForAccount(accountId) : getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Get last sync state — keyed by account_id
  const syncKey = accountId || 'default';
  const syncResult = await query(
    `SELECT history_id FROM inbox.sync_state WHERE account_id = $1`,
    [syncKey]
  );

  let historyId = syncResult.rows[0]?.history_id;
  const newMessages = [];

  if (!historyId) {
    // First sync limited to 10 messages to avoid flooding budget.
    const listResult = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      labelIds: ['INBOX'],
    });

    const messages = listResult.data.messages || [];
    for (const msg of messages) {
      try {
        const metadata = await fetchEmailMetadata(msg.id, accountId);
        newMessages.push(metadata);
      } catch (err) {
        console.error(`[poller] Failed to fetch ${msg.id}:`, err.message);
      }
    }

    // Get current history ID for next poll
    const profile = await gmail.users.getProfile({ userId: 'me' });
    historyId = profile.data.historyId;

    // Initialize sync state (keyed by account_id)
    await query(
      `INSERT INTO inbox.sync_state (account_id, channel, history_id, messages_synced)
       VALUES ($1, 'email', $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         history_id = $2, messages_synced = inbox.sync_state.messages_synced + $3, last_poll_at = now(), updated_at = now()`,
      [syncKey, historyId, newMessages.length]
    );
  } else {
    // Incremental sync via history
    try {
      // Drain previously-failed fetches first (bounded retry) so a transient
      // error on a prior cycle can no longer permanently drop the message.
      const recovered = await processFetchRetries(accountId, syncKey);
      newMessages.push(...recovered);

      // No labelId filter — Gmail drops thread continuations when filtering
      // by label in history.list(). We fetch all history and filter client-side.
      const historyResult = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: historyId,
        historyTypes: ['messageAdded', 'labelAdded'],
      });

      const history = historyResult.data.history || [];
      const seenIds = new Set();

      for (const h of history) {
        // Collect candidates from both messageAdded and labelsAdded events
        const candidates = [
          ...(h.messagesAdded || []).map(a => a.message),
          ...(h.labelsAdded || [])
            .filter(a => a.labelIds?.includes('INBOX'))
            .map(a => a.message),
        ];

        for (const msg of candidates) {
          const msgId = msg.id;
          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);

          try {
            // Early dedup: skip messages already in DB
            const existing = await query(
              `SELECT 1 FROM inbox.messages WHERE provider_msg_id = $1`,
              [msgId]
            );
            if (existing.rows.length > 0) continue;

            const metadata = await fetchEmailMetadata(msgId, accountId);

            // Client-side INBOX filter: only process messages currently in inbox
            if (!metadata.labels?.includes('INBOX')) continue;

            newMessages.push(metadata);
          } catch (err) {
            console.error(`[poller] Failed to fetch ${msgId}:`, err.message);
            // Record for bounded retry instead of dropping permanently — the
            // cursor advances below, so this is the only path back to the message.
            await recordFetchRetry(syncKey, msgId, err);
          }
        }
      }

      // Update sync state
      const newHistoryId = historyResult.data.historyId || historyId;
      await query(
        `UPDATE inbox.sync_state
         SET history_id = $1, messages_synced = messages_synced + $2, last_poll_at = now(), updated_at = now()
         WHERE account_id = $3`,
        [newHistoryId, newMessages.length, syncKey]
      );
    } catch (err) {
      if (err.code === 404) {
        // History expired — delete sync state so next poll does a full sync
        console.warn('[poller] History ID expired. Will do full sync on next poll.');
        await query(
          `DELETE FROM inbox.sync_state WHERE account_id = $1`,
          [syncKey]
        );
      } else {
        throw err;
      }
    }
  }

  console.log(`[poller] ${accountId ? `Account ${accountId}: ` : ''}Found ${newMessages.length} new messages`);
  return newMessages;
}

// Signal types a reply resolves — persistent types (commitment, deadline, approval_needed) need explicit resolution
const REPLY_RESOLVES_TYPES = ['request', 'question', 'info', 'introduction', 'decision', 'action_item'];

/**
 * Resolve signals under the account's org scope (STAQPRO-263 / OPT-166 P2d).
 *
 * inbox.signals' write policy is org-only (sql/200, allow_system=false), so post
 * pool-flip resolveSignalsByMessage's UPDATE black-holes to 0 rows (silent no-op)
 * unless app.org_ids contains the signal's owner_org_id. reconcileSignals is
 * per-account = per-org, so we open a brief org scope bracketing ONLY this DB write
 * — never held across the Gmail fetchMessageLabels() network call. Mirrors the
 * reaper's per-call scope helper. INERT until the flip (superuser bypasses RLS).
 *
 * A null ownerOrgId (pre-tenancy account, should not occur — mig138 backfilled all
 * accounts to Staqs + set the column DEFAULT) falls back to the bare executor;
 * post-flip that row's signals would black-hole regardless, which P2d cannot fix.
 */
async function resolveSignalsScoped(ownerOrgId, messageId, reason, opts = {}) {
  if (!ownerOrgId) {
    return resolveSignalsByMessage(messageId, reason, opts);
  }
  const scope = await withSystemOrgScope('gmail-poller', ownerOrgId);
  try {
    return await resolveSignalsByMessage(messageId, reason, { ...opts, exec: scope });
  } finally {
    await scope.release();
  }
}

/**
 * Reconcile signals against Gmail state: detect user replies and archives.
 * Cheap query — only checks messages with unresolved signals from the last 30 days.
 * @param {string} accountId - Account ID to reconcile
 */
async function reconcileSignals(accountId) {
  // Account row (inbox.accounts has no RLS → unscoped-safe) gives both the owned
  // email addresses and the owner_org_id used to scope the inbox.signals reads and
  // writes below. Read it FIRST so the org id is available for the scoped read.
  const ownedResult = await query(
    `SELECT LOWER(identifier) AS email, owner_org_id FROM inbox.accounts WHERE id = $1`,
    [accountId]
  );
  const ownedEmails = ownedResult.rows.map(r => r.email);
  const ownerOrgId = ownedResult.rows[0]?.owner_org_id ?? null;

  // Find messages with unresolved signals (last 30 days only). inbox.signals'
  // SELECT policy (sql/190) fail-closes with no app context, so read this account's
  // org's signals under a brief org scope (DB-only burst, no network held inside)
  // so it does not black-hole post pool-flip. INERT today (superuser bypasses RLS).
  const unresolvedSql = `SELECT DISTINCT m.id AS message_id, m.thread_id, m.provider_msg_id, m.account_id
     FROM inbox.signals s
     JOIN inbox.messages m ON s.message_id = m.id
     WHERE s.resolved = false
       AND m.channel = 'email'
       AND m.account_id = $1
       AND s.created_at >= now() - interval '30 days'`;
  let unresolvedRows;
  if (ownerOrgId) {
    const scope = await withSystemOrgScope('gmail-poller', ownerOrgId);
    try {
      unresolvedRows = (await scope(unresolvedSql, [accountId])).rows;
    } finally {
      await scope.release();
    }
  } else {
    unresolvedRows = (await query(unresolvedSql, [accountId])).rows;
  }

  if (unresolvedRows.length === 0) return;

  for (const row of unresolvedRows) {
    try {
      // 1. Check for user reply in thread — query local DB (no API call)
      if (row.thread_id) {
        const replyResult = await query(
          `SELECT 1 FROM inbox.messages
           WHERE thread_id = $1
             AND id != $2
             AND LOWER(from_address) = ANY($3)
             AND received_at > (SELECT received_at FROM inbox.messages WHERE id = $2)
           LIMIT 1`,
          [row.thread_id, row.message_id, ownedEmails]
        );
        if (replyResult.rows.length > 0) {
          await resolveSignalsScoped(ownerOrgId, row.message_id, 'gmail_reply_detected', { onlyTypes: REPLY_RESOLVES_TYPES });
          continue; // Reply found — skip label check for this message
        }
      }

      // 2. Check for archive via Gmail API (format: 'minimal' — cheapest call)
      if (row.provider_msg_id && !row.provider_msg_id.startsWith('demo_') && !row.provider_msg_id.startsWith('test_')) {
        const labels = await fetchMessageLabels(row.provider_msg_id, row.account_id);
        if (!labels.includes('INBOX')) {
          // Message was archived in Gmail — resolve all signals
          await resolveSignalsScoped(ownerOrgId, row.message_id, 'gmail_archived');
          await query(
            `UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
            [row.message_id]
          );
        }
      }
    } catch (err) {
      // If Gmail says the message no longer exists (deleted, not just archived),
      // resolve the signals as gmail_deleted so we stop retrying every poll forever.
      const errMsg = err?.message || '';
      const isNotFound = err?.code === 404
        || err?.response?.status === 404
        || /Requested entity was not found|not found/i.test(errMsg);
      if (isNotFound) {
        try {
          await resolveSignalsScoped(ownerOrgId, row.message_id, 'gmail_deleted');
          await query(
            `UPDATE inbox.messages SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
            [row.message_id]
          );
        } catch (e2) {
          console.error(`[poller] reconcileSignals: failed to mark deleted ${row.message_id}:`, e2.message);
        }
      } else {
        console.error(`[poller] reconcileSignals: error on message ${row.message_id}:`, errMsg);
      }
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
