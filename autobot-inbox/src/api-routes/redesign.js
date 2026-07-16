import { query } from '../db.js';
import { withSystemScope } from '../../../lib/db.js';
import { publishEvent } from '../runtime/infrastructure.js';
import { transitionState } from '../runtime/state-machine.js';
import { emit } from '../runtime/event-bus.js';
import { randomBytes, timingSafeEqual } from 'crypto';
import { assertPublicUrl, safeFetch } from '../../../lib/net/ssrf.js';
import { classifyVisitor } from '../../../agents/executor-redesign/visitor-classifier.js';
import { resolveServeByMatch, siteHostFromUrl } from './front-door-corpus.js';
import { coldTailEnabled, generateColdTail } from '../front-door/cold-tail.js';
import {
  screenRedesignInput,
  REDESIGN_SAFETY_VERSION,
  isServable,
} from '../../../lib/runtime/redesign-safety.js';

/**
 * Website Redesign API routes.
 *
 * POST /api/redesign/submit       — submit a URL for redesign
 * GET  /api/redesign/status/:id   — poll job status
 * GET  /api/redesign/preview/:id  — redirect to preview URL
 * GET  /api/redesign/strategy/:id — serve strategy rationale
 *
 * Public endpoints — no auth required (rate-limited instead).
 * These are the first Optimus-as-a-service endpoints.
 */

const MAX_PER_IP_24H = 3;
const MAX_GLOBAL_24H = 10;

const REDESIGN_SYSTEM_ACTOR = 'redesign-intake';

// OPT-166 P3-B5/B6: agent_graph.work_items is a system-writable operational
// table (sql/200 agent_write_work_items admits tenancy.is_system()), but these
// routes run with NO agent/board principal at all (anonymous lead capture +
// API_SECRET admin bearer) — there is no other identity to scope the write
// under. Run `fn(exec)` with `exec` bound to a system-scoped (app.role=system)
// query so the INSERT/UPDATE/DELETE writes below satisfy tenancy.is_system()
// post-flip. OPT-166 P3-B6: fail-closed — this guards WRITE paths only, no
// catch-and-fallback to an unscoped query. If withSystemScope throws, the
// error propagates and the route layer returns 500.
async function withRedesignScope(fn) {
  const scoped = await withSystemScope(REDESIGN_SYSTEM_ACTOR);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}

/**
 * Validate that a URL is safe to scrape (no SSRF).
 *
 * Delegates to the shared `assertPublicUrl` helper (lib/net/ssrf.js), which
 * covers IPv4 AND IPv6 private/reserved ranges post-resolution — closing the
 * previous IPv6-resolving-host bypass in the IPv4-only `split('.')` check. The
 * `{ valid, reason }` return shape is preserved for the existing callers.
 */
async function validateUrl(urlString) {
  try {
    const { url } = await assertPublicUrl(urlString);
    return { valid: true, url };
  } catch (err) {
    return { valid: false, reason: err.reason || err.message || 'Invalid URL' };
  }
}

/**
 * Normalize URL for dedup (strip trailing slash, lowercase host).
 */
