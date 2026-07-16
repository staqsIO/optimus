/**
 * MCP-compatible tool registry.
 * Tools are callable by agents via the tool allow-list in agent config.
 * P1: Deny by default — agents can only use tools in their tools_allowed list.
 * P2: Infrastructure enforces — DB permission check, timeouts, audit trail.
 */

import { createHash } from 'crypto';
import { query } from '../src/db.js';
import { fetchEmailBody, fetchEmailMetadata, createDraft } from '../src/gmail/client.js';
import { pollForNewMessages } from '../src/gmail/poller.js';
import { selectFewShots } from '../src/voice/few-shot-selector.js';
import { getProfile } from '../src/voice/profile-builder.js';
import { getUnresolvedSignals, getUpcomingDeadlines } from '../src/signal/extractor.js';
import { getContacts, getContactSummary } from '../src/signal/relationship-graph.js';
import { getDailyStats, getAgentActivity, getBudgetStatus } from '../src/signal/briefing-generator.js';
import { makeFlowToolHandler } from './flow-tools/index.js';

// Module-scope cache for DB tool_registry allowed_agents.
// Populated on first executeTool() call, refreshable via loadToolPermissions().
let _dbPermissions = null;

export async function loadToolPermissions() {
  try {
    const result = await query(
      `SELECT tool_name, allowed_agents FROM agent_graph.tool_registry WHERE is_active = true`
    );
    _dbPermissions = new Map(result.rows.map(r => [r.tool_name, r.allowed_agents]));
  } catch (err) {
    // P1: deny by default — in production, DB permission layer must not be bypassed.
    // Only skip in test/dev when NODE_ENV is explicitly set.
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      console.warn(`[tool-registry] Failed to load DB permissions: ${err.message}. Layer 2 check disabled (${process.env.NODE_ENV} mode).`);
      _dbPermissions = null;
    } else {
      throw new Error(`[tool-registry] FATAL: Cannot load DB permissions — Layer 2 enforcement unavailable. ${err.message}`);
    }
  }
  return _dbPermissions;
}

