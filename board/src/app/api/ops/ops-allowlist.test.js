// STAQPRO-540 (Ship-0): /api/ops prefix-allowlist smoke.
//
// Importing the route file is heavy (Next.js + NextAuth deps), so — following
// the inbox-proxy-allowlist.test.js convention — we duplicate the small
// predicate here and guard it with a regression assertion that route.ts both
// declares the entries AND wires isPathAllowed into validatePath. Pure-function
// test, no Next runtime.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const routePath = fileURLToPath(new URL('./route.ts', import.meta.url));
const routeSrc = readFileSync(routePath, 'utf8');

// Mirror of the route's predicate (kept in sync via the regression guards below).
const ALLOWED_PREFIXES = [
  '/api/accounts', '/api/actions', '/api/activity', '/api/agents', '/api/audit',
  '/api/board-members', '/api/briefing', '/api/campaigns',
  '/api/capture-sources', '/api/chat',
  '/api/contacts', '/api/content', '/api/contracts', '/api/counterparties',
  '/api/deals', '/api/documents', '/api/drafts', '/api/drive', '/api/explorer',
  '/api/flows', '/api/github', '/api/governance', '/api/intents', '/api/meetings',
  '/api/metrics', '/api/models', '/api/needs-attention', '/api/organizations',
  '/api/pipeline', '/api/preferences', '/api/projects', '/api/research-sources',
  '/api/runs', '/api/search', '/api/services', '/api/signals', '/api/signatures',
  '/api/stats', '/api/status', '/api/tenancy', '/api/transcripts', '/api/triage',
  '/api/voice-prints', '/api/wiki',
];

function isPathAllowed(pathname) {
  return ALLOWED_PREFIXES.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

describe('ops allowlist — allows the known board surface', () => {
  it('exact resource-group roots pass', () => {
    assert.equal(isPathAllowed('/api/drafts'), true);
    assert.equal(isPathAllowed('/api/signals'), true);
    assert.equal(isPathAllowed('/api/stats'), true);
  });

  it('sub-paths under a root pass (dynamic segments)', () => {
    assert.equal(isPathAllowed('/api/contacts/abc-123/tags'), true);
    assert.equal(isPathAllowed('/api/intents/42/approve'), true);
    assert.equal(isPathAllowed('/api/chat/sessions'), true);
    // owning-org picker source for capture sources (tenancy.orgs, not the CRM).
    assert.equal(isPathAllowed('/api/tenancy/orgs'), true);
  });
});

describe('ops allowlist — rejects non-allowlisted paths (the second door)', () => {
  it('rejects control endpoints that route through inbox-proxy, not ops', () => {
    assert.equal(isPathAllowed('/api/system/halt'), false);
    assert.equal(isPathAllowed('/api/halt'), false);
    assert.equal(isPathAllowed('/api/resume'), false);
    assert.equal(isPathAllowed('/api/phase/dead-man-switch'), false);
  });

  it('rejects unknown / internal / debug surfaces', () => {
    assert.equal(isPathAllowed('/api/internal/secrets'), false);
    assert.equal(isPathAllowed('/api/debug/pipeline'), false);
    assert.equal(isPathAllowed('/api/'), false);
  });

  it('does not allow a prefix-collision sibling (root must be exact or root/...)', () => {
    // "/api/stats" is allowed but "/api/stats-export" must not piggyback on it.
    assert.equal(isPathAllowed('/api/stats-export'), false);
  });
});

describe('ops allowlist — regression guard against route.ts drift', () => {
  it('route.ts declares ALLOWED_PREFIXES with sentinel entries', () => {
    assert.match(routeSrc, /ALLOWED_PREFIXES/);
    assert.match(routeSrc, /"\/api\/drafts"/);
    assert.match(routeSrc, /"\/api\/voice-prints"/);
  });

  it('validatePath actually enforces the allowlist (not dead code)', () => {
    assert.match(routeSrc, /if \(!isPathAllowed\(url\.pathname\)\) return false;/);
  });

  it('control endpoints are NOT present in the ops allowlist', () => {
    assert.doesNotMatch(routeSrc, /"\/api\/halt"/);
    assert.doesNotMatch(routeSrc, /"\/api\/system\/halt"/);
  });
});