function normalizeUrl(urlString) {
  const parsed = new URL(urlString);
  parsed.hash = '';
  let normalized = parsed.href;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * Lightweight business type classification from raw HTML.
 * Mirrors logic from redesign-strategy.js detectBusinessType() but
 * works on raw HTML string instead of structured scraped data.
 */
function classifyFromHtml(html) {
  const lower = html.toLowerCase();

  // JSON-LD detection
  const jsonLdMatches = lower.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const jsonLdText = jsonLdMatches.join(' ').toLowerCase();

  // Aggregate all visible text signals (title, meta, headings, nav)
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].toLowerCase() : '';
  const metaDescMatch = html.match(/<meta[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].toLowerCase() : '';
  const headingMatches = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [];
  const headings = headingMatches.map(h => h.replace(/<[^>]+>/g, '').toLowerCase()).join(' ');
  const allText = `${jsonLdText} ${title} ${metaDesc} ${headings}`;

  const scores = {};
  function bump(type, weight) { scores[type] = (scores[type] || 0) + weight; }

  // JSON-LD type signals (high confidence)
  if (/law|attorney|legalservice/i.test(jsonLdText)) bump('legal', 3);
  if (/medicalorganization|physician|hospital|dentist/i.test(jsonLdText)) bump('healthcare', 3);
  if (/restaurant|foodestablishment|cafe|bar/i.test(jsonLdText)) bump('restaurant', 3);
  if (/realestate/i.test(jsonLdText)) bump('real-estate', 3);
  if (/educationalorganization|school|course/i.test(jsonLdText)) bump('education', 3);
  if (/financialservice|bankaccount/i.test(jsonLdText)) bump('finance', 3);
  if (/nonprofit|ngo/i.test(jsonLdText)) bump('nonprofit', 3);
  if (/product|store|offer/i.test(jsonLdText)) bump('ecommerce', 2);
  if (/softwareapplication/i.test(jsonLdText)) bump('saas', 2);
  if (/localbusiness|homeandconstructionbusiness|autobodyshop|autorepair|electrician|plumber|roofingcontractor|hvac|locksmith|movingcompany/i.test(jsonLdText)) bump('home-services', 3);

  // Keyword signals from visible text (lower confidence)
  if (/\b(attorney|lawyer|law\s*firm|legal\s*services|practice\s*areas)\b/.test(allText)) bump('legal', 2);
  if (/\b(patient|doctor|medical|clinic|health\s*care|appointment|wellness|therapy|dental)\b/.test(allText)) bump('healthcare', 2);
  if (/\b(menu|reserv|dine|cuisine|chef|appetizer|entree|brunch)\b/.test(allText)) bump('restaurant', 2);
  if (/\b(listing|property|realtor|mls|mortgage|sq\s*ft|bedroom|open\s*house)\b/.test(allText)) bump('real-estate', 2);
  if (/\b(tuition|curriculum|enroll|student|campus|learn|course|class)\b/.test(allText)) bump('education', 2);
  if (/\b(invest|portfolio|wealth|banking|loan|credit|insurance|fintech)\b/.test(allText)) bump('finance', 2);
  if (/\b(donate|mission|impact|volunteer|501c|charity|cause)\b/.test(allText)) bump('nonprofit', 2);
  if (/\b(shop|cart|product|add\s*to\s*bag|checkout|shipping|price)\b/.test(allText)) bump('ecommerce', 1);
  if (/\b(saas|api|integration|platform|dashboard|workflow|pricing\s*plan)\b/.test(allText)) bump('saas', 1);
  if (/\b(agency|portfolio|creative|branding|design\s*studio|our\s*work)\b/.test(allText)) bump('agency', 1);
  if (/\b(consult|advisory|strategy|solutions|expertise|engagement)\b/.test(allText)) bump('consulting', 1);
  if (/\b(software|developer|open.source|github|stack|deploy|infrastructure)\b/.test(allText)) bump('technology', 1);
  // Home services / local service businesses (repair, install, contractors, etc.)
  if (/\b(repair|install|replacement|maintenance|free\s*(?:quote|estimate)|service\s*area|windshield|auto\s*glass|roofing|plumbing|hvac|landscaping|garage\s*door|pest|cleaning|remodel|contractor|handyman|fencing|paving|towing|locksmith|siding|gutter|flooring|painting|moving|junk\s*removal|pressure\s*wash|tree\s*service)\b/.test(allText)) bump('home-services', 3);
  if (/\b(licensed|insured|bonded|family.owned|locally.owned|serving|same.day|emergency|residential|commercial)\b/.test(allText)) bump('home-services', 1);

  let best = 'default';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) { best = type; bestScore = score; }
  }
  return best;
}

/**
 * Lightweight audience detection from raw HTML.
 */
function classifyAudienceFromHtml(html) {
  const lower = html.toLowerCase();
  const b2b = (lower.match(/enterprise|solutions|integration|api|platform|teams|business|b2b|roi|workflow/gi) || []).length;
  const b2c = (lower.match(/shop|buy|personal|family|home|lifestyle|cart|order/gi) || []).length;
  if (b2b > b2c + 2) return 'B2B';
  if (b2c > b2b + 2) return 'B2C';
  return 'mixed';
}

/**
 * ── /api/redesign/* access model (plan 019) ─────────────────────────────────
 * Two route classes, declared explicitly:
 *   1. PUBLIC + IP-RATE-LIMITED — anonymous lead capture: `POST /classify`,
 *      `POST /submit`. Bounded so they cannot be used to drive unlimited
 *      outbound fetch / LLM work.
 *   2. JOB-TOKEN-OWNED — bound to whoever submitted the job: `POST /notify`,
 *      `GET /status|strategy|preview/:id`. Caller must present the job token
 *      returned at submit (header `x-job-token`, `?token=`, or body `jobToken`),
 *      OR be admin (`Bearer API_SECRET`) — the board reads previews via the
 *      ops-auth proxy. Mismatch → 404 (never confirm a job's existence).
 * Admin-only (unchanged): `:id/cancel`, `:id/retry`, `clear` (API_SECRET).
 */

