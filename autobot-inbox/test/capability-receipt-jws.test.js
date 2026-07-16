/**
 * OPT-77 — capability-receipt-jws unit tests.
 *
 * Covers all 6 acceptance cases:
 *   1. happy path   — sign → verify returns valid + correct claims
 *   2. expired      — exp in the past → valid:false, reason includes "expired"
 *   3. wrong aud    — expectedAudience mismatch → valid:false
 *   4. revoked      — jti in revocation list → valid:false
 *   5. bad sig      — tampered payload → valid:false
 *   6. missing scope — no scope.capability → valid:false
 *
 * No network, no DB. JWKS resolved via self-issued path (issuerDid === currentOrgDid).
 * Revocation list is injected via revocationFetcher option.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  signReceipt,
  verifyReceipt,
  _injectKeysForTest,
  _resetKeysForTest,
  _clearCachesForTest,
} from '../../lib/federation/capability-receipt-jws.js';

// ─── Test key setup ──────────────────────────────────────────────────────────

const { privateKey: TEST_PRIVATE_PEM, publicKey: TEST_PUBLIC_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Second keypair for bad-sig test (different key → tampered signature)
const { privateKey: ALT_PRIVATE_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ISSUER   = 'did:web:staqs.io';
const AUDIENCE = 'did:web:umbadvisors.com';
const SUBJECT  = 'agent:claw-workshop';
const SCOPE    = { capability: 'kg.read', filter: null, max_results: 500, max_calls: 100 };
const CONTRACT = 'sha256:abc123deadbeef';

/** No-op revocation fetcher — returns empty list. */
const noRevocations = async (_url) => ({ revoked: [] });

/** Shared verify options — self-issued path (issuer === currentOrgDid) avoids network. */
const verifyOpts = (extra = {}) => ({
  expectedAudience:  AUDIENCE,
  currentOrgDid:     ISSUER,   // self-issued: resolves via local key, no JWKS fetch
  revocationFetcher: noRevocations,
  ...extra,
});

// ─── Setup / teardown ────────────────────────────────────────────────────────

function setup() {
  _resetKeysForTest();
  _clearCachesForTest();
  _injectKeysForTest(TEST_PRIVATE_PEM, TEST_PUBLIC_PEM);
}

// ─── 1. Happy path ───────────────────────────────────────────────────────────

test('signReceipt → verifyReceipt: happy path', async (_t) => {
  setup();

  const jws = signReceipt({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, scope: SCOPE, contractHash: CONTRACT });
  assert.ok(typeof jws === 'string', 'JWS must be a string');
  assert.ok(jws.split('.').length === 3, 'JWS must have 3 parts (compact serialization)');

  const result = await verifyReceipt(jws, verifyOpts());

  assert.equal(result.valid, true, `Expected valid:true, got reason: ${result.reason}`);
  assert.equal(result.reason, null);
  assert.ok(result.claims, 'claims must be present');

  // Verify frozen v0.1 envelope fields
  assert.equal(result.claims.v,              '1',      'v must be "1"');
  assert.equal(result.claims.iss,            ISSUER,   'iss must match');
  assert.equal(result.claims.aud,            AUDIENCE, 'aud must match');
  assert.equal(result.claims.sub,            SUBJECT,  'sub must match');
  assert.ok(result.claims.jti,                         'jti must be present');
  assert.ok(result.claims.iat > 0,                     'iat must be set');
  assert.ok(result.claims.exp > result.claims.iat,     'exp must be after iat');
  assert.equal(result.claims.nbf,            result.claims.iat, 'nbf must equal iat');
  assert.equal(result.claims.scope.capability, 'kg.read');
  assert.equal(result.claims.scope.max_results, 500);
  assert.equal(result.claims.scope.max_calls,   100);
  assert.equal(result.claims.contract_hash,  CONTRACT, 'contract_hash must match');
  assert.ok(result.claims.revocable_at.includes('staqs.io'),   'revocable_at must reference issuer domain');
  assert.equal(result.claims.act,            null,     'act must be null in v0.1');
});

