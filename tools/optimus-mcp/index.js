#!/usr/bin/env node
/**
 * Optimus MCP Server — Board API tools for Claude Code.
 *
 * Replaces the Colima/OpenShell/OpenClaw sandbox stack with a lightweight
 * MCP server that board members add to their Claude Code config. The Board
 * API Gateway (JWT auth, rate limiting, scope enforcement) IS the security
 * boundary. No sandbox needed.
 *
 * Env vars:
 *   OPTIMUS_TOKEN    — Board member JWT (issued via issue-token.js)
 *   OPTIMUS_API_URL  — Board API base URL (default: https://preview.staqs.io)
 */

import os from 'os';
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createApi, isCustomerToken, CUSTOMER_OPERATIONS } from './client.js';
import { registerGenerateLandingPage } from './generate-landing-page.js';
import {
  ENGAGEMENT_OPERATIONS,
  ENGAGEMENT_KINDS,
  ENGAGEMENT_CREATE_STATUSES,
  PROPOSAL_SOURCE_TYPES,
  PROPOSAL_KINDS,
  PROPOSAL_FORMATS,
} from './engagement-ops.js';

const TOKEN = process.env.OPTIMUS_TOKEN;
const API_URL = process.env.OPTIMUS_API_URL || 'https://preview.staqs.io';

if (!TOKEN) {
  console.error('OPTIMUS_TOKEN env var required. Run: node issue-token.js <github-username>');
  process.exit(1);
}

// ============================================================
// Token class detection (OPT-37)
// ============================================================
// An 'optimus-customer' token is an external, org-scoped principal: it can only
// reach the org-shared "company brain" surface (KB + artifacts + enrichment).
// We register ONLY that set and skip the board-agent heartbeat. This is
// defense-in-depth + UX — the server's customer ceiling is the actual boundary
// (a board-only call returns 403 regardless of exposure). The detection helper
// and the customer operation set both live in client.js so the MCP server and
// the CLI (cli.js) can never drift.

const IS_CUSTOMER = isCustomerToken(TOKEN);

// The customer-safe tool set — derived from the shared CUSTOMER_OPERATIONS
// registry (client.js) so it stays in lockstep with the CLI.
const CUSTOMER_SAFE_TOOLS = new Set(CUSTOMER_OPERATIONS.map((op) => op.tool));

// ============================================================
// HTTP client (thin wrapper over Board API — shared with the CLI)
// ============================================================

const api = createApi({ token: TOKEN, apiUrl: API_URL });

// Run a customer-safe operation by its MCP tool name through the shared registry,
// returning the MCP text-content envelope. Guarantees the MCP tool and the CLI
// hit the identical endpoint + body for every customer operation.
function customerOp(toolName) {
  const op = CUSTOMER_OPERATIONS.find((o) => o.tool === toolName);
  if (!op) throw new Error(`no shared operation for ${toolName}`);
  return async (args) => {
    const data = await op.run(api, args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  };
}

// ============================================================
// MCP Server
// ============================================================

const server = new McpServer({
  name: 'optimus',
  version: '1.0.0',
});

// OPT-37: for an external customer token, only register the customer-safe tool
// set. Wrap server.tool so every registration below is filtered without editing
// each call. A board token registers everything (no-op filter).
const _registerTool = server.tool.bind(server);
server.tool = (name, ...rest) => {
  if (IS_CUSTOMER && !CUSTOMER_SAFE_TOOLS.has(name)) return undefined;
  return _registerTool(name, ...rest);
};

// --- Pipeline Health ---

server.tool(
  'optimus_health',
  'Check Optimus pipeline health: queue stats, stuck tasks, agent status',
  {},
  async () => {
    const [health, agents] = await Promise.all([
      api('GET', '/api/pipeline/health'),
      api('GET', '/api/agents/status'),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ health, agents }, null, 2) }] };
  }
);

// --- Inbox ---

