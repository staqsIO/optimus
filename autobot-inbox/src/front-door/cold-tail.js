/**
 * Feature 008 Phase 1.5 — templated cold-tail generation.
 *
 * On a serve-by-match MISS, build an intent page payload INLINE (<2s, ~$0)
 * instead of falling through to the 5–8 min / $2.31 full-redesign pipeline:
 *
 *   rate gates → G8 screen → match products (cached catalog) →
 *   assemble BARE payload from CATALOG VOCABULARY ONLY → respond
 *   → fire-and-forget write-through as publish_status='unlisted'
 *
 * Design verdicts baked in (Liotta + Linus pre-impl review, 2026-06-10):
 *   - NO LLM on the hot path. The only load-bearing field is the matched
 *     product list; headline/CTA come from the matched collection. Raw intent
 *     text is NEVER echoed into the published page or the URL — even a G8
 *     false-negative cannot surface attacker text (injection surface removed
 *     by construction). LLM copy is a possible later async enrichment (P5).
 *   - Cold-tail rows are 'unlisted': servable by DIRECT slug (the returned
 *     link works immediately) but NEVER in the serve-by-match pool or list
 *     API until the board promotes them — one caller's intent can never shape
 *     pages served to future organic visitors (corpus-poisoning fix).
 *   - Slug = <collection-handle>-<8-char sha256(normalized intent)>: zero
 *     intent tokens on the brand domain; identical intents converge to one
 *     row, distinct intents cannot collide.
 *   - Write-through is AWAITED and a URL is returned ONLY when the row is
 *     live (originally fire-and-forget: the redirect raced the INSERT → 404
 *     → poisoned ISR cache; and never-persisted serves got guaranteed-dead
 *     links). ON CONFLICT DO NOTHING — seed rows are immutable to this path.
 *     Persist is skipped when the embedder is down (a row without an
 *     embedding could never properly serve the match pool anyway).
 *   - Rate gates run BEFORE any embedding/LLM work: in-memory per-IP window
 *     (single-instance API, mirrors beaconWindow precedent) + DB-backed
 *     global daily cap on cold_tail row creation.
 *
 * Flag: FRONT_DOOR_COLDTAIL (default OFF, read at call time).
 * Env:  FRONT_DOOR_CATALOG_HOSTS — JSON site_host→catalog_host map for
 *       headless storefronts (e.g. {"altitudeguitar.com":"altitudeguitar.myshopify.com"}).
 */

import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { screenRedesignInput, REDESIGN_SAFETY_VERSION } from '../../../lib/runtime/redesign-safety.js';
import { embedOne, embedMany } from '../../../lib/rag/embedder.js';
import { catalogFromShopify, dedupeAndCap } from '../../../lib/scrapers/product-catalog.js';
import { normalizePayload, cleanText, SLUG_RE } from './payload.js';
import { enrichColdTail } from './enrich.js';

const AGENT_ID = 'front-door-coldtail';
const TOP_N = 6;
// Minimum best-match score to PERSIST a cold-tail row (deny-by-default corpus
// growth — junk/garbage intents are served a one-shot page but never minted).
// Embedding cosine scale; when the matcher ran unranked (no embedder) we skip
// persistence entirely, so this floor only ever applies to ranked output.
export const PERSIST_SCORE_FLOOR = 0.35;
const CATALOG_TTL_MS = 15 * 60 * 1000;
const CATALOG_CAP = 250;

// Per-IP hourly window (flood bound; the LRU cap + global cap are the real
// abuse backstops). In-memory is correct for the single-instance API — same
// reasoning as beaconWindow in front-door-api.js (P4).
const IP_MAX_PER_HOUR = 30;
const ipWindow = { startedAt: 0, counts: new Map() };
// Global daily cap is DB-backed (Linus: survives restarts, exact): cold_tail
// rows created in the last 24h.
const GLOBAL_MAX_PER_DAY = 100;
// Per-site ceiling on auto entries; oldest evicted on overflow.
const PER_SITE_CAP = 200;