// ─── 2. Expired receipt ───────────────────────────────────────────────────────

test('verifyReceipt: expired receipt returns valid:false', async (_t) => {
  setup();

  // Sign with ttl=1 and backdate by manipulating the payload directly
  const jws = signReceipt({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, scope: SCOPE, contractHash: CONTRACT, ttl: 1 });

  // Decode and backdate exp to the past
  const [h, p, _s] = jws.split('.');
  const claims = JSON.parse(Buffer.from(p + '==='.slice((p.length + 3) % 4), 'base64').toString('utf-8'));
  claims.exp = Math.floor(Date.now() / 1000) - 10; // 10s ago
  const newP = Buffer.from(JSON.stringify(claims)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  // Re-sign with the same key so signature is valid, only exp is wrong
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${newP}`);
  const newSig = signer.sign(TEST_PRIVATE_PEM).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const expiredJws = `${h}.${newP}.${newSig}`;
  const result = await verifyReceipt(expiredJws, verifyOpts());

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('expired'), `reason should mention expired, got: ${result.reason}`);
  assert.equal(result.claims, null);
});

// ─── 3. Wrong audience ────────────────────────────────────────────────────────

test('verifyReceipt: wrong audience returns valid:false', async (_t) => {
  setup();

  const jws = signReceipt({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, scope: SCOPE, contractHash: CONTRACT });
  const result = await verifyReceipt(jws, verifyOpts({ expectedAudience: 'did:web:wrong-org.com' }));

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('aud mismatch'), `reason should mention aud mismatch, got: ${result.reason}`);
});

// ─── 4. Revoked jti ──────────────────────────────────────────────────────────

test('verifyReceipt: revoked jti returns valid:false', async (_t) => {
  setup();

  const jws = signReceipt({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, scope: SCOPE, contractHash: CONTRACT });

  // Decode to get the jti
  const [, payloadB64] = jws.split('.');
  const paddedP = payloadB64 + '==='.slice((payloadB64.length + 3) % 4);
  const claims  = JSON.parse(Buffer.from(paddedP, 'base64').toString('utf-8'));
  const { jti } = claims;

  // Inject revocation list containing this jti
  const revokedFetcher = async (_url) => ({ revoked: [jti] });

  const result = await verifyReceipt(jws, verifyOpts({ revocationFetcher: revokedFetcher }));

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('revoked'), `reason should mention revoked, got: ${result.reason}`);
});

// ─── 5. Bad signature ─────────────────────────────────────────────────────────

test('verifyReceipt: tampered signature returns valid:false', async (_t) => {
  setup();

  const jws = signReceipt({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, scope: SCOPE, contractHash: CONTRACT });

  // Tamper by replacing the signature segment with one from a different key
  const [h, p] = jws.split('.');
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const badSig = signer.sign(ALT_PRIVATE_PEM).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const tamperedJws = `${h}.${p}.${badSig}`;
  const result = await verifyReceipt(tamperedJws, verifyOpts());

  assert.equal(result.valid, false);
  assert.ok(
    result.reason?.includes('signature'),
    `reason should mention signature, got: ${result.reason}`,
  );
});

// ─── 6. Missing scope.capability ─────────────────────────────────────────────

test('verifyReceipt: missing scope.capability returns valid:false', async (_t) => {
  setup();

  // Build a JWS manually without scope.capability
  const now = Math.floor(Date.now() / 1000);
  const badClaims = {
    v: '1', iss: ISSUER, aud: AUDIENCE, sub: SUBJECT,
    jti: 'test-no-scope', iat: now, exp: now + 3600, nbf: now,
    scope: { filter: null, max_results: 10, max_calls: 10 }, // no capability
    contract_hash: CONTRACT, revocable_at: null, act: null,
  };

  const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(badClaims));

  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = signer.sign(TEST_PRIVATE_PEM).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jws = `${h}.${p}.${sig}`;
  const result = await verifyReceipt(jws, verifyOpts());

  assert.equal(result.valid, false);
  assert.ok(result.reason?.includes('scope.capability'), `reason should mention scope.capability, got: ${result.reason}`);
});
