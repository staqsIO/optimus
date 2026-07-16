// route-tier-surface-diff.test.js — STAQPRO-598 (ADR-014 M3 follow-up).
//
// THE "447th-ROUTE" GUARD — the SSE / upgrade surface-diff.
// ============================================================================
// route-tier-coverage.test.js already asserts every key in the live `routes`
// Map classifies non-`via:default`. That guarantees coverage of the dispatch
// table. This file closes the remaining gap that the coverage test's own TODO
// (route-tier-coverage.test.js, ADR-014 M3 follow-up) called out:
//
//   "diff the live HTTP surface — SSE / upgrade / raw listeners registered off
//    the routes Map — against the classified set."
//
// The risk STAQPRO-600 (the enforce flip) is exposed to: a route reachable over
// HTTP that the tier middleware never sees, because it was registered on a
// surface OTHER than the `routes` Map (a websocket `server.on('upgrade')`, a
// second dispatch path, an SSE stream wired off-Map). Such a route would skip
// the identity gate entirely when enforcement flips on — a silent hole.
//
// WHAT THIS GUARDS (three invariants):
//
//   (A) ANTI-BYPASS / single-choke-point (source guard): api.js dispatches
//       EVERY request through `matchRoute()` → the `routes` Map, and registers
//       NO parallel HTTP surface (`server.on('upgrade')`, a WebSocket server, a
//       second `createServer` handler with its own routing). If someone adds
//       one, the tier middleware no longer covers it — this test fails loudly so
//       the enforce flip is re-evaluated before the hole ships.
//
//   (B) SSE / streaming surface is classified (runtime walk): the long-lived
//       event-stream endpoints are the easiest to miss because they don't return
//       JSON and look "special". Every known streaming route that IS wired into
//       the live Map must classify to an EXPLICIT tier (never `via:default`), so
//       an SSE stream can never fall through to the bare fallback. Streaming
//       routes that are NOT currently wired are surfaced as a NOTE (not a
//       failure) — they carry no live HTTP surface to leak.
//
//   (C) Classifier ↔ live-route staleness (warn, not fail): every exact-match
//       EXCEPTION in the classifier should correspond to a live registered
//       route. A stale exception (route renamed/removed, exception left behind)
//       is dead config — warned here so it gets cleaned up, but not failed,
//       because an exception with no live route can't misroute live traffic.
//
// ENUMERATION STRATEGY: runtime walk of the live `routes` Map (the SAME object
// the dispatcher consults), normalized through the SAME routeKeyFor() — NOT a
// source regex. This is deliberate: the whole point is to catch drift a
// source-parse would miss. (A) additionally reads api.js source, but only to
// assert the ABSENCE of a parallel dispatch surface — a negative source guard,
// not a positive route enumeration.
//
// SKIP-GATE: importing the full app (api.js) transitively pulls heavy optional
// deps (docx, googleapis, @aws-sdk/client-s3 via lib/). In a deps-light env the
// import throws ERR_MODULE_NOT_FOUND; we self-skip with a clear note rather than
// fail collection (mirrors test/fuzz/tenant-isolation-fuzz.test.js PART 0). In
// CI (`test:ci`) the deps are installed and the import resolves, so the guard
// runs for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_SRC_PATH = join(__dirname, '..', 'src', 'api.js');

// Streaming / long-lived HTTP endpoints (text/event-stream). These are the
// "special" routes the surface-diff exists to police. Keys are canonical
// `METHOD /normalized-path`. A route here that is wired into the live Map MUST
// classify non-default; one that is NOT wired is reported as a NOTE.
//   - GET /api/events           : api.js dashboard SSE stream (pg_notify relay)
//   - GET /api/agent-activity   : agent-activity SSE relay (registerAgentActivitySSERoute;
//                                 currently NOT wired into the Map — surfaced as a NOTE)
//   - GET /api/public/events/feed : public archive event feed (JSON poll, not a
//                                 stream, but enumerated as an events surface for completeness)
const KNOWN_STREAMING_ROUTES = Object.freeze([
  'GET /api/events',
  'GET /api/agent-activity',
  'GET /api/public/events',
  'GET /api/public/events/feed',
]);

async function loadSurface() {
  // Dynamic import inside the test so a deps-light env self-skips instead of
  // failing collection. route-tiers.js imports routeKeyFor from api.js, so a
  // single api.js failure covers both modules.
  const api = await import('../src/api.js');
  const rt = await import('../src/route-tiers.js');
  return {
    routes: api.routes,
    routeKeyFor: api.routeKeyFor,
    classify: rt.classify,
    EXCEPTIONS: rt.EXCEPTIONS,
    DEFAULT_TIER: rt.DEFAULT_TIER,
    TIER_PRESETS: rt.TIER_PRESETS,
  };
}

function splitKey(key) {
  const sp = key.indexOf(' ');
  return { method: key.slice(0, sp), path: key.slice(sp + 1) };
}

