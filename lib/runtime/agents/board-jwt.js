/**
 * Board member JWT issuer and verifier.
 *
 * SEPARATE keypair from agent-jwt.js (Linus security requirement).
 * Board tokens use iss: 'optimus-board', 24h TTL, and include scope[].
 * Verification checks jti revocation table for instant token kill.
 *
 * No external dependencies — Node `crypto` only (P4: boring infrastructure).
 *
 * Key management:
 *   1. BOARD_JWT_KEY_PEM env var → inline PEM (Railway/Docker)
 *   2. Ephemeral RSA pair (dev/CI)
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomUUID } from 'crypto';
import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/board-jwt');

let privateKey = null;
let publicKey = null;
let keySource = null;

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours — default for interactive (OAuth) logins
// Caller-requestable TTL bounds. Only the API_SECRET-gated /api/auth/token route
// passes a custom ttl (for long-lived CLI/MCP tokens); the OAuth login path always
// uses the 24h default. The max caps the blast radius of a leaked long-lived token,
// and the revocation table must outlive it (see revokeBoardToken).
const MIN_TOKEN_TTL_SECONDS = 60; // 1 minute floor
const MAX_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const ISSUER = 'optimus-board';

function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Load or generate RSA key pair. Call once at startup.
 */
export async function initializeBoardJwtKeys() {
  if (process.env.BOARD_JWT_KEY_PEM) {
    const pem = process.env.BOARD_JWT_KEY_PEM.replace(/\\n/g, '\n');
    privateKey = pem;
    publicKey = createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    keySource = 'env-pem';
  } else {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    keySource = 'ephemeral';
  }
  log.info(`Board JWT signing initialized (source: ${keySource})`);
}

/**
 * Issue a board member JWT.
 *
 * @param {string} memberId - Board member UUID (from board_members table)
 * @param {string} githubUsername - GitHub username for acted_by tracking
 * @param {string[]} [scope=['*']] - Allowed API scopes
 * @param {number} [ttlSeconds=TOKEN_TTL_SECONDS] - Token lifetime. Clamped to
 *   [MIN_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS]; a non-finite value falls back
 *   to the 24h default. Only the API_SECRET-gated mint route should pass this.
 * @returns {{ token: string, expiresAt: number, jti: string }}
 */
export function issueBoardToken(memberId, githubUsername, scope = ['*'], ttlSeconds = TOKEN_TTL_SECONDS) {
  if (!privateKey) throw new Error('Board JWT keys not initialized');

  const requested = Number(ttlSeconds);
  const ttl = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), MIN_TOKEN_TTL_SECONDS), MAX_TOKEN_TTL_SECONDS)
    : TOKEN_TTL_SECONDS;

  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const jti = randomUUID();

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: ISSUER,
    sub: memberId,
    github_username: githubUsername,
    scope,
    iat: now,
    exp,
    jti,
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return {
    token: `${signable}.${signature}`,
    expiresAt: exp * 1000,
    jti,
  };
}

/**
 * Verify a board member JWT and return its claims.
 * Checks signature, expiry, issuer, and jti revocation table.
 *
 * @param {string} token
 * @returns {Promise<{ sub: string, iss: string, github_username: string, scope: string[], iat: number, exp: number, jti: string }>}
 */
export async function verifyBoardToken(token) {
  if (!publicKey) throw new Error('Board JWT keys not initialized');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 parts');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signable = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signable);
  if (!verifier.verify(publicKey, signature)) {
    throw new Error('Board JWT signature verification failed');
  }

  const claims = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));

  // Validate issuer
  if (claims.iss !== ISSUER) {
    throw new Error(`Invalid JWT issuer: ${claims.iss} (expected ${ISSUER})`);
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(`Board JWT expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }

  // Check revocation (fail-closed: DB error = reject token)
  const revoked = await query(
    'SELECT 1 FROM agent_graph.token_revocations WHERE jti = $1',
    [claims.jti]
  );
  if (revoked.rows.length > 0) {
    throw new Error('Board JWT has been revoked');
  }

  return claims;
}

/**
 * Revoke a board token by jti. Takes effect immediately.
 */
export async function revokeBoardToken(jti, memberId, reason = 'manual revocation') {
  // The revocation row must outlive the longest-lived token, or a revoked
  // long-TTL token would silently un-revoke when its row is pruned. Size it off
  // the MAX (90d), not the 24h default. The actual token still dies at its own exp.
  const expiresAt = new Date(Date.now() + MAX_TOKEN_TTL_SECONDS * 1000).toISOString();
  await query(
    `INSERT INTO agent_graph.token_revocations (jti, member_id, reason, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, memberId, reason, expiresAt]
  );
}

/**
 * Prune expired revocation entries (call periodically).
 */
export async function pruneRevokedTokens() {
  const result = await query(
    'DELETE FROM agent_graph.token_revocations WHERE expires_at < now()'
  );
  if (result.rowCount > 0) {
    log.info(`Pruned ${result.rowCount} expired revocation entries`);
  }
}
