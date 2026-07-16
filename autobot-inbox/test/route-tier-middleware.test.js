// route-tier-middleware.test.js — STAQPRO-542 (ADR-014).
//
// Two concerns, both tested as PURE functions (no prod server, no DB):
//   1. classify() puts representative routes — including the seeded sensitive
//      ones — into the expected tier.
//   2. identityGate() (the enforce-mode gate logic) admits/denies correctly:
//      board-only rejects agent_jwt + bare api_secret; authed-any rejects
//      no-auth; public allows; bare-default (unclassified) → 403.
//
// The gate is unit-tested directly (NOT through the live server) per the task —
// in Phase 0 every tier is 'observe' so the gate never blocks at runtime; this
// test pins the logic that the follow-up enforce flip will switch on.

import test from 'node:test';
import assert from 'node:assert/strict';

// Importing api.js (via route-tiers) populates the routes Map so routeKeyFor
// normalization is live.
import {
  classify,
  identityGate,
  IDENTITY,
  SCOPE,
} from '../src/route-tiers.js';

// ── classify(): representative routes per tier (incl. seeded sensitive) ───────
test('classify: sensitive routes land on the expected tier + axes', () => {
  const cases = [
    // admin (board-JWT-only)
    ['POST', '/api/halt',                'admin',          IDENTITY.BOARD_ONLY, SCOPE.NONE],
    ['POST', '/api/resume',              'admin',          IDENTITY.BOARD_ONLY, SCOPE.NONE],
    ['DELETE', '/api/contacts/xyz',      'admin',          IDENTITY.BOARD_ONLY, SCOPE.NONE],
    ['POST', '/api/models/sync',         'admin',          IDENTITY.BOARD_ONLY, SCOPE.NONE],
    ['POST', '/api/agents/config',       'admin',          IDENTITY.BOARD_ONLY, SCOPE.NONE],
    // viewer-scoped (per-user)
    ['GET', '/api/drafts',               'viewer-scoped',  IDENTITY.AUTHED_ANY, SCOPE.OWNER],
    ['GET', '/api/contacts',             'viewer-scoped',  IDENTITY.AUTHED_ANY, SCOPE.OWNER],
    ['GET', '/api/contacts/123',         'viewer-scoped',  IDENTITY.AUTHED_ANY, SCOPE.OWNER],
    ['GET', '/api/today/meetings',       'viewer-scoped',  IDENTITY.AUTHED_ANY, SCOPE.OWNER],
    ['GET', '/api/signals',              'viewer-scoped',  IDENTITY.AUTHED_ANY, SCOPE.OWNER],
    // org-shared (incl. signatures — board-JWT enforcement flip is a follow-up)
    ['GET', '/api/signatures',           'org-shared',     IDENTITY.AUTHED_ANY, SCOPE.ORG],
    ['POST', '/api/signatures/create',   'org-shared',     IDENTITY.AUTHED_ANY, SCOPE.ORG],
    // public / bypass tiers
    ['GET', '/api/health',               'public',         IDENTITY.PUBLIC,         SCOPE.NONE],
    ['POST', '/api/webhooks/tldv',       'webhook-authed', IDENTITY.WEBHOOK_SECRET, SCOPE.NONE],
    ['POST', '/api/webhooks/foo',        'webhook-authed', IDENTITY.WEBHOOK_SECRET, SCOPE.NONE],
    ['POST', '/api/voice-memo/upload',   'webhook-authed', IDENTITY.WEBHOOK_SECRET, SCOPE.NONE],
    ['GET', '/api/sign/tok',             'public-signing', IDENTITY.SIGNING_TOKEN,  SCOPE.NONE],
    // ops-control
    ['POST', '/api/cron/explorer',       'ops-control',    IDENTITY.AUTHED_ANY, SCOPE.NONE],
    ['POST', '/api/phase/dead-man-switch/renew', 'ops-control', IDENTITY.AUTHED_ANY, SCOPE.NONE],
    ['GET', '/api/redesign/status/x',    'ops-control',    IDENTITY.AUTHED_ANY, SCOPE.NONE],
  ];
  for (const [m, p, tier, identity, scope] of cases) {
    const r = classify(m, p);
    assert.equal(r.tier, tier, `${m} ${p} tier`);
    assert.equal(r.identity, identity, `${m} ${p} identity`);
    assert.equal(r.scope, scope, `${m} ${p} scope`);
  }
});

// ── identityGate(): enforce-mode gate logic ───────────────────────────────────
const BOARD_JWT = { role: 'board', source: 'jwt', github_username: 'ecgang' };
const AGENT_JWT = { role: 'orchestrator', source: 'agent_jwt' };
const BARE_SECRET = { role: 'board', source: 'api_secret', github_username: null };
const SECRET_WITH_USER = { role: 'board', source: 'api_secret', github_username: 'ecgang' };

test('identityGate: public allows anyone (even no auth)', () => {
  assert.equal(identityGate(IDENTITY.PUBLIC, null, 'exception').allow, true);
  assert.equal(identityGate(IDENTITY.PUBLIC, BOARD_JWT, 'prefix').allow, true);
});

test('identityGate: webhook-secret / signing-token defer to handler (allow at gate)', () => {
  assert.equal(identityGate(IDENTITY.WEBHOOK_SECRET, null, 'exception').allow, true);
  assert.equal(identityGate(IDENTITY.SIGNING_TOKEN, null, 'prefix').allow, true);
});

test('identityGate: authed-any rejects no-auth, allows any authenticated principal', () => {
  const noAuth = identityGate(IDENTITY.AUTHED_ANY, null, 'prefix');
  assert.equal(noAuth.allow, false);
  assert.equal(noAuth.status, 401);
  assert.equal(identityGate(IDENTITY.AUTHED_ANY, BOARD_JWT, 'prefix').allow, true);
  assert.equal(identityGate(IDENTITY.AUTHED_ANY, AGENT_JWT, 'prefix').allow, true);
  assert.equal(identityGate(IDENTITY.AUTHED_ANY, SECRET_WITH_USER, 'prefix').allow, true);
});

test('identityGate: board-only admits board JWT, rejects agent_jwt + bare api_secret', () => {
  assert.equal(identityGate(IDENTITY.BOARD_ONLY, BOARD_JWT, 'exception').allow, true);

  const agent = identityGate(IDENTITY.BOARD_ONLY, AGENT_JWT, 'exception');
  assert.equal(agent.allow, false);
  assert.equal(agent.status, 403);

  const bare = identityGate(IDENTITY.BOARD_ONLY, BARE_SECRET, 'exception');
  assert.equal(bare.allow, false);
  assert.equal(bare.status, 403);

  const noAuth = identityGate(IDENTITY.BOARD_ONLY, null, 'exception');
  assert.equal(noAuth.allow, false);
  assert.equal(noAuth.status, 401);
});

test('identityGate: bare-default (unclassified) is denied 403 in enforce mode', () => {
  const r = identityGate(IDENTITY.AUTHED_ANY, BOARD_JWT, 'default');
  assert.equal(r.allow, false);
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'unclassified');
});
