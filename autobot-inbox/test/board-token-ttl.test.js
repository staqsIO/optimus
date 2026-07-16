/**
 * Board JWT — caller-requestable TTL (clamped) on issueBoardToken.
 *
 * The API_SECRET-gated /api/auth/token route may request a custom token
 * lifetime (for long-lived local MCP/CLI tokens). issueBoardToken clamps the
 * request to [60s, 90d] and falls back to the 24h default for omitted/invalid
 * values, so an out-of-range request can never mint an unbounded token. The
 * OAuth login path passes no ttl and keeps the 24h default.
 *
 * Offline: issuance uses an ephemeral RSA pair (no DB, no env PEM).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  initializeBoardJwtKeys,
  issueBoardToken,
} from '../../lib/runtime/agents/board-jwt.js';

const DAY = 24 * 60 * 60;
const MEMBER = 'bee111cb-d3e7-4849-9ac8-1566163ccd1e';

// Decode a JWT payload (base64url, unverified) and return exp - iat.
function ttlOf(token) {
  const p = JSON.parse(
    Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  );
  return { ttl: p.exp - p.iat, iss: p.iss, scope: p.scope };
}

before(async () => {
  await initializeBoardJwtKeys();
});

test('default TTL is 24h when no ttl is passed (OAuth-login behavior)', () => {
  const { ttl, iss } = ttlOf(issueBoardToken(MEMBER, 'ecgang').token);
  assert.equal(iss, 'optimus-board');
  assert.equal(ttl, DAY);
});

test('a custom 90-day TTL is honored', () => {
  const { ttl } = ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], 90 * DAY).token);
  assert.equal(ttl, 90 * DAY);
});

test('a custom 7-day TTL is honored', () => {
  const { ttl } = ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], 7 * DAY).token);
  assert.equal(ttl, 7 * DAY);
});

test('above-max requests are clamped to 90 days', () => {
  const { ttl } = ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], 200 * DAY).token);
  assert.equal(ttl, 90 * DAY);
});

test('below-floor requests are clamped to 60s', () => {
  const { ttl } = ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], 5).token);
  assert.equal(ttl, 60);
});

test('non-finite ttl falls back to the 24h default', () => {
  assert.equal(ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], NaN).token).ttl, DAY);
  assert.equal(ttlOf(issueBoardToken(MEMBER, 'ecgang', ['*'], undefined).token).ttl, DAY);
});

test('scope is preserved alongside a custom ttl', () => {
  const { scope, ttl } = ttlOf(issueBoardToken(MEMBER, 'ecgang', ['pipeline:read'], 30 * DAY).token);
  assert.deepEqual(scope, ['pipeline:read']);
  assert.equal(ttl, 30 * DAY);
});