// Public classify rate limit: in-memory per-IP hourly window, same pattern as
// the front-door beacon (P4 — no distributed limiter for a single-instance API).
const CLASSIFY_MAX_PER_IP_HOUR = 30;
const classifyWindow = { startedAt: 0, counts: new Map() };
export function classifyRateAllowed(ip, now = Date.now()) {
  if (now - classifyWindow.startedAt > 60 * 60 * 1000) {
    classifyWindow.startedAt = now;
    classifyWindow.counts.clear();
  }
  const n = (classifyWindow.counts.get(ip) || 0) + 1;
  classifyWindow.counts.set(ip, n);
  return n <= CLASSIFY_MAX_PER_IP_HOUR;
}

/** Extract the requester IP (X-Forwarded-For first hop, else socket). */
function requesterIpOf(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/** Constant-time string compare (avoids leaking token/secret length-timing). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True if the request carries a valid admin Bearer (API_SECRET). */
function isAdminAuthed(req) {
  const authHeader = req.headers['authorization'] || '';
  const secret = process.env.API_SECRET;
  return !!secret && authHeader.startsWith('Bearer ') && safeEqual(authHeader.slice(7), secret);
}

/** Pull the caller-supplied job token from header, query string, or body. */
function extractJobToken(req, body) {
  const headerTok = req.headers['x-job-token'];
  if (typeof headerTok === 'string' && headerTok) return headerTok;
  if (body && typeof body.jobToken === 'string' && body.jobToken) return body.jobToken;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (q) return q;
  } catch { /* non-parseable url — no query token */ }
  return null;
}

/**
 * Authorize access to a specific job. Admin (API_SECRET) may read/write any
 * job; otherwise the caller must present the job's own token. Returns boolean —
 * callers translate `false` into a 404 (do NOT confirm the job exists).
 */
export function isJobAccessAuthorized(req, body, jobMetadata) {
  if (isAdminAuthed(req)) return true;
  const provided = extractJobToken(req, body);
  const expected = jobMetadata && jobMetadata.job_token;
  if (!provided || typeof expected !== 'string' || !expected) return false;
  return safeEqual(provided, expected);
}

/**
 * ── /status access control ───────────────────────────────────────────────────
 * Plan 019 (#499) put every id-scoped redesign route behind a job token / admin
 * bearer, 404-ing everyone else. `GET /status/:id` briefly ran a transitional
 * anonymous grace window (Plan 019 §grace) to avoid breaking pollers that
 * hadn't threaded `jobToken` yet; that window has fully drained (#500 Stage 2)
 * and `/status` is now strictly token/admin-gated like every other id-scoped
 * redesign route — unauthorized callers 404, no exceptions.
 */

/**
 * Decide how a caller is handled on `GET /status/:id`. Returns:
 *   'authorized' — valid token or admin; serve the full payload.
 *   'deny'       — unauthorized; caller 404s (Plan 019 behavior).
 * Pure/deterministic, mirroring `isJobAccessAuthorized`.
 */
export function resolveStatusAccess(req, meta) {
  return isJobAccessAuthorized(req, null, meta) ? 'authorized' : 'deny';
}