// ── (A) Anti-bypass: the routes Map is the ONLY HTTP dispatch surface ─────────
// Pure source guard — no app import needed, so it runs even in a deps-light env.
test('anti-bypass: api.js registers no parallel HTTP dispatch surface (websocket/upgrade)', () => {
  const src = readFileSync(API_SRC_PATH, 'utf8');

  // A websocket / HTTP-upgrade listener would carry requests that NEVER pass
  // through matchRoute() → the tier middleware. Forbid it. If a real upgrade
  // surface is ever needed, it must be added to the classifier's enforcement
  // path and this guard updated deliberately (re-evaluate STAQPRO-600 first).
  const upgradeListener = /\.on\(\s*['"]upgrade['"]/;
  assert.ok(
    !upgradeListener.test(src),
    "api.js registered an 'upgrade' listener — websocket/upgrade requests bypass " +
      'the tier middleware (matchRoute is the only gated dispatch path). Route it ' +
      'through the routes Map + classifier, or update this guard with a tier decision ' +
      'for the upgrade surface (ADR-014 / STAQPRO-600 enforce flip).',
  );

  const wsServer = /new\s+(?:WebSocket\.Server|WebSocketServer|ws\.Server)\b/;
  assert.ok(
    !wsServer.test(src),
    'api.js instantiated a WebSocket server — its connections bypass the tier ' +
      'middleware. Gate it through the classifier or update this guard deliberately.',
  );

  // Exactly one createServer() invocation that takes a request handler — a second
  // server with its own handler would be a second, unclassified dispatch path.
  // Match `createServer(` only as a real call, ignoring the bare `import { … }`
  // and the `http.createServer` prose in comments (neither is an invocation that
  // passes a handler). We count `= createServer(` (the server is assigned) — the
  // canonical shape of an invocation here.
  const createServerCalls = (src.match(/=\s*createServer\s*\(/g) || []).length;
  assert.equal(
    createServerCalls,
    1,
    `api.js has ${createServerCalls} createServer(handler) call(s); expected exactly 1. A ` +
      'second HTTP server is a parallel dispatch surface the tier middleware does not cover.',
  );

  // The single dispatcher resolves handlers via matchRoute (the routes-Map choke
  // point). Assert it is actually used inside createServer — defends against a
  // refactor that swaps matchRoute for ad-hoc routing.
  assert.ok(
    /matchRoute\s*\(\s*req\.method\s*,/.test(src),
    'api.js dispatcher no longer resolves handlers via matchRoute(req.method, …) — ' +
      'the routes-Map single-choke-point invariant (ADR-014 M3) may be broken.',
  );
});

// ── (B) SSE / streaming surface is explicitly classified ─────────────────────
test('SSE/streaming surface: every wired streaming route classifies non-default', async () => {
  let S;
  try {
    S = await loadSurface();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(
      `[598-surface-diff] app import unavailable in this env (${e.code || e.message}); ` +
        'skipping SSE classification check (runs for real under test:ci).',
    );
    return;
  }
  const { routes, classify, DEFAULT_TIER, TIER_PRESETS } = S;

  const offMap = [];
  const offending = [];
  for (const key of KNOWN_STREAMING_ROUTES) {
    if (!routes.has(key)) {
      offMap.push(key);
      continue;
    }
    const { method, path } = splitKey(key);
    const r = classify(method, path);
    assert.ok(TIER_PRESETS[r.tier], `streaming route ${key} got unknown tier '${r.tier}'`);
    if (r.via === 'default') {
      offending.push(`${key} → tier=${r.tier} via=default`);
    }
  }

  // Not-wired streaming routes carry no live HTTP surface — report, don't fail.
  // (e.g. GET /api/agent-activity: registerAgentActivitySSERoute is exported but
  //  not invoked, so the route is not reachable; when it gets wired it must be
  //  classified — its prefix rule already covers it.)
  for (const key of offMap) {
    // eslint-disable-next-line no-console
    console.log(
      `[598-surface-diff] NOTE: streaming route ${key} is in the known set but not ` +
        'wired into the live routes Map (no live HTTP surface). Re-check when it is wired.',
    );
  }

  assert.deepEqual(
    offending,
    [],
    `These streaming/SSE routes fell to the bare '${DEFAULT_TIER}' default — an SSE ` +
      'stream must never skip explicit classification (it would bypass the identity ' +
      'gate when STAQPRO-600 flips enforcement). Add a prefix rule or exception in ' +
      'src/route-tiers.js:\n  ' +
      offending.join('\n  '),
  );

  // At least one streaming route must actually be wired — otherwise this guard is
  // vacuously green and the SSE surface silently disappeared.
  const wiredCount = KNOWN_STREAMING_ROUTES.filter((k) => routes.has(k)).length;
  assert.ok(
    wiredCount > 0,
    'No known streaming route is wired into the live Map — the SSE surface vanished ' +
      'or KNOWN_STREAMING_ROUTES drifted from production. Investigate before trusting green.',
  );
});

// ── (C) Classifier ↔ live-route staleness (warn, not fail) ────────────────────
test('staleness (warn): every classifier EXCEPTION maps to a live registered route', async () => {
  let S;
  try {
    S = await loadSurface();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(
      `[598-surface-diff] app import unavailable in this env (${e.code || e.message}); ` +
        'skipping staleness check.',
    );
    return;
  }
  const { routes, EXCEPTIONS } = S;

  const stale = Object.keys(EXCEPTIONS).filter((key) => !routes.has(key));
  if (stale.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[598-surface-diff] WARN: ${stale.length} classifier EXCEPTION(s) have no live ` +
        'route (stale config — route renamed/removed but exception left behind). Prune ' +
        'from src/route-tiers.js EXCEPTIONS:\n  ' +
        stale.join('\n  '),
    );
  }

  // Sanity: the live Map must actually be populated (proves the app loaded and
  // register*Routes() ran) so the warn-only check above isn't comparing against
  // an empty Map. This DOES fail — an empty Map means the surface broke.
  assert.ok(
    routes.size > 400,
    `expected the live routes Map to be fully populated (~447), got ${routes.size} — ` +
      'register*Routes() may not have run; staleness comparison would be meaningless.',
  );
});
