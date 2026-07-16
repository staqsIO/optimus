import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'executor-redesign' });

// Server-to-server client for the canonical AEO scoring backend (the same
// Railway service ~/aeo-app's ApiClient talks to). We hit the backend directly
// rather than the public aeo.staqs.io Next.js layer so we bypass its public
// abuse caps (3 audits/hour PER IP — fatal for a single-IP server caller) and
// authenticate as a trusted caller via X-API-Key.
//
// Contract (mirrors aeo-app/src/lib/api/client.ts):
//   POST {AEO_API_URL}/api/audits/   body { domain }  → Audit
//   GET  {AEO_API_URL}/api/audits/{id}                 → Audit (poll)
//   Audit = { id, status, scores?: { overall_score, categories, score_version,
//             generated_at }, recommendations?: [...] }
//
// Dormant until AEO_API_URL is set on this service — returns null with no
// behavior change. Best-effort throughout: never throws, never blocks the job.

const REQ_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_MS = 90_000;
const MAX_RECOMMENDATIONS = 5;

function authHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.AEO_API_KEY) h['X-API-Key'] = process.env.AEO_API_KEY;
  return h;
}

async function apiFetch(path, init = {}) {
  const base = process.env.AEO_API_URL.replace(/\/$/, '');
  const res = await fetch(base + path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    redirect: 'error', // trusted backend — no redirect chasing
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AEO ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Pull a numeric score out of a category node whose inner shape we don't fully
 * own (the backend payload is Record<string, unknown>). Best-effort.
 */
function categoryScore(val) {
  if (typeof val === 'number') return Math.round(val);
  if (val && typeof val === 'object') {
    const s = val.score ?? val.overall_score ?? val.value;
    if (typeof s === 'number') return Math.round(s);
  }
  return null;
}

function summarize(audit, domain) {
  const scores = audit.scores || {};
  const categoryScores = {};
  for (const [key, val] of Object.entries(scores.categories || {})) {
    const s = categoryScore(val);
    if (s !== null) categoryScores[key] = s;
  }
  const recs = Array.isArray(audit.recommendations) ? audit.recommendations : [];
  const recommendations = recs
    .map((r) => ({
      title: String(r?.title ?? r?.name ?? '').slice(0, 160),
      description: String(r?.description ?? r?.summary ?? '').slice(0, 400),
      priority: r?.priority ?? null,
    }))
    .filter((r) => r.title)
    .slice(0, MAX_RECOMMENDATIONS);

  return {
    domain,
    auditId: audit.id || null,
    overallScore: typeof scores.overall_score === 'number' ? Math.round(scores.overall_score) : null,
    categoryScores,
    recommendations,
    scoreVersion: scores.score_version || audit.score_version || null,
    auditedAt: scores.generated_at || audit.updated_at || null,
  };
}

/**
 * Run a canonical AEO audit for a domain via the backend. Returns a compact
 * summary, or null if the service is unconfigured / slow / down / errored.
 *
 * @param {string} domain  bare hostname, e.g. "example.com"
 * @param {{ maxPollMs?: number }} [opts]
 * @returns {Promise<object|null>}
 */
export async function scoreDomainAEO(domain, { maxPollMs = DEFAULT_MAX_POLL_MS } = {}) {
  if (!process.env.AEO_API_URL) return null; // dormant until configured
  if (!domain || typeof domain !== 'string') return null;

  try {
    let audit = await apiFetch('/api/audits/', {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });

    const startedAt = Date.now();
    while (
      audit &&
      audit.status !== 'completed' &&
      audit.status !== 'failed' &&
      Date.now() - startedAt < maxPollMs
    ) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      audit = await apiFetch(`/api/audits/${audit.id}`, { method: 'GET' });
    }

    if (!audit || audit.status !== 'completed' || !audit.scores) {
      log.warn(` AEO audit not ready for ${domain} (status=${audit?.status || 'none'})`);
      return null;
    }
    const summary = summarize(audit, domain);
    log.info(` AEO canonical: ${domain} → overall=${summary.overallScore}, ${summary.recommendations.length} recs`);
    return summary;
  } catch (err) {
    log.warn(` AEO audit failed for ${domain} (non-fatal): ${err.message}`);
    return null;
  }
}
