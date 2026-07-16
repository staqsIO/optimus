/**
 * generate_landing_page — MCP tool wrapping the PUBLIC redesign generator.
 *
 * Feature 008 tier-3 MVP ("agent declares intent → page"). A teammate describes
 * an intent in a chat (Claude Desktop/Code); this tool drives the same public
 * `/api/redesign/submit` → `/api/redesign/status/:id` → `/api/redesign/preview/:id`
 * flow the demo UI uses, and hands back a shareable preview URL.
 *
 * The redesign endpoints are PUBLIC (no auth — rate-limited instead), so this
 * module does NOT use client.js / OPTIMUS_TOKEN. It is a standalone, dependency-
 * free thin wrapper over global fetch. It is deliberately NOT part of
 * CUSTOMER_OPERATIONS — that registry is the kb + artifacts surface (Liotta);
 * this is a separate public-endpoint tool.
 *
 * The org-wide cap (10 generations / 24h) and the Model Armor inbound gate are
 * enforced server-side; this client just surfaces the resulting 429 / 400 with a
 * clear, human-readable message.
 */

const DEFAULT_API_BASE = 'https://preview.staqs.io';

// Poll cadence + ceiling for `wait` mode. Generation is async (~minutes) on the
// M1 runner; ~8 min at 10s intervals comfortably covers a normal run without
// hanging a chat session forever.
const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 8 * 60_000;

const TERMINAL_OK = 'completed';
const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'timed_out']);

/** Resolve the Board API base URL: explicit arg → OPTIMUS_API_BASE → OPTIMUS_API_URL → default. */
export function resolveApiBase(explicit) {
  const base = explicit
    || process.env.OPTIMUS_API_BASE
    || process.env.OPTIMUS_API_URL
    || DEFAULT_API_BASE;
  return String(base).replace(/\/+$/, '');
}

