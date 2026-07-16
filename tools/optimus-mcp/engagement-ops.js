/**
 * Engagement operations — the board-only "engagement → living spec → tailored
 * proposal" surface of the Optimus MCP.
 *
 * Same philosophy as CUSTOMER_OPERATIONS in client.js: the HTTP mapping for each
 * verb is defined in ONE place (here) and consumed by index.js, so the MCP tool
 * and its HTTP call can never drift. Kept dependency-free (no zod) so the
 * autobot-inbox test suite can import it and pin every method/path/body against
 * a mock fetch, offline.
 *
 * These are board-operator routes (tier `org-shared`, viewer-scoped). They are
 * deliberately NOT in CUSTOMER_OPERATIONS, so the customer-token filter in
 * index.js (server.tool wrapper) keeps them off the customer surface — a board
 * token registers them, a customer token never sees them.
 *
 * Ownership is derived server-side from OPTIMUS_TOKEN; the create/add verbs
 * accept an OPTIONAL on_behalf_of_org_id (a validated selection among orgs you
 * own) but never a raw owner_org_id (the API rejects that as a spoof).
 *
 * Each op: { tool, summary, run(api, args) } where run performs the single
 * Board API call. `api` is the createApi() client: api(method, path, body?).
 */

// Valid engagement kinds and create-time statuses, mirrored from the API
// (autobot-inbox/src/api-routes/engagements.js — see VALID_KINDS /
// CREATE_STATUSES near the top of that file; keep these in sync if the route
// adds values). Kept here for the zod schema in index.js and for
// self-documentation; the API is the enforcing boundary.
export const ENGAGEMENT_KINDS = ['website', 'mobile_app', 'api', 'other', 'advisory'];
export const ENGAGEMENT_CREATE_STATUSES = ['prospect', 'active'];
export const PROPOSAL_SOURCE_TYPES = ['paste', 'url', 'upload'];
export const PROPOSAL_KINDS = ['draft', 'finalized', 'note'];
export const PROPOSAL_FORMATS = ['md', 'docx', 'gdoc'];

const enc = encodeURIComponent;

/** Drop undefined/null keys so we only send what the caller actually set. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export const ENGAGEMENT_OPERATIONS = [
  {
    tool: 'optimus_engagements',
    summary: 'List engagements (org-scoped). Each is a client/project workspace whose Living spec synthesizes into a tailored proposal.',
    run: (api, a) => {
      const params = new URLSearchParams();
      if (a.status) params.set('status', a.status);
      const qs = params.toString();
      return api('GET', `/api/engagements${qs ? `?${qs}` : ''}`);
    },
  },
  {
    tool: 'optimus_engagement',
    summary: 'Get one engagement: its Living spec, sections, ingested proposals (sources), and open conflicts.',
    run: (api, a) => api('GET', `/api/engagements/${enc(a.id)}`),
  },
  {
    tool: 'optimus_create_engagement',
    summary: 'Start a new engagement. Seeds a Living spec that inherits baseline standards from the Master spec at synth time.',
    run: (api, a) => api('POST', '/api/engagements', compact({
      name: a.name,
      client: a.client,
      kind: a.kind,
      status: a.status,
      on_behalf_of_org_id: a.on_behalf_of_org_id,
    })),
  },
  {
    tool: 'optimus_add_engagement_proposal',
    summary: 'Add a source ("proposal") to an engagement — pasted text, a public URL, or an uploaded file (base64). These feed the Living spec at synth time.',
    run: (api, a) => {
      const body = compact({
        kind: a.kind || 'draft',
        title: a.title,
        on_behalf_of_org_id: a.on_behalf_of_org_id,
      });
      const sourceType = a.source_type || (a.url ? 'url' : a.content_b64 ? 'upload' : 'paste');
      body.source_type = sourceType;
      if (sourceType === 'paste') {
        if (!a.content) throw new Error('source_type "paste" requires content');
        body.content = a.content;
      } else if (sourceType === 'url') {
        if (!a.url) throw new Error('source_type "url" requires url');
        body.url = a.url;
      } else if (sourceType === 'upload') {
        if (!a.content_b64 || !a.filename) {
          throw new Error('source_type "upload" requires content_b64 and filename');
        }
        body.content_b64 = a.content_b64;
        body.filename = a.filename;
      } else {
        throw new Error(`unknown source_type "${sourceType}" (paste|url|upload)`);
      }
      return api('POST', `/api/engagements/${enc(a.id)}/proposals`, body);
    },
  },
  {
    tool: 'optimus_synthesize_engagement',
    summary: 'Re-synthesize the Living spec from all source proposals + the Master-spec baseline. ASYNC: returns immediately with status "synthesizing"; poll optimus_engagement until the spec version bumps (~30-90s). dry_run=true returns a synchronous preview without persisting.',
    run: (api, a) => api('POST', `/api/engagements/${enc(a.id)}/synthesize`, compact({
      dry_run: a.dry_run,
      model_key: a.model_key,
    })),
  },
  {
    tool: 'optimus_generate_proposal',
    summary: 'Generate the deliverable proposal from the synthesized Living spec. Master engagement → generic bracketed template; client engagement → TAILORED proposal with brackets filled from real meetings/emails. format: md|docx|gdoc (default md). Cached per spec version unless force=true.',
    run: (api, a) => api('POST', `/api/engagements/${enc(a.id)}/generate-proposal`, compact({
      format: a.format || 'md',
      force: a.force,
    })),
  },
  {
    tool: 'optimus_list_generated_proposals',
    summary: 'List the generated proposal deliverables for an engagement (each tied to a spec version + mode), newest first.',
    run: (api, a) => api('GET', `/api/engagements/${enc(a.id)}/generated-proposals`),
  },
];

/** Look up an engagement operation by its MCP tool name. */
export function findEngagementOperation(tool) {
  return ENGAGEMENT_OPERATIONS.find((op) => op.tool === tool) || null;
}
