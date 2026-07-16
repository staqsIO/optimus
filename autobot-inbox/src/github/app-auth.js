/**
 * GitHub App authentication module.
 *
 * Prefers GitHub App installation tokens (scoped, auto-expire, bot identity)
 * over PAT. Falls back to GITHUB_TOKEN if App credentials aren't configured.
 *
 * JWT signing uses Node built-in crypto — no new dependencies (P4: boring infrastructure).
 *
 * Env vars (App auth):
 *   GITHUB_APP_ID                  — GitHub App ID
 *   GITHUB_APP_PRIVATE_KEY_PATH    — Path to RS256 PEM private key (local dev)
 *   GITHUB_APP_PRIVATE_KEY         — Inline PEM content (cloud deployments, takes precedence over PATH)
 *   GITHUB_APP_INSTALLATION_ID     — Installation ID for the target org
 *
 * Env vars (PAT fallback):
 *   GITHUB_TOKEN                   — Personal access token
 */

import { createSign } from 'crypto';
import { readFileSync } from 'fs';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Base64url encode a buffer (no padding, URL-safe alphabet).
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a signed JWT for GitHub App authentication (RS256).
 */
function createAppJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: appId,
    iat: now - 60,   // clock drift tolerance
    exp: now + 600,  // 10 minute max
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return `${signable}.${signature}`;
}

/**
 * Exchange an App JWT for a scoped installation access token.
 */
async function requestInstallationToken(jwt, installationId) {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
}

/**
 * Get a GitHub authentication token.
 *
 * Priority:
 * 1. GitHub App installation token (cached with 55-min TTL refresh)
 * 2. GITHUB_TOKEN PAT (backward compat for dev/CI)
 *
 * @returns {Promise<string>} Bearer token for GitHub API
 */
export async function getGitHubToken() {
  const appId = process.env.GITHUB_APP_ID;
  const keyInline = process.env.GITHUB_APP_PRIVATE_KEY;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  // App auth available — use it (inline key for cloud, file path for local dev)
  if (appId && (keyInline || keyPath) && installationId) {
    const now = Date.now();
    // Refresh if <5 minutes remaining
    if (cachedToken && cachedTokenExpiresAt - now > 5 * 60 * 1000) {
      return cachedToken;
    }

    const privateKey = keyInline || readFileSync(keyPath, 'utf-8');
    const jwt = createAppJWT(appId, privateKey);
    const result = await requestInstallationToken(jwt, installationId);
    cachedToken = result.token;
    cachedTokenExpiresAt = result.expiresAt;
    return cachedToken;
  }

  // PAT fallback
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return pat;

  throw new Error(
    'No GitHub credentials configured. Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH + GITHUB_APP_INSTALLATION_ID, or GITHUB_TOKEN.'
  );
}
