/**
 * Shared Optimus access client — OPT-37.
 *
 * The Board API is the thin HTTP security boundary (JWT auth, rate limiting,
 * scope enforcement, the customer ceiling). Every transport — MCP server
 * (index.js), CLI (cli.js), or a customer's own direct `fetch` — is just a way
 * to call that one HTTP surface. This module is the ONE place the customer
 * operation set is defined, so the MCP tools and the CLI can never drift: both
 * import `CUSTOMER_OPERATIONS` and `createApi` from here.
 *
 * Dependency-free on purpose (no MCP SDK, no zod) so it imports cleanly from the
 * autobot-inbox test suite and from a lightweight CLI.
 */

const DEFAULT_API_URL = 'https://preview.staqs.io';

/**
 * Decode the `iss` claim of a JWT WITHOUT verifying it. The Board API verifies
 * every token; this is only used client-side to decide which tools/commands to
 * surface. Returns null on any malformed input.
 */
export function tokenIssuer(jwt) {
  try {
    const payload = String(jwt).split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    return JSON.parse(json).iss || null;
  } catch {
    return null;
  }
}

/** True for an external customer token (iss 'optimus-customer'). */
export function isCustomerToken(jwt) {
  return tokenIssuer(jwt) === 'optimus-customer';
}

/**
 * Build the thin HTTP client. Returns `api(method, path, body)`.
 *
 * @param {Object}   opts
 * @param {string}   opts.token       - OPTIMUS_TOKEN (board or customer JWT)
 * @param {string}   [opts.apiUrl]    - Board API base URL
 * @param {Function} [opts.fetchImpl] - fetch override (tests inject a mock)
 * @param {number}   [opts.timeoutMs] - per-request timeout (default 30s)
 */
