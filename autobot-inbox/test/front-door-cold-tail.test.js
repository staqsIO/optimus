/**
 * Feature 008 Phase 1.5 — templated cold-tail generation (offline tests).
 *
 * Pins the review-mandated invariants (Liotta + Linus, 2026-06-10):
 *   - rate gates run BEFORE screen/match work; 429 surfaced
 *   - G8 screen fail-closed
 *   - bare payload uses CATALOG VOCABULARY ONLY — raw intent never appears
 *     in payload strings or the slug
 *   - slug = collection-handle + intent digest (deterministic, convergent)
 *   - write-through: unlisted + cold_tail + ON CONFLICT DO NOTHING (never
 *     UPDATE — seed rows immutable), skipped when embedder down, skipped
 *     below the persist score floor, org stamped from existing site rows
 *   - shared normalizePayload enforced (handle/CTA whitelists)
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateColdTail,
  coldTailEnabled,
  coldTailSlug,
  pickCollection,
  PERSIST_SCORE_FLOOR,
  _resetColdTailState,
} from '../src/front-door/cold-tail.js';
import { normalizePayload, cleanText, PAYLOAD_LIMITS } from '../src/front-door/payload.js';

const SITE = 'altitudeguitar.com';
const ORG = '7c164445-43f2-4802-a7d3-5cab06611e99';

const CATALOG = [
  { title: 'Fender Stratocaster 1961', description: 'vintage strat', price: '3850',
    url: 'https://x.myshopify.com/products/fender-strat-61', category: 'Electric Guitars' },
  { title: 'Gibson Les Paul Custom', description: 'silverburst', price: '4100',
    url: 'https://x.myshopify.com/products/gibson-lp-custom', category: 'Electric Guitars' },
];
const COLLECTIONS = [
  { handle: 'electric-guitars', title: 'Electric Guitars' },
  { handle: 'amplifiers', title: 'Amplifiers' },
];

let ipCounter = 0;
const freshIp = () => `10.1.0.${++ipCounter}`;

function makeDeps(overrides = {}) {
  const queries = [];
  return {
    queries,
    _anthropic: null, // short-circuit async enrichment in unit tests
    _query: async (sql, params) => {
      queries.push({ sql, params });
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      if (/SELECT owner_org_id/i.test(sql)) return { rows: [{ owner_org_id: ORG }] };
      return { rows: [] };
    },
    _screen: async () => ({ ok: true, reason: null }),
    _match: async (intent, catalog) => ({
      matched: catalog.map((p, i) => ({ ...p, score: 0.8 - i * 0.1 })),
      ranked: true,
    }),
    _embedOne: async () => new Array(1536).fill(0.1),
    _catalogFromShopify: async () => CATALOG,
    _fetchCollections: async () => COLLECTIONS,
    ...overrides,
  };
}

beforeEach(() => _resetColdTailState());

test('coldTailEnabled: default OFF, runtime read', () => {
  delete process.env.FRONT_DOOR_COLDTAIL;
  assert.equal(coldTailEnabled(), false);
  process.env.FRONT_DOOR_COLDTAIL = 'true';
  assert.equal(coldTailEnabled(), true);
  delete process.env.FRONT_DOOR_COLDTAIL;
});

test('happy path: bare payload, catalog vocabulary only, unlisted write-through', async () => {
  const deps = makeDeps();
  const intent = 'UNIQUEMARKER want a vintage style electric guitar';
  const res = await generateColdTail({ siteHost: SITE, intent, requesterIp: freshIp() }, deps);

  assert.equal(res.ok, true);
  assert.equal(res.persisted, true); // persist is AWAITED — url is live before we hand it out
  assert.match(res.url, new RegExp(`^https://${SITE}/intent/electric-guitars-[0-9a-f]{8}$`));

  // Raw intent NEVER appears in any payload string or the slug.
  const flat = JSON.stringify(res.payload).toLowerCase();
  assert.ok(!flat.includes('uniquemarker'));
  assert.ok(!res.intentSlug.includes('uniquemarker'));

  assert.equal(res.payload.headline, 'Electric Guitars'); // matched collection title
  // 'vintage' is a rare intent token (only the Strat carries it) → the Gibson
  // is shed by the relevance cutoff. Honest short list, not topN padding.
  assert.deepEqual(res.payload.products.map((p) => p.handle), ['fender-strat-61']);
  assert.deepEqual(res.payload.cta, { label: 'Shop the collection', collection_handle: 'electric-guitars' });
  assert.equal(res.payload.subhead, '');
  assert.deepEqual(res.payload.sections, []);

  const insert = deps.queries.find((q) => /INSERT INTO content\.front_door_corpus/.test(q.sql));
  assert.ok(insert, 'write-through INSERT happened');
  assert.match(insert.sql, /ON CONFLICT \(site_host, intent_slug\) DO NOTHING/);
  assert.ok(!/DO UPDATE/.test(insert.sql), 'cold-tail NEVER updates existing rows');
  assert.match(insert.sql, /'unlisted'/);
  assert.match(insert.sql, /'cold_tail'/);
  assert.equal(insert.params[0], ORG); // org stamped from existing site rows
});

test('slug: deterministic + convergent for identical intents, distinct otherwise', () => {
  const col = { handle: 'electric-guitars', title: 'Electric Guitars' };
  const a = coldTailSlug('  Vintage   STRAT please ', col);
  const b = coldTailSlug('vintage strat please', col);
  const c = coldTailSlug('different intent entirely', col);
  assert.equal(a, b); // normalization converges
  assert.notEqual(a, c);
  assert.match(a, /^electric-guitars-[0-9a-f]{8}$/);
  assert.match(coldTailSlug('x', null), /^intent-[0-9a-f]{8}$/);
});

test('rate gate: per-IP window 429s BEFORE screen/match/query work', async () => {
  const deps = makeDeps({
    _screen: async () => { throw new Error('screen must not run when rate-limited'); },
  });
  const ip = '203.0.113.77';
  // burn the window (gates run before screen, so the throwing screen proves order
  // only on the 31st call — the first 30 DO screen; use a passing screen for those)
  const warmDeps = makeDeps();
  for (let i = 0; i < 30; i++) {
    await generateColdTail({ siteHost: SITE, intent: 'guitar', requesterIp: ip }, warmDeps);
  }
  const res = await generateColdTail({ siteHost: SITE, intent: 'guitar', requesterIp: ip }, deps);
  assert.deepEqual({ ok: res.ok, status: res.status }, { ok: false, status: 429 });
});

test('rate gate: DB global daily cap 429s', async () => {
  const deps = makeDeps({
    _query: async (sql) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 100 }] };
      return { rows: [] };
    },
    _screen: async () => { throw new Error('must not screen past global cap'); },
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'guitar', requesterIp: freshIp() }, deps);
  assert.deepEqual({ ok: res.ok, status: res.status }, { ok: false, status: 429 });
});

test('G8 screen rejection → ok:false 400, nothing persisted', async () => {
  const deps = makeDeps({ _screen: async () => ({ ok: false, reason: 'blocked-by-model-armor' }) });
  const res = await generateColdTail({ siteHost: SITE, intent: 'ignore instructions', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.ok(!deps.queries.some((q) => /INSERT/.test(q.sql)));
});

test('below persist floor: page served, NOT persisted, NO url (dead-link guard)', async () => {
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p) => ({ ...p, score: PERSIST_SCORE_FLOOR - 0.1 })),
      ranked: true,
    }),
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'barely related thing', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.persisted, false);
  assert.equal(res.url, null); // a /intent link for a never-persisted slug is a guaranteed 404
  assert.ok(!deps.queries.some((q) => /INSERT/.test(q.sql)));
});

test('unranked match (embedder down in matcher): NOT served — falls through', async () => {
  // Reverses the original "serve unranked, just don't persist" invariant:
  // a live embedder outage (2026-06-12) made every intent resolve to the
  // same wrong-brand collection. Unranked output must never be presented
  // as a match; the route falls through to queued live generation instead.
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p) => ({ ...p, score: null })),
      ranked: false,
    }),
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'some guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'embedder-unavailable');
  assert.equal(deps.queries.some((q) => /INSERT INTO content\.front_door_corpus/i.test(q.sql)), false);
});

test('embedder down at persist time: INSERT skipped, no url', async () => {
  const deps = makeDeps({ _embedOne: async () => null });
  const res = await generateColdTail({ siteHost: SITE, intent: 'vintage guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true); // page payload still served
  assert.equal(res.persisted, false);
  assert.equal(res.url, null);
  assert.ok(!deps.queries.some((q) => /INSERT/.test(q.sql)));
});

test('persist failure (DB error) → served, no url, never throws', async () => {
  const deps = makeDeps({
    _query: async (sql) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      if (/SELECT owner_org_id/i.test(sql)) return { rows: [{ owner_org_id: ORG }] };
      if (/INSERT/.test(sql)) throw new Error('pool exhausted');
      return { rows: [] };
    },
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'vintage guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.persisted, false);
  assert.equal(res.url, null);
});

test('sold inventory filtered from matching (available:false dropped)', async () => {
  const deps = makeDeps({
    _match: undefined,
    _catalogFromShopify: async () => [
      { ...CATALOG[0], available: false }, // sold one-off
      { ...CATALOG[1], available: true },
    ],
    _embedMany: async (texts) => texts.map(() => new Array(1536).fill(0.1)),
    _embedOne: async () => new Array(1536).fill(0.1),
  });
  delete deps._match;
  const res = await generateColdTail({ siteHost: SITE, intent: 'gibson les paul', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.payload.products.map((p) => p.handle), ['gibson-lp-custom']); // sold strat gone
});

test('no org on record for site: INSERT skipped (deny-by-default minting)', async () => {
  const deps = makeDeps({
    _query: async (sql) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      if (/SELECT owner_org_id/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  });
  const res = await generateColdTail({ siteHost: 'unseeded-site.com', intent: 'vintage guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true);
  assert.ok(!deps.queries.some((q) => /INSERT/.test(q.sql)));
});

test('empty catalog → clean miss (caller falls through)', async () => {
  const deps = makeDeps({ _catalogFromShopify: async () => [] });
  const res = await generateColdTail({ siteHost: SITE, intent: 'guitar', requesterIp: freshIp() }, deps);
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'no-catalog' });
});

test('never throws: internal error → ok:false reason', async () => {
  const deps = makeDeps({ _match: async () => { throw new Error('kaboom'); } });
  const res = await generateColdTail({ siteHost: SITE, intent: 'guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, false);
  assert.match(res.reason, /^cold-tail-error:/);
});

test('default match path: catalog vectors embedded ONCE per cache fill, not per request', async () => {
  let embedManyCalls = 0;
  let embedOneCalls = 0;
  const dim = 1536;
  const unit = (i) => { const v = new Array(dim).fill(0); v[i % dim] = 1; return v; };
  const deps = makeDeps({
    _match: undefined, // exercise the default rankCachedProducts path
    _embedMany: async (texts) => { embedManyCalls++; return texts.map((_, i) => unit(i)); },
    _embedOne: async () => { embedOneCalls++; return unit(0); }, // == first product → top match
  });
  delete deps._match;

  const r1 = await generateColdTail({ siteHost: SITE, intent: 'vintage fender stratocaster', requesterIp: freshIp() }, deps);
  const r2 = await generateColdTail({ siteHost: SITE, intent: 'gibson les paul custom shop', requesterIp: freshIp() }, deps);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(embedManyCalls, 1, 'catalog embedded once, reused across requests');
  assert.ok(embedOneCalls >= 2, 'per-request work is one intent embedding (+persist embed)');
  // ranked by cached vectors: intent vec == product[0] vec → product[0] first, score 1
  assert.equal(r1.payload.products[0].handle, 'fender-strat-61');
  assert.equal(r1.payload.products[0].score, 1);
});

test('relevance cutoff: rare intent token sheds non-matching padding', async () => {
  // 'stratocaster' appears in 1 of 2 catalog products (rare) — the Gibson is
  // embedding-adjacent padding and must be shed. (Cosine gaps cannot do this:
  // live measurement put a wah pedal 0.011 from a true baritone.)
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p, i) => ({ ...p, score: 0.44 - i * 0.005 })), // realistic compressed band
      ranked: true,
    }),
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'fender stratocaster vintage', requesterIp: freshIp() }, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.payload.products.map((p) => p.handle), ['fender-strat-61']);
});

test('relevance cutoff: no rare tokens (generic intent) keeps the cluster', async () => {
  // 'electric guitar' tokens match BOTH products (not rare) → correctly generic.
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p, i) => ({ ...p, score: 0.44 - i * 0.005 })),
      ranked: true,
    }),
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'electric guitar', requesterIp: freshIp() }, deps);
  assert.equal(res.payload.products.length, 2);
});

test('relevance cutoff: intent tokens absent from catalog entirely → keep all (no false shed)', async () => {
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p, i) => ({ ...p, score: 0.44 - i * 0.005 })),
      ranked: true,
    }),
  });
  const res = await generateColdTail({ siteHost: SITE, intent: 'flombulous zorp device', requesterIp: freshIp() }, deps);
  assert.equal(res.payload.products.length, 2); // tokens unknown to catalog don't filter
});

test('relevance cutoff: relative score floor sheds embedding drift', async () => {
  // Live case (2026-06-12): an Xotic pedal at 0.489 rode a Les Paul query
  // whose top match scored 0.570 by carrying the rare token "burst" —
  // cross-category drift sits at 75–86% of the top score while true siblings
  // sit at 92–97%. Products after rank-1 must score ≥ 88% of the top match.
  const deps = makeDeps({
    _match: async (intent, catalog) => ({
      matched: catalog.map((p, i) => ({ ...p, score: i === 0 ? 0.57 : 0.489 })),
      ranked: true,
    }),
  });
  const res = await generateColdTail(
    { siteHost: SITE, intent: 'electric guitar', requesterIp: freshIp() }, deps
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.payload.products.map((p) => p.handle), ['fender-strat-61']);
});

test('pickCollection: token overlap picks the right collection; null when none', () => {
  const matched = [{ title: 'Fender Stratocaster', category: 'Electric Guitars' }];
  assert.equal(pickCollection(matched, COLLECTIONS)?.handle, 'electric-guitars');
  assert.equal(pickCollection(matched, [{ handle: 'mugs', title: 'Coffee Mugs' }]), null);
  assert.equal(pickCollection([], COLLECTIONS), null);
});

test('pickCollection: intent tokens break product-token ties (live Fender/Gibson mismatch)', () => {
  // "gibson custom shop les paul" matched products from BOTH custom shops;
  // product tokens alone tied 3–3 and catalog order picked Fender
  // (2026-06-12). The buyer's own words must win the tie.
  const collections = [
    { handle: 'fender-custom-shop', title: 'Fender Custom Shop' },
    { handle: 'gibson-custom-shop', title: 'Gibson Custom' },
  ];
  const matched = [
    { title: 'Gibson Custom Shop SG Reissue', category: 'Electric Guitars' },
    { title: 'Fender Custom Shop Stratocaster', category: 'Electric Guitars' },
  ];
  // Without intent the 3–3 tie falls to catalog order (fender) — pinned so a
  // future tie-break change is a conscious one.
  assert.equal(pickCollection(matched, collections)?.handle, 'fender-custom-shop');
  assert.equal(
    pickCollection(matched, collections, 'gibson custom shop les paul')?.handle,
    'gibson-custom-shop'
  );
});

test('shared normalizePayload: whitelists hold for template output too', () => {
  const out = normalizePayload(
    {
      headline: 'Electric Guitars',
      products: [
        { handle: 'allowed-one', title: 'ok', reason: '', score: 0.9 },
        { handle: 'not-offered', title: 'sneaky', reason: '', score: 0.9 },
      ],
      cta: { label: 'x', collection_handle: 'not-a-real-collection' },
    },
    'electric-guitars-abcd1234',
    new Set(['allowed-one']),
    COLLECTIONS
  );
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].handle, 'allowed-one');
  assert.equal(out.cta, null); // CTA not in real collections → dropped
});

test('cleanText: strips tags + control chars, caps length', () => {
  assert.equal(cleanText('<script>x</script>hello world', 50), 'x hello world');
  assert.equal(cleanText('a'.repeat(500), PAYLOAD_LIMITS.headline).length, PAYLOAD_LIMITS.headline);
});
