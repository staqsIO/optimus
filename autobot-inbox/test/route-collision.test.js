// route-collision.test.js — STAQPRO-588 regression guard.
//
// The cross-tenant leak in GET /api/signals was caused by a ROUTE COLLISION:
// api-routes/flows.js registered the same `GET /api/signals` Map key as an inline
// handler in api.js. registerFlowRoutes() runs later, so last-writer-wins silently
// shadowed the scoped handler with an unscoped `SELECT * FROM agent_graph.signals`.
//
// This guard is deterministic (source-level, no DB) and runs in the required
// `test:ci` job. It pins the post-fix invariant: GET /api/signals is owned by
// EXACTLY ONE module (flows.js, the tenant-scoped flow-signal feed), and api.js
// must never re-register it. If someone re-adds an inline handler, this fails
// before the collision can ship.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

// Count `routes.set('GET /api/signals', ...)` registrations (exact path, not subpaths).
function countSignalsRegistrations(src) {
  const re = /routes\.set\(\s*['"]GET \/api\/signals['"]\s*,/g;
  return (src.match(re) || []).length;
}

test('api.js does NOT register GET /api/signals (tombstone holds; no collision)', () => {
  const apiSrc = readFileSync(join(SRC, 'api.js'), 'utf8');
  assert.equal(
    countSignalsRegistrations(apiSrc),
    0,
    'api.js must not register GET /api/signals — it would collide with and shadow ' +
      'the scoped flows.js handler. Scope the flows handler instead.',
  );
  assert.match(
    apiSrc,
    /Do NOT re-register 'GET \/api\/signals'/,
    'the tombstone comment that documents the collision footgun must remain',
  );
});

test('flows.js owns GET /api/signals exactly once and scopes it with visibleClause', () => {
  const flowsSrc = readFileSync(join(SRC, 'api-routes', 'flows.js'), 'utf8');
  assert.equal(
    countSignalsRegistrations(flowsSrc),
    1,
    'flows.js must register GET /api/signals exactly once (the canonical feed)',
  );
  assert.match(
    flowsSrc,
    /visibleClause\(principal,\s*\{\s*ownerOrgCol:\s*'owner_org_id'/,
    'listSignalsCore must scope agent_graph.signals by owner_org_id (fail-closed)',
  );
});

test('no other api-routes module registers GET /api/signals (single owner)', async () => {
  const { readdirSync } = await import('node:fs');
  const routesDir = join(SRC, 'api-routes');
  let total = 0;
  for (const f of readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    total += countSignalsRegistrations(readFileSync(join(routesDir, f), 'utf8'));
  }
  assert.equal(total, 1, 'exactly one api-routes module may own GET /api/signals (flows.js)');
});

// ── STAQPRO-596: /api/today/* are the same leak class (unscoped content.documents) ──
function countRegistrations(src, route) {
  const re = new RegExp(`routes\\.set\\(\\s*['"]GET ${route.replace(/\//g, '\\/')}['"]\\s*,`, 'g');
  return (src.match(re) || []).length;
}

test('meetings.js owns the /api/today/* routes exactly once and scopes content.documents', () => {
  const meetingsSrc = readFileSync(join(SRC, 'api-routes', 'meetings.js'), 'utf8');
  assert.equal(
    countRegistrations(meetingsSrc, '/api/today/meetings'),
    1,
    'meetings.js must register GET /api/today/meetings exactly once',
  );
  assert.equal(
    countRegistrations(meetingsSrc, '/api/today/meeting-attendees'),
    1,
    'meetings.js must register GET /api/today/meeting-attendees exactly once',
  );
  // Both today queries must scope content.documents by owner org, fail-closed.
  const scoped = (meetingsSrc.match(
    /visibleClause\(principal,\s*\{\s*ownerOrgCol:\s*'d\.owner_org_id'/g,
  ) || []).length;
  assert.ok(
    scoped >= 2,
    `both /today handlers must scope content.documents via visibleClause(... 'd.owner_org_id') (found ${scoped})`,
  );
});

test('no other api-routes module registers the /api/today/* routes (single owner)', async () => {
  const { readdirSync } = await import('node:fs');
  const routesDir = join(SRC, 'api-routes');
  let meetings = 0;
  let attendees = 0;
  for (const f of readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(routesDir, f), 'utf8');
    meetings += countRegistrations(src, '/api/today/meetings');
    attendees += countRegistrations(src, '/api/today/meeting-attendees');
  }
  assert.equal(meetings, 1, 'exactly one module may own GET /api/today/meetings');
  assert.equal(attendees, 1, 'exactly one module may own GET /api/today/meeting-attendees');
});
