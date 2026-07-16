import { ConfidentialClientApplication } from '@azure/msal-node';
import { query } from '../db.js';
import { decryptCredentials } from '../runtime/credentials.js';

/**
 * Multi-account Outlook OAuth2 with TTL-based cache.
 * Mirrors gmail/auth.js pattern. Uses MSAL for token management.
 * - getOutlookAuth(accountId): loads encrypted creds from DB, acquires token
 * - clearOutlookAuthCache(accountId): invalidate on credential update
 * - getOutlookAuthUrl(label): OAuth setup helper
 * - exchangeOutlookCode(code): exchange auth code for tokens
 */

// Cache: accountId → { accessToken, expiresAt }
const authCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access'];

/**
 * Get an access token for a specific Outlook account.
 * Loads encrypted credentials from inbox.accounts, decrypts, acquires token via MSAL.
 * @param {string} accountId - inbox.accounts.id
 * @returns {Promise<string>} Access token
 */
export async function getOutlookAuth(accountId) {
  // Check cache
  const cached = authCache.get(accountId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  // Load from DB
  const result = await query(
    `SELECT credentials, identifier FROM inbox.accounts WHERE id = $1 AND provider = 'outlook' AND is_active = true`,
    [accountId]
  );
  const account = result.rows[0];
  if (!account) throw new Error(`Outlook account ${accountId} not found or inactive`);

  if (!account.credentials) {
    throw new Error(`Account ${accountId} has no stored credentials. Re-connect via Settings.`);
  }

  // Decrypt and acquire token via MSAL
  const creds = decryptCredentials(account.credentials);
  const msalConfig = {
    auth: {
      clientId: creds.client_id || process.env.OUTLOOK_CLIENT_ID,
      clientSecret: creds.client_secret || process.env.OUTLOOK_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${creds.tenant_id || process.env.OUTLOOK_TENANT_ID}`,
    },
  };

  const msalClient = new ConfidentialClientApplication(msalConfig);

  const tokenResponse = await msalClient.acquireTokenByRefreshToken({
    refreshToken: creds.refresh_token,
    scopes: SCOPES,
  });

  if (!tokenResponse?.accessToken) {
    throw new Error(`Failed to acquire Outlook token for account ${accountId}`);
  }

  // Cache
  authCache.set(accountId, {
    accessToken: tokenResponse.accessToken,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return tokenResponse.accessToken;
}

/**
 * Invalidate auth cache for an account (call on credential update).
 * @param {string} accountId
 */
export function clearOutlookAuthCache(accountId) {
  authCache.delete(accountId);
}

/**
 * Generate an Azure AD auth URL for OAuth setup.
 * @param {string} [label] - Optional label hint for state parameter
 * @returns {string} Auth URL
 */
export function getOutlookAuthUrl(label) {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const tenantId = process.env.OUTLOOK_TENANT_ID;
  if (!clientId || !tenantId) {
    throw new Error('Missing OUTLOOK_CLIENT_ID or OUTLOOK_TENANT_ID in .env');
  }

  const redirectUri = `http://localhost:3457/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    response_mode: 'query',
    prompt: 'consent',
  });
  if (label) params.set('state', JSON.stringify({ label }));

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`;
}

/**
 * Exchange auth code for tokens (one-time setup).
 * @param {string} code - Authorization code from callback
 * @returns {Promise<Object>} Token response with accessToken and refreshToken
 */
export async function exchangeOutlookCode(code) {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const tenantId = process.env.OUTLOOK_TENANT_ID;

  const msalConfig = {
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };

  const msalClient = new ConfidentialClientApplication(msalConfig);

  const tokenResponse = await msalClient.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: `http://localhost:3457/callback`,
  });

  return tokenResponse;
}
