import { google } from 'googleapis';
import { query } from '../db.js';
import { decryptCredentials } from '../runtime/credentials.js';

/**
 * Multi-account Gmail OAuth2 with TTL-based cache.
 * - getAuthForAccount(accountId): loads encrypted creds from DB, caches for 5 min
 * - getAuth(): backward-compat fallback to env vars if no accountId
 * - clearAuthCache(accountId): invalidate on credential update
 */

// Cache: accountId → { client, expiresAt }
const authCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get authenticated OAuth2 client for a specific account.
 * Loads encrypted credentials from inbox.accounts, decrypts, creates OAuth2 client.
 * @param {string} accountId - inbox.accounts.id
 * @returns {Promise<import('googleapis').Auth.OAuth2Client>}
 */
export async function getAuthForAccount(accountId) {
  // Check cache
  const cached = authCache.get(accountId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.client;
  }

  // Load from DB
  const result = await query(
    `SELECT credentials, identifier FROM inbox.accounts WHERE id = $1 AND channel = 'email' AND is_active = true`,
    [accountId]
  );
  const account = result.rows[0];
  if (!account) throw new Error(`Email account ${accountId} not found or inactive`);

  if (!account.credentials) {
    throw new Error(`Account ${accountId} has no stored credentials. Re-connect via Settings.`);
  }

  // Decrypt and create OAuth2 client
  const creds = decryptCredentials(account.credentials);
  const client = new google.auth.OAuth2(
    creds.client_id || process.env.GMAIL_CLIENT_ID,
    creds.client_secret || process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || `http://localhost:${process.env.API_PORT || 3001}/api/auth/gmail-callback`
  );
  client.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token || undefined,
  });

  // Cache
  authCache.set(accountId, { client, expiresAt: Date.now() + CACHE_TTL_MS });
  return client;
}

/**
 * Invalidate auth cache for an account (call on credential update).
 * @param {string} accountId
 */
export function clearAuthCache(accountId) {
  authCache.delete(accountId);
}

// --- Backward-compatible single-account auth (env var based) ---

let oauth2Client;

/**
 * Get authenticated Gmail OAuth2 client from env vars.
 * Backward-compat for default account and OAuth setup flow.
 */
export function getAuth() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || `http://localhost:${process.env.API_PORT || 3001}/api/auth/gmail-callback`
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    });
  }
  return oauth2Client;
}

/**
 * Generate an auth URL for OAuth setup.
 * @param {string} [label] - Optional label hint for state parameter
 * @param {string} [owner] - Board member username to link account ownership
 */
export function getAuthUrl(label, owner) {
  const auth = getAuth();
  const state = {};
  if (label) state.label = label;
  if (owner) state.owner = owner;
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts.other.readonly',
      // NB: no drive.readonly. It is a Google-RESTRICTED scope that our standard
      // consent flow never actually grants, so it was dead weight on every Gmail
      // connection. All Drive reads go through the service account (DWD /
      // SA-direct), never per-user OAuth. (ADR-016 D3 / OPT-103.)
    ],
    state: Object.keys(state).length > 0 ? JSON.stringify(state) : undefined,
  });
}

/**
 * Exchange auth code for tokens (one-time setup).
 */
export async function exchangeCode(code) {
  const auth = getAuth();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  return tokens;
}
