// route-tier-coverage.test.js — STAQPRO-542 (ADR-014) coverage forcing-function.
//
// The whole O(1) audit collapse (one middleware + one table) only holds if EVERY
// registered route carries an explicit tier. This test enumerates the live,
// fully-populated `routes` Map (after all register*Routes() have run at api.js
// module load) and asserts classify() covers every key.
//
// FORCING FUNCTION (ADR-014 §5 / M6a): the test FAILS if any route resolves
// `via:'default'` — i.e. it fell through to the bare most-restrictive fallback
// instead of being explicitly classified by a prefix rule or an exception. The
// runtime default still exists for safety, but CI requires every route to be
// explicitly covered, so "ship a new route unclassified" is impossible.
//
// SURFACE GUARD (ADR-014 §3 / M3): asserts the Map this test enumerates is the
// SAME object the dispatcher consults, and that classify() normalizes through
// the SAME routeKeyFor() matchRoute() uses — so the table can never be
// phantom-green against a divergent runtime key (the STAQPRO-588 collision
// class). The SSE/upgrade surface-diff — proving no route reaches HTTP off the
// routes Map (e.g. a websocket/upgrade listener) and that streaming endpoints
// classify explicitly — is closed by route-tier-surface-diff.test.js (STAQPRO-598).

import test from 'node:test';
import assert from 'node:assert/strict';

import { routes, matchRoute, routeKeyFor } from '../src/api.js';
import {
  classify,
  TIER_PRESETS,
  DEFAULT_TIER,
} from '../src/route-tiers.js';

function splitKey(key) {
  const sp = key.indexOf(' ');
  return { method: key.slice(0, sp), path: key.slice(sp + 1) };
}

test('every registered route is explicitly classified (no via:default)', () => {
  const keys = [...routes.keys()];
  assert.ok(keys.length > 400, `expected the live Map to be fully populated (~446 routes), got ${keys.length}`);

  const defaults = [];
  for (const key of keys) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    assert.ok(TIER_PRESETS[r.tier], `route ${key} got unknown tier '${r.tier}'`);
    if (r.via === 'default') defaults.push(key);
  }

  assert.equal(
    defaults.length,
    0,
    `These routes fell to the bare '${DEFAULT_TIER}' default — add an explicit ` +
      `prefix rule or exception in src/route-tiers.js:\n  ${defaults.join('\n  ')}`,
  );
});

test('classify normalizes through the SAME routeKeyFor the dispatcher uses (M3)', () => {
  // For every Map key, classify()'s normalized key must equal the key itself
  // (the inputs ARE the canonical normalized keys), proving classify shares the
  // runtime normalizer rather than an independent regex.
  for (const key of routes.keys()) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    assert.equal(r.key, key, `classify normalized ${key} -> ${r.key} (normalizer divergence)`);
  }
});

test('surface guard: matchRoute resolves via the same Map object classify reads (M3)', () => {
  // routeKeyFor(...) must return a key present in the very Map this test holds,
  // and matchRoute must resolve to that Map's handler — i.e. one choke point.
  // Spot-check across parameterized + exact routes.
  const samples = [
    ['GET', '/api/contacts/abc-123', 'GET /api/contacts/:id'],
    ['POST', '/api/webhooks/anything', 'POST /api/webhooks/:source'],
    ['GET', '/api/sign/tok123', 'GET /api/sign/:token'],
    ['GET', '/api/health', 'GET /api/health'],
  ];
  for (const [m, p, expectedKey] of samples) {
    assert.equal(routeKeyFor(m, p), expectedKey, `routeKeyFor(${m},${p})`);
    assert.equal(
      matchRoute(m, p),
      routes.get(expectedKey),
      `matchRoute(${m},${p}) must be the handler registered under ${expectedKey}`,
    );
    // classify must normalize to the SAME key.
    assert.equal(classify(m, p).key, expectedKey);
  }
  // The live HTTP surface-diff (SSE / upgrade / raw listeners registered off the
  // routes Map vs the classified set) is covered by route-tier-surface-diff.test.js
  // (STAQPRO-598). This file covers the routes Map — the single dispatch choke point.
});

test('no route resolves via:prefix to the most-restrictive viewer-scoped tier (STAQPRO-597)', () => {
  // STAQPRO-597 tightening: a route landing on viewer-scoped (== DEFAULT_TIER,
  // the most-restrictive fail-closed tier) MUST be an explicit, handler-vetted
  // decision (via:'exception'), never an inheritance of a broad family prefix
  // rule (via:'prefix'). The viewer-scoped family prefix rules remain as a
  // fail-closed backstop for NEW routes, but CI now forces every existing
  // viewer-scoped route to carry its own exception — so "the most-restrictive
  // default silently caught it" can't recur for the routes 600 will enforce on.
  const prefixViewer = [];
  for (const key of routes.keys()) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    if (r.via === 'prefix' && r.tier === DEFAULT_TIER) prefixViewer.push(key);
  }
  assert.equal(
    prefixViewer.length,
    0,
    `These routes inherit the most-restrictive '${DEFAULT_TIER}' tier from a family ` +
      `prefix rule instead of an explicit exception. Add a per-route entry to ` +
      `EXCEPTIONS in src/route-tiers.js (STAQPRO-597):\n  ${prefixViewer.join('\n  ')}`,
  );
});

test('the STAQPRO-597 viewer-scoped routes are explicitly classified (via:exception)', () => {
  // Spot-anchor a representative slice of the 57 reclassified routes so a future
  // refactor that drops the explicit exceptions (re-introducing prefix reliance)
  // fails here with a clear pointer, not just in the aggregate guard above.
  const mustBeExplicit = [
    'GET /api/meetings',
    'GET /api/voice-prints',
    'POST /api/drafts/approve',
    'POST /api/contacts/merge',
    'GET /api/calendar/day',
    'POST /api/signals',
  ];
  for (const key of mustBeExplicit) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    assert.equal(r.via, 'exception', `${key} must be an explicit exception, got via:'${r.via}'`);
    assert.equal(r.tier, 'viewer-scoped', `${key} expected viewer-scoped, got '${r.tier}'`);
  }
});

test('/api/runs family is org-shared (STAQPRO-597 — reads work_items.owner_org_id)', () => {
  for (const key of ['GET /api/runs', 'GET /api/runs/tree', 'GET /api/runs/activity', 'GET /api/runs/transitions']) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    assert.equal(r.tier, 'org-shared', `${key} expected org-shared, got '${r.tier}'`);
    assert.equal(r.via, 'exception', `${key} must be an explicit exception, got via:'${r.via}'`);
    assert.equal(r.scope, 'org', `${key} expected scope=org`);
  }
});

test('classification distribution is sane (M6 metrics snapshot)', () => {
  const byTier = {};
  for (const key of routes.keys()) {
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
  }
  // Every named tier must be represented (the taxonomy isn't dead weight) except
  // we only hard-assert the security-critical ones exist.
  assert.ok(byTier['admin'] > 0, 'expected some admin (board-only) routes');
  assert.ok(byTier['viewer-scoped'] > 0, 'expected some viewer-scoped routes');
  assert.ok(byTier['public'] > 0, 'expected some public routes');
  assert.ok(byTier['webhook-authed'] > 0, 'expected some webhook-authed routes');
  assert.ok(byTier['public-signing'] > 0, 'expected some public-signing routes');
});