export function createApi({ token, apiUrl, fetchImpl, timeoutMs = 30_000 } = {}) {
  if (!token) throw new Error('createApi requires { token }');
  const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No fetch implementation available (Node >= 18 or pass fetchImpl)');
  }

  return async function api(method, path, body = null) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    // AbortSignal.timeout isn't available on every runtime the customer may use.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(timeoutMs);
    }
    const res = await doFetch(`${base}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.reason ? ` (${data.reason})` : '';
      throw new Error(`${method} ${path} → ${res.status}: ${data.error || JSON.stringify(data)}${reason}`);
    }
    return data;
  };
}

const ARTIFACT_KINDS = ['prd', 'proposal', 'spec', 'adr', 'brief', 'deck', 'transcript', 'summary', 'doc', 'other'];

/**
 * The customer-safe operation set — the org-shared "company brain" surface a
 * customer token can reach (kb:* + artifacts:* scopes). This is the SAME set
 * the MCP server exposes as CUSTOMER_SAFE_TOOLS; the `tool` field cross-links
 * them. Each operation declares its CLI `command`, argument spec (for parsing +
 * `--help`), and a `run(api, args)` that performs the single HTTP call.
 *
 * Arg spec entry: { name, positional?, required?, type ('string'|'number'),
 *   enum?, default?, describe }. Positional args are filled in order; the rest
 * are `--flag value` options.
 */
export const CUSTOMER_OPERATIONS = [
  {
    command: 'search',
    tool: 'optimus_search_kb',
    summary: 'Search the Optimus knowledge base (RAG).',
    args: [
      { name: 'query', positional: true, required: true, describe: 'Search query' },
      { name: 'limit', type: 'number', default: 5, describe: 'Max results (default 5)' },
    ],
    run: (api, a) => api('POST', '/api/search', { query: a.query, limit: a.limit ?? 5 }),
  },
  {
    command: 'ingest-doc',
    tool: 'optimus_ingest_document',
    summary: 'Push a document (PRD, spec, research, notes) into the knowledge base.',
    args: [
      { name: 'title', required: true, describe: 'Document title' },
      { name: 'raw', describe: 'Full raw text/markdown (or pass --file / pipe stdin)' },
      { name: 'file', describe: 'Read raw content from this file path' },
      { name: 'format', enum: ['plain', 'markdown'], default: 'markdown', describe: 'Content format (default markdown)' },
    ],
    run: (api, a) => api('POST', '/api/ingest', {
      source: 'mcp-upload', title: a.title, raw: a.raw, format: a.format ?? 'markdown',
    }),
  },
  {
    command: 'ingest-transcript',
    tool: 'optimus_ingest_transcript',
    summary: 'Push a raw meeting transcript (TLDV / Granola / Gemini) into the KB.',
    args: [
      { name: 'title', required: true, describe: 'Meeting title' },
      { name: 'raw', describe: 'Full raw transcript (or pass --file / pipe stdin)' },
      { name: 'file', describe: 'Read transcript from this file path' },
      { name: 'format', enum: ['plain', 'tldv', 'gemini'], default: 'plain', describe: 'Transcript format (default plain)' },
    ],
    run: (api, a) => api('POST', '/api/ingest', {
      source: 'transcript', title: a.title, raw: a.raw, format: a.format ?? 'plain',
    }),
  },
  {
    command: 'push-summary',
    tool: 'optimus_push_summary',
    summary: 'Push a daily summary of what you worked on into the KB.',
    args: [
      { name: 'text', describe: 'Summary text/markdown (or pass --file / pipe stdin)' },
      { name: 'file', describe: 'Read summary from this file path' },
      { name: 'date', describe: 'ISO date the summary covers (default: today)' },
    ],
    run: (api, a) => api('POST', '/api/ingest', {
      source: 'daily-summary',
      title: `Daily summary${a.date ? ` — ${a.date}` : ''}`,
      raw: a.text,
      format: 'markdown',
    }),
  },
  {
    command: 'ingest-artifact',
    tool: 'optimus_ingest_artifact',
    summary: 'Route a typed artifact (registry + KB) in one call. Same title = new version.',
    args: [
      { name: 'title', required: true, describe: 'Artifact title (the per-artifact identity)' },
      { name: 'kind', required: true, enum: ARTIFACT_KINDS, describe: 'Artifact type' },
      { name: 'raw', describe: 'Full raw text/markdown (or pass --file / pipe stdin)' },
      { name: 'file', describe: 'Read raw content from this file path' },
    ],
    run: (api, a) => api('POST', '/api/artifacts', { raw: a.raw, kind: a.kind, title: a.title }),
  },
  {
    command: 'capture-url',
    tool: 'optimus_capture_url',
    summary: 'Fetch a URL / Drive doc, normalize it, route it as a typed artifact.',
    args: [
      { name: 'url', positional: true, required: true, describe: 'Public URL to fetch and capture' },
      { name: 'kind', enum: ARTIFACT_KINDS, default: 'doc', describe: 'Artifact type (default doc)' },
    ],
    run: (api, a) => api('POST', '/api/artifacts', { url: a.url, kind: a.kind ?? 'doc' }),
  },
  {
    command: 'list-artifacts',
    tool: 'optimus_list_artifacts',
    summary: 'List managed artifacts (org-scoped). Optional kind/status filters.',
    args: [
      { name: 'kind', enum: ARTIFACT_KINDS, describe: 'Filter by artifact kind' },
      { name: 'status', enum: ['active', 'superseded', 'archived'], describe: 'Filter by status' },
    ],
    run: (api, a) => {
      const params = new URLSearchParams();
      if (a.kind) params.set('kind', a.kind);
      if (a.status) params.set('status', a.status);
      const qs = params.toString();
      return api('GET', `/api/artifacts${qs ? `?${qs}` : ''}`);
    },
  },
  {
    command: 'get-artifact',
    tool: 'optimus_get_artifact',
    summary: 'Get one artifact and its full version lineage by id (org-scoped).',
    args: [
      { name: 'id', positional: true, required: true, describe: 'Artifact UUID' },
    ],
    run: (api, a) => api('GET', `/api/artifacts/${encodeURIComponent(a.id)}`),
  },
  {
    command: 'enrich-contact',
    tool: 'optimus_enrich_contact',
    summary: 'Everything Optimus has captured + linked about a contact (org-scoped).',
    args: [
      { name: 'id', positional: true, required: true, describe: 'Contact id (signal.contacts.id)' },
    ],
    run: (api, a) => api('GET', `/api/artifacts/enrich/contact/${encodeURIComponent(a.id)}`),
  },
  {
    command: 'enrich-project',
    tool: 'optimus_enrich_project',
    summary: 'Everything Optimus has captured + linked about a project (org-scoped).',
    args: [
      { name: 'id', positional: true, required: true, describe: 'Project id (agent_graph.projects.id)' },
    ],
    run: (api, a) => api('GET', `/api/artifacts/enrich/project/${encodeURIComponent(a.id)}`),
  },
];

/** Look up an operation by its CLI command name. */
export function findOperation(command) {
  return CUSTOMER_OPERATIONS.find((op) => op.command === command) || null;
}