/** Build the public preview URL for a job id against a given base. */
export function previewUrlFor(apiBase, jobId) {
  return `${resolveApiBase(apiBase)}/api/redesign/preview/${encodeURIComponent(jobId)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalize a preview URL the submit response may hand back. The dedup branch
 * returns an absolute `meta.preview_url` (possibly null); the serve-by-corpus
 * branch returns a relative `/api/redesign/preview/<id>`. Fall back to the
 * canonical preview URL built from jobId. Returns an absolute URL or null.
 */
function resolvePreviewUrl(base, serverPreview, jobId) {
  if (typeof serverPreview === 'string' && serverPreview) {
    if (/^https?:\/\//i.test(serverPreview)) return serverPreview;
    return `${base}${serverPreview.startsWith('/') ? '' : '/'}${serverPreview}`;
  }
  return jobId ? previewUrlFor(base, jobId) : null;
}

/**
 * Drive a landing-page generation end to end.
 *
 * @param {Object}   opts
 * @param {string}   opts.url            - site to redesign (required)
 * @param {string}   opts.intent         - visitor intent → visitorIntent (required)
 * @param {boolean}  [opts.wait=true]    - poll to completion (true) or return the jobId immediately (false)
 * @param {string}   [opts.apiBase]      - Board API base URL override
 * @param {Function} [opts.fetchImpl]    - fetch override (tests inject a mock)
 * @param {number}   [opts.pollIntervalMs]
 * @param {number}   [opts.maxWaitMs]
 * @param {Function} [opts.sleepImpl]    - sleep override (tests inject a no-op)
 * @returns {Promise<Object>} result envelope (see shapes below)
 */
export async function generateLandingPage({
  url,
  intent,
  wait = true,
  apiBase,
  fetchImpl,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxWaitMs = MAX_WAIT_MS,
  sleepImpl = sleep,
} = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('generate_landing_page requires a non-empty { url }');
  }
  if (!intent || typeof intent !== 'string') {
    throw new Error('generate_landing_page requires a non-empty { intent }');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No fetch implementation available (Node >= 18 or pass fetchImpl)');
  }
  const base = resolveApiBase(apiBase);

  // ── 1. Submit ────────────────────────────────────────────────────────────
  const submitRes = await doFetch(`${base}/api/redesign/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, visitorIntent: intent }),
  });
  const submitData = await submitRes.json().catch(() => ({}));

  if (!submitRes.ok) {
    const message = submitData.error || `HTTP ${submitRes.status}`;
    if (submitRes.status === 429) {
      return {
        status: 'rate_limited',
        message: 'Daily generation cap reached — try again tomorrow.',
        detail: message,
      };
    }
    if (submitRes.status === 400) {
      // The inbound Model Armor gate rejects unsafe intents with a 400 before any
      // job is created (server attaches err.safetyBlock; only the message reaches
      // the body). Surface it as an unsafe-intent rejection.
      return {
        status: 'rejected',
        message: `Intent rejected as unsafe (or invalid request): ${message}`,
        detail: message,
      };
    }
    throw new Error(`submit failed (${submitRes.status}): ${message}`);
  }

  const jobId = submitData.jobId;
  const statusUrl = `${base}/api/redesign/status/${jobId}`;
  const previewUrl = previewUrlFor(base, jobId);

  // A dedup/serve-by-match/cold-tail hit can come back already 'completed' on
  // submit — the pre-warm path. Return the page immediately without polling.
  // Cold-tail (Phase 1.5) additionally carries `url`: a live, shareable
  // intent page on the target site itself — hand THAT to the human.
  if (submitData.status === TERMINAL_OK) {
    // Corpus/cold-tail serves have NO redesign preview artifact — their
    // artifactId is a corpus row id, and /api/redesign/preview/<corpus-id>
    // 404s (bit Eric live 2026-06-10). For those, the live intent page on the
    // site itself (`url`) IS the page — never fabricate a preview link.
    const fromCorpus = !!submitData.servedFromCorpus;
    return {
      jobId: jobId ?? (fromCorpus ? null : submitData.artifactId) ?? null,
      status: 'completed',
      previewUrl: fromCorpus
        ? null
        : resolvePreviewUrl(base, submitData.previewUrl, jobId ?? submitData.artifactId),
      deduplicated: !!submitData.deduplicated,
      servedFromCorpus: fromCorpus,
      ...(submitData.coldTail ? { coldTail: true } : {}),
      ...(submitData.url ? { url: submitData.url } : {}),
      ...(submitData.intentSlug ? { intentSlug: submitData.intentSlug } : {}),
      ...(fromCorpus && submitData.url
        ? { message: 'Served from the intent corpus — `url` is the live page on the site; share that link.' }
        : {}),
    };
  }

  // ── 2. Fire-and-return (wait === false) ──────────────────────────────────
  if (!wait) {
    return {
      jobId,
      status: submitData.status || 'created',
      statusUrl,
      previewUrl,
      message: 'Generation started. Poll statusUrl; the page appears at previewUrl when status is completed.',
    };
  }

  // ── 3. Poll to completion ────────────────────────────────────────────────
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const statusRes = await doFetch(statusUrl, { method: 'GET' });
    const statusData = await statusRes.json().catch(() => ({}));
    if (!statusRes.ok) continue; // transient — keep polling until the deadline

    const s = statusData.status;
    if (s === TERMINAL_OK) {
      return {
        jobId,
        status: 'completed',
        previewUrl,
        costUsd: statusData.costUsd ?? null,
      };
    }
    if (TERMINAL_FAIL.has(s)) {
      return {
        jobId,
        status: 'failed',
        message: statusData.error || `Generation ${s}.`,
        statusUrl,
      };
    }
    // created | assigned | in_progress → keep waiting
  }

  // ── 4. Timeout (still running) ───────────────────────────────────────────
  return {
    jobId,
    status: 'generating',
    previewUrl,
    statusUrl,
    message: 'Still generating — check previewUrl shortly (it returns the page once published).',
  };
}

/**
 * Register the `generate_landing_page` MCP tool on a server.
 *
 * Imported by index.js. Kept separate so the pure driver (generateLandingPage)
 * stays testable without the MCP SDK. `z` is the same zod the server uses.
 */
export function registerGenerateLandingPage(server, z) {
  server.tool(
    'generate_landing_page',
    'Generate a bespoke, intent-targeted landing page for a site and return a shareable preview URL. '
      + 'Describe what the visitor is looking for (the intent) and the tool drives the Optimus redesign '
      + 'generator: it foregrounds the products/messaging that match the intent. By default it waits for '
      + 'generation to finish (~minutes) and returns the live preview URL. Re-running the same url+intent '
      + 'returns the cached page instantly (server-side dedup) — a cheap pre-warm.',
    {
      url: z.string().describe('The site to redesign, e.g. https://allbirds.com'),
      intent: z.string().describe('What the visitor is looking for / their intent, e.g. "waterproof rain shoes"'),
      wait: z.boolean().optional().describe(
        'Wait for generation to complete and return the live preview URL (default true). '
        + 'Set false to return immediately with the jobId + status URL.',
      ),
    },
    async ({ url, intent, wait = true }) => {
      const result = await generateLandingPage({ url, intent, wait });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
