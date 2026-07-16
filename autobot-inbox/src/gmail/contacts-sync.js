import { google } from 'googleapis';
import { getAuth, getAuthForAccount } from './auth.js';
import { withSystemOrgScope } from '../db.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

// OPT-166 P2e: signal.contacts' write policy is org-scoped (mig 200: FOR ALL,
// allow_system=false) — a SYSTEM scope does NOT satisfy its WITH CHECK, and a
// bare `query` under the RLS pool-flip would hard-fail this INSERT with 42501.
// Google Contacts sync is single-tenant → CURRENT_ORG_ID (Staqs internal), the
// same org mig 134's DEFAULT stamps on new signal.contacts rows — matching the
// sent-analyzer (withSentAnalyzerOrgScope) and poller precedents. INERT today:
// the app connects as a BYPASSRLS superuser, so RLS is inert until the flip.
//
// NOTE: unlike sent-analyzer, syncGoogleContacts INTERLEAVES Google People API
// pagination between upserts, so we must NOT wrap the whole sync in one scope
// (a transaction may never span network I/O). Instead each upsertContact opens
// its own short single-statement scope — contacts sync is on-demand (not a hot
// poll loop), so the per-call txn overhead is acceptable.
const CONTACTS_SYNC_AGENT_ID = 'contacts-sync';

// Run `fn(exec)` with `exec` org-scoped (app.org_ids=[CURRENT_ORG_ID]) via
// withSystemOrgScope — reachable under REQUIRE_AGENT_JWT=true (contacts-sync
// holds no JWT principal), unlike the old withAgentScope path which threw for a
// plain-string id under enforcement and fell back to unscoped writes → 42501
// post-flip. FAIL CLOSED: no bare-`query` fallback — a scope that can't open
// must not degrade to an unscoped signal.contacts write. The caller must keep
// `fn`'s body to pure DB work (no network await) so the scope never spans I/O.
async function withContactsOrgScope(fn) {
  const scoped = await withSystemOrgScope(CONTACTS_SYNC_AGENT_ID, CURRENT_ORG_ID);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Upsert a single contact into signal.contacts.
 * COALESCE preserves existing reactive data; || merges metadata.
 * Runs inside a short org scope (no network inside the txn) so the write
 * satisfies signal.contacts' org-scoped WITH CHECK post-RLS-flip.
 *
 * Exported so the OPT-166 flip-readiness sensor can drive this REAL call site
 * (its withContactsOrgScope wrapper + ON CONFLICT DO UPDATE) as autobot_agent,
 * rather than reconstructing a lookalike INSERT (the V-8 sensor-blind-spot the
 * prior rollbacks kept hiding). Not part of the public product surface.
 */
export async function upsertContact(email, name, org, resourceName) {
  await withContactsOrgScope((exec) =>
    exec(
      `INSERT INTO signal.contacts (email_address, name, organization, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email_address) DO UPDATE SET
         name = COALESCE(signal.contacts.name, EXCLUDED.name),
         organization = COALESCE(signal.contacts.organization, EXCLUDED.organization),
         metadata = signal.contacts.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [email, name, org, JSON.stringify({
        google_contact: true,
        resource_name: resourceName,
        synced_at: new Date().toISOString(),
      })]
    )
  );
}

/**
 * Sync Google Contacts into signal.contacts.
 * Fetches both "My Contacts" (connections.list) and "Other contacts"
 * (otherContacts.list) to cover explicitly-added and auto-saved contacts.
 *
 * @param {import('googleapis').Auth.OAuth2Client|null} authClient
 * @param {string|null} accountId - inbox.accounts.id (used if authClient is null)
 * @returns {Promise<number>} Number of contact entries synced
 */
export async function syncGoogleContacts(authClient = null, accountId = null) {
  const auth = authClient || (accountId ? await getAuthForAccount(accountId) : getAuth());
  const people = google.people({ version: 'v1', auth });

  let synced = 0;

  console.log('[contacts-sync] Starting Google Contacts sync...');

  // 1. My Contacts (explicitly added)
  let pageToken = null;
  do {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'names,emailAddresses,organizations',
      pageToken,
    });

    for (const person of (res.data.connections || [])) {
      const name = person.names?.[0]?.displayName || null;
      const org = person.organizations?.[0]?.name || null;

      for (const entry of (person.emailAddresses || [])) {
        const email = entry.value?.toLowerCase();
        if (!email) continue;
        await upsertContact(email, name, org, person.resourceName);
        synced++;
      }
    }

    pageToken = res.data.nextPageToken;
    if (synced > 0 && synced % 100 === 0) {
      console.log(`[contacts-sync] Synced ${synced} contacts...`);
    }
  } while (pageToken);

  console.log(`[contacts-sync] My Contacts done: ${synced} synced`);

  // 2. Other Contacts (auto-saved from interactions)
  let otherSynced = 0;
  pageToken = null;
  try {
    do {
      const res = await people.otherContacts.list({
        pageSize: 1000,
        readMask: 'names,emailAddresses',
        pageToken,
      });

      for (const person of (res.data.otherContacts || [])) {
        const name = person.names?.[0]?.displayName || null;
        const org = person.organizations?.[0]?.name || null;

        for (const entry of (person.emailAddresses || [])) {
          const email = entry.value?.toLowerCase();
          if (!email) continue;
          await upsertContact(email, name, org, person.resourceName);
          otherSynced++;
        }
      }

      pageToken = res.data.nextPageToken;
      if (otherSynced > 0 && otherSynced % 100 === 0) {
        console.log(`[contacts-sync] Other contacts: ${otherSynced} synced...`);
      }
    } while (pageToken);
  } catch (err) {
    console.warn(`[contacts-sync] Other contacts fetch failed (non-fatal): ${err.message}`);
  }

  synced += otherSynced;
  console.log(`[contacts-sync] Complete: ${synced} contacts synced (${synced - otherSynced} primary + ${otherSynced} other)`);
  return synced;
}
