/**
 * Feature 008 Phase 1 — front-door public read API + visit beacon
 * (src/api-routes/front-door-api.js).
 *
 * Offline tests with an injected _query mock:
 *   - corpus list: site validation, published+current-safety scoping, shape
 *   - corpus slug: slug/site validation, 404 on miss, payload pass-through
 *   - visit beacon: field clamping (fail-closed 400s), insert shape,
 *     per-IP rate limit
 *   - route-tiers: /api/front-door/* classifies as 'public'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerFrontDoorRoutes, normalizeSiteParam } from '../src/api-routes/front-door-api.js';
import { REDESIGN_SAFETY_VERSION } from '../../lib/runtime/redesign-safety.js';

function makeRoutes(queryImpl) {
  const routes = new Map();
  const calls = [];
  registerFrontDoorRoutes(routes, {
    _query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl ? queryImpl(sql, params) : { rows: [] };
    },
  });
  return { routes, calls };
}

const fakeRes = () => {
  const headers = {};
  return { setHeader: (k, v) => { headers[k] = v; }, headers };
};

function visitBody(overrides = {}) {
  return {
    site: 'altitudeguitar.com',
    tier: 1,
    platform: 'chatgpt',
    visitor_kind: 'human',
    path: '/',
    ...overrides,
  };
}

// Distinct IP per test so the shared in-memory beacon window never collides.
let ipCounter = 0;
const reqFor = (url, ip = `10.0.0.${++ipCounter}`) => ({
  url,
  headers: { 'x-forwarded-for': ip },
});

test('normalizeSiteParam: lowercases, strips one www, rejects junk', () => {
  assert.equal(normalizeSiteParam('WWW.AltitudeGuitar.com'), 'altitudeguitar.com');
  assert.equal(normalizeSiteParam('shop.example.com'), 'shop.example.com');
  assert.equal(normalizeSiteParam('not a host!'), null);
  assert.equal(normalizeSiteParam(''), null);
  assert.equal(normalizeSiteParam(undefined), null);
});

test('registers exactly the three front-door routes', () => {
  const { routes } = makeRoutes();
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      'GET /api/front-door/corpus',
      'GET /api/front-door/corpus/:slug',
      'POST /api/front-door/visit',
    ]
  );
});

test('corpus list: requires site param', async () => {
  const { routes } = makeRoutes();
  const handler = routes.get('GET /api/front-door/corpus');
  await assert.rejects(
    () => handler(reqFor('/api/front-door/corpus'), null, fakeRes()),
    (err) => err.statusCode === 400
  );
});

test('corpus list: published+current-safety scoping, www stripped, cache header', async () => {
  const { routes, calls } = makeRoutes(() => ({
    rows: [{ intent_slug: 'best-beginner-acoustic-guitar', updated_at: 't1' }],
  }));
  const handler = routes.get('GET /api/front-door/corpus');
  const res = fakeRes();
  const out = await handler(reqFor('/api/front-door/corpus?site=www.AltitudeGuitar.com'), null, res);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /publish_status = 'published'/);
  assert.deepEqual(calls[0].params, ['altitudeguitar.com', REDESIGN_SAFETY_VERSION]);
  assert.deepEqual(out, {
    site: 'altitudeguitar.com',
    entries: [{ intent_slug: 'best-beginner-acoustic-guitar', updated_at: 't1' }],
  });
  assert.match(res.headers['Cache-Control'], /s-maxage=300/);
});

test('corpus slug: invalid slug → 400, miss → 404, hit → payload', async () => {
  const row = {
    intent_slug: 'best-beginner-acoustic-guitar',
    intent_text: 'best beginner acoustic guitar',
    payload: { version: 1, headline: 'h' },
    publish_status: 'published',
    updated_at: 't1',
  };
  const { routes, calls } = makeRoutes((sql, params) =>
    params[1] === 'best-beginner-acoustic-guitar' ? { rows: [row] } : { rows: [] }
  );
  const handler = routes.get('GET /api/front-door/corpus/:slug');

  await assert.rejects(
    () => handler(reqFor('/api/front-door/corpus/NOT%20A%20SLUG?site=altitudeguitar.com'), null, fakeRes()),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => handler(reqFor('/api/front-door/corpus/unknown-slug?site=altitudeguitar.com'), null, fakeRes()),
    (err) => err.statusCode === 404
  );

  const out = await handler(
    reqFor('/api/front-door/corpus/best-beginner-acoustic-guitar?site=altitudeguitar.com'),
    null,
    fakeRes()
  );
  assert.equal(out.intent_slug, 'best-beginner-acoustic-guitar');
  assert.deepEqual(out.payload, { version: 1, headline: 'h' });
  assert.equal(out.publish_status, 'published'); // drives the frontend robots flip
  assert.match(calls.at(-1).sql, /publish_status IN \('published', 'unlisted'\)/);
  assert.deepEqual(calls.at(-1).params, [
    'altitudeguitar.com',
    'best-beginner-acoustic-guitar',
    REDESIGN_SAFETY_VERSION,
  ]);
});

test('visit beacon: valid body inserts clamped row', async () => {
  const { routes, calls } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  const out = await handler(
    reqFor('/api/front-door/visit'),
    visitBody({ served_intent_slug: 'best-beginner-acoustic-guitar', rewrite_applied: true })
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO content\.front_door_visits/);
  assert.deepEqual(calls[0].params, [
    'altitudeguitar.com', 1, 'chatgpt', 'human', '/',
    'best-beginner-acoustic-guitar', true, null,
  ]);
});

test('visit beacon: optional fields default to null/false', async () => {
  const { routes, calls } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  await handler(reqFor('/api/front-door/visit'), visitBody({ tier: 0, platform: 'direct' }));
  assert.deepEqual(calls[0].params, [
    'altitudeguitar.com', 0, 'direct', 'human', '/', null, false, null,
  ]);
});

test('visit beacon: captures user_agent from body, clamped to 512', async () => {
  const { routes, calls } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  await handler(reqFor('/api/front-door/visit'), visitBody({ ua: 'GPTBot/1.0 (+https://openai.com/gptbot)' }));
  assert.equal(calls[0].params[7], 'GPTBot/1.0 (+https://openai.com/gptbot)');

  // over-long UA is clamped to 512 (DB is VARCHAR(512); handler slices too)
  await handler(reqFor('/api/front-door/visit'), visitBody({ ua: 'x'.repeat(900) }));
  assert.equal(calls[1].params[7].length, 512);
});

test('visit beacon: malformed fields are 400s, nothing inserted', async () => {
  const { routes, calls } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  const bads = [
    visitBody({ site: 'nope nope' }),
    visitBody({ tier: 3 }),                              // declared tiers are Phase 2/3
    visitBody({ tier: 'x' }),
    visitBody({ platform: 'CH ATGPT!' }),
    visitBody({ visitor_kind: 'robot' }),
    visitBody({ path: 'no-leading-slash' }),
    visitBody({ served_intent_slug: 'Bad Slug!' }),
    {},
  ];
  for (const body of bads) {
    await assert.rejects(
      () => handler(reqFor('/api/front-door/visit'), body),
      (err) => err.statusCode === 400,
      `expected 400 for ${JSON.stringify(body)}`
    );
  }
  assert.equal(calls.length, 0);
});

test('visit beacon: path is length-clamped, not rejected', async () => {
  const { routes, calls } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  await handler(reqFor('/api/front-door/visit'), visitBody({ path: '/' + 'x'.repeat(2000) }));
  assert.equal(calls[0].params[4].length, 512);
});

test('visit beacon: per-IP rate limit returns 429', async () => {
  const { routes } = makeRoutes();
  const handler = routes.get('POST /api/front-door/visit');
  const ip = '203.0.113.9';
  for (let i = 0; i < 600; i++) {
    await handler(reqFor('/api/front-door/visit', ip), visitBody());
  }
  await assert.rejects(
    () => handler(reqFor('/api/front-door/visit', ip), visitBody()),
    (err) => err.statusCode === 429
  );
});

test('route-tiers: /api/front-door/* classifies as public', async () => {
  const { PREFIX_RULES } = await import('../src/route-tiers.js');
  const tierFor = (m, p) => PREFIX_RULES.find((r) => r.test(m, p))?.tier || null;
  assert.equal(tierFor('GET', '/api/front-door/corpus'), 'public');
  assert.equal(tierFor('GET', '/api/front-door/corpus/:slug'), 'public');
  assert.equal(tierFor('POST', '/api/front-door/visit'), 'public');
});