export const tools = {
  // Gmail tools
  gmail_poll: {
    name: 'gmail_poll',
    description: 'Poll Gmail for new messages',
    capabilities: { schemas: ['inbox'], network: true },
    output_schema: { messages: 'array', count: 'number' },
    timeout: 120000,
    handler: async () => pollForNewMessages(),
  },
  gmail_fetch: {
    name: 'gmail_fetch',
    description: 'Fetch email body by Gmail ID (D1: on-demand, never stored)',
    parameters: { provider_msg_id: 'string' },
    output_schema: { emailId: 'string', provider_msg_id: 'string', from: 'string', subject: 'string', emailBody: 'string', snippet: 'string' },
    capabilities: { schemas: [], network: true },
    timeout: 30000,
    handler: async ({ provider_msg_id }) => fetchEmailBody(provider_msg_id),
  },

  // Task graph tools
  task_create: {
    name: 'task_create',
    description: 'Create a work item in the task graph',
    parameters: { type: 'string', title: 'string', description: 'string', assignedTo: 'string' },
    output_schema: { workItemId: 'string', type: 'string', title: 'string', status: 'string', assignedTo: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async (params) => {
      const { createWorkItem } = await import('../src/runtime/state-machine.js');
      return createWorkItem(params);
    },
  },
  task_assign: {
    name: 'task_assign',
    description: 'Assign a task to an agent',
    parameters: { workItemId: 'string', agentId: 'string' },
    output_schema: { workItemId: 'string', agentId: 'string', status: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId, agentId }) => {
      return query(
        `UPDATE agent_graph.work_items SET assigned_to = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [agentId, workItemId]
      );
    },
  },
  task_update: {
    name: 'task_update',
    description: 'Update a work item',
    parameters: { workItemId: 'string', updates: 'object' },
    output_schema: { workItemId: 'string', status: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId, updates }) => {
      const { transitionState } = await import('../src/runtime/state-machine.js');
      if (updates.status) {
        return transitionState({ workItemId, toState: updates.status, ...updates });
      }
    },
  },
  task_read: {
    name: 'task_read',
    description: 'Read a work item and its context',
    parameters: { workItemId: 'string' },
    output_schema: { workItemId: 'string', type: 'string', title: 'string', description: 'string', status: 'string', assignedTo: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ workItemId }) => {
      const result = await query(`SELECT * FROM agent_graph.work_items WHERE id = $1`, [workItemId]);
      return result.rows[0];
    },
  },

  // Voice tools
  voice_query: {
    name: 'voice_query',
    description: 'Query voice profile and few-shot examples',
    parameters: { recipientEmail: 'string', subject: 'string' },
    output_schema: { profile: 'object', fewShots: 'array' },
    capabilities: { schemas: ['voice'], network: false },
    timeout: 15000,
    handler: async ({ recipientEmail, subject }) => ({
      profile: await getProfile(recipientEmail),
      fewShots: await selectFewShots({ recipientEmail, subject }),
    }),
  },

  // Signal tools
  signal_extract: {
    name: 'signal_extract',
    description: 'Extract and store signals from email content',
    parameters: { emailId: 'string', signals: 'array' },
    output_schema: { emailId: 'string', signalCount: 'number' },
    capabilities: { schemas: ['inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async ({ emailId, signals }) => {
      for (const s of signals) {
        await query(
          `INSERT INTO inbox.signals (email_id, signal_type, content, confidence, due_date)
           VALUES ($1, $2, $3, $4, $5)`,
          [emailId, s.type, s.content, s.confidence, s.dueDate || null]
        );
      }
    },
  },
  signal_query: {
    name: 'signal_query',
    description: 'Query signals, contacts, and deadlines',
    parameters: { type: 'string' },
    output_schema: { signals: 'array', deadlines: 'array', vipContacts: 'array' },
    capabilities: { schemas: ['inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async ({ type }) => ({
      signals: await getUnresolvedSignals({ type }),
      deadlines: await getUpcomingDeadlines(7),
      vipContacts: await getContacts({ vipOnly: true }),
    }),
  },

  // Draft tools
  draft_create: {
    name: 'draft_create',
    description: 'Create a response draft (action proposal)',
    parameters: { emailId: 'string', body: 'string', subject: 'string', toAddresses: 'array' },
    output_schema: { draftId: 'string', emailId: 'string', body: 'string', subject: 'string', status: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ emailId, body, subject, toAddresses }) => {
      const result = await query(
        `INSERT INTO agent_graph.action_proposals (action_type, message_id, body, subject, to_addresses) VALUES ('email_draft', $1, $2, $3, $4) RETURNING *`,
        [emailId, body, subject, toAddresses]
      );
      return result.rows[0];
    },
  },
  draft_read: {
    name: 'draft_read',
    description: 'Read an action proposal by ID',
    parameters: { draftId: 'string' },
    output_schema: { draftId: 'string', emailId: 'string', body: 'string', subject: 'string', toAddresses: 'array', status: 'string' },
    capabilities: { schemas: ['agent_graph'], network: false },
    timeout: 10000,
    handler: async ({ draftId }) => {
      const result = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
      return result.rows[0];
    },
  },

  // Gate tools
  gate_check: {
    name: 'gate_check',
    description: 'Run constitutional gate checks on an action proposal',
    parameters: { draftId: 'string' },
    output_schema: { draftId: 'string', passed: 'boolean', gates: 'array', blockers: 'array' },
    capabilities: { schemas: ['agent_graph', 'voice'], network: false },
    timeout: 30000,
    handler: async ({ draftId }) => {
      const { checkDraftGates } = await import('../src/runtime/guard-check.js');
      const draft = await query(`SELECT * FROM agent_graph.action_proposals WHERE id = $1`, [draftId]);
      return checkDraftGates(draft.rows[0], null, null, null, draft.rows[0]?.action_type);
    },
  },

  // Stats tools
  stats_query: {
    name: 'stats_query',
    description: 'Query system stats and metrics',
    output_schema: { daily: 'object', agents: 'array', budget: 'object' },
    capabilities: { schemas: ['agent_graph', 'inbox', 'signal'], network: false },
    timeout: 15000,
    handler: async () => ({
      daily: await getDailyStats(),
      agents: await getAgentActivity(),
      budget: await getBudgetStatus(),
    }),
  },

  // Briefing tools
  briefing_create: {
    name: 'briefing_create',
    description: 'Store a generated briefing',
    parameters: { briefing: 'object' },
    output_schema: { briefingDate: 'string', status: 'string' },
    capabilities: { schemas: ['signal'], network: false },
    timeout: 10000,
    handler: async ({ briefing }) => {
      return query(
        `INSERT INTO signal.briefings (briefing_date, summary, action_items, signals, trending_topics, vip_activity, generated_by)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, 'architect')
         ON CONFLICT (briefing_date) DO UPDATE SET summary = EXCLUDED.summary`,
        [briefing.summary, JSON.stringify(briefing.actionItems), JSON.stringify(briefing.signals),
         JSON.stringify(briefing.trendingTopics), JSON.stringify(briefing.vipActivity)]
      );
    },
  },

  // ─── Agent-dispatch tools ──────────────────────────────────────────
  // These route to agents via FlowToolRegistry.dispatchToAgent().
  // No handler — the flow engine dispatches based on agentId + dispatch_mode.

  classify_message: {
    name: 'classify_message',
    description: 'Classify a message into category, routing, and priority',
    parameters: { emailBody: 'string', from: 'string', subject: 'string', channel: 'string' },
    output_schema: { classification: 'string', confidence: 'number', routingClass: 'string', domainTags: 'array', rationale: 'string' },
    dispatch_mode: 'agent',
    agentId: 'executor-intake',
    capabilities: { schemas: ['inbox', 'agent_graph'], network: false },
    timeout: 30000,
  },

  compose_reply: {
    name: 'compose_reply',
    description: 'Compose a voice-matched reply using email context',
    parameters: { emailBody: 'string', from: 'string', subject: 'string', channel: 'string' },
    output_schema: { body: 'string', subject: 'string', toAddresses: 'array', draftIntent: 'string', emailSummary: 'string' },
    dispatch_mode: 'agent',
    agentId: 'executor-responder',
    capabilities: { schemas: ['agent_graph', 'voice'], network: false },
    timeout: 60000,
  },

  create_ticket: {
    name: 'create_ticket',
    description: 'Structure feedback into a Linear + GitHub issue',
    parameters: { emailBody: 'string', from: 'string', subject: 'string', targetRepo: 'string' },
    output_schema: { title: 'string', description: 'string', severity: 'string', category: 'string', linearUrl: 'string', githubUrl: 'string' },
    dispatch_mode: 'agent',
    agentId: 'executor-ticket',
    capabilities: { schemas: ['agent_graph'], network: true },
    timeout: 60000,
  },

  research_analyze: {
    name: 'research_analyze',
    description: 'Run gap analysis or deep research on content',
    parameters: { researchType: 'string', content: 'string' },
    output_schema: { summary: 'string', gaps: 'array', alreadyCovered: 'array', notApplicable: 'array' },
    dispatch_mode: 'agent',
    agentId: 'executor-research',
    capabilities: { schemas: ['agent_graph'], network: true },
    timeout: 120000,
  },

  score_priority: {
    name: 'score_priority',
    description: 'Score priority and recommend response strategy',
    parameters: { emailBody: 'string', from: 'string', subject: 'string', triageCategory: 'string' },
    output_schema: { priorityScore: 'number', urgency: 'string', recommendation: 'string', responseGuidance: 'string', flags: 'array' },
    dispatch_mode: 'agent',
    agentId: 'strategist',
    capabilities: { schemas: ['agent_graph', 'inbox', 'signal'], network: false },
    timeout: 45000,
  },

  // ─── Flow-native agents ────────────────────────────────────────────
  // Declarative single-shot agents that live in /flow-agents/. The `flow:`
  // prefix on agentId tells the dispatcher to route to the shared runner
  // instead of a pipeline-agent wrapper. See flow-agents/README.md.

  summarize: {
    name: 'summarize',
    description: 'Summarize text concisely in a chosen style',
    parameters: {
      text: 'string',
      maxWords: 'number',
      style: { type: 'string', enum: ['concise', 'bullet-points', 'technical'] },
    },
    output_schema: { summary: 'string' },
    dispatch_mode: 'agent',
    agentId: 'flow:summarize',
    capabilities: { schemas: [], network: false },
    timeout: 30000,
    native: true,
  },

  classify_text: {
    name: 'classify_text',
    description: 'Classify text into one of a provided set of categories',
    parameters: { text: 'string', categories: 'array', context: 'string' },
    output_schema: { category: 'string', confidence: 'number', rationale: 'string' },
    dispatch_mode: 'agent',
    agentId: 'flow:classify_text',
    capabilities: { schemas: [], network: false },
    timeout: 30000,
    native: true,
  },

  extract_entities: {
    name: 'extract_entities',
    description: 'Extract structured entities (dates, amounts, names, URLs, ...) from text',
    parameters: { text: 'string', entityTypes: 'array', context: 'string' },
    output_schema: { entities: 'array' },
    dispatch_mode: 'agent',
    agentId: 'flow:extract_entities',
    capabilities: { schemas: [], network: false },
    timeout: 30000,
    native: true,
  },

  rewrite_tone: {
    name: 'rewrite_tone',
    description: 'Rewrite text in a target tone, preserving facts',
    parameters: {
      text: 'string',
      tone: { type: 'string', enum: ['formal', 'casual', 'assertive', 'soft', 'concise'] },
      instructions: 'string',
    },
    output_schema: { rewritten: 'string' },
    dispatch_mode: 'agent',
    agentId: 'flow:rewrite_tone',
    capabilities: { schemas: [], network: false },
    timeout: 30000,
    native: true,
  },

  // ─── Flow-native utility tools ─────────────────────────────────────
  // Pure data transforms — no LLM, no DB writes, no network. See flow-tools/.

  json_pick: {
    name: 'json_pick',
    description: 'Extract a subset of fields from an object',
    parameters: { source: 'object', fields: 'array' },
    output_schema: {}, // dynamic — depends on `fields`
    dispatch_mode: 'function',
    capabilities: { schemas: [], network: false },
    timeout: 5000,
    handler: makeFlowToolHandler('json_pick'),
    native: true,
  },

  condition_check: {
    name: 'condition_check',
    description: 'Evaluate a simple comparison and return a boolean gate result',
    parameters: {
      left: 'string',
      operator: {
        type: 'string',
        enum: ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'exists'],
      },
      right: 'string',
    },
    output_schema: { result: 'boolean', reason: 'string' },
    dispatch_mode: 'function',
    capabilities: { schemas: [], network: false },
    timeout: 5000,
    handler: makeFlowToolHandler('condition_check'),
    native: true,
  },

  html_to_text: {
    name: 'html_to_text',
    description: 'Strip HTML and decode entities to produce readable plain text',
    parameters: { html: 'string', maxLength: 'number' },
    output_schema: { text: 'string' },
    dispatch_mode: 'function',
    capabilities: { schemas: [], network: false },
    timeout: 5000,
    handler: makeFlowToolHandler('html_to_text'),
    native: true,
  },

  list_filter: {
    name: 'list_filter',
    description: 'Filter an array by comparing a named field on each item against a value',
    parameters: {
      list: 'array',
      field: 'string',
      operator: {
        type: 'string',
        enum: ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'exists'],
      },
      value: 'string',
    },
    output_schema: { items: 'array', count: 'number' },
    dispatch_mode: 'function',
    capabilities: { schemas: [], network: false },
    timeout: 5000,
    handler: makeFlowToolHandler('list_filter'),
    native: true,
  },
};

/**
 * Execute a tool by name, with layered permission checks, timeout, and audit trail.
 *
 * Enforcement layers:
 *   1. Agent config allow-list (P1: deny by default)
 *   2. DB tool_registry.allowed_agents (P2: infrastructure enforces)
 *   3. Per-tool timeout via Promise.race
 *   4. Fire-and-forget audit INSERT to tool_invocations
 */
export async function executeTool(toolName, params, agentConfig) {
  const agentId = agentConfig?.id ?? 'unknown';

  // Layer 1: Check tool is in agent's config allow-list (P1: deny by default)
  // agents.json uses 'tools', DB agent_configs uses 'tools_allowed' — accept either
  const allowedTools = agentConfig?.tools || agentConfig?.tools_allowed;
  if (!allowedTools?.includes(toolName)) {
    throw new Error(`Agent ${agentId} not authorized for tool ${toolName}`);
  }

  const tool = tools[toolName];
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Layer 2: DB tool_registry permission check
  if (!_dbPermissions) await loadToolPermissions();
  if (_dbPermissions) {
    const allowedAgents = _dbPermissions.get(toolName);
    if (allowedAgents && !allowedAgents.includes(agentId)) {
      throw new Error(`Agent ${agentId} not in tool_registry.allowed_agents for ${toolName}`);
    }
  }

  // Layer 3: Execute with timeout
  const timeout = tool.timeout || 30000;
  const startTime = Date.now();
  let success = false;
  let errorMessage = null;
  let result;
  let timer;

  try {
    result = await Promise.race([
      tool.handler(params || {}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
    success = true;
    return result;
  } catch (err) {
    errorMessage = err.message;
    throw err;
  } finally {
    clearTimeout(timer);

    // Layer 4: Fire-and-forget audit trail
    const durationMs = Date.now() - startTime;
    const paramsHash = params
      ? createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16)
      : null;
    const summary = success
      ? (typeof result === 'object' ? 'ok' : String(result).slice(0, 200))
      : null;

    // Non-blocking — audit failures must not affect tool execution
    query(
      `INSERT INTO agent_graph.tool_invocations (agent_id, tool_name, params_hash, result_summary, duration_ms, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [agentId, toolName, paramsHash, summary, durationMs, success, errorMessage]
    ).catch(() => {});
  }
}