// Product relevance cutoff (Eric, 2026-06-10: one real baritone in stock but
// the page padded to 6 — weak matches are worse than a short honest list).
// Cosine GAPS cannot separate signal from padding here: live measurement put
// a wah pedal 0.011 from the true baritone (all music gear compresses into a
// ~0.43 band on text-embedding-3-small). What discriminates is token RARITY:
// an intent token matching few catalog products ("baritone", 1/246) is the
// buyer's actual constraint; one matching most of it ("guitar") is noise.
// Keep the top embedding match always + any product containing at least one
// rare intent token. Intents with no rare tokens ("electric guitar") keep
// their whole embedding cluster — correctly generic.
const RARE_TOKEN_DF_RATIO = 0.5; // token is "rare" when in ≤ half the catalog

// Second cutoff, ANDed with the rare-token filter (Claude field test,
// 2026-06-12): a rare token can ACCIDENTALLY match drift — "burst" let an
// Xotic pedal (0.489) ride a Les Paul reissue query whose top match scored
// 0.570. Live measurement shows brand/model intents DO carry a usable
// RELATIVE gap (cross-brand/category drift lands at 75–86% of the top score;
// true siblings at 92–97%), so products after rank-1 must also score ≥ 88%
// of the top match. The near-band cases a ratio can't separate (wah 0.011
// from baritone, above) are exactly what the rare-token filter handles.
const RELATIVE_SCORE_FLOOR = 0.88;

