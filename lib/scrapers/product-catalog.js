import { createLogger } from '../logger.js';

const log = createLogger('scraper-catalog');

export const MAX_PRODUCTS = 60;
const TITLE_MAX = 200;
const DESC_MAX = 600;
const PRICE_MAX = 40;
const CATEGORY_MAX = 80;
const SHOPIFY_TIMEOUT_MS = 8_000;

/**
 * Per-product catalog extraction for intent-driven landing pages.
 *
 * Three best-effort sources, in coverage order:
 *   1. JSON-LD  — Product / ItemList / Offer blocks already parsed by the scraper
 *   2. Shopify  — <origin>/products.json (huge coverage; same-origin, already SSRF-validated)
 *   3. DOM      — product-card heuristics via Playwright page.evaluate
 *
 * Returns products[] = { title, description, price, image, url, category }.
 * Always best-effort: every source is independently try/caught so a bad shape
 * never breaks the redesign — a site with no catalog simply yields [].
 */

const cap = (s, n) =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '';

function absUrl(href, base) {
  if (!href || typeof href !== 'string') return null;
  try { return new URL(href, base).href; } catch { return null; }
}

function stripHtml(s) {
  return typeof s === 'string'
    ? s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ')
    : '';
}

function normalizeProduct(raw, baseUrl) {
  const title = cap(raw.title, TITLE_MAX);
  if (!title) return null;
  return {
    title,
    description: cap(stripHtml(raw.description), DESC_MAX),
    price: cap(raw.price != null ? String(raw.price) : '', PRICE_MAX),
    image: absUrl(raw.image, baseUrl),
    url: absUrl(raw.url, baseUrl),
    category: cap(raw.category, CATEGORY_MAX),
    // Only the Shopify source knows availability; other sources default true.
    // false = no purchasable variant (sold one-offs on vintage shops) — intent
    // matching skips these so shopping pages aren't padded with SOLD items.
    available: raw.available !== false,
  };
}

/**
 * Merge sources, drop dupes (by title, case-insensitive), cap the count.
 */
export function dedupeAndCap(products, baseUrl, max = MAX_PRODUCTS) {
  const seen = new Set();
  const out = [];
  for (const raw of products || []) {
    const p = normalizeProduct(raw, baseUrl);
    if (!p) continue;
    const key = p.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Source 1 — JSON-LD. Walks already-parsed ld+json blocks for Product nodes
 * (incl. @graph, ItemList → itemListElement, ListItem → item).
 */
export function catalogFromJsonLd(jsonLdBlocks, baseUrl) {
  const out = [];
  const MAX_DEPTH = 4; // real Product schema never nests deeper; bounds hostile/cyclic input
  const typesOf = (node) => {
    const t = node['@type'];
    return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x));
  };
  const walk = (node, depth) => {
    if (depth > MAX_DEPTH) return;
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth)); return; }
    if (typesOf(node).includes('Product')) {
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const img = Array.isArray(node.image) ? node.image[0] : node.image;
      out.push({
        title: node.name,
        description: typeof node.description === 'string' ? node.description : '',
        price: offer ? (offer.price ?? offer.lowPrice ?? '') : '',
        image: img && typeof img === 'object' ? (img.url || img.contentUrl) : img,
        url: node.url || offer?.url,
        category: typeof node.category === 'string' ? node.category : '',
      });
    }
    // Recurse into common container shapes (depth-bounded above)
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.itemListElement) walk(node.itemListElement, depth + 1);
    if (node.item) walk(node.item, depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
  };
  for (const block of jsonLdBlocks || []) {
    try { walk(block, 0); } catch { /* skip malformed block */ }
  }
  return out;
}

/**
 * Source 2 — Shopify. Same-origin /products.json (the origin was already
 * SSRF-validated upstream in scrapeForBrand → validateNotSSRF). fetchImpl is
 * injectable for testing.
 */
