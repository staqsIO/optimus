/**
 * Feature 008 — async cold-tail copy enrichment (src/front-door/enrich.js).
 *
 * Offline tests pinning the review-mandated invariants:
 *   - LLM output can only re-describe: reasons whitelisted to existing
 *     handles; products never added/removed/reordered; strings sanitized
 *   - UPDATE guarded WHERE source='cold_tail' (seed rows untouchable)
 *   - idempotent via payload.enriched_at
 *   - LLM/no-key/bad-JSON failures bail without UPDATE, never throw
 *   - revalidate pinged with the page path
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichColdTail, mergeEnrichedCopy } from '../src/front-door/enrich.js';
import { PAYLOAD_LIMITS } from '../src/front-door/payload.js';

const SITE = 'altitudeguitar.com';
const SLUG = 'music-man-d92b463f';

function basePayload() {
  return {
    version: 1,
    intent_slug: SLUG,
    headline: 'Music Man',
    subhead: '',
    sections: [],
    products: [
      { handle: 'jp15-baritone', title: 'EBMM JP15 Baritone', reason: '', score: 0.6 },
      { handle: 'other-guitar', title: 'Some Guitar', reason: '', score: 0.55 },
    ],
    faq: [],
    cta: { label: 'Shop the collection', collection_handle: 'music-man' },
  };
}

function llmClient(copy) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(copy) }],
        usage: { input_tokens: 300, output_tokens: 120 },
      }),
    },
  };
}

function makeDeps({ payload = basePayload(), copy, fetchCalls = [], queries = [] } = {}) {
  return {
    queries,
    fetchCalls,
    _query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT payload/.test(sql)) return { rows: [{ payload }] };
      return { rows: [] };
    },
    _anthropic: copy === undefined ? null : llmClient(copy),
    _fetch: async (url, opts) => {
      fetchCalls.push({ url, body: opts?.body });
      return { ok: true, status: 200 };
    },
  };
}

test('mergeEnrichedCopy: whitelists handles, sanitizes, preserves structure', () => {
  const merged = mergeEnrichedCopy(
    basePayload(),
    {
      headline: '<b>Baritone Guitars</b> for Drop Tunings',
      subhead: 'Built for low-end clarity',
      products: [
        { handle: 'jp15-baritone', reason: 'Purpose-built 27.5" baritone scale' },
        { handle: 'invented-product', reason: 'should be dropped' },
      ],
    },
    '2026-06-10T18:00:00Z'
  );
  assert.equal(merged.headline, 'Baritone Guitars for Drop Tunings'); // tags stripped
  assert.equal(merged.subhead, 'Built for low-end clarity');
  assert.deepEqual(merged.products.map((p) => p.handle), ['jp15-baritone', 'other-guitar']); // order/membership untouched
  assert.equal(merged.products[0].reason, 'Purpose-built 27.5" baritone scale');
  assert.equal(merged.products[1].reason, ''); // invented handle dropped, target untouched
  assert.equal(merged.enriched_at, '2026-06-10T18:00:00Z');
  assert.equal(merged.cta.collection_handle, 'music-man'); // non-copy fields preserved
});

test('mergeEnrichedCopy: relevant:false prunes (shrink only, min 1, no reorder)', () => {
  const merged = mergeEnrichedCopy(
    basePayload(),
    {
      headline: 'Baritone Guitars',
      products: [
        { handle: 'jp15-baritone', reason: 'true baritone', relevant: true },
        { handle: 'other-guitar', reason: 'not a baritone', relevant: false },
      ],
    },
    't'
  );
  assert.deepEqual(merged.products.map((p) => p.handle), ['jp15-baritone']);

  // All flagged false → fail-safe keeps everything
  const allFlagged = mergeEnrichedCopy(
    basePayload(),
    { headline: 'x', products: [
      { handle: 'jp15-baritone', relevant: false },
      { handle: 'other-guitar', relevant: false },
    ] },
    't'
  );
  assert.equal(allFlagged.products.length, 2);

  // Flagging an invented handle does nothing
  const invented = mergeEnrichedCopy(
    basePayload(),
    { headline: 'x', products: [{ handle: 'not-real', relevant: false }] },
    't'
  );
  assert.equal(invented.products.length, 2);
});

test('mergeEnrichedCopy: caps lengths via shared limits', () => {
  const merged = mergeEnrichedCopy(basePayload(), { headline: 'x'.repeat(500) }, 't');
  assert.equal(merged.headline.length, PAYLOAD_LIMITS.headline);
});

test('enrich happy path: guarded UPDATE + revalidate ping', async () => {
  const deps = makeDeps({
    copy: {
      headline: 'Baritone Guitars for Drop Tunings',
      subhead: 'Low tunings, full clarity',
      products: [{ handle: 'jp15-baritone', reason: 'True baritone scale length' }],
    },
  });
  const res = await enrichColdTail(
    { siteHost: SITE, slug: SLUG, intent: 'baritone guitar for drop tunings', collection: { title: 'Music Man' } },
    deps
  );
  assert.equal(res.ok, true);
  assert.ok(res.costUsd > 0);

  const update = deps.queries.find((q) => /UPDATE content\.front_door_corpus/.test(q.sql));
  assert.ok(update, 'UPDATE ran');
  assert.match(update.sql, /source = 'cold_tail'/); // seed rows untouchable
  assert.ok(!/publish_status/.test(update.sql)); // never changes listing status
  const stored = JSON.parse(update.params[0]);
  assert.equal(stored.headline, 'Baritone Guitars for Drop Tunings');
  assert.ok(stored.enriched_at);

  assert.equal(deps.fetchCalls.length, 1);
  assert.match(deps.fetchCalls[0].url, /\/api\/revalidate$/);
  assert.equal(JSON.parse(deps.fetchCalls[0].body).path, `/intent/${SLUG}`);
});

test('idempotent: already-enriched row → no LLM, no UPDATE', async () => {
  const payload = { ...basePayload(), enriched_at: '2026-06-10T17:00:00Z' };
  const deps = makeDeps({ payload, copy: { headline: 'should not be used' } });
  const res = await enrichColdTail({ siteHost: SITE, slug: SLUG, intent: 'x', collection: null }, deps);
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'already-enriched' });
  assert.ok(!deps.queries.some((q) => /UPDATE/.test(q.sql)));
});

test('no API key: clean bail, no UPDATE', async () => {
  const deps = makeDeps(); // _anthropic: null
  const res = await enrichColdTail({ siteHost: SITE, slug: SLUG, intent: 'x', collection: null }, deps);
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'no-api-key' });
  assert.ok(!deps.queries.some((q) => /UPDATE/.test(q.sql)));
});

test('LLM bad JSON: clean bail, no UPDATE', async () => {
  const deps = makeDeps({ copy: 'ignored' });
  deps._anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json at all' }], usage: { input_tokens: 1, output_tokens: 1 } }) } };
  const res = await enrichColdTail({ siteHost: SITE, slug: SLUG, intent: 'x', collection: null }, deps);
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'llm-bad-json' });
  assert.ok(!deps.queries.some((q) => /UPDATE/.test(q.sql)));
});

test('LLM throws: never propagates', async () => {
  const deps = makeDeps({ copy: 'ignored' });
  deps._anthropic = { messages: { create: async () => { throw new Error('api down'); } } };
  const res = await enrichColdTail({ siteHost: SITE, slug: SLUG, intent: 'x', collection: null }, deps);
  assert.equal(res.ok, false);
  assert.match(res.reason, /^enrich-error:/);
});

test('row missing (evicted/unpersisted): clean bail', async () => {
  const deps = makeDeps({ copy: { headline: 'x' } });
  deps._query = async (sql) => { deps.queries.push({ sql }); return { rows: [] }; };
  const res = await enrichColdTail({ siteHost: SITE, slug: SLUG, intent: 'x', collection: null }, deps);
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'row-missing' });
});
