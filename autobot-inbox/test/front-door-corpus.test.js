/**
 * Feature 008 Phase 1 — serve-by-match corpus lookup (front-door-corpus.js).
 *
 * Pins the findCorpusMatch / resolveServeByMatch contract with injected
 * _query/_embedOne mocks, so these run offline in test:ci:
 *   - flag gating (default OFF, runtime read)
 *   - miss reasons: no-intent, bad-url, corpus-empty, below-threshold, corpus-error
 *   - embedding cosine path (threshold, no fall-through to keyword)
 *   - keyword Jaccard fallback when the embedder is unavailable
 *   - pgvector text-form parsing ('[0.1,…]' from pg)
 *   - payload/intentSlug pass-through; html null in Phase 1
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findCorpusMatch,
  resolveServeByMatch,
  serveByMatchEnabled,
  siteHostFromUrl,
  EMBED_THRESHOLD,
  KEYWORD_THRESHOLD,
} from '../src/api-routes/front-door-corpus.js';

const URL_AG = 'https://www.altitudeguitar.com/';

function row(overrides = {}) {
  return {
    id: 'corpus-row-1',
    intent_slug: 'best-beginner-acoustic-guitar',
    intent_text: 'best beginner acoustic guitar',
    intent_variants: ['good starter acoustic guitar', 'first acoustic guitar'],
    intent_embedding: null,
    payload: { version: 1, headline: 'Start playing today' },
    html: null,
    ...overrides,
  };
}

const queryReturning = (rows) => async () => ({ rows });
const queryThrowing = (code) => async () => {
  const err = new Error('relation does not exist');
  err.code = code;
  throw err;
};
const noEmbed = async () => null;

// Unit vectors for exact cosine control: e1·e1 = 1, e1·e2 = 0.
const dim = 1536;
const unit = (i) => {
  const v = new Array(dim).fill(0);
  v[i] = 1;
  return v;
};

test('serveByMatchEnabled: default OFF, runtime read', () => {
  delete process.env.FRONT_DOOR_SERVE_BY_MATCH;
  assert.equal(serveByMatchEnabled(), false);
  process.env.FRONT_DOOR_SERVE_BY_MATCH = 'true';
  assert.equal(serveByMatchEnabled(), true);
  process.env.FRONT_DOOR_SERVE_BY_MATCH = 'off';
  assert.equal(serveByMatchEnabled(), false);
  delete process.env.FRONT_DOOR_SERVE_BY_MATCH;
});

test('siteHostFromUrl: lowercases, strips one www, null on garbage', () => {
  assert.equal(siteHostFromUrl('https://WWW.AltitudeGuitar.com/x?y=1'), 'altitudeguitar.com');
  assert.equal(siteHostFromUrl('https://shop.example.com'), 'shop.example.com');
  assert.equal(siteHostFromUrl('not a url'), null);
});

test('resolveServeByMatch: flag off → serve:false flag-off, no lookup', async () => {
  delete process.env.FRONT_DOOR_SERVE_BY_MATCH;
  let queried = false;
  const res = await resolveServeByMatch(
    { url: URL_AG, intent: 'beginner guitar' },
    { _query: async () => { queried = true; return { rows: [] }; }, _embedOne: noEmbed }
  );
  assert.deepEqual(res, { serve: false, reason: 'flag-off' });
  assert.equal(queried, false);
});

test('findCorpusMatch: empty/whitespace intent → no-intent miss', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: '   ' },
    { _query: queryReturning([row()]), _embedOne: noEmbed }
  );
  assert.deepEqual(res, { hit: false, reason: 'no-intent' });
});

test('findCorpusMatch: unparseable url → bad-url miss', async () => {
  const res = await findCorpusMatch(
    { url: '::nope::', intent: 'beginner guitar' },
    { _query: queryReturning([row()]), _embedOne: noEmbed }
  );
  assert.deepEqual(res, { hit: false, reason: 'bad-url' });
});

test('findCorpusMatch: no published rows → corpus-empty miss', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'beginner guitar' },
    { _query: queryReturning([]), _embedOne: noEmbed }
  );
  assert.deepEqual(res, { hit: false, reason: 'corpus-empty' });
});

test('findCorpusMatch: query failure → miss, never throws', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'beginner guitar' },
    { _query: queryThrowing('42P01'), _embedOne: noEmbed }
  );
  assert.equal(res.hit, false);
  assert.match(res.reason, /^corpus-error:/);
});

test('findCorpusMatch: scopes query by site host and current safety version', async () => {
  let captured;
  await findCorpusMatch(
    { url: URL_AG, intent: 'beginner guitar' },
    {
      _query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; },
      _embedOne: noEmbed,
    }
  );
  assert.equal(captured.params[0], 'altitudeguitar.com'); // www stripped
  assert.equal(typeof captured.params[1], 'number');      // REDESIGN_SAFETY_VERSION
  assert.match(captured.sql, /publish_status = 'published'/);
});

test('embedding path: cosine >= threshold → hit with payload/slug, html null', async () => {
  const rows = [
    row({ id: 'a', intent_slug: 'electric', intent_embedding: unit(1) }),
    row({ id: 'b', intent_embedding: unit(0) }), // identical to query vec → cosine 1
  ];
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'best beginner acoustic guitar' },
    { _query: queryReturning(rows), _embedOne: async () => unit(0) }
  );
  assert.equal(res.hit, true);
  assert.equal(res.artifactId, 'b');
  assert.equal(res.intentSlug, 'best-beginner-acoustic-guitar');
  assert.equal(res.html, null);
  assert.deepEqual(res.payload, { version: 1, headline: 'Start playing today' });
  assert.ok(res.score >= EMBED_THRESHOLD);
});

test('embedding path: parses pgvector text form from pg', async () => {
  const rows = [row({ intent_embedding: JSON.stringify(unit(0)) })];
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'beginner acoustic' },
    { _query: queryReturning(rows), _embedOne: async () => unit(0) }
  );
  assert.equal(res.hit, true);
});

test('embedding path: below threshold → miss, does NOT fall through to keyword', async () => {
  // Orthogonal vectors (cosine 0) but intent_text would be a perfect keyword
  // match — the embedder's verdict must win.
  const rows = [row({ intent_text: 'best beginner acoustic guitar', intent_embedding: unit(1) })];
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'best beginner acoustic guitar' },
    { _query: queryReturning(rows), _embedOne: async () => unit(0) }
  );
  assert.deepEqual(res, { hit: false, reason: 'below-threshold' });
});

test('keyword fallback: embedder unavailable, Jaccard >= threshold → hit', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'best beginner acoustic guitar' },
    { _query: queryReturning([row()]), _embedOne: noEmbed }
  );
  assert.equal(res.hit, true);
  assert.equal(res.reason, 'corpus-hit');
  assert.ok(res.score >= KEYWORD_THRESHOLD);
});

test('keyword fallback: matches via intent_variants too', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'good starter acoustic guitar' },
    { _query: queryReturning([row({ intent_text: 'totally different phrase entirely' })]), _embedOne: noEmbed }
  );
  assert.equal(res.hit, true);
});

test('keyword fallback: unrelated intent → below-threshold miss', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'wholesale industrial plumbing fittings' },
    { _query: queryReturning([row()]), _embedOne: noEmbed }
  );
  assert.deepEqual(res, { hit: false, reason: 'below-threshold' });
});

test('keyword fallback: embedOne throwing is treated as unavailable', async () => {
  const res = await findCorpusMatch(
    { url: URL_AG, intent: 'best beginner acoustic guitar' },
    { _query: queryReturning([row()]), _embedOne: async () => { throw new Error('boom'); } }
  );
  assert.equal(res.hit, true); // keyword path took over
});

test('resolveServeByMatch: hit passes payload/intentSlug/html through', async () => {
  process.env.FRONT_DOOR_SERVE_BY_MATCH = '1';
  try {
    const res = await resolveServeByMatch(
      { url: URL_AG, intent: 'best beginner acoustic guitar' },
      { _query: queryReturning([row()]), _embedOne: noEmbed }
    );
    assert.equal(res.serve, true);
    assert.equal(res.artifactId, 'corpus-row-1');
    assert.equal(res.intentSlug, 'best-beginner-acoustic-guitar');
    assert.equal(res.html, null);
    assert.deepEqual(res.payload, { version: 1, headline: 'Start playing today' });
    assert.equal(res.reason, 'corpus-hit');
  } finally {
    delete process.env.FRONT_DOOR_SERVE_BY_MATCH;
  }
});

test('resolveServeByMatch: flag on but corpus miss → serve:false with reason', async () => {
  process.env.FRONT_DOOR_SERVE_BY_MATCH = '1';
  try {
    const res = await resolveServeByMatch(
      { url: URL_AG, intent: 'beginner guitar' },
      { _query: queryReturning([]), _embedOne: noEmbed }
    );
    assert.deepEqual(res, { serve: false, reason: 'corpus-empty' });
  } finally {
    delete process.env.FRONT_DOOR_SERVE_BY_MATCH;
  }
});
