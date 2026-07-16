/**
 * Progressive Intent Front Door — public read API + visit beacon.
 *
 * Feature 008 Phase 1 (P1-B), consumed by test-site frontends
 * (first: altitudeguitar.com — Next.js middleware + /intent/[slug] ISR pages):
 *
 *   GET  /api/front-door/corpus?site=<host>        — published intent slugs
 *   GET  /api/front-door/corpus/:slug?site=<host>  — one published payload
 *   POST /api/front-door/visit                     — anonymous visit beacon
 *
 * All three are PUBLIC (route-tiers: 'public'):
 *   - reads expose only `published` marketing copy (screened + sanitized at
 *     seed time, safety_version-pinned at read time);
 *   - the beacon is anonymous telemetry — no IP stored, no body beyond the
 *     clamped fields below (the Phase 2 provenance spine is deliberately NOT
 *     built here).
 * Inputs are validated/clamped fail-closed; the beacon is additionally
 * IP-rate-limited in memory (it is the only public INSERT).
 */

import { query } from '../db.js';
import { REDESIGN_SAFETY_VERSION } from '../../../lib/runtime/redesign-safety.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,253}$/;
const PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VISITOR_KINDS = new Set(['human', 'agent']);
const MAX_PATH_LEN = 512;

// Beacon rate limit: in-memory per-IP hourly window. Generous for real traffic
// (one beacon per pageview), tight enough to bound a dumb flood. A distributed
// limiter is overkill for a single-instance API (P4).
const BEACON_MAX_PER_IP_HOUR = 600;
const beaconWindow = { startedAt: 0, counts: new Map() };

function beaconAllowed(ip, now = Date.now()) {
  if (now - beaconWindow.startedAt > 60 * 60 * 1000) {
    beaconWindow.startedAt = now;
    beaconWindow.counts.clear();
  }
  const n = (beaconWindow.counts.get(ip) || 0) + 1;
  beaconWindow.counts.set(ip, n);
  return n <= BEACON_MAX_PER_IP_HOUR;
}

/** Normalize + validate a site host param: lowercase, strip one www. */
export function normalizeSiteParam(site) {
  if (typeof site !== 'string') return null;
  let host = site.trim().toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return HOST_RE.test(host) ? host : null;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function siteFromReq(req) {
  const url = new URL(req.url, 'http://localhost');
  const site = normalizeSiteParam(url.searchParams.get('site') || '');
  if (!site) throw badRequest('Missing or invalid required query param: site');
  return site;
}

export function registerFrontDoorRoutes(routes, { _query = query } = {}) {
  // GET /api/front-door/corpus?site=<host> — published slugs for the site.
  // Drives generateStaticParams() on the frontend. Cacheable: the corpus
  // changes only on manual seed runs.
  routes.set('GET /api/front-door/corpus', async (req, _body, res) => {
    const site = siteFromReq(req);
    const result = await _query(
      `SELECT intent_slug, updated_at
         FROM content.front_door_corpus
        WHERE site_host = $1
          AND publish_status = 'published'
          AND safety_version = $2
        ORDER BY intent_slug`,
      [site, REDESIGN_SAFETY_VERSION]
    );
    if (res) res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return {
      site,
      entries: result.rows.map((r) => ({
        intent_slug: r.intent_slug,
        updated_at: r.updated_at,
      })),
    };
  });

  // GET /api/front-door/corpus/:slug?site=<host> — one published payload.
  routes.set('GET /api/front-door/corpus/:slug', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const slug = parts[parts.length - 1];
    if (!SLUG_RE.test(slug)) throw badRequest('Invalid slug');
    const site = siteFromReq(req);

    // Serves 'published' AND 'unlisted' (Phase 1.5 cold-tail rows): a direct
    // /intent/<slug> link must work immediately, but unlisted rows stay out of
    // the LIST API and the serve-by-match pool until board promotion — a
    // direct link only reaches whoever it was generated for / shared with.
    const result = await _query(
      `SELECT intent_slug, intent_text, payload, publish_status, updated_at
         FROM content.front_door_corpus
        WHERE site_host = $1
          AND intent_slug = $2
          AND publish_status IN ('published', 'unlisted')
          AND safety_version = $3`,
      [site, slug, REDESIGN_SAFETY_VERSION]
    );
    if (result.rows.length === 0) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    const row = result.rows[0];
    if (res) res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return {
      site,
      intent_slug: row.intent_slug,
      intent_text: row.intent_text,
      payload: row.payload,
      // Frontend sets robots per status: published → indexable (AEO),
      // unlisted (cold-tail, unpromoted) → noindex.
      publish_status: row.publish_status,
      updated_at: row.updated_at,
    };
  });

  // POST /api/front-door/visit — anonymous beacon from site middleware.
  // Fields are clamped fail-closed; anything malformed is a 400, never a
  // partial insert. Returns 204-shaped empty object (no body the edge waits on).
  routes.set('POST /api/front-door/visit', async (req, body) => {
    const ip = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
    if (!beaconAllowed(ip)) {
      const err = new Error('Rate limit exceeded');
      err.statusCode = 429;
      throw err;
    }

    const b = body || {};
    const site = normalizeSiteParam(b.site);
    if (!site) throw badRequest('Invalid site');

    const tier = Number(b.tier);
    if (tier !== 0 && tier !== 1) throw badRequest('Invalid tier (Phase 1: 0 or 1)');

    const platform = typeof b.platform === 'string' ? b.platform.trim().toLowerCase() : '';
    if (!PLATFORM_RE.test(platform)) throw badRequest('Invalid platform');

    const visitorKind = typeof b.visitor_kind === 'string' ? b.visitor_kind.trim().toLowerCase() : '';
    if (!VISITOR_KINDS.has(visitorKind)) throw badRequest('Invalid visitor_kind');

    const path = typeof b.path === 'string' && b.path.startsWith('/')
      ? b.path.slice(0, MAX_PATH_LEN)
      : null;
    if (!path) throw badRequest('Invalid path');

    let servedSlug = null;
    if (b.served_intent_slug != null && b.served_intent_slug !== '') {
      if (typeof b.served_intent_slug !== 'string' || !SLUG_RE.test(b.served_intent_slug)) {
        throw badRequest('Invalid served_intent_slug');
      }
      servedSlug = b.served_intent_slug;
    }

    const rewriteApplied = b.rewrite_applied === true;

    // Raw User-Agent — lets us break down WHICH agents actually reach the front
    // door (the classifier collapses every bot into one 'agent' bucket, so the
    // visits table alone could never answer "is ChatGPT/Perplexity hitting us").
    const userAgent = typeof b.ua === 'string' && b.ua ? b.ua.slice(0, 512) : null;

    await _query(
      `INSERT INTO content.front_door_visits
         (site_host, tier, platform, visitor_kind, path, served_intent_slug, rewrite_applied, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [site, tier, platform, visitorKind, path, servedSlug, rewriteApplied, userAgent]
    );
    return { ok: true };
  });
}