export function registerRedesignRoutes(routes) {
  // POST /api/redesign/classify — lightweight industry classification
  routes.set('POST /api/redesign/classify', async (req, body) => {
    const { url } = body || {};
    if (!url || typeof url !== 'string') {
      const err = new Error('Missing required field: url');
      err.statusCode = 400;
      throw err;
    }

    // Public route, but bounded — classify drives a live outbound fetch (SSRF
    // surface + cost). Rate-limit per IP before doing any DNS/fetch work.
    if (!classifyRateAllowed(requesterIpOf(req))) {
      const err = new Error('Rate limit: too many classification requests. Try again later.');
      err.statusCode = 429;
      throw err;
    }

    const validation = await validateUrl(url);
    if (!validation.valid) {
      const err = new Error(validation.reason);
      err.statusCode = 400;
      throw err;
    }

    // Lightweight fetch — just HTML, no Playwright, 5s timeout, 50KB limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let html;
    try {
      // safeFetch re-validates validation.url AND every redirect target before
      // following it (redirect: 'manual'), closing the redirect-follow SSRF
      // bypass where a validated host 302s to an internal/link-local address.
      const res = await safeFetch(validation.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'STAQS-Classify/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Read only first 50KB
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      const MAX_BYTES = 50 * 1024;
      // eslint-disable-next-line no-constant-condition -- streamed-read loop, break inside
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes >= MAX_BYTES) break;
      }
      reader.cancel();
      html = new TextDecoder().decode(Buffer.concat(chunks).slice(0, MAX_BYTES));
    } catch (fetchErr) {
      // If fetch fails, return generic classification
      return { businessType: 'default', audience: 'mixed', industry: [] };
    } finally {
      clearTimeout(timeout);
    }

    const businessType = classifyFromHtml(html);
    const audience = classifyAudienceFromHtml(html);

    return { businessType, audience };
  });
  // POST /api/redesign/submit
  routes.set('POST /api/redesign/submit', async (req, body) => {
    const {
      url, email,
      visitorIntent,
      styleDirections, inspirationRefs, primaryCta, keepFromCurrent,
      classifiedIndustry, classifiedAudience,
    } = body || {};
    if (!url || typeof url !== 'string') {
      const err = new Error('Missing required field: url');
      err.statusCode = 400;
      throw err;
    }

    // Visitor intent — drives intent-targeted landing-page generation. Optional.
    const intent = typeof visitorIntent === 'string'
      ? visitorIntent.trim().slice(0, 300)
      : '';

    // INBOUND SAFETY GATE (P1 deny-by-default, P2 infra-enforces / G8).
    // visitor_intent is user-supplied and flows UNSCREENED into a Sonnet prompt
    // whose output is served publicly. Screen it through Model Armor BEFORE a work
    // item is created and BEFORE the LLM is ever invoked. On block: reject with a
    // 4xx and never enqueue the job. Fail-CLOSED in prod if Model Armor is
    // unconfigured (overridable via MODEL_ARMOR_FAIL_OPEN for local/dev).
    if (intent) {
      const inboundVerdict = await screenRedesignInput(intent, 'executor-redesign', {
        label: 'visitor_intent',
      });
      if (!inboundVerdict.ok) {
        const err = new Error(inboundVerdict.reason);
        err.statusCode = 400;
        err.safetyBlock = inboundVerdict.detail;
        throw err;
      }
    }

    // Validate URL safety (SSRF prevention)
    const validation = await validateUrl(url);
    if (!validation.valid) {
      const err = new Error(validation.reason);
      err.statusCode = 400;
      throw err;
    }

    // Extract requester IP from headers (X-Forwarded-For for proxied requests)
    const requesterIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';

    // Progressive Intent Front Door — tier 0/1 classification (feature 008 §4.1).
    // Inference only (referrer + User-Agent -> { visitor_kind, platform, tier });
    // advisory provenance, NOT a security control (spec §0/§6). Tiers 2/3
    // (declared intent) are later phases, so intent_source is always 'inferred'.
    const classification = classifyVisitor(req.headers || {});

    // Rate limit: per-IP (3/24h)
    const ipCountResult = await query(
      `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND metadata->>'requester_ip' = $1
         AND created_at > now() - interval '24 hours'`,
      [requesterIp]
    );
    if (parseInt(ipCountResult.rows[0].cnt, 10) >= MAX_PER_IP_24H) {
      const err = new Error('Rate limit: maximum 3 redesigns per 24 hours');
      err.statusCode = 429;
      throw err;
    }

    // Rate limit: global (10/24h)
    const globalCountResult = await query(
      `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND created_at > now() - interval '24 hours'`
    );
    if (parseInt(globalCountResult.rows[0].cnt, 10) >= MAX_GLOBAL_24H) {
      const err = new Error('Service busy: daily capacity reached. Try again tomorrow.');
      err.statusCode = 429;
      throw err;
    }

    // Admission control removed — API and executor-redesign run on different machines
    // (Railway vs M1), making liveness detection unreliable. Instead, we rely on:
    // 1. Reaper cancels stale-assigned jobs after 60 minutes
    // 2. Status endpoint returns terminal state for missing/cancelled jobs

    // Dedup: same normalized URL within 24h returns existing job (skip failed/timed_out)
    const normalized = normalizeUrl(validation.url);
    // Dedup only collapses jobs with the SAME visitor intent — two different
    // intents on the same URL are genuinely different landing pages.
    // Cache/dedup MUST NOT serve a page that predates the current safety logic.
    // A completed job is only reusable if it cleared the publish gate at the
    // current safety version; otherwise force a fresh run (which re-screens).
    // In-progress jobs (no html yet) still dedup normally.
    const existingResult = await query(
      `SELECT id, status, metadata FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
         AND metadata->>'target_url_normalized' = $1
         AND COALESCE(metadata->>'visitor_intent', '') = $2
         AND created_at > now() - interval '24 hours'
         AND status NOT IN ('failed', 'cancelled', 'timed_out')
         AND NOT (status = 'in_progress' AND updated_at < now() - interval '10 minutes')
         AND (
           status <> 'completed'
           OR (
             metadata->>'publish_status' = 'published'
             AND COALESCE((metadata->>'safety_version')::int, 0) = $3
           )
         )
       ORDER BY created_at DESC LIMIT 1`,
      [normalized, intent, REDESIGN_SAFETY_VERSION]
    );
    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      const meta = existing.metadata || {};
      return {
        jobId: existing.id,
        status: existing.status,
        previewUrl: meta.preview_url || null,
        // Return the existing job's token so the deduped submitter can poll/own
        // it. Older jobs created before this field exists return null.
        jobToken: meta.job_token || null,
        deduplicated: true,
      };
    }

    // Serve-by-match branch (feature 008 §1/§7). Before triggering live
    // generation, check the pre-generated corpus (content.front_door_corpus,
    // sql/162) for an intent-matched entry that can be served instantly (~$0).
    // Gated behind FRONT_DOOR_SERVE_BY_MATCH (default OFF) — rollout is an env
    // flip; with the flag off we fall through to existing behavior unchanged.
    const serveByMatch = await resolveServeByMatch({
      url: normalized,
      intent,
      classification,
    });
    if (serveByMatch.serve) {
      // Pre-generated corpus entry instead of a generation job. In Phase 1 the
      // servable artifact is the structured payload (html is null — corpus
      // entries are rendered natively by the site frontend); return it inline
      // for the agent/MCP path. artifactId is a corpus row id, NOT a work item,
      // so it must not be dressed up as a /api/redesign/preview URL.
      const hitSite = siteHostFromUrl(normalized);
      return {
        jobId: null,
        status: 'completed',
        servedFromCorpus: true,
        artifactId: serveByMatch.artifactId || null,
        intentSlug: serveByMatch.intentSlug || null,
        payload: serveByMatch.payload || null,
        // The live, shareable intent page on the site itself.
        url: hitSite && serveByMatch.intentSlug
          ? `https://${hitSite}/intent/${serveByMatch.intentSlug}`
          : null,
        previewUrl: null,
      };
    }

    // Cold-tail branch (feature 008 Phase 1.5). Corpus MISS with a declared
    // intent → build a TEMPLATED payload inline (<2s, ~$0: G8 screen → product
    // match → catalog-vocabulary assembly → unlisted write-through) instead of
    // falling through to the 5-8 min full-redesign pipeline. Gated behind
    // FRONT_DOOR_COLDTAIL (default OFF). Any cold-tail failure falls through
    // to existing behavior — strictly additive. Its rate gates live inside
    // generateColdTail and run before any of ITS embedding/LLM work; 429s are
    // surfaced rather than burning a $2.31 fallback job on a rate-limited
    // caller.
    if (coldTailEnabled() && intent) {
      const siteHost = siteHostFromUrl(normalized);
      if (siteHost) {
        const coldTail = await generateColdTail({ siteHost, intent, requesterIp });
        if (coldTail.ok) {
          return {
            jobId: null,
            status: 'completed',
            servedFromCorpus: true,
            coldTail: true,
            artifactId: null,
            intentSlug: coldTail.intentSlug,
            payload: coldTail.payload,
            url: coldTail.url,
            previewUrl: null,
          };
        }
        if (coldTail.status === 429) {
          const err = new Error('Rate limit exceeded for instant intent pages. Try again later.');
          err.statusCode = 429;
          throw err;
        }
        // Other failures (no catalog, screen reject already 400s upstream on
        // the seeded path, validation) fall through to live generation.
      }
    }

    // Per-job ownership token (CSPRNG). Binds the id-scoped read/write routes
    // (notify/status/strategy/preview) to whoever submitted the job, closing the
    // IDOR + notify-hijack without breaking anonymous lead capture (the caller
    // holds the token from this response).
    const jobToken = randomBytes(32).toString('hex');

    // Create work item in the task graph
    const metadata = {
      target_url: validation.url,
      target_url_normalized: normalized,
      requester_email: email || null,
      requester_ip: requesterIp,
      job_token: jobToken,
      // Front-door provenance (feature 008 §5, minimal). Inferred tier 0/1
      // classification persisted alongside requester_ip; the dedicated
      // attribution table is an open question (§10.1) deferred past this pass.
      front_door: {
        tier: classification.tier,
        platform: classification.platform,
        visitor_kind: classification.visitor_kind,
        intent_source: 'inferred',
      },
    };
    if (intent) metadata.visitor_intent = intent;

    // Style-intake fields — previously sent by the demo UI but dropped here.
    // Best-effort, shape/length guarded; consumed by the redesign blueprint.
    const strField = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    if (Array.isArray(styleDirections)) {
      metadata.style_directions = styleDirections
        .filter((d) => typeof d === 'string')
        .slice(0, 5)
        .map((d) => d.slice(0, 60));
    }
    if (Array.isArray(inspirationRefs)) {
      metadata.inspiration_refs = inspirationRefs.slice(0, 5).map((r) => ({
        name: strField(r?.name, 80),
        palette: Array.isArray(r?.palette)
          ? r.palette.filter((c) => typeof c === 'string').slice(0, 6).map((c) => c.slice(0, 16))
          : null,
        description: strField(r?.description, 200),
      }));
    }
    const primaryCtaVal = strField(primaryCta, 120);
    if (primaryCtaVal) metadata.primary_cta = primaryCtaVal;
    const keepVal = strField(keepFromCurrent, 200);
    if (keepVal) metadata.keep_from_current = keepVal;
    const industryVal = strField(classifiedIndustry, 80);
    if (industryVal) metadata.classified_industry = industryVal;
    const audienceVal = strField(classifiedAudience, 80);
    if (audienceVal) metadata.classified_audience = audienceVal;

    const result = await withRedesignScope(exec => exec(
      `INSERT INTO agent_graph.work_items
       (type, title, routing_class, metadata, status, assigned_to, created_by)
       VALUES ('task', $2, 'FULL', $1, 'assigned', 'executor-redesign', 'orchestrator')
       RETURNING id, status, created_at`,
      [JSON.stringify(metadata), `Redesign: ${validation.url}`]
    ));

    const jobId = result.rows[0].id;

    // Emit task event so executor-redesign agent can claim it
    await emit({
      eventType: 'task_created',
      workItemId: jobId,
      targetAgentId: 'executor-redesign',
      priority: 0,
      eventData: { target_url: validation.url },
    });

    await publishEvent(
      'redesign_submitted',
      `Website redesign submitted for ${validation.url}`,
      null, jobId,
      { target_url: validation.url }
    );

    return {
      jobId,
      status: 'created',
      createdAt: result.rows[0].created_at,
      // The caller MUST retain this to poll status / read preview / set notify.
      jobToken,
    };
  });

  // GET /api/redesign/status/:id — poll job status
  routes.set('GET /api/redesign/status/:id', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    if (!jobId) {
      const err = new Error('Missing job ID');
      err.statusCode = 400;
      throw err;
    }

    const result = await query(
      `SELECT id, status, metadata, created_at, updated_at
       FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );

    if (result.rows.length === 0) {
      // Return terminal status instead of 404 so frontend stops polling.
      // The job may have been cancelled, cleared, or never existed.
      return {
        jobId,
        status: 'failed',
        hasPreview: false,
        error: 'Job not found — it may have been cancelled or expired.',
        createdAt: null,
        updatedAt: null,
      };
    }

    const job = result.rows[0];
    const meta = job.metadata || {};

    // Ownership: only the submitter (job token) or admin may read a job's state.
    // Mismatch → 404 (do not disclose that the job exists). Same strict gating
    // as notify/strategy/preview — no anonymous fallback.
    const statusAccess = resolveStatusAccess(req, meta);
    if (statusAccess === 'deny') {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }

    // If HTML output exists, report as completed regardless of internal state
    // (the reaper may have timed out the task after the HTML was stored)
    const effectiveStatus = meta.html_output ? 'completed' : job.status;

    // Queue position: count jobs ahead of this one (created earlier, not yet completed)
    let queuePosition = null;
    if (['created', 'assigned'].includes(job.status) && !meta.html_output) {
      const queueResult = await query(
        `SELECT COUNT(*) AS cnt FROM agent_graph.work_items
         WHERE type = 'task' AND metadata ? 'target_url'
           AND status IN ('created', 'assigned', 'in_progress')
           AND created_at < $1
           AND id != $2`,
        [job.created_at, jobId]
      );
      queuePosition = parseInt(queueResult.rows[0].cnt, 10) + 1; // 1-indexed
    }

    return {
      jobId: job.id,
      status: effectiveStatus,
      hasPreview: !!meta.html_output,
      hasStrategy: !!meta.strategy_rationale,
      // Optimus-internal unit economics — the only non-customer-facing field in
      // this payload. Only authorized (token/admin) callers reach this line at
      // all, so it's always safe to return.
      costUsd: meta.cost_usd || null,
      auditBefore: meta.audit_before || null,
      auditAfter: meta.audit_after || null,
      aeoReport: meta.aeo_report || null,
      businessContext: meta.business_context || null,
      progressPhase: meta.progress_phase || null,
      heartbeatAt: meta.heartbeat_at || null,
      queuePosition,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  });

  // POST /api/redesign/notify — save email for completion notification
  routes.set('POST /api/redesign/notify', async (req, body) => {
    const { jobId, email } = body || {};
    if (!jobId || !email || typeof email !== 'string' || !email.includes('@')) {
      const err = new Error('Missing jobId or valid email');
      err.statusCode = 400;
      throw err;
    }

    // Ownership: notify writes an attacker-controllable email onto a job by id.
    // Require the job token (or admin) and match it against THIS job before the
    // write. Missing job OR mismatch → 404 (never confirm existence).
    // tenancy:allow-unscoped — public, un-tenanted lead-gen flow: a redesign job
    // has no owning org; access is bound by the per-job token (checked below via
    // isJobAccessAuthorized), not by tenancy. Same as the other by-id redesign
    // reads on this route.
    const owner = await query(
      `SELECT metadata FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );
    if (owner.rows.length === 0 || !isJobAccessAuthorized(req, body, owner.rows[0].metadata)) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }

    // Store email in the work item metadata
    await withRedesignScope(exec => exec(
      `UPDATE agent_graph.work_items
       SET metadata = metadata || jsonb_build_object('notify_email', $1::text)
       WHERE id = $2 AND type = 'task' AND metadata ? 'target_url'`,
      [email, jobId]
    ));

    return { ok: true };
  });

  // POST /api/redesign/:id/cancel — manually cancel a stuck job (requires API_SECRET)
  routes.set('POST /api/redesign/:id/cancel', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    // URL: /api/redesign/<id>/cancel → id is parts[parts.length - 2]
    const jobId = parts[parts.length - 2];

    // Verify it exists and is in a cancellable state
    const result = await query(
      `SELECT id, status FROM agent_graph.work_items WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );
    if (result.rows.length === 0) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }
    const job = result.rows[0];
    if (!['in_progress', 'assigned', 'created'].includes(job.status)) {
      const err = new Error(`Cannot cancel job in state: ${job.status}`);
      err.statusCode = 409;
      throw err;
    }

    await transitionState({
      workItemId: jobId,
      toState: 'cancelled',
      agentId: 'board',
      configHash: 'manual',
      reason: 'Manual cancellation by board',
      // OPT-166 P3-B5: this admin route authenticates via API_SECRET bearer, not
      // a board JWT (req.auth) — there is no board principal to scope under, so
      // run the transition as the redesign-intake system actor (state-machine.js
      // opens withSystemScope internally when systemActor is set). agentId stays
      // 'board' for the state_transitions audit record.
      systemActor: REDESIGN_SYSTEM_ACTOR,
    });

    return { jobId, status: 'cancelled' };
  });

  // POST /api/redesign/:id/retry — retry a stuck/failed/cancelled job (requires API_SECRET)
  routes.set('POST /api/redesign/:id/retry', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 2];

    const result = await query(
      `SELECT id, status, retry_count, assigned_to FROM agent_graph.work_items WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );
    if (result.rows.length === 0) {
      const err = new Error('Job not found');
      err.statusCode = 404;
      throw err;
    }
    const job = result.rows[0];
    if (!['in_progress', 'timed_out', 'failed', 'cancelled'].includes(job.status)) {
      const err = new Error(`Cannot retry job in state: ${job.status}`);
      err.statusCode = 409;
      throw err;
    }

    // If still in_progress, transition to timed_out first
    if (job.status === 'in_progress') {
      await transitionState({
        workItemId: jobId,
        toState: 'timed_out',
        agentId: 'board',
        configHash: 'manual',
        reason: 'Manual retry requested by board',
        // OPT-166 P3-B5 — see cancel handler above: API_SECRET bearer, no board
        // JWT, so scope the transition as the redesign-intake system actor.
        systemActor: REDESIGN_SYSTEM_ACTOR,
      });
    }

    // Increment retry count and reset to assigned
    await withRedesignScope(exec => exec(
      `UPDATE agent_graph.work_items SET retry_count = retry_count + 1, status = 'assigned', assigned_to = 'executor-redesign', updated_at = now() WHERE id = $1`,
      [jobId]
    ));

    // Emit event so executor-redesign picks it up
    await emit({
      eventType: 'task_assigned',
      workItemId: jobId,
      targetAgentId: 'executor-redesign',
      priority: 0,
      eventData: { retry: (job.retry_count || 0) + 1, reason: 'manual_retry' },
    });

    return { jobId, status: 'assigned', retryCount: (job.retry_count || 0) + 1 };
  });

  // DELETE /api/redesign/clear — admin: clear all redesign jobs (requires API_SECRET)
  routes.set('DELETE /api/redesign/clear', async (req) => {
    const authHeader = req.headers['authorization'] || '';
    const secret = process.env.API_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const err = new Error('Unauthorized');
      err.statusCode = 401;
      throw err;
    }

    const result = await withRedesignScope(exec => exec(
      `DELETE FROM agent_graph.work_items
       WHERE type = 'task' AND metadata ? 'target_url'
       RETURNING id, title, status`
    ));

    return {
      deleted: result.rowCount,
      jobs: result.rows.map(r => ({ id: r.id, title: r.title, status: r.status })),
    };
  });

  // GET /api/redesign/strategy/:id — serve strategy rationale as standalone page
  routes.set('GET /api/redesign/strategy/:id', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    const result = await query(
      `SELECT metadata FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'`,
      [jobId]
    );

    const meta = result.rows[0]?.metadata;
    // Ownership gate (admin or job token) BEFORE any disclosure. Same 404 as the
    // not-available case so an unauthorized caller cannot probe job existence.
    if (!meta || !isJobAccessAuthorized(req, null, meta) || !meta.strategy_rationale) {
      const err = new Error('Strategy rationale not available');
      err.statusCode = 404;
      throw err;
    }

    const targetUrl = meta.target_url || '';
    const domain = targetUrl ? new URL(targetUrl).hostname : 'site';
    const bc = meta.business_context || {};
    const rationale = meta.strategy_rationale;

    // Convert markdown to simple HTML for display
    const htmlBody = rationale
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Strategy Rationale — ${domain}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 40px 24px; color: #1a1a2e; line-height: 1.7; background: #fafafa; }
    h1 { color: #0f1923; border-bottom: 2px solid #22c55e; padding-bottom: 8px; }
    h2 { color: #1a2332; margin-top: 32px; }
    h3 { color: #334155; }
    li { margin: 4px 0; }
    strong { color: #0f1923; }
    .meta { color: #64748b; font-size: 14px; margin-bottom: 24px; }
    .badge { display: inline-block; background: #22c55e; color: #0f1923; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-right: 8px; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 13px; }
    footer a { color: #22c55e; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Strategy Rationale</h1>
  <div class="meta">
    <span class="badge">${bc.businessType || 'website'}</span>
    <span class="badge">${bc.audience || 'general'}</span>
    <span class="badge">goal: ${bc.primaryConversionGoal || 'contact'}</span>
    <br>Redesign of <strong>${domain}</strong>
  </div>
  <div>${htmlBody}</div>
  <footer>
    Generated by <a href="https://staqs.io">STAQS.IO</a> strategic redesign pipeline
  </footer>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(html);
    return '__sse__';
  });

  // GET /api/redesign/preview/:id — serve generated HTML directly from Postgres
  routes.set('GET /api/redesign/preview/:id', async (req, _body, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const jobId = parts[parts.length - 1];

    const result = await query(
      `SELECT metadata FROM agent_graph.work_items
       WHERE id = $1 AND type = 'task' AND metadata ? 'target_url'
         AND metadata ? 'html_output'`,
      [jobId]
    );

    const meta = result.rows[0]?.metadata;
    // Ownership gate (admin or job token) BEFORE serving generated output. Same
    // 404 as not-available so an unauthorized caller cannot probe job existence.
    if (!meta || !isJobAccessAuthorized(req, null, meta)) {
      const err = new Error('Preview not available');
      err.statusCode = 404;
      throw err;
    }
    const htmlOutput = meta.html_output;
    if (!htmlOutput) {
      const err = new Error('Preview not available');
      err.statusCode = 404;
      throw err;
    }

    // OUTBOUND PUBLISH GATE (P1 deny-by-default). Untrusted model output is only
    // served once it cleared the publish gate at the CURRENT safety version. A
    // page persisted before the gate existed (no publish_status / stale
    // safety_version) or one the gate blocked is withheld — never served.
    if (!isServable(meta)) {
      const err = new Error('Preview not available');
      err.statusCode = 404;
      throw err;
    }

    // Serve the self-contained HTML directly
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // CSP: deny-by-default. 'unsafe-inline' is confined to style-src only (the
      // generated landing pages need inline styles); it is NOT inherited by
      // default-src, so CSS injection via default-src is closed. script-src 'none'
      // blocks all JS. img-src drops data: (a data: SVG can carry active content)
      // and allows only same-origin + https: raster sources.
      'Content-Security-Policy': "default-src 'self' fonts.googleapis.com fonts.gstatic.com; script-src 'none'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(htmlOutput);
    return '__sse__'; // Signal to api.js that we handled the response
  });

}
