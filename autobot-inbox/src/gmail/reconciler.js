import { google } from 'googleapis';
import { getAuthForAccount } from './auth.js';
import { fetchEmailMetadata } from './client.js';
import { query } from '../db.js';

/**
 * Gmail reconciliation safety net.
 *
 * Every 5 minutes, queries Gmail via messages.list (query-based, not history-based)
 * to find recent INBOX messages. Compares against inbox.messages in DB.
 * Any message found by search but missing from DB = dropped by the history poller.
 *
 * This catches edge cases where history.list silently drops messages:
 * - Thread continuations that don't emit messageAdded events
 * - History ID gaps after Gmail backend issues
 * - Messages that arrive during poller downtime
 *
 * Design: P4 (boring infrastructure) — uses the same googleapis client as the poller.
 * No external dependencies, no MCP, no new patterns.
 */

const RECONCILE_WINDOW_MINUTES = 10; // Default: look back 10 min to overlap with poll cycle
const FIRST_RUN_WINDOW_DAYS = 7;     // First run: look back 7 days to catch historical misses
let isFirstRun = true;

/**
 * Reconcile a single account's inbox against DB.
 * @param {Object} account
 * @param {number} [windowMinutes] Override lookback window
 * @returns {Promise<Array>} Messages found missing from DB (already ingested)
 */
async function reconcileAccount(account, windowMinutes) {
  const accountId = account.id;
  const recovered = [];

  try {
    const auth = await getAuthForAccount(accountId);
    if (!auth) {
      console.warn(`[reconciler] No auth for account ${accountId}, skipping`);
      return recovered;
    }

    const gmail = google.gmail({ version: 'v1', auth });

    // Query-based search: find all INBOX messages from the lookback window
    const lookbackMinutes = windowMinutes || RECONCILE_WINDOW_MINUTES;
    const afterDate = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const afterEpoch = Math.floor(afterDate.getTime() / 1000);

    const searchResult = await gmail.users.messages.list({
      userId: 'me',
      q: `in:inbox after:${afterEpoch}`,
      maxResults: lookbackMinutes > 60 ? 200 : 50,
    });

    const messages = searchResult.data.messages || [];
    if (messages.length === 0) return recovered;

    // Batch check which message IDs are already in DB
    const gmailIds = messages.map(m => m.id);
    const existingResult = await query(
      `SELECT provider_msg_id FROM inbox.messages
       WHERE provider_msg_id = ANY($1::text[])`,
      [gmailIds]
    );
    const existingIds = new Set(existingResult.rows.map(r => r.provider_msg_id));

    // Identify missing messages
    const missingIds = gmailIds.filter(id => !existingIds.has(id));

    if (missingIds.length === 0) return recovered;

    console.log(`[reconciler] Found ${missingIds.length} messages missing from DB for account ${account.identifier}`);

    // Fetch metadata for missing messages and return them for ingestion
    for (const msgId of missingIds) {
      try {
        const metadata = await fetchEmailMetadata(msgId, accountId);

        // Double-check INBOX label (messages.list q=in:inbox should handle this,
        // but verify in case of race condition with archiving)
        if (!metadata.labels?.includes('INBOX')) continue;

        recovered.push(metadata);
      } catch (err) {
        console.error(`[reconciler] Failed to fetch metadata for ${msgId}:`, err.message);
      }
    }

    if (recovered.length > 0) {
      console.log(`[reconciler] Recovered ${recovered.length} messages for account ${account.identifier}`);
    }
  } catch (err) {
    // Don't let reconciler errors affect the main pipeline
    console.error(`[reconciler] Error reconciling account ${account.identifier}:`, err.message);
  }

  return recovered;
}

/**
 * Reconcile all active email accounts.
 * Returns messages that were missing from DB — caller is responsible for ingesting them.
 * @returns {Promise<Array>} All recovered messages across all accounts
 */
export async function reconcileAllAccounts() {
  const accountsResult = await query(
    `SELECT id, identifier, label FROM inbox.accounts
     WHERE channel = 'email' AND is_active = true AND sync_status != 'setup'
     ORDER BY created_at`
  );
  const accounts = accountsResult.rows;

  if (accounts.length === 0) return [];

  // First run after deploy: use wider window to catch historical misses
  const windowMinutes = isFirstRun ? FIRST_RUN_WINDOW_DAYS * 24 * 60 : undefined;
  if (isFirstRun) {
    console.log(`[reconciler] First run — looking back ${FIRST_RUN_WINDOW_DAYS} days to catch missed messages`);
    isFirstRun = false;
  }

  const allRecovered = [];
  for (const account of accounts) {
    const recovered = await reconcileAccount(account, windowMinutes);
    allRecovered.push(...recovered);
  }

  // Auto-archive sweep: hide stale board drafts whose threads are
  // already replied-to or archived in Gmail. Best-effort — failures
  // never block the recovery path.
  try {
    const { autoArchiveSweep } = await import('./auto-archive-sweep.js');
    const counters = await autoArchiveSweep();
    if (counters.swept > 0) {
      console.log(
        `[reconciler] auto-archive: swept=${counters.swept} ` +
        `replied=${counters.archived_external} ` +
        `archived=${counters.archived_no_reply} ` +
        `tier_override=${counters.archived_tier_override || 0} ` +
        `open=${counters.still_open} errors=${counters.errors}`
      );
    }
  } catch (err) {
    console.warn(`[reconciler] auto-archive sweep failed (non-fatal): ${err.message}`);
  }

  return allRecovered;
}