export function coldTailEnabled() {
  const v = (process.env.FRONT_DOOR_COLDTAIL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function ipAllowed(ip, now = Date.now()) {
  if (now - ipWindow.startedAt > 60 * 60 * 1000) {
    ipWindow.startedAt = now;
    ipWindow.counts.clear();
  }
  const n = (ipWindow.counts.get(ip) || 0) + 1;
  ipWindow.counts.set(ip, n);
  return n <= IP_MAX_PER_HOUR;
}

// ── catalog + collections cache (in-memory TTL; losing it costs one scrape) ──

const catalogCache = new Map(); // site_host → { products, collections, fetchedAt }

function catalogHostFor(siteHost) {
  try {
    const map = JSON.parse(process.env.FRONT_DOOR_CATALOG_HOSTS || '{}');
    return (map && typeof map === 'object' && map[siteHost]) || siteHost;
  } catch {
    return siteHost;
  }
}

async function fetchCollections(host) {
  try {
    const res = await fetch(`https://${host}/collections.json?limit=250`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'STAQS-FrontDoor/1.0', Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.collections || []).map((c) => ({ handle: c.handle, title: c.title }));
  } catch {
    return [];
  }
}

async function getSiteCatalog(siteHost, deps) {
  const now = Date.now();
  const hit = catalogCache.get(siteHost);
  if (hit && now - hit.fetchedAt < CATALOG_TTL_MS) return hit;
  const host = catalogHostFor(siteHost);
  const origin = `https://${host}`;
  const raw = await (deps._catalogFromShopify || catalogFromShopify)(origin);
  // In-stock only: a shopping intent page padded with SOLD one-offs fails the
  // shopper (Claude field test, 2026-06-10). Sources without availability
  // data default available:true.
  const products = raw.length
    ? dedupeAndCap(raw, origin, CATALOG_CAP).filter((p) => p.available !== false)
    : [];
  const collections = await (deps._fetchCollections || fetchCollections)(host);
  // Embed the catalog ONCE per cache fill (the warm-path latency fix: live
  // verification showed re-embedding ~250 products per request cost ~5-7s/req;
  // with vectors cached, a warm request embeds only the intent — ~1 API call).
  // vectors[i] may be null (per-item embed failure) — those rank last.
  let vectors = null;
  if (products.length) {
    try {
      vectors = await (deps._embedMany || embedMany)(products.map(productText));
    } catch {
      vectors = null; // embedder down → unranked fallback per request
    }
  }
  // Per-product token sets + token document frequency, computed once per
  // cache fill — powers the rare-token relevance cutoff at request time.
  // Token sets ride on the product objects so ranked copies keep them.
  const tokenDf = new Map();
  for (const p of products) {
    p._tokens = tokenize(productText(p));
    for (const t of p._tokens) tokenDf.set(t, (tokenDf.get(t) || 0) + 1);
  }
  const entry = { products, collections, vectors, tokenDf, fetchedAt: now };
  catalogCache.set(siteHost, entry);
  return entry;
}

// Mirrors intent-matcher's productText (agents/executor-redesign/intent-matcher.js)
// so cached vectors rank identically to matchProductsToIntent.
function productText(p) {
  return [p.title, p.description, p.category].filter(Boolean).join('. ').slice(0, 1000);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank cached-catalog products against an intent using the cache's
 * precomputed vectors — one embedOne call per request instead of re-embedding
 * the whole catalog (matchProductsToIntent semantics, warm-path speed).
 */
async function rankCachedProducts(intent, entry, { topN }, deps) {
  const intentVec = await (deps._embedOne || embedOne)(intent);
  if (!intentVec || !entry.vectors) {
    // Same graceful fallback as matchProductsToIntent: unranked candidates.
    return { matched: entry.products.slice(0, topN).map((p) => ({ ...p, score: null })), ranked: false };
  }
  const scored = entry.products
    .map((p, i) => ({ ...p, score: cosine(intentVec, entry.vectors[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return { matched: scored, ranked: true };
}

// ── assembly helpers (catalog vocabulary only) ───────────────────────────────

function handleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[0] === 'products' && parts[1] ? parts[1] : null;
  } catch {
    return null;
  }
}

function tokenize(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

/**
 * Pick the collection that best describes the matched products — token
 * overlap between collection title/handle and the products' titles+categories,
 * with the intent's own tokens weighted double. The intent weighting exists
 * because product overlap alone TIES across sibling collections: "gibson
 * custom shop les paul" matched products from BOTH custom shops, "Fender
 * Custom Shop" and "Gibson Custom" tied 3–3 on product tokens, and catalog
 * order picked Fender (live mismatch, 2026-06-12). Intent tokens are used
 * for SCORING only — every output string stays catalog vocabulary.
 * Deterministic, $0; null when nothing overlaps.
 */
export function pickCollection(matched, collections, intent = '') {
  if (!collections.length || !matched.length) return null;
  const productTokens = new Set();
  for (const p of matched) {
    for (const t of tokenize(`${p.title} ${p.category || ''}`)) productTokens.add(t);
  }
  const intentTokens = tokenize(intent);
  let best = null;
  let bestScore = 0;
  for (const c of collections) {
    let score = 0;
    for (const t of tokenize(`${c.title} ${c.handle}`)) {
      if (productTokens.has(t)) score++;
      if (intentTokens.has(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Deterministic slug: collection handle (or 'intent') + intent digest. No intent tokens. */
export function coldTailSlug(intent, collection) {
  const normalized = String(intent).trim().toLowerCase().replace(/\s+/g, ' ');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  let base = collection?.handle && SLUG_RE.test(collection.handle) ? collection.handle : 'intent';
  base = base.slice(0, 70);
  return `${base}-${digest}`;
}

// ── main entry ───────────────────────────────────────────────────────────────

/**
 * Generate (and best-effort persist) a templated cold-tail payload.
 *
 * @param {object} args
 * @param {string} args.siteHost    - normalized site host (e.g. altitudeguitar.com)
 * @param {string} args.intent      - declared visitor intent (non-empty)
 * @param {string} args.requesterIp - for the per-IP window
 * @param {object} [deps]           - injectable for offline tests
 * @returns {Promise<{ ok:boolean, reason?:string, status?:number,
 *                     payload?:object, intentSlug?:string, url?:string,
 *                     persisted?:boolean }>}
 *
 * Never throws — any failure returns ok:false and the caller falls through to
 * existing behavior (strictly additive).
 */
export async function generateColdTail({ siteHost, intent, requesterIp }, deps = {}) {
  const _query = deps._query || query;
  try {
    // 1. Rate gates BEFORE any embedding/LLM work.
    if (!ipAllowed(requesterIp || 'unknown', deps._now)) {
      return { ok: false, reason: 'rate-limited-ip', status: 429 };
    }
    const capRes = await _query(
      `SELECT count(*)::int AS n FROM content.front_door_corpus
        WHERE source = 'cold_tail' AND created_at > now() - interval '24 hours'`
    );
    if ((capRes.rows[0]?.n || 0) >= GLOBAL_MAX_PER_DAY) {
      return { ok: false, reason: 'rate-limited-global', status: 429 };
    }

    // 2. G8 inbound screen (fail-closed). Gates the match query — the OUTPUT
    // can't contain intent text regardless (catalog vocabulary only).
    const screen = await (deps._screen || screenRedesignInput)(intent, AGENT_ID, {
      label: 'cold-tail intent',
    });
    if (!screen.ok) return { ok: false, reason: screen.reason, status: 400 };

    // 3. Catalog (cached, vectors precomputed) + 4. product match.
    const entry = await getSiteCatalog(siteHost, deps);
    const { products: catalog, collections } = entry;
    if (catalog.length === 0) return { ok: false, reason: 'no-catalog' };
    const { matched, ranked } = deps._match
      ? await deps._match(intent, catalog, { topN: TOP_N })
      : await rankCachedProducts(intent, entry, { topN: TOP_N }, deps);
    if (!ranked) {
      // Embedder down → do NOT serve catalog-order products as if they
      // matched. A live agent (2026-06-12) got the same wrong-brand
      // collection for EVERY intent during an embedder outage — the
      // "graceful" unranked page reads as a confident match and fails the
      // shopper. Falling through to queued live generation (bounded by the
      // route's per-IP/global caps) is honest: ag-webapp surfaces it as
      // 202 {status:"generating"}.
      console.warn('[cold-tail] embedder unavailable — refusing unranked serve, falling through');
      return { ok: false, reason: 'embedder-unavailable' };
    }
    const allHandles = matched
      .map((p) => ({ ...p, handle: handleFromUrl(p.url) }))
      .filter((p) => p.handle);
    if (allHandles.length === 0) return { ok: false, reason: 'no-matchable-products' };

    // Relevance cutoffs (see RARE_TOKEN_DF_RATIO + RELATIVE_SCORE_FLOOR
    // notes). The top embedding match always stays; others must clear the
    // relative score floor AND (when the intent has rare tokens) contain at
    // least one rare intent token. No rare tokens → the floor alone applies.
    const dfCap = Math.max(1, catalog.length * RARE_TOKEN_DF_RATIO);
    const rareTokens = [...tokenize(intent)].filter(
      (t) => (entry.tokenDf?.get(t) || 0) > 0 && (entry.tokenDf?.get(t) || 0) <= dfCap
    );
    const topScore = ranked ? allHandles[0].score ?? 0 : 0;
    const withHandles = allHandles.filter((p, i) => {
      if (i === 0) return true;
      if (ranked && topScore > 0 && (p.score ?? 0) < topScore * RELATIVE_SCORE_FLOOR) return false;
      if (rareTokens.length === 0) return true;
      const ptokens = p._tokens || tokenize(productText(p));
      return rareTokens.some((t) => ptokens.has(t));
    });

    // 5. Bare payload — catalog vocabulary only; intent never echoed.
    const collection = pickCollection(withHandles, collections, intent);
    const slug = coldTailSlug(intent, collection);
    const headline =
      cleanText(collection?.title, 120) ||
      cleanText(withHandles[0].category, 120) ||
      'Picked for you';
    const candidate = {
      headline,
      subhead: '',
      sections: [],
      products: withHandles.map((p) => ({
        handle: p.handle, title: p.title, reason: '', score: p.score ?? null,
      })),
      faq: [],
      cta: collection ? { label: 'Shop the collection', collection_handle: collection.handle } : null,
    };
    const payload = normalizePayload(
      candidate, slug, new Set(withHandles.map((p) => p.handle)), collections
    );
    if (!payload) return { ok: false, reason: 'payload-validation-failed' };

    // 6/7. Write-through — AWAITED before the URL is returned. This was
    // fire-and-forget originally, but the redirect could land on
    // /intent/<slug> before the INSERT committed → 404, which on-demand ISR
    // then caches for an hour (dead-link race, hit live by a Claude agent
    // 2026-06-10). The ~300-600ms persist cost is the price of a link that
    // is guaranteed live. Only ranked matches above the floor persist; the
    // payload itself is served regardless — but a URL is returned ONLY when
    // the row exists (a /intent link for a never-persisted slug is a
    // guaranteed 404).
    const bestScore = ranked ? (withHandles[0].score ?? 0) : null;
    const shouldPersist = ranked && bestScore >= PERSIST_SCORE_FLOOR;
    let persisted = false;
    if (shouldPersist) {
      const persist = async () => {
        const embedding = await (deps._embedOne || embedOne)(intent);
        if (!embedding) return false; // embedder down → row could never serve matching
        // Tenancy stamp comes from the site's existing (seeded) corpus rows —
        // a site with no seeded corpus has no org on record, so we don't mint
        // rows for it (deny-by-default; the one-shot page was still served).
        const orgRes = await _query(
          `SELECT owner_org_id FROM content.front_door_corpus
            WHERE site_host = $1 ORDER BY created_at ASC LIMIT 1`,
          [siteHost]
        );
        const ownerOrgId = orgRes.rows[0]?.owner_org_id;
        if (!ownerOrgId) return false;
        await _query(
          `INSERT INTO content.front_door_corpus
             (owner_org_id, site_host, intent_slug, intent_text, intent_variants,
              intent_embedding, payload, catalog_hash, safety_version,
              publish_status, source, model, generation_cost_usd)
           VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6, $7, $8, 'unlisted', 'cold_tail', NULL, 0)
           ON CONFLICT (site_host, intent_slug) DO NOTHING`,
          [
            ownerOrgId, siteHost, slug, cleanText(intent, 300),
            JSON.stringify(embedding), JSON.stringify(payload),
            null, REDESIGN_SAFETY_VERSION,
          ]
        );
        // Per-site cap: evict oldest cold_tail rows beyond the ceiling.
        await _query(
          `DELETE FROM content.front_door_corpus
            WHERE id IN (
              SELECT id FROM content.front_door_corpus
               WHERE site_host = $1 AND source = 'cold_tail'
               ORDER BY updated_at DESC OFFSET $2)`,
          [siteHost, PER_SITE_CAP]
        );
        // ON CONFLICT DO NOTHING: insert OR pre-existing row — either way the
        // /intent/<slug> link is live.
        return true;
      };
      try {
        persisted = (await persist()) === true;
      } catch (err) {
        console.warn(`[cold-tail] write-through failed for ${slug}: ${err.message}`);
      }
      if (persisted) {
        // Async copy upgrade (intent-matched headline/subhead/reasons via
        // Haiku) — strictly off the serving path; idempotent via
        // payload.enriched_at; page revalidates when it lands.
        const enrichPromise = enrichColdTail({ siteHost, slug, intent, collection }, deps)
          .catch((err) => console.warn(`[cold-tail] enrich failed for ${slug}: ${err.message}`));
        if (deps._awaitEnrich) await enrichPromise; // tests only
      }
    }

    return {
      ok: true,
      payload,
      intentSlug: slug,
      // A URL is only handed out when the row is live — never a dead link.
      url: persisted ? `https://${siteHost}/intent/${slug}` : null,
      persisted,
    };
  } catch (err) {
    return { ok: false, reason: `cold-tail-error:${err.message}` };
  }
}

/** Test hook: reset in-memory state. */
export function _resetColdTailState() {
  ipWindow.startedAt = 0;
  ipWindow.counts.clear();
  catalogCache.clear();
}
