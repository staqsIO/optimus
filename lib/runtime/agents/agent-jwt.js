/**
 * JWT issuer and verifier for internal agent identity (ADR-018).
 *
 * Agents hold short-lived RS256 JWT tokens. withAgentScope() verifies
 * the JWT signature before setting session vars. State transitions
 * record JWT-verified identity.
 *
 * No external dependencies — Node `crypto` only (P4: boring infrastructure).
 *
 * Key management (order of precedence):
 *   1. AGENT_JWT_KEY_PATH env var → dedicated PEM file (production)
 *   2. GITHUB_APP_PRIVATE_KEY_PATH env var → reuse GitHub App PEM
 *   3. Neither → crypto.generateKeyPairSync('rsa') ephemeral pair (dev/CI)
 *
 * Federation claim extension (ADR-018 addendum, STAQPRO-358):
 *   v2 tokens carry composite iss `"optimus-agent@<org-did>"` plus new
 *   `org` and `aud` claims, supporting cross-org federation per ADR-007.
 *   v1 tokens (legacy `iss: "optimus-agent"`, no org/aud) are still
 *   accepted and treated as `org="self"`, `aud="self"` during rollout.
 *   `REQUIRE_FEDERATION_CLAIMS=true` enforces v2 (rejects v1, rejects
 *   `aud` mismatch with this process's `ORG_DID`).
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/agent-jwt');

let privateKey = null;
let publicKey = null;
let keySource = null;

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const ISSUER_PREFIX = 'optimus-agent';

/**
 * Resolve this process's federation org DID. Default `"self"` is intentionally
 * non-routable so single-org deploys cannot leak grants across orgs (ADR-007).
 * Read at call time (not module load) so tests can flip ORG_DID dynamically.
 */
export function getOrgDid() {
  return process.env.ORG_DID || 'self';
}

/**
 * Base64url encode (no padding, URL-safe alphabet).
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64url decode.
 */
function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Load or generate RSA key pair. Call once at startup.
 */
export async function initializeJwtKeys() {
  // 1a. PEM content directly in env var (Railway/Docker — no filesystem access)
  if (process.env.AGENT_JWT_KEY_PEM) {
    const pem = process.env.AGENT_JWT_KEY_PEM.replace(/\\n/g, '\n');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'env-pem';
  }
  // 1b. Dedicated agent JWT key file
  else if (process.env.AGENT_JWT_KEY_PATH) {
    const pem = readFileSync(process.env.AGENT_JWT_KEY_PATH, 'utf-8');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'dedicated-key';
  }
  // 2. Reuse GitHub App PEM
  else if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const pem = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
    privateKey = pem;
    publicKey = extractPublicKey(pem);
    keySource = 'github-app';
  }
  // 3. Ephemeral key pair (dev/CI)
  else {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    keySource = 'ephemeral';
  }

  log.info(`JWT signing initialized (source: ${keySource})`);
}

/**
 * Extract public key from a PEM private key.
 */
function extractPublicKey(pem) {
  return createPublicKey(pem).export({ type: 'spki', format: 'pem' });
}

/**
 * Tier mapping from agent config type to spec tier name.
 *
 * STAQPRO-303 PR-B-prereq.1a: `board` and `external` entries added so the
 * board API's JWT mint and nemoclaw external agents resolve to their own
 * tier rather than defaulting to `'executor'`. RLS policies in B-prereq.1e
 * gate `is_board()` and external-agent scopes on the tier claim, so the
 * mapping must produce the right tier for the JWT to carry the right
 * authority.
 */
const TIER_MAP = {
  orchestrator: 'orchestrator',
  strategist: 'strategist',
  architect: 'architect',
  reviewer: 'reviewer',
  executor: 'executor',
  board: 'board',
  external: 'external',
};

/**
 * Issue a short-lived JWT for an agent.
 *
 * @param {string} agentId - Agent identifier (e.g., 'executor-triage')
 * @param {object} agentConfig - Agent config from agents.json
 * @returns {{ token: string, expiresAt: number }}
 */
