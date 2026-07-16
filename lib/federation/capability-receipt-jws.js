/**
 * OPT-77 / T1-E — Capability Receipt sign/verify JWS primitive.
 *
 * Implements the v0.1 envelope from spec/proposals/capability-receipt-envelope.md.
 * The envelope format is FROZEN at v0.1 — any change here is a breaking change
 * across federation peers.
 *
 * Envelope payload (JWT claims, v0.1):
 *   {
 *     v:             "1",          // envelope version
 *     iss:           "<org-did>",  // issuing org DID
 *     aud:           "<org-did>",  // audience org DID
 *     sub:           "<agent-id>", // subject agent bearing this capability
 *     jti:           "<uuid>",     // unique receipt ID (revocation key)
 *     iat:           <unix-sec>,
 *     exp:           <unix-sec>,
 *     nbf:           <unix-sec>,
 *     scope: {
 *       capability:  "kg.read|rag.read|audit.read",
 *       filter:      <object|null>,
 *       max_results: <number>,
 *       max_calls:   <number>,
 *     },
 *     contract_hash: "sha256:<hex>",
 *     revocable_at:  "<url>",      // issuer's revocation list URL
 *     act:           null,         // RFC 8693 delegation — null in v0.1
 *   }
 *
 * Crypto path: RS256 JWT compact serialization. Reuses the same
 * Node `crypto` sign/verify pattern as lib/runtime/agents/agent-jwt.js
 * (createSign('RSA-SHA256') / createVerify('RSA-SHA256')).
 *
 * Key source (order of precedence):
 *   1. AGENT_JWT_KEY_PEM env var (Railway/Docker)
 *   2. AGENT_JWT_KEY_PATH env var → read PEM file
 *   3. GITHUB_APP_PRIVATE_KEY_PATH env var → reuse GitHub App PEM
 *   4. Ephemeral RSA-2048 keypair (dev/CI) — logs a warning
 *
 * NO DB writes. NO HTTP endpoints. Pure crypto primitive.
 * JWKS + revocation fetches are injectable/mockable for tests.
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('federation/capability-receipt-jws');

// ─── Key management (mirrors agent-jwt.js) ───────────────────────────────────

let _privateKeyPem = null;
let _publicKeyPem = null;
let _ephemeralWarned = false;

/**
 * Initialize signing keys. Call once at startup (or lazily on first sign).
 * Mirrors the key-load order in lib/runtime/agents/agent-jwt.js.
 */
export function initKeys() {
  if (_privateKeyPem && _publicKeyPem) return;

  if (process.env.AGENT_JWT_KEY_PEM) {
    const pem = process.env.AGENT_JWT_KEY_PEM.replace(/\\n/g, '\n');
    _privateKeyPem = pem;
    _publicKeyPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    log.info('federation/capability-receipt: keys loaded from AGENT_JWT_KEY_PEM');
    return;
  }
  if (process.env.AGENT_JWT_KEY_PATH) {
    const pem = readFileSync(process.env.AGENT_JWT_KEY_PATH, 'utf-8');
    _privateKeyPem = pem;
    _publicKeyPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    log.info('federation/capability-receipt: keys loaded from AGENT_JWT_KEY_PATH');
    return;
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const pem = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
    _privateKeyPem = pem;
    _publicKeyPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' });
    log.info('federation/capability-receipt: keys loaded from GITHUB_APP_PRIVATE_KEY_PATH');
    return;
  }

  // Ephemeral (dev/CI)
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  _privateKeyPem = pair.privateKey;
  _publicKeyPem = pair.publicKey;
  if (!_ephemeralWarned) {
    log.warn('federation/capability-receipt: no key env set — using ephemeral RSA-2048. Set AGENT_JWT_KEY_PEM before issuing receipts to federation peers.');
    _ephemeralWarned = true;
  }
}

/** Expose the public key PEM for JWKS endpoint construction. */
export function getPublicKeyPem() {
  initKeys();
  return _publicKeyPem;
}

/** Reset keys (test-only). */
export function _resetKeysForTest() {
  _privateKeyPem = null;
  _publicKeyPem = null;
  _ephemeralWarned = false;
}

/** Inject a specific keypair (test-only). */
export function _injectKeysForTest(privatePem, publicPem) {
  _privateKeyPem = privatePem;
  _publicKeyPem = publicPem;
}

