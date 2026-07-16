import { writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { assertPublicUrl } from '../net/ssrf.js';
import {
  catalogFromJsonLd,
  catalogFromShopify,
  productCardExtractor,
  dedupeAndCap,
} from './product-catalog.js';

const log = createLogger('scraper-playwright');
const SCRAPE_TIMEOUT_MS = 30_000;

// Schemes that never issue a network fetch to an arbitrary host — inline
// data, in-memory blobs, and the internal about: pages Chromium itself
// navigates to (e.g. the initial blank page). These carry no SSRF risk and
// must NOT be run through assertPublicUrl, which only understands http(s)
// and would otherwise reject them as an invalid scheme, breaking every
// scraped page that inlines a data: image/icon.
const SAFE_INERT_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/**
 * Build a Playwright route handler that blocks SSRF: it re-validates every
 * request the page makes (main document AND sub-resources) against
 * `assertPublicUrl`, so a target that passes the entry-URL check cannot
 * bounce Chromium into `http://169.254.169.254/...` (cloud metadata) or any
 * other internal host via a 3xx redirect or an `<img>`/`fetch`/`xhr` to one.
 * Each redirect hop re-enters this handler as a fresh request, so redirects
 * are covered by the same mechanism as sub-resources — no separate handling
 * needed.
 *
 * Exported (pure, no browser dependency) so it can be unit-tested with a fake
 * `route` and an injected `assertPublicUrl`.
 *
 * Semantics mirror `validateNotSSRF` in `scrapers/index.js`: a DNS miss is
 * lenient (allow — let the request fail naturally) while an actual
 * SSRF_BLOCKED verdict (or an unparseable URL) aborts the request.
 *
 * @param {{ assertPublicUrl?: Function, log?: Object, cache?: Map }} [opts]
 * @returns {Function} async (route) => void
 */
export function makeSsrfRouteGuard({ assertPublicUrl: assertFn = assertPublicUrl, log: logger, cache = new Map() } = {}) {
  return async (route) => {
    const reqUrl = route.request().url();
    let parsed;
    try {
      parsed = new URL(reqUrl);
    } catch {
      return route.abort('blockedbyclient');
    }

    // Not a network fetch — nothing for assertPublicUrl to validate.
    if (SAFE_INERT_SCHEMES.has(parsed.protocol)) {
      return route.continue();
    }

    // Memoize per-origin so sub-resources on an already-cleared host don't
    // each pay a fresh DNS lookup.
    const origin = parsed.origin;
    let verdict = cache.get(origin);
    if (verdict === undefined) {
      try {
        await assertFn(reqUrl);
        verdict = 'allow';
      } catch (err) {
        verdict = err && err.code === 'DNS_LOOKUP_FAILED' ? 'allow' : 'block';
      }
      cache.set(origin, verdict);
    }

    if (verdict === 'block') {
      logger?.warn?.(`SSRF: aborted request to ${reqUrl}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  };
}

/**
 * Build a Playwright *WebSocket* route handler applying the same SSRF
 * verdict as `makeSsrfRouteGuard`. `page.route()` never intercepts WebSocket
 * upgrades — Playwright ships `routeWebSocket` as a separate API for exactly
 * this reason — so without this, a scraped page's
 * `new WebSocket('ws://169.254.169.254/...')` sails straight past the HTTP
 * guard and can reach internal metadata/Redis/etc. endpoints directly.
 *
 * `assertPublicUrl` only accepts http(s) URLs, so a raw ws(s):// URL passed
 * through verbatim would be falsely rejected as an invalid scheme — the
 * ws/wss scheme is rewritten to http/https (same host, same DNS resolution)
 * before validation.
 *
 * By default a routed WebSocket does NOT reach the real server (Playwright
 * assumes you're mocking it) — `close()` is how this guard blocks a verdict,
 * and `connectToServer()` is what lets an allowed connection actually reach
 * the real server unmodified.
 *
 * @param {{ assertPublicUrl?: Function, log?: Object, cache?: Map }} [opts]
 * @returns {Function} async (ws: WebSocketRoute) => void
 */
export function makeSsrfWebSocketGuard({ assertPublicUrl: assertFn = assertPublicUrl, log: logger, cache = new Map() } = {}) {
  return async (ws) => {
    const wsUrl = ws.url();
    let httpEquivalent;
    let origin;
    try {
      const parsed = new URL(wsUrl);
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      httpEquivalent = parsed.href;
      // Key the shared cache on the origin AFTER the ws->http(s) rewrite, so it
      // matches the http(s):// origin the HTTP guard keys on (a pre-rewrite
      // ws:// origin would never match, silently defeating cache sharing).
      origin = parsed.origin;
    } catch {
      logger?.warn?.(`SSRF: closed WebSocket to unparseable URL ${wsUrl}`);
      return ws.close();
    }

    let verdict = cache.get(origin);
    if (verdict === undefined) {
      try {
        await assertFn(httpEquivalent);
        verdict = 'allow';
      } catch (err) {
        verdict = err && err.code === 'DNS_LOOKUP_FAILED' ? 'allow' : 'block';
      }
      cache.set(origin, verdict);
    }

    if (verdict === 'block') {
      logger?.warn?.(`SSRF: closed WebSocket to ${wsUrl}`);
      return ws.close();
    }
    ws.connectToServer();
  };
}

/**
 * Wire the SSRF guards onto every page the browser context creates —
 * including popups (`window.open`, `target="_blank"`, ...). `page.route()`
 * and `page.routeWebSocket()` are per-Page, not inherited by pages the
 * context spawns later, so a popup would otherwise get NO guard at all: a
 * scraped site could open `http://169.254.169.254/...` in a new tab and hit
 * it completely unguarded.
 *
 * RESIDUAL RISK: this listener must register the popup's routes before the
 * popup's first request goes out. Playwright creates the popup's CDP target
 * (firing this event) before the triggering navigation is dispatched, so in
 * practice registration wins the race — but that ordering is not a hard
 * guarantee from the Playwright API. This narrows, rather than eliminates,
 * the window, the same posture as the documented DNS-rebinding TOCTOU in
 * `lib/net/ssrf.js`.
 *
 * Exported (pure context-wiring, no real browser dependency) so it's
 * unit-testable with a fake context + fake popup page.
 *
 * @param {Object} context - a Playwright BrowserContext (or a fake exposing `.on('page', cb)`)
 * @param {{ httpGuard: Function, wsGuard: Function, log?: Object }} deps
 */
export function attachPopupSsrfGuards(context, { httpGuard, wsGuard, log: logger } = {}) {
  context.on('page', async (popup) => {
    // Both registrations are dispatched synchronously (before the first await)
    // so they race the popup's first request as tightly as possible, same as
    // the main page. Fail CLOSED: if either registration rejects, the popup
    // would proceed with (at least partly) NO SSRF guard, so close it. The
    // main page fails closed by letting the awaited rejection abort the whole
    // scrape; an event listener can't crash the scrape, so closing the popup
    // is the localized equivalent — an unguarded popup reaches no host at all.
    try {
      await Promise.all([
        popup.route('**/*', httpGuard),
        popup.routeWebSocket('**/*', wsGuard),
      ]);
    } catch (err) {
      logger?.warn?.(`SSRF: failed to guard popup, closing it: ${err.message}`);
      await popup.close?.().catch(() => {});
    }
  });
}

/**
 * Scrape a URL using Playwright for brand extraction + HTML structure.
 * @param {string} targetUrl - URL to scrape
 * @param {string} workDir - Directory to write artifacts
 * @param {Object} options - { frameworkColors: Set, auditAEO: Function|null, extractCatalog: boolean }
 * @returns {{ html, title, meta, designData, aeoResult, images, seoElements, catalog }}
 */
export async function scrapeWithPlaywright(targetUrl, workDir, options = {}) {
  const frameworkColors = options.frameworkColors || new Set();
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) STAQS-Redesign-Bot/1.0',
    });

    // SSRF guard: the entry URL is validated by the caller (scrapers/index.js),
    // but Chromium follows redirects and loads sub-resources itself, bypassing
    // that check. Intercept every request — HTTP(S), WebSocket, and any popup
    // the page opens — so redirect targets, img/script/xhr/css fetches, WS
    // connections, and window.open()'d tabs can't reach internal hosts. One
    // shared cache means clearing an origin via the HTTP guard also short-
    // circuits its WS/popup lookups.
    const ssrfCache = new Map();
    const httpGuard = makeSsrfRouteGuard({ log, cache: ssrfCache });
    const wsGuard = makeSsrfWebSocketGuard({ log, cache: ssrfCache });
    await page.route('**/*', httpGuard);
    await page.routeWebSocket('**/*', wsGuard);
    attachPopupSsrfGuards(page.context(), { httpGuard, wsGuard, log });

    // Try networkidle first (strict: zero requests for 500ms), but fall back to
    // domcontentloaded + settle delay for sites that never stop network activity
    // (analytics, chat widgets, background polling). RC2 fix.
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 10_000 });
    } catch {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: SCRAPE_TIMEOUT_MS });
      await page.waitForTimeout(2000);
    }

    // Extract page data
    const html = await page.content();
    const title = await page.title();
    const meta = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el?.getAttribute('content') || null;
      };
      return {
        description: getMeta('description') || getMeta('og:description'),
        ogImage: getMeta('og:image'),
        themeColor: getMeta('theme-color'),
      };
    });

    // Extract all SEO-critical elements for preservation in redesign
    const seoElements = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el?.getAttribute('content') || null;
      };
      const ogTags = {};
      for (const el of document.querySelectorAll('meta[property^="og:"]')) {
        ogTags[el.getAttribute('property')] = el.getAttribute('content');
      }
      const jsonLd = [];
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { jsonLd.push(JSON.parse(script.textContent)); } catch {}
      }
      const canonical = document.querySelector('link[rel="canonical"]')?.href || null;
      const hreflang = [];
      for (const el of document.querySelectorAll('link[rel="alternate"][hreflang]')) {
        hreflang.push({ lang: el.getAttribute('hreflang'), href: el.href });
      }
      const robots = getMeta('robots');
      const lang = document.documentElement.getAttribute('lang');
      const headings = [];
      for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
        headings.push({ tag: h.tagName.toLowerCase(), text: h.textContent?.trim().slice(0, 120) });
      }
      const navLinks = [];
      for (const a of document.querySelectorAll('nav a[href], header a[href]')) {
        navLinks.push({ text: a.textContent?.trim().slice(0, 80), href: a.href });
      }
      return {
        title: document.title, metaDescription: getMeta('description'),
        canonical, lang, robots, ogTags, jsonLd, hreflang, headings, navLinks,
      };
    });

    writeFileSync(join(workDir, 'seo-elements.json'), JSON.stringify(seoElements, null, 2));

    const seoHeadLines = [];
    seoHeadLines.push('<meta charset="utf-8">');
    seoHeadLines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    if (seoElements.title) seoHeadLines.push(`<title>${seoElements.title}</title>`);
    if (seoElements.metaDescription) seoHeadLines.push(`<meta name="description" content="${seoElements.metaDescription.replace(/"/g, '&quot;')}">`);
    if (seoElements.canonical) seoHeadLines.push(`<link rel="canonical" href="${seoElements.canonical}">`);
    if (seoElements.lang) seoHeadLines.push(`<!-- IMPORTANT: Add lang="${seoElements.lang}" to the <html> tag -->`);
    if (seoElements.robots) seoHeadLines.push(`<meta name="robots" content="${seoElements.robots}">`);
    for (const [property, content] of Object.entries(seoElements.ogTags || {})) {
      if (content) seoHeadLines.push(`<meta property="${property}" content="${String(content).replace(/"/g, '&quot;')}">`);
    }
    for (const { lang: hLang, href } of (seoElements.hreflang || [])) {
      seoHeadLines.push(`<link rel="alternate" hreflang="${hLang}" href="${href}">`);
    }
    for (const block of (seoElements.jsonLd || [])) {
      seoHeadLines.push(`<script type="application/ld+json">${JSON.stringify(block, null, 2)}</script>`);
    }
    writeFileSync(join(workDir, 'seo-head.html'), seoHeadLines.join('\n'));
    log.info(`Generated seo-head.html with ${seoHeadLines.length} SEO elements`);

    // Extract computed styles and brand identity
    const frameworkColorList = [...frameworkColors];
    const designData = await page.evaluate((fwColors) => {
      const frameworkColorSet = new Set(fwColors);
      const body = document.body;
      const computed = getComputedStyle(body);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5);

      // Helper: rgb string to hex
      function rgbToHex(rgb) {
        const m = rgb.match(/(\d+)/g);
        if (!m || m.length < 3) return rgb;
        return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
      }

      // Extract color palette from visible elements with frequency counting
      const colorFreq = {};
      const elements = document.querySelectorAll('*');
      for (let i = 0; i < Math.min(elements.length, 300); i++) {
        const style = getComputedStyle(elements[i]);
        const rect = elements[i].getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const area = rect.width * rect.height;

        for (const c of [style.color, style.backgroundColor]) {
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'rgb(0, 0, 0)' && c !== 'rgb(255, 255, 255)') {
            const hex = rgbToHex(c);
            if (frameworkColorSet.has(hex)) continue; // Skip framework grays
            colorFreq[hex] = (colorFreq[hex] || 0) + area;
          }
        }
      }

      // Sort by visual area (most prominent colors first)
      const sortedColors = Object.entries(colorFreq)
        .sort((a, b) => b[1] - a[1])
        .map(([hex]) => hex);

      // Brand color detection from high-signal elements
      const brandSignals = {
        logo: [],
        nav: [],
        buttons: [],
        headings: [],
        links: [],
      };

      // Logo area colors
      const logoEl = document.querySelector('[class*="logo" i], [id*="logo" i], header img, .site-header img, nav img');
      if (logoEl) {
        const parent = logoEl.closest('a, div, header');
        if (parent) {
          const ps = getComputedStyle(parent);
          if (ps.backgroundColor !== 'rgba(0, 0, 0, 0)') brandSignals.logo.push(rgbToHex(ps.backgroundColor));
          if (ps.color !== 'rgba(0, 0, 0, 0)') brandSignals.logo.push(rgbToHex(ps.color));
        }
      }

      // Nav/header colors
      const nav = document.querySelector('nav, header, [role="navigation"]');
      if (nav) {
        const ns = getComputedStyle(nav);
        brandSignals.nav.push(rgbToHex(ns.backgroundColor), rgbToHex(ns.color));
      }

      // Button/CTA colors
      for (const btn of document.querySelectorAll('a[class*="btn" i], a[class*="button" i], button, .cta, [class*="cta" i]')) {
        const bs = getComputedStyle(btn);
        if (bs.backgroundColor !== 'rgba(0, 0, 0, 0)') brandSignals.buttons.push(rgbToHex(bs.backgroundColor));
        if (bs.color !== 'rgba(0, 0, 0, 0)') brandSignals.buttons.push(rgbToHex(bs.color));
      }

      // Heading colors
      for (const h of headings) {
        const hs = getComputedStyle(h);
        brandSignals.headings.push(rgbToHex(hs.color));
      }

      // Link colors
      const links = document.querySelectorAll('a');
      for (let i = 0; i < Math.min(links.length, 20); i++) {
        brandSignals.links.push(rgbToHex(getComputedStyle(links[i]).color));
      }

      // Deduplicate brand signals
      for (const key of Object.keys(brandSignals)) {
        brandSignals[key] = [...new Set(brandSignals[key])].filter(c => c && c !== '#000000' && c !== '#ffffff');
      }

      // Determine if clear branding exists (3+ consistent non-black/white colors)
      const allBrandColors = [...new Set([
        ...brandSignals.logo, ...brandSignals.nav,
        ...brandSignals.buttons, ...brandSignals.headings,
      ])].filter(c => c && c !== '#000000' && c !== '#ffffff' && !frameworkColorSet.has(c));

      const hasClearBranding = allBrandColors.length >= 2;
      // Top brand colors = most frequent among brand elements
      const brandColorRanked = allBrandColors
        .sort((a, b) => (colorFreq[a] || 0) - (colorFreq[b] || 0))
        .reverse()
        .slice(0, 5);

      return {
        bodyFont: computed.fontFamily,
        bodyColor: computed.color,
        bodyBg: computed.backgroundColor,
        headings: headings.map(h => ({
          tag: h.tagName,
          text: h.textContent?.trim().slice(0, 100),
          font: getComputedStyle(h).fontFamily,
          color: rgbToHex(getComputedStyle(h).color),
        })),
        colorPalette: sortedColors.slice(0, 20),
        brand: {
          hasClearBranding,
          primaryColors: brandColorRanked,
          signals: brandSignals,
        },
      };
    }, frameworkColorList);

    // Extract image URLs for reuse in redesign
    const images = await page.evaluate(() => {
      const seen = new Set();
      const imgs = [];

      // <img> tags
      for (const img of document.querySelectorAll('img[src]')) {
        const src = img.src;
        if (!src || seen.has(src) || src.startsWith('data:')) continue;
        seen.add(src);
        const rect = img.getBoundingClientRect();
        imgs.push({
          src,
          alt: img.alt || '',
          width: img.naturalWidth || Math.round(rect.width),
          height: img.naturalHeight || Math.round(rect.height),
          context: img.closest('section, header, footer, main, div')?.className?.slice(0, 60) || '',
          isLogo: /logo/i.test(img.alt || img.className || img.src),
          isHero: rect.width > 600 || (rect.width > 300 && rect.top < 800),
        });
      }

      // CSS background images on visible elements
      const bgElements = document.querySelectorAll('[style*="background"], section, header, div, figure');
      for (let i = 0; i < Math.min(bgElements.length, 100); i++) {
        const style = getComputedStyle(bgElements[i]);
        const bgImg = style.backgroundImage;
        if (bgImg && bgImg !== 'none' && bgImg.startsWith('url(')) {
          const url = bgImg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
          if (!url.startsWith('data:') && !seen.has(url)) {
            seen.add(url);
            const rect = bgElements[i].getBoundingClientRect();
            imgs.push({
              src: url,
              alt: '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              context: bgElements[i].className?.slice(0, 60) || bgElements[i].tagName,
              isLogo: false,
              isHero: rect.width > 600 || (rect.width > 300 && rect.top < 800),
              isBackground: true,
            });
          }
        }
      }

      // OG image
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      if (ogImage && !seen.has(ogImage)) {
        imgs.push({ src: ogImage, alt: 'Open Graph image', width: 0, height: 0, context: 'og:image', isLogo: false, isHero: false });
      }

      return imgs;
    });

    // Save image manifest and brand data for CLI
    writeFileSync(join(workDir, 'images.json'), JSON.stringify(images, null, 2));
    writeFileSync(join(workDir, 'brand.json'), JSON.stringify(designData.brand, null, 2));

    // Generate human-readable image manifest for LLM consumption
    const manifestLines = ['# Image Manifest — USE THESE EXACT URLs\n'];
    const logos = images.filter(i => i.isLogo);
    const heroes = images.filter(i => i.isHero && !i.isLogo);
    const others = images.filter(i => !i.isLogo && !i.isHero);

    if (logos.length > 0) {
      manifestLines.push('## Logo Images (MUST use in header)');
      for (const img of logos) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || 'Logo'}" | ${img.width}x${img.height}`);
      }
      manifestLines.push('');
    }
    if (heroes.length > 0) {
      manifestLines.push('## Hero / Banner Images (use prominently above the fold)');
      for (const img of heroes) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || ''}" | ${img.width}x${img.height} | context: ${img.context || 'hero'}`);
      }
      manifestLines.push('');
    }
    if (others.length > 0) {
      manifestLines.push('## Other Images (reuse in relevant sections)');
      for (const img of others) {
        manifestLines.push(`- src: ${img.src}`);
        manifestLines.push(`  alt: "${img.alt || ''}" | ${img.width}x${img.height} | context: ${img.context || 'general'}`);
      }
      manifestLines.push('');
    }
    manifestLines.push(`\nTotal: ${images.length} images available. Use ALL of them where contextually appropriate.`);
    writeFileSync(join(workDir, 'image-manifest.md'), manifestLines.join('\n'));

    log.info(`Extracted ${images.length} images from ${targetUrl}`);
    log.info(`Brand: ${designData.brand.hasClearBranding ? 'DETECTED' : 'weak'} — colors: ${designData.brand.primaryColors.join(', ') || 'none'}`);

    // Extract product catalog (for intent-driven landing pages). Best-effort:
    // JSON-LD (already parsed) → Shopify same-origin → DOM heuristics, in
    // coverage order, stopping early once we have enough. Never fatal.
    // Gated on options.extractCatalog so non-intent redesigns skip the cost.
    let catalog = [];
    if (options.extractCatalog) try {
      const origin = new URL(targetUrl).origin;
      let rows = catalogFromJsonLd(seoElements.jsonLd, targetUrl);
      if (rows.length < 8) {
        rows = rows.concat(await catalogFromShopify(origin));
      }
      if (rows.length < 4) {
        const domCards = await page.evaluate(productCardExtractor);
        rows = rows.concat(domCards || []);
      }
      catalog = dedupeAndCap(rows, targetUrl);
      writeFileSync(join(workDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
      log.info(`Catalog: ${catalog.length} products extracted from ${targetUrl}`);
    } catch (err) {
      log.warn(`Catalog extraction failed (non-fatal): ${err.message}`);
    }

    // AEO audit (reuse the already-open page)
    let aeoResult = null;
    try {
      aeoResult = options.auditAEO ? await options.auditAEO(page) : null;
    } catch (err) {
      log.warn(`AEO audit failed (non-fatal): ${err.message}`);
    }

    // Save HTML for Claude Code CLI to read
    const htmlPath = join(workDir, 'original.html');
    writeFileSync(htmlPath, html);

    // Enforce size limit (5MB)
    if (html.length > 5 * 1024 * 1024) {
      throw new Error('Page HTML exceeds 5MB limit');
    }

    return { html, title, meta, designData, aeoResult, images, seoElements, catalog };
  } finally {
    await browser.close();
  }
}
