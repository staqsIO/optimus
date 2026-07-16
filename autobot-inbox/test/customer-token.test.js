// customer-token.test.js — OPT-37.
//
// Pure-function coverage for the external customer token (no prod server, no DB):
//   1. route-tiers classify() puts the customer-token admin routes on 'admin'
//      (board-only) — NOT ops-control, so an agent JWT can never mint them.
//   2. The customer authorization ceiling logic: a customer principal may reach
//      only {public, public-signing, org-shared}; ops-control / admin /
//      viewer-scoped are denied. (Replicates the CUSTOMER_ALLOWED_TIERS set the
//      api.js dispatch middleware enforces, pinned against real classify() output.)
//   3. issueCustomerToken() produces a well-formed iss:'optimus-customer' JWT
//      carrying sub + org_id + scope (verifyCustomerToken's DB check is exercised
//      by the integration/manual plan, not here).

import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, IDENTITY, SCOPE } from '../src/route-tiers.js';
import { initializeCustomerJwtKeys, issueCustomerToken } from '../src/runtime/customer-jwt.js';

// ── 1. customer-token admin routes classify board-only ────────────────────────
test('classify: customer-token admin routes are board-only (not ops-control)', () => {
  const cases = [
    ['POST', '/api/auth/customer-token'],
    ['POST', '/api/auth/customer-token/issue'],
    ['POST', '/api/auth/customer-token/revoke'],
    ['GET', '/api/customer-principals'],
  ];
  for (const [m, p] of cases) {
    const r = classify(m, p);
    assert.equal(r.tier, 'admin', `${m} ${p} tier`);
    assert.equal(r.identity, IDENTITY.BOARD_ONLY, `${m} ${p} identity`);
    assert.equal(r.scope, SCOPE.NONE, `${m} ${p} scope`);
  }
});

// ── 2. customer ceiling: allowed vs denied tiers ──────────────────────────────
test('customer ceiling: only public/public-signing/org-shared are reachable', () => {
  const CUSTOMER_ALLOWED_TIERS = new Set(['public', 'public-signing', 'org-shared']);
  const allowed = [
    ['GET', '/api/health'],            // public
    ['POST', '/api/ingest'],           // org-shared (KB write)
    ['POST', '/api/artifacts'],        // org-shared (artifact write)
    ['GET', '/api/artifacts'],         // org-shared (artifact list)
    ['POST', '/api/search'],           // org-shared (KB search)
    ['GET', '/api/artifacts/enrich/contact/abc'], // org-shared
  ];
  const denied = [
    ['POST', '/api/halt'],             // admin
    ['POST', '/api/auth/customer-token'], // admin
    ['GET', '/api/drafts'],            // viewer-scoped
    ['GET', '/api/signals'],           // viewer-scoped
    ['POST', '/api/cron/explorer'],    // ops-control
    ['POST', '/api/board/build'],      // ops-control
    ['GET', '/api/intents'],           // ops-control
  ];
  for (const [m, p] of allowed) {
    assert.ok(CUSTOMER_ALLOWED_TIERS.has(classify(m, p).tier), `${m} ${p} should be reachable`);
  }
  for (const [m, p] of denied) {
    assert.ok(!CUSTOMER_ALLOWED_TIERS.has(classify(m, p).tier), `${m} ${p} should be denied`);
  }
});

// ── 3. issued token is a well-formed customer JWT ─────────────────────────────
test('issueCustomerToken: emits iss optimus-customer with sub/org_id/scope', async () => {
  await initializeCustomerJwtKeys(); // ephemeral keypair in test
  const orgId = '7c164445-43f2-4802-a7d3-5cab06611e99';
  const principalId = '11111111-1111-1111-1111-111111111111';
  const { token, expiresAt, jti } = issueCustomerToken(principalId, orgId, ['kb:read', 'kb:write']);

  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT has 3 segments');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
  assert.equal(payload.iss, 'optimus-customer');
  assert.equal(payload.sub, principalId);
  assert.equal(payload.org_id, orgId);
  assert.deepEqual(payload.scope, ['kb:read', 'kb:write']);
  assert.equal(payload.jti, jti);
  assert.ok(expiresAt > Date.now(), 'expiresAt in the future');
});
