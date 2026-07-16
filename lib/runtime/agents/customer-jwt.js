/**
 * Customer (external, non-board) JWT issuer and verifier — OPT-37.
 *
 * The THIRD token class, distinct from board-jwt.js and agent-jwt.js by design
 * (the same "separate keypair per principal class" rule Linus required for the
 * board/agent split). A customer token authenticates an EXTERNAL principal —
 * a customer's own agent system (Cursor, bespoke) plugging into Optimus — that:
 *
 *   - is `authed-any` (passes the identity gate for public + org-shared tiers),
 *   - is NOT `board` (can never satisfy the board-only/admin identity gate),
 *   - is NOT an internal `agent_jwt` (so it NEVER gets adminBypass — the
 *     org-wide trusted scope; resolveAuth maps it to source 'customer_jwt'),
 *   - is bound to exactly ONE org (org_id claim) → the request principal becomes
 *     syntheticPrincipal(org_id), so every tenant-scoped read fail-closes to that
 *     single org via visibleClause(). A customer can only ever see its own org.
 *
 * iss: 'optimus-customer', 24h TTL, scope[]. Verification additionally checks
 * the customer_principals row is still active (deactivating a principal kills
 * ALL its tokens instantly) AND the shared jti revocation table (kills ONE
 * token). No external dependencies — Node `crypto` only (P4).
 *
 * Key management mirrors board-jwt.js:
 *   1. CUSTOMER_JWT_KEY_PEM env var → inline PEM (Railway/Docker)
 *   2. Ephemeral RSA pair (dev/CI)
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomUUID } from 'crypto';
import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/customer-jwt');

let privateKey = null;
let publicKey = null;
let keySource = null;

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const ISSUER = 'optimus-customer';

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
 * Load or generate the customer-token RSA key pair. Call once at startup.
 * Falls back to a board key only if a dedicated customer key is absent AND an
 * ephemeral pair would be acceptable — but we always prefer a SEPARATE key.
 */
export async function initializeCustomerJwtKeys() {
  if (process.env.CUSTOMER_JWT_KEY_PEM) {
    const pem = process.env.CUSTOMER_JWT_KEY_PEM.replace(/\\n/g, '\n');
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
  log.info(`Customer JWT signing initialized (source: ${keySource})`);
}

/**
 * Issue a customer JWT bound to one org.
 *
 * @param {string} principalId - customer_principals.id (UUID)
 * @param {string} orgId       - tenancy.orgs.id the token is scoped to (UUID)
 * @param {string[]} [scope]   - allowed API scopes (default: read+capture)
 * @returns {{ token: string, expiresAt: number, jti: string }}
 */
export function issueCustomerToken(principalId, orgId, scope = ['kb:read', 'kb:write', 'artifacts:read', 'artifacts:write']) {
  if (!privateKey) throw new Error('Customer JWT keys not initialized');
  if (!principalId || !orgId) throw new Error('issueCustomerToken requires principalId and orgId');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const jti = randomUUID();

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: ISSUER,
    sub: principalId,
    org_id: orgId,
    scope,
    iat: now,
    exp,
    jti,
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return { token: `${signable}.${signature}`, expiresAt: exp * 1000, jti };
}

/**
 * Verify a customer JWT and return its claims.
 * Checks signature, expiry, issuer, customer_principals.is_active, and the jti
 * revocation table. Fail-closed: any DB error rejects the token.
 *
 * @param {string} token
 * @returns {Promise<{ sub, iss, org_id, scope, iat, exp, jti }>}
 */
export async function verifyCustomerToken(token) {
  if (!publicKey) throw new Error('Customer JWT keys not initialized');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 parts');
  const [headerB64, payloadB64, signatureB64] = parts;

  const signable = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signable);
  if (!verifier.verify(publicKey, signature)) {
    throw new Error('Customer JWT signature verification failed');
  }

  const claims = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));

  if (claims.iss !== ISSUER) {
    throw new Error(`Invalid JWT issuer: ${claims.iss} (expected ${ISSUER})`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(`Customer JWT expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }
  if (!claims.org_id) {
    throw new Error('Customer JWT missing org_id claim');
  }

  // The principal must still be active AND still bound to the token's org.
  // Deactivating the principal (or re-binding it) kills every token it holds.
  const principal = await query(
    `SELECT org_id, is_active FROM agent_graph.customer_principals WHERE id = $1`,
    [claims.sub]
  );
  const row = principal.rows[0];
  if (!row || row.is_active !== true) {
    throw new Error('Customer principal is inactive or unknown');
  }
  if (String(row.org_id) !== String(claims.org_id)) {
    throw new Error('Customer token org binding no longer matches principal');
  }

  // Per-token revocation (shared table with board tokens).
  const revoked = await query(
    'SELECT 1 FROM agent_graph.token_revocations WHERE jti = $1',
    [claims.jti]
  );
  if (revoked.rows.length > 0) {
    throw new Error('Customer JWT has been revoked');
  }

  return claims;
}

/**
 * Revoke a single customer token by jti (immediate). Reuses the shared
 * token_revocations table the board tokens use.
 */
export async function revokeCustomerToken(jti, principalId, reason = 'manual revocation') {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  // token_revocations.member_id FKs board_members — a customer principal is NOT
  // a board member, so member_id stays NULL and the principal id is recorded in
  // reason. The jti is the revocation key; that is all the verifier consults.
  await query(
    `INSERT INTO agent_graph.token_revocations (jti, member_id, reason, expires_at)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, `[customer ${principalId || 'unknown'}] ${reason}`, expiresAt]
  );
}