server.tool(
  'optimus_inbox',
  'List recent emails in the Optimus inbox with triage results',
  {
    limit: z.number().optional().describe('Max emails to return (default 20)'),
    status: z.string().optional().describe('Filter by status: pending, triaged, archived'),
  },
  async ({ limit = 20, status }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    const data = await api('GET', `/api/runs?${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Drafts / Proposals ---

server.tool(
  'optimus_drafts',
  'List draft replies and action proposals awaiting board review',
  {
    status: z.string().optional().describe('Filter: pending, approved, rejected, sent'),
  },
  async ({ status }) => {
    const params = status ? `?status=${status}` : '';
    const data = await api('GET', `/api/drafts${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_approve_draft',
  'Approve a draft reply or action proposal',
  {
    id: z.string().describe('Draft/proposal UUID to approve'),
  },
  async ({ id }) => {
    const data = await api('POST', '/api/drafts/approve', { id });
    return { content: [{ type: 'text', text: `Approved: ${id}\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_reject_draft',
  'Reject a draft reply with feedback for the agent to try again',
  {
    id: z.string().describe('Draft/proposal UUID to reject'),
    feedback: z.string().describe('Why this draft was rejected — agents will use this to improve'),
  },
  async ({ id, feedback }) => {
    const data = await api('POST', '/api/drafts/reject', { id, feedback });
    return { content: [{ type: 'text', text: `Rejected: ${id}\n${JSON.stringify(data)}` }] };
  }
);

// --- Signals ---

server.tool(
  'optimus_signals',
  'List extracted signals (priorities, deadlines, commitments, opportunities)',
  {
    limit: z.number().optional().describe('Max signals to return (default 20)'),
  },
  async ({ limit = 20 }) => {
    const data = await api('GET', `/api/signals?limit=${limit}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Campaigns ---

server.tool(
  'optimus_campaigns',
  'List campaigns with status, scores, and iteration counts',
  {
    status: z.string().optional().describe('Filter: pending_approval, approved, running, completed, failed'),
  },
  async ({ status }) => {
    const params = status ? `?status=${status}` : '';
    const data = await api('GET', `/api/campaigns${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_campaign_detail',
  'Get detailed campaign info including iterations, output, and PR link',
  {
    id: z.string().describe('Campaign UUID'),
  },
  async ({ id }) => {
    const data = await api('GET', `/api/campaigns/${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_create_campaign',
  'Submit a new campaign for the agent organization to execute',
  {
    goal: z.string().describe('What should be built or done — be specific'),
    budget_usd: z.number().optional().describe('Budget envelope in USD (default $10)'),
    max_iterations: z.number().optional().describe('Max improvement iterations (default 20)'),
    success_criteria: z.string().optional().describe('What "done" looks like'),
    files: z.array(z.object({
      name: z.string(),
      content: z.string(),
    })).optional().describe('Context files to include with the campaign'),
  },
  async ({ goal, budget_usd, max_iterations, success_criteria, files }) => {
    const body = {
      goal_description: goal,
      budget_envelope_usd: budget_usd || 10,
      max_iterations: max_iterations || 20,
    };
    if (success_criteria) {
      body.success_criteria = [{ metric: 'quality_score', operator: '>=', threshold: 0.85, description: success_criteria }];
    }
    if (files?.length) {
      body.metadata = { uploaded_files: files };
    }
    const data = await api('POST', '/api/campaigns', body);
    return { content: [{ type: 'text', text: `Campaign created: ${data.campaign_id || JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_approve_campaign',
  'Approve a pending campaign to start execution',
  {
    id: z.string().describe('Campaign UUID to approve'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/campaigns/${id}/approve`);
    return { content: [{ type: 'text', text: `Campaign ${id} approved.\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_pause_campaign',
  'Pause a running campaign',
  {
    id: z.string().describe('Campaign UUID to pause'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/campaigns/${id}/pause`);
    return { content: [{ type: 'text', text: `Campaign ${id} paused.\n${JSON.stringify(data)}` }] };
  }
);

// --- Build (Orchestrator Tasks) ---

server.tool(
  'optimus_build',
  'Submit a task directly to the orchestrator pipeline (for quick operations)',
  {
    prompt: z.string().describe('What to do — routes to the best agent automatically'),
  },
  async ({ prompt }) => {
    const data = await api('POST', '/api/board/build', { prompt });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_build_status',
  'Check the status of an orchestrator build task',
  {
    id: z.string().describe('Work item UUID'),
  },
  async ({ id }) => {
    const data = await api('GET', `/api/board/build?id=${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

// --- Intents ---

server.tool(
  'optimus_intents',
  'List pending intents (proposed agent actions awaiting board approval)',
  {},
  async () => {
    const data = await api('GET', '/api/intents');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  'optimus_approve_intent',
  'Approve a pending intent',
  {
    id: z.string().describe('Intent UUID'),
  },
  async ({ id }) => {
    const data = await api('POST', `/api/intents/${id}/approve`);
    return { content: [{ type: 'text', text: `Intent ${id} approved.\n${JSON.stringify(data)}` }] };
  }
);

server.tool(
  'optimus_reject_intent',
  'Reject a pending intent with feedback',
  {
    id: z.string().describe('Intent UUID'),
    feedback: z.string().describe('Reason for rejection'),
  },
  async ({ id, feedback }) => {
    const data = await api('POST', `/api/intents/${id}/reject`, { feedback });
    return { content: [{ type: 'text', text: `Intent ${id} rejected.\n${JSON.stringify(data)}` }] };
  }
);

// --- Engagements (board-only: engagement → Living spec → tailored proposal) ---
// Registered from the shared ENGAGEMENT_OPERATIONS registry (engagement-ops.js)
// so the MCP tool and its HTTP call can never drift, and the registry can be
// unit-tested against a mock api offline. NOT in CUSTOMER_OPERATIONS, so the
// customer-token filter on server.tool keeps them off the customer surface.

// Run an engagement operation by tool name through the shared registry,
// returning the MCP text-content envelope.
function engagementOp(toolName) {
  const op = ENGAGEMENT_OPERATIONS.find((o) => o.tool === toolName);
  if (!op) throw new Error(`no engagement operation for ${toolName}`);
  return async (args) => {
    const data = await op.run(api, args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  };
}

server.tool(
  'optimus_engagements',
  'List engagements (org-scoped). Each engagement is a client/project workspace whose Living spec synthesizes into a tailored proposal.',
  {
    status: z.string().optional().describe('Filter by lifecycle status (e.g. prospect, active, won)'),
  },
  ({ status }) => engagementOp('optimus_engagements')({ status })
);

server.tool(
  'optimus_engagement',
  'Get one engagement: its Living spec, sections, ingested proposals (sources), and open conflicts.',
  {
    id: z.string().describe('Engagement UUID'),
  },
  ({ id }) => engagementOp('optimus_engagement')({ id })
);

server.tool(
  'optimus_create_engagement',
  'Start a new engagement. Seeds a Living spec that inherits baseline standards from the Master spec at synth time. Ownership is derived from your token; on_behalf_of_org_id selects among orgs you own.',
  {
    name: z.string().describe('Engagement name (e.g. "Acme Marketing Site")'),
    client: z.string().optional().describe('Client / company name (e.g. "Acme Corp")'),
    kind: z.enum(ENGAGEMENT_KINDS).optional().describe('Engagement kind (default: other)'),
    status: z.enum(ENGAGEMENT_CREATE_STATUSES).optional().describe('Create-time status (default: prospect; advance later)'),
    on_behalf_of_org_id: z.string().optional().describe('Authoring org id (must be an org you own)'),
  },
  ({ name, client, kind, status, on_behalf_of_org_id }) =>
    engagementOp('optimus_create_engagement')({ name, client, kind, status, on_behalf_of_org_id })
);

server.tool(
  'optimus_add_engagement_proposal',
  'Add a source ("proposal") to an engagement — pasted text, a public URL, or an uploaded file (base64). These feed the Living spec at synth time. Note: this is an engagement SOURCE, distinct from action proposals (optimus_drafts).',
  {
    id: z.string().describe('Engagement UUID'),
    source_type: z.enum(PROPOSAL_SOURCE_TYPES).optional().describe('paste | url | upload (inferred from which content field you set)'),
    kind: z.enum(PROPOSAL_KINDS).optional().describe('Source kind (default: draft)'),
    title: z.string().optional().describe('Title (optional; auto-derived from content)'),
    content: z.string().optional().describe('Raw text/markdown — for source_type "paste"'),
    url: z.string().optional().describe('Public URL — for source_type "url"'),
    content_b64: z.string().optional().describe('Base64 file bytes — for source_type "upload" (.md/.txt/.pdf/.docx)'),
    filename: z.string().optional().describe('Filename with extension — required with content_b64'),
    on_behalf_of_org_id: z.string().optional().describe('Authoring org id (must be an org you own)'),
  },
  (args) => engagementOp('optimus_add_engagement_proposal')(args)
);

server.tool(
  'optimus_synthesize_engagement',
  'Re-synthesize the Living spec from all source proposals + the Master-spec baseline. ASYNC: returns immediately with status "synthesizing"; poll optimus_engagement until the spec version bumps (~30-90s typical). dry_run=true returns a synchronous preview without persisting.',
  {
    id: z.string().describe('Engagement UUID'),
    dry_run: z.boolean().optional().describe('Return a synchronous preview without persisting'),
    model_key: z.string().optional().describe('Override the synthesis model'),
  },
  ({ id, dry_run, model_key }) =>
    engagementOp('optimus_synthesize_engagement')({ id, dry_run, model_key })
);

server.tool(
  'optimus_generate_proposal',
  'Generate the deliverable proposal from the synthesized Living spec. Master engagement → generic bracketed template; client engagement → TAILORED proposal with brackets filled from real meetings/emails. Cached per spec version unless force=true. Synthesize first if you have unsynthesized sources.',
  {
    id: z.string().describe('Engagement UUID'),
    format: z.enum(PROPOSAL_FORMATS).optional().describe('md | docx | gdoc (default: md)'),
    force: z.boolean().optional().describe('Bypass the per-spec-version cache and regenerate'),
  },
  ({ id, format, force }) => engagementOp('optimus_generate_proposal')({ id, format, force })
);

server.tool(
  'optimus_list_generated_proposals',
  'List the generated proposal deliverables for an engagement (each tied to a spec version + mode), newest first.',
  {
    id: z.string().describe('Engagement UUID'),
  },
  ({ id }) => engagementOp('optimus_list_generated_proposals')({ id })
);

// --- Knowledge Base ---

server.tool(
  'optimus_search_kb',
  'Search the Optimus knowledge base (RAG) for relevant information',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (default 5)'),
  },
  ({ query: q, limit = 5 }) => customerOp('optimus_search_kb')({ query: q, limit })
);

// --- Knowledge Base: capture (write) ---
// Ownership (your user + org) is derived server-side from OPTIMUS_TOKEN. These
// tools deliberately expose NO owner/org parameter — the backend rejects any.

server.tool(
  'optimus_ingest_document',
  'Push a document (PRD, spec, research, notes) into the Optimus knowledge base. Owned by you + your org automatically. Use this to make your work compound into the shared brain.',
  {
    title: z.string().describe('Document title'),
    raw: z.string().describe('Full raw text/markdown — do NOT summarize first; the brain extracts against full context'),
    format: z.enum(['plain', 'markdown']).optional().describe('Content format (default markdown)'),
  },
  ({ title, raw, format = 'markdown' }) => customerOp('optimus_ingest_document')({ title, raw, format })
);

server.tool(
  'optimus_ingest_transcript',
  'Push a raw meeting transcript (TLDV / Granola / Gemini) into the knowledge base. Drop the full raw transcript — do not summarize first.',
  {
    title: z.string().describe('Meeting title (e.g. "Keenan / VoiceRail feedback 2026-06-02")'),
    raw: z.string().describe('Full raw transcript text'),
    format: z.enum(['plain', 'tldv', 'gemini']).optional().describe('Transcript format for the meeting normalizer (default plain)'),
  },
  ({ title, raw, format = 'plain' }) => customerOp('optimus_ingest_transcript')({ title, raw, format })
);

server.tool(
  'optimus_push_summary',
  'Push a daily summary of what you worked on into the knowledge base. Point a scheduled daily Claude task at this so yesterday\'s work lands automatically.',
  {
    text: z.string().describe('The summary text (markdown)'),
    date: z.string().optional().describe('ISO date the summary covers (default: today)'),
  },
  ({ text, date }) => customerOp('optimus_push_summary')({ text, date })
);

// --- Artifact registry (OPT-92): typed, versioned artifacts ---
// Ownership (your user + org) is derived server-side from OPTIMUS_TOKEN. These
// tools deliberately expose NO owner/org parameter — the backend rejects any.

server.tool(
  'optimus_ingest_artifact',
  'Route a typed artifact (PRD, proposal, spec, ADR, brief, deck, transcript, summary, doc) through Optimus. Lands in the artifact registry (typed + versioned) AND the knowledge base (chunks/embeddings) in one call. Re-pushing the same title creates a new VERSION; identical bytes are an idempotent no-op. Owned by you + your org automatically.',
  {
    raw: z.string().describe('Full raw text/markdown — do NOT summarize first; the brain extracts against full context'),
    kind: z.enum(['prd', 'proposal', 'spec', 'adr', 'brief', 'deck', 'transcript', 'summary', 'doc', 'other']).describe('Artifact type'),
    title: z.string().describe('Artifact title (the per-artifact identity; same title = new version of the same artifact)'),
  },
  ({ raw, kind, title }) => customerOp('optimus_ingest_artifact')({ raw, kind, title })
);

server.tool(
  'optimus_capture_url',
  'Fetch a web page / Drive doc by URL, normalize it, and route it through Optimus as a typed artifact (registry + KB). Fails clearly on auth-walled URLs. Owned by you + your org automatically.',
  {
    url: z.string().describe('Public URL to fetch and capture'),
    kind: z.enum(['prd', 'proposal', 'spec', 'adr', 'brief', 'deck', 'transcript', 'summary', 'doc', 'other']).optional().describe('Artifact type (default: doc)'),
  },
  ({ url, kind = 'doc' }) => customerOp('optimus_capture_url')({ url, kind })
);

server.tool(
  'optimus_list_artifacts',
  'List managed artifacts in the registry, scoped to your org. Optional kind/status filters.',
  {
    kind: z.enum(['prd', 'proposal', 'spec', 'adr', 'brief', 'deck', 'transcript', 'summary', 'doc', 'other']).optional().describe('Filter by artifact kind'),
    status: z.enum(['active', 'superseded', 'archived']).optional().describe('Filter by status'),
  },
  ({ kind, status }) => customerOp('optimus_list_artifacts')({ kind, status })
);

server.tool(
  'optimus_get_artifact',
  'Get one artifact and its full version lineage by id (org-scoped).',
  {
    id: z.string().describe('Artifact UUID'),
  },
  ({ id }) => customerOp('optimus_get_artifact')({ id })
);

// --- On-demand enrichment (OPT-93) ---
// "Pull everything captured into this entity now." Returns the artifact links +
// derived facts the async enrichment worker attached to a contact/project, org-
// scoped automatically. No re-run is needed — the worker keeps these current as
// artifacts land.

server.tool(
  'optimus_enrich_contact',
  'Show everything Optimus has captured + linked about a contact: artifact links (auto/pending/confirmed) and derived facts, with provenance back to the source artifact. Org-scoped automatically.',
  {
    id: z.string().describe('Contact id (signal.contacts.id)'),
  },
  ({ id }) => customerOp('optimus_enrich_contact')({ id })
);

server.tool(
  'optimus_enrich_project',
  'Show everything Optimus has captured + linked about a project: artifact links (auto/pending/confirmed) and derived facts, with provenance back to the source artifact. Org-scoped automatically.',
  {
    id: z.string().describe('Project id (agent_graph.projects.id)'),
  },
  ({ id }) => customerOp('optimus_enrich_project')({ id })
);

// --- Today Summary ---

server.tool(
  'optimus_today',
  'Get today\'s summary: emails, drafts pending, signals, active campaigns, cost',
  {},
  async () => {
    const [drafts, signals, campaigns, health] = await Promise.all([
      api('GET', '/api/drafts?status=pending').catch(() => ({ rows: [] })),
      api('GET', '/api/signals?limit=10').catch(() => ({ rows: [] })),
      api('GET', '/api/campaigns?status=running').catch(() => ({ rows: [] })),
      api('GET', '/api/pipeline/health').catch(() => ({})),
    ]);
    const summary = {
      pending_drafts: drafts.rows?.length ?? drafts.length ?? 0,
      recent_signals: signals.rows?.length ?? signals.length ?? 0,
      active_campaigns: campaigns.rows?.length ?? campaigns.length ?? 0,
      pipeline: health,
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

// --- Wiki Compilation ---

server.tool(
  'optimus_wiki_compile',
  'Trigger wiki compilation for a project — clusters pending vault docs and LLM-compiles them into structured wiki articles',
  { slug: z.string().describe('Project slug'), maxArticles: z.number().optional().describe('Max articles to compile (default 20)') },
  async ({ slug, maxArticles }) => {
    const result = await api('POST', '/api/projects/compile', { slug, maxArticles });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_list',
  'List compiled wiki articles for a project',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_health',
  'Get wiki health report (lint) for a project — checks links, orphans, staleness, thin content, contradictions',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki/health?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_status',
  'Get compilation status — how many docs are pending, compiled, or are wiki articles',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('GET', `/api/projects/wiki/status?slug=${encodeURIComponent(slug)}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'optimus_wiki_lint',
  'Run wiki lint and store the health report in project memory',
  { slug: z.string().describe('Project slug') },
  async ({ slug }) => {
    const result = await api('POST', '/api/projects/wiki/lint', { slug });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Landing-page generator (feature 008 tier-3) ---
// Wraps the PUBLIC /api/redesign/submit→status→preview flow so a teammate can
// generate a bespoke intent-targeted landing page from a chat and get a
// shareable URL back. Uses no OPTIMUS_TOKEN (the endpoints are public, rate-
// limited server-side) and is NOT in CUSTOMER_OPERATIONS — so the customer-token
// filter on server.tool keeps it off the customer surface automatically.
registerGenerateLandingPage(server, z);

// ============================================================
// Heartbeat (machine awareness for Board UI)
// ============================================================

const HEARTBEAT_AGENT_ID = process.env.OPTIMUS_AGENT_ID || process.env.NEMOCLAW_AGENT_ID || 'nemoclaw';
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer = null;

async function sendHeartbeat(status = 'online') {
  try {
    await api('POST', '/api/agents/heartbeat', {
      agent_id: HEARTBEAT_AGENT_ID,
      status,
      machine_name: os.hostname(),
      machine_arch: os.arch(),
    });
  } catch {
    // Fire-and-forget — heartbeat failure must not crash the MCP server
  }
}

function startHeartbeat() {
  sendHeartbeat('online');
  heartbeatTimer = setInterval(() => sendHeartbeat('online'), HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // Synchronous-safe: attempt final heartbeat but don't block exit
  sendHeartbeat('stopped').finally(() => process.exit(0));
}

process.on('SIGINT', stopHeartbeat);
process.on('SIGTERM', stopHeartbeat);

// ============================================================
// Start
// ============================================================

// ============================================================
// Transport selection (OPT-37)
// ============================================================
// Default: stdio — each board/customer client runs this locally, pointed at the
// hosted Board API via OPTIMUS_API_URL. This is the supported path.
//
// Opt-in: OPTIMUS_MCP_TRANSPORT=http starts a stateless Streamable-HTTP endpoint
// (for hosted / on-prem deployments where a remote MCP client connects over the
// network). EXPERIMENTAL — validate against your client before relying on it.
// The Board API JWT remains the security boundary in BOTH modes.
const TRANSPORT = (process.env.OPTIMUS_MCP_TRANSPORT || 'stdio').toLowerCase();

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp() {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const port = Number(process.env.OPTIMUS_MCP_PORT || 3399);
  const mcpPath = process.env.OPTIMUS_MCP_PATH || '/mcp';
  // Stateless mode (sessionIdGenerator: undefined): each request is independent —
  // simplest, and correct for our model where identity rides the Bearer token,
  // not an MCP session. Connect ONCE; reuse the transport across requests.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith(mcpPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined; }
      catch { body = undefined; }
      transport.handleRequest(req, res, body).catch((err) => {
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
      });
    });
  });
  httpServer.listen(port, () => {
    console.error(`[optimus-mcp] Streamable-HTTP transport listening on :${port}${mcpPath} (EXPERIMENTAL)`);
  });
}

if (TRANSPORT === 'http') {
  await startHttp();
} else {
  await startStdio();
}

// Begin heartbeat after transport is connected. Skipped for customer tokens:
// the heartbeat hits ops-control (→403 for customers) and a customer machine
// must not surface as a board agent in the Board UI.
if (!IS_CUSTOMER) {
  startHeartbeat();
} else {
  console.error('[optimus-mcp] customer token detected — registered customer-safe tool set; heartbeat disabled');
}