export function issueAgentToken(agentId, agentConfig) {
  if (!privateKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const orgDid = getOrgDid();

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: `${ISSUER_PREFIX}@${orgDid}`,
    sub: agentId,
    org: orgDid,
    aud: orgDid,
    tier: TIER_MAP[agentConfig.type] || 'executor',
    tools: agentConfig.tools || [],
    iat: now,
    exp,
    jti: randomUUID(),
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return {
    token: `${signable}.${signature}`,
    expiresAt: exp * 1000, // ms for JS Date compat
  };
}

/**
 * Verify an agent JWT and return its claims.
 *
 * @param {string} token - JWT string
 * @returns {{ sub: string, org: string, aud: string, tier: string, tools: string[], iat: number, exp: number, jti: string }}
 * @throws {Error} on invalid signature, expired token, or malformed claims
 *
 * v1 tokens (iss: "optimus-agent", no org/aud) are accepted and treated as
 * `org="self"`, `aud="self"`. v2 tokens carry composite iss and explicit
 * org/aud claims. Under `REQUIRE_FEDERATION_CLAIMS=true`, v1 tokens are
 * rejected and `aud` must match this process's `ORG_DID`.
 */
export function verifyAgentToken(token) {
  if (!publicKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 parts');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signable = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signable);
  if (!verifier.verify(publicKey, signature)) {
    throw new Error('JWT signature verification failed');
  }

  // Decode and validate claims
  const claims = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(`JWT expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }

  // Validate issuer prefix (split composite v2 `"optimus-agent@<org>"`).
  // Empty iss is rejected; legacy `"optimus-agent"` (no @) is accepted as v1.
  const [issPrefix, issOrgSuffix] = (claims.iss || '').split('@');
  if (issPrefix !== ISSUER_PREFIX) {
    throw new Error(`Invalid JWT issuer prefix: ${issPrefix || '(empty)'} (expected ${ISSUER_PREFIX})`);
  }

  // Validate sub format
  if (!/^[a-z0-9_-]+$/.test(claims.sub)) {
    throw new Error(`Invalid JWT sub claim: ${claims.sub}`);
  }

  // Federation claims (ADR-018 addendum). Default to "self" for v1 tokens.
  const tokenOrg = claims.org ?? (issOrgSuffix || 'self');
  const tokenAud = claims.aud ?? 'self';

  // Always-on consistency check: when composite iss carries an org suffix
  // AND an explicit `org` claim is present, they must agree. Catches tampered
  // tokens where one was changed but not the other.
  if (issOrgSuffix && claims.org && claims.org !== issOrgSuffix) {
    throw new Error(`JWT org claim (${claims.org}) does not match iss org suffix (${issOrgSuffix})`);
  }

  // Strict federation enforcement (rollout flag).
  if (process.env.REQUIRE_FEDERATION_CLAIMS === 'true') {
    if (!claims.org) {
      throw new Error('Missing required `org` claim under REQUIRE_FEDERATION_CLAIMS=true');
    }
    const expectedAud = getOrgDid();
    if (tokenAud !== expectedAud) {
      throw new Error(`JWT aud mismatch: token aud=${tokenAud} does not match this org's ORG_DID=${expectedAud}`);
    }
  }

  return { ...claims, org: tokenOrg, aud: tokenAud };
}

/**
 * Test-only: issue a v1-shaped token (no @<org> in iss, no org/aud claims)
 * to exercise the verifyAgentToken backward-compat path. Production code
 * paths must NOT call this — issueAgentToken always emits v2 tokens.
 *
 * @internal
 */
export function _issueLegacyTokenForTest(agentId, agentConfig) {
  if (!privateKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: ISSUER_PREFIX,
    sub: agentId,
    tier: TIER_MAP[agentConfig.type] || 'executor',
    tools: agentConfig.tools || [],
    iat: now,
    exp,
    jti: randomUUID(),
  }));

  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));

  return { token: `${signable}.${signature}`, expiresAt: exp * 1000 };
}

/**
 * Test-only: sign an arbitrary claim set so tests can exercise verifier
 * branches that aren't reachable via the production issuance path (e.g.
 * wrong issuer prefix, iss-org mismatch). Production code paths must NOT
 * call this.
 *
 * @internal
 */
export function _signClaimsForTest(claims) {
  if (!privateKey) throw new Error('JWT keys not initialized — call initializeJwtKeys() first');
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signable = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(privateKey));
  return `${signable}.${signature}`;
}