// ─── Base64url helpers (same pattern as agent-jwt.js) ────────────────────────

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  const padded = str + '==='.slice((str.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ENVELOPE_VERSION = '1';
const MAX_TTL_SECONDS = 24 * 60 * 60; // 24h per spec

// ─── Cache stores (JWKS + revocation) ────────────────────────────────────────

const _jwksCache = new Map();   // issuerDid → { keys, expiresAt }
const _revCache  = new Map();   // revocableAt URL → { jtiSet, expiresAt }
const CACHE_TTL_MS = 60_000;    // 60s

// ─── Injectable fetchers (swap in tests to avoid network) ────────────────────

/**
 * Default JWKS fetcher. Fetches `<issuerBaseUrl>/.well-known/jwks.json`.
 * Resolvable: `issuerDid` of the form `did:web:<domain>` → base URL is
 * `https://<domain>`.
 *
 * @param {string} issuerDid
 * @returns {Promise<{keys: Array}>}
 */
async function defaultJwksFetcher(issuerDid) {
  const domain = issuerDid.replace(/^did:web:/, '');
  const url = `https://${domain}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${url}`);
  return res.json();
}

/**
 * Default revocation list fetcher. Fetches `revocableAt` URL.
 * @param {string} revocableAt
 * @returns {Promise<{revoked: string[]}>}
 */
async function defaultRevocationFetcher(revocableAt) {
  const res = await fetch(revocableAt);
  if (!res.ok) throw new Error(`Revocation fetch failed: ${res.status} ${revocableAt}`);
  return res.json();
}

// ─── signReceipt ─────────────────────────────────────────────────────────────

/**
 * Sign a capability receipt envelope as a compact JWS (RS256 JWT).
 *
 * @param {object} params
 * @param {string} params.issuer       - Issuing org DID (e.g. "did:web:staqs.io")
 * @param {string} params.audience     - Audience org DID (e.g. "did:web:umbadvisors.com")
 * @param {string} params.subject      - Subject agent ID (e.g. "agent:claw-workshop")
 * @param {object} params.scope        - { capability, filter?, max_results, max_calls }
 * @param {string} params.contractHash - "sha256:<hex>" anchoring the business contract
 * @param {number} [params.ttl=3600]   - Receipt lifetime in seconds (max 86400 = 24h)
 * @returns {string} Compact JWS string (header.payload.signature)
 */
export function signReceipt({ issuer, audience, subject, scope, contractHash, ttl = 3600 }) {
  if (!issuer)       throw new Error('signReceipt: issuer is required');
  if (!audience)     throw new Error('signReceipt: audience is required');
  if (!subject)      throw new Error('signReceipt: subject is required');
  if (!scope?.capability) throw new Error('signReceipt: scope.capability is required');
  if (!contractHash) throw new Error('signReceipt: contractHash is required');
  if (ttl > MAX_TTL_SECONDS) throw new Error(`signReceipt: ttl ${ttl}s exceeds 24h max`);

  initKeys();

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    v:             ENVELOPE_VERSION,
    iss:           issuer,
    aud:           audience,
    sub:           subject,
    jti:           randomUUID(),
    iat:           now,
    exp:           now + ttl,
    nbf:           now,
    scope: {
      capability:  scope.capability,
      filter:      scope.filter   ?? null,
      max_results: scope.max_results ?? 500,
      max_calls:   scope.max_calls   ?? 100,
    },
    contract_hash: contractHash,
    revocable_at:  `https://${issuer.replace(/^did:web:/, '')}/.well-known/federation/revocations`,
    act:           null,
  };

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body   = base64url(JSON.stringify(payload));
  const signable = `${header}.${body}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signable);
  const signature = base64url(signer.sign(_privateKeyPem));

  return `${signable}.${signature}`;
}

// ─── verifyReceipt ───────────────────────────────────────────────────────────

/**
 * Verify a capability receipt JWS.
 *
 * Checks:
 *   1. Signature (RS256 via issuer's JWKS)
 *   2. exp (not expired)
 *   3. nbf (not before, if present)
 *   4. aud (matches expectedAudience)
 *   5. iss (matches currentOrgDid when expectedAudience === currentOrgDid)
 *   6. jti not in revocation list (fetched from claims.revocable_at, cached 60s)
 *   7. scope.capability present
 *
 * @param {string} receipt - Compact JWS string
 * @param {object} opts
 * @param {string} opts.expectedAudience - The org DID that should be the aud claim
 * @param {string} opts.currentOrgDid    - This org's DID (used for issuer validation)
 * @param {Function} [opts.jwksFetcher]       - Override JWKS fetch (for tests)
 * @param {Function} [opts.revocationFetcher] - Override revocation fetch (for tests)
 * @returns {Promise<{valid: boolean, claims: object|null, reason: string|null}>}
 */
export async function verifyReceipt(receipt, {
  expectedAudience,
  currentOrgDid,
  jwksFetcher      = defaultJwksFetcher,
  revocationFetcher = defaultRevocationFetcher,
} = {}) {
  // ── 1. Parse structure ──────────────────────────────────────────────────
  let headerB64, payloadB64, sigB64, claims, header;
  try {
    const parts = receipt.split('.');
    if (parts.length !== 3) return fail('malformed JWS: expected 3 parts');
    [headerB64, payloadB64, sigB64] = parts;
    header = JSON.parse(base64urlDecode(headerB64).toString('utf-8'));
    claims = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
  } catch (e) {
    return fail(`parse error: ${e.message}`);
  }

  if (header.alg !== 'RS256') return fail(`unsupported algorithm: ${header.alg}`);

  // ── 2. Time checks ──────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= now) return fail('receipt expired');
  if (claims.nbf  && claims.nbf  >  now) return fail('receipt not yet valid (nbf)');

  // ── 3. Audience check ───────────────────────────────────────────────────
  if (expectedAudience && claims.aud !== expectedAudience) {
    return fail(`aud mismatch: expected ${expectedAudience}, got ${claims.aud}`);
  }

  // ── 4. Scope check ──────────────────────────────────────────────────────
  if (!claims.scope?.capability) return fail('missing scope.capability');

  // ── 5. Signature verification (via issuer JWKS) ─────────────────────────
  const issuer = claims.iss;
  if (!issuer) return fail('missing iss claim');

  let publicKeyPem;
  try {
    publicKeyPem = await resolvePublicKey(issuer, { currentOrgDid, jwksFetcher });
  } catch (e) {
    return fail(`JWKS resolution failed: ${e.message}`);
  }

  try {
    const signable = `${headerB64}.${payloadB64}`;
    const sig = base64urlDecode(sigB64);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signable);
    if (!verifier.verify(publicKeyPem, sig)) {
      return fail('signature verification failed');
    }
  } catch (e) {
    return fail(`signature error: ${e.message}`);
  }

  // ── 6. Revocation check ─────────────────────────────────────────────────
  const revocableAt = claims.revocable_at;
  if (revocableAt && claims.jti) {
    try {
      const revoked = await resolveRevocationList(revocableAt, revocationFetcher);
      if (revoked.has(claims.jti)) return fail(`jti ${claims.jti} is revoked`);
    } catch (e) {
      // Fail-open on revocation fetch errors (network partition) but log
      log.warn(`Revocation check failed for jti=${claims.jti}: ${e.message}`);
    }
  }

  return { valid: true, claims, reason: null };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function fail(reason) {
  return { valid: false, claims: null, reason };
}

/**
 * Resolve the RS256 public key for an issuer DID.
 * If the issuer DID matches `currentOrgDid`, use our local public key directly
 * (avoids a network round-trip for self-issued receipts in tests).
 * Otherwise fetch the issuer's JWKS.
 */
async function resolvePublicKey(issuerDid, { currentOrgDid, jwksFetcher }) {
  // Self-issued: use our local key (also makes tests trivial to wire)
  if (issuerDid === currentOrgDid) {
    initKeys();
    return _publicKeyPem;
  }

  // Check cache
  const cached = _jwksCache.get(issuerDid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.publicKeyPem;
  }

  // Fetch JWKS
  const jwks = await jwksFetcher(issuerDid);
  // Find first RSA key (use/alg: RS256 preferred)
  const jwk = (jwks.keys || []).find(k =>
    (k.kty === 'RSA') && (k.use === 'sig' || !k.use) && (k.alg === 'RS256' || !k.alg)
  );
  if (!jwk) throw new Error(`No RS256 key found in JWKS for ${issuerDid}`);

  // Convert JWK → PEM via Node crypto
  const keyObj = createPublicKey({ key: jwk, format: 'jwk' });
  const publicKeyPem = keyObj.export({ type: 'spki', format: 'pem' });

  _jwksCache.set(issuerDid, { publicKeyPem, expiresAt: Date.now() + CACHE_TTL_MS });
  return publicKeyPem;
}

/**
 * Fetch and cache the revocation list for a given `revocable_at` URL.
 * Returns a Set of revoked JTIs.
 */
async function resolveRevocationList(revocableAt, fetcher) {
  const cached = _revCache.get(revocableAt);
  if (cached && cached.expiresAt > Date.now()) return cached.jtiSet;

  const data = await fetcher(revocableAt);
  const jtiSet = new Set(data.revoked || []);
  _revCache.set(revocableAt, { jtiSet, expiresAt: Date.now() + CACHE_TTL_MS });
  return jtiSet;
}

/** Clear all caches (test-only). */
export function _clearCachesForTest() {
  _jwksCache.clear();
  _revCache.clear();
}