export async function catalogFromShopify(origin, fetchImpl = fetch) {
  const cleanOrigin = origin.replace(/\/$/, '');
  const url = `${cleanOrigin}/products.json?limit=250`;
  const fetchOpts = {
    signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    headers: {
      'User-Agent': 'STAQS-Redesign-Bot/1.0',
      Accept: 'application/json',
    },
  };
  try {
    // SSRF-safe: do NOT auto-follow redirects. The origin was SSRF-validated
    // upstream, but a redirect could point anywhere (internal IPs, metadata
    // endpoints). Allow at most ONE hop, and only to the SAME origin.
    let res = await fetchImpl(url, { ...fetchOpts, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      let dest = null;
      try { dest = loc ? new URL(loc, url) : null; } catch { dest = null; }
      if (!dest || dest.origin !== cleanOrigin) return []; // refuse cross-origin redirect
      res = await fetchImpl(dest.href, { ...fetchOpts, redirect: 'error' });
    }
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return []; // non-Shopify sites 200 with HTML
    const data = await res.json();
    if (!data || !Array.isArray(data.products)) return [];
    return data.products.map((p) => {
      const variant = Array.isArray(p.variants) ? p.variants[0] : null;
      const image = (Array.isArray(p.images) && p.images[0]?.src) || p.image?.src || null;
      return {
        title: p.title,
        description: p.body_html || '',
        price: variant?.price ?? '',
        image,
        url: p.handle ? `${origin.replace(/\/$/, '')}/products/${p.handle}` : null,
        category: p.product_type || '',
        // ANY purchasable variant counts; products.json marks sold one-offs
        // with available:false on every variant.
        available: Array.isArray(p.variants)
          ? p.variants.some((v) => v?.available !== false)
          : true,
      };
    });
  } catch (err) {
    log.warn(`Shopify catalog probe failed for ${origin}: ${err.message}`);
    return [];
  }
}

/**
 * Source 3 — DOM heuristics. This function is serialized and runs INSIDE the
 * page via page.evaluate, so it must be fully self-contained (no closure refs).
 * Returns raw product rows with absolute URLs (DOM .href / .src are absolute).
 */
export function productCardExtractor() {
  const PRICE_RE = /(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP))/;
  const PRODUCT_HREF_RE = /\/(products?|item|shop|p|collections\/[^/]+\/products)\//i;
  const out = [];
  const seen = new Set();

  // Candidate cards: anchors that link to product-shaped URLs, plus common
  // product-card containers.
  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) =>
    PRODUCT_HREF_RE.test(a.getAttribute('href') || '')
  );
  const containers = Array.from(
    document.querySelectorAll(
      '[class*="product" i], [class*="card" i], [data-product-id], [data-product], li[class*="grid" i]'
    )
  );

  // Collect a buffer above MAX_PRODUCTS (60) — dedupeAndCap trims to the real
  // cap afterward. Self-contained (runs in page.evaluate), so the constant is
  // inlined rather than imported.
  const collect = (root, hrefHint) => {
    if (!root || out.length >= 80) return;
    const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
    const priceMatch = text.match(PRICE_RE);
    const img = root.querySelector('img[src]');
    // A real product card has an image AND a price somewhere in it.
    if (!img || !priceMatch) return;

    // Title: prefer heading, then img alt, then anchor aria-label/text.
    let title =
      root.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]')?.textContent?.trim() ||
      img.getAttribute('alt') ||
      '';
    title = title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title || title.length < 2) return;

    const anchor = root.matches('a[href]') ? root : root.querySelector('a[href]');
    const url = anchor?.href || hrefHint || null;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    out.push({
      title,
      description: '',
      price: priceMatch[0],
      image: img.src,
      url,
      category: '',
    });
  };

  for (const a of anchors) {
    // Walk up to the nearest card-ish ancestor so we capture the price+img.
    const card = a.closest('li, article, div[class*="product" i], div[class*="card" i]') || a;
    collect(card, a.href);
  }
  for (const c of containers) collect(c, null);

  return out;
}
