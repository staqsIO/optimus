import { query } from '../db.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { getConfig } from '../../../lib/config/loader.js';

/**
 * Board query handler — conversational LLM replies to board member questions.
 * Pattern 2 from Liotta's evaluation: queries (<5s), between commands (<500ms) and signals (async DAG).
 *
 * Uses config-driven model (no agent-loop overhead) for fast, cheap factual answers.
 * All context comes from the DB — no untrusted data in system prompt.
 */

const agentsConfig = getConfig('agents');
const boardQueryConfig = agentsConfig.agents['board-query'];

let _llm = null;
function getLLM() {
  if (!_llm) _llm = createLLMClient(boardQueryConfig.model, agentsConfig.models);
  return _llm;
}

const SYSTEM_PROMPT = `You are the Optimus board assistant. Answer the board member's question using the pipeline data provided in the latest message. Be concise and conversational. If you don't have enough data to answer, say so honestly. Do not make up information not present in the context.

You have tools available. Use them when the board member is asking you to DO something (create an issue, start research, create a directive). If they're asking a question, answer it directly without tools.

You may receive prior conversation turns for continuity. Use them to understand references like "that email", "Dustin", "do it", etc. Pipeline context is only attached to the latest message and reflects current state.`;

// ============================================================
// Conversation history (in-memory, per-session, 30-min TTL)
// ============================================================

const conversationHistory = new Map();
const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY_TURNS = 10; // 10 exchange pairs (20 messages)

// Purge stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of conversationHistory) {
    if (now - session.lastActivity > HISTORY_TTL_MS) {
      conversationHistory.delete(id);
    }
  }
}, 5 * 60_000).unref();

function getSession(sessionId) {
  let session = conversationHistory.get(sessionId);
  if (!session) {
    session = { messages: [], lastActivity: Date.now() };
    conversationHistory.set(sessionId, session);
  }
  session.lastActivity = Date.now();
  return session;
}

function appendToSession(sessionId, role, content) {
  const session = getSession(sessionId);
  session.messages.push({ role, content });
  // Trim to keep last N turns (each turn = user + assistant)
  while (session.messages.length > MAX_HISTORY_TURNS * 2) {
    session.messages.shift();
  }
}

const TOOLS = [
  {
    name: 'start_research',
    description: 'Submit content or a URL for research analysis against the Optimus spec. Results delivered asynchronously.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'URL or text content to analyze' },
        type: { type: 'string', enum: ['url', 'text'], description: 'Whether the content is a URL or plain text' },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'create_github_issue',
    description: 'Create a GitHub issue in a staqsIO repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository (e.g. "optimus" or "staqsIO/optimus"). Defaults to staqsIO/optimus if omitted.' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_directive',
    description: 'Create a board directive work item for the orchestrator to process.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Directive title/instruction' },
      },
      required: ['title'],
    },
  },
];

/**
 * Handle a board member's conversational query.
 * Returns either a direct answer or a proposed action (tool_use) for confirmation.
 * Maintains per-session conversation history for multi-turn continuity.
 * @param {string} question - The board member's natural language question
 * @param {{ source?: string, sessionId?: string }} options
 * @returns {Promise<{ type: 'answer', answer: string, costUsd: number } | { type: 'action', tool: string, input: object, summary: string, costUsd: number } | null>}
 */
export async function handleBoardQuery(question, { source = 'telegram', sessionId = 'default' } = {}) {
  const provider = agentsConfig.models[boardQueryConfig.model]?.provider || 'anthropic';
  const requiredKey = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[requiredKey]) return null;

  const start = Date.now();

  try {
    // Gather pipeline context in parallel
    const [signals, drafts, budget, activity, briefing, recentMessages, recentOutbound] = await Promise.all([
      getUnresolvedSignals(),
      getPendingDrafts(),
      getTodayBudget(),
      getAgentActivity(),
      getLatestBriefing(),
      getRecentMessages(),
      getRecentOutbound(),
    ]);

    const context = formatContext({ signals, drafts, budget, activity, briefing, recentMessages, recentOutbound });

    // Build multi-turn messages: history (bare Q&A) + current turn (with fresh context)
    const session = getSession(sessionId);
    const messages = [
      ...session.messages,
      { role: 'user', content: `${context}\n\nBoard member question: ${question}` },
    ];

    const llm = getLLM();
    const response = await callProvider(llm, {
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: boardQueryConfig.maxTokens || 1024,
      temperature: boardQueryConfig.temperature ?? 0.3,
      tools: TOOLS,
    });

    const { inputTokens, outputTokens } = response;
    const costUsd = computeCost(inputTokens, outputTokens, llm.modelConfig);
    const latencyMs = Date.now() - start;

    console.log(`[board-query] ${source} query answered in ${latencyMs}ms, cost=$${costUsd.toFixed(4)}, tokens=${inputTokens}+${outputTokens}, model=${llm.modelId}, history=${session.messages.length}`);

    // Check if LLM wants to use a tool (action proposal)
    if (response.stopReason === 'tool_use') {
      const toolBlock = response.toolCalls?.[0];
      if (toolBlock) {
        const summary = formatActionSummary(toolBlock.name, toolBlock.input);
        // Store in history: user question + assistant's action proposal (as text summary)
        appendToSession(sessionId, 'user', question);
        appendToSession(sessionId, 'assistant', `[Proposed action: ${summary}]`);
        return { type: 'action', tool: toolBlock.name, input: toolBlock.input, summary, costUsd };
      }
    }

    // Direct text answer
    const answer = response.text || 'No response generated.';

    // Store in history: user question (bare, no context) + assistant answer
    appendToSession(sessionId, 'user', question);
    appendToSession(sessionId, 'assistant', answer);

    return { type: 'answer', answer, costUsd };
  } catch (err) {
    console.error(`[board-query] Failed:`, err.message);
    return null;
  }
}

/**
 * Format a human-readable summary of a proposed action.
 */
function formatActionSummary(tool, input) {
  switch (tool) {
    case 'start_research':
      return `Research: ${input.content?.slice(0, 80)}${input.content?.length > 80 ? '...' : ''}`;
    case 'create_github_issue': {
      const repo = input.repo || 'staqsIO/optimus';
      return `Create issue in ${repo}: "${input.title}"`;
    }
    case 'create_directive':
      return `Directive: "${input.title}"`;
    default:
      return `${tool}: ${JSON.stringify(input).slice(0, 80)}`;
  }
}

// ============================================================
// Context gatherers
// ============================================================

async function getUnresolvedSignals() {
  const result = await query(
    `SELECT id, signal_type, content, created_at
     FROM inbox.signals
     WHERE resolved = false AND created_at >= CURRENT_DATE - 7
     ORDER BY created_at DESC LIMIT 10`
  );
  return result.rows;
}

async function getPendingDrafts() {
  const result = await query(
    `SELECT id, subject, channel, created_at
     FROM agent_graph.action_proposals
     WHERE board_action IS NULL
     ORDER BY created_at DESC LIMIT 10`
  );
  return result.rows;
}

async function getTodayBudget() {
  const result = await query(
    `SELECT allocated_usd, spent_usd
     FROM agent_graph.budgets
     WHERE scope = 'daily' AND period_start = CURRENT_DATE
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function getAgentActivity() {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'in_progress') AS active_tasks,
       COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= CURRENT_DATE) AS completed_today,
       COUNT(DISTINCT assigned_to) FILTER (WHERE status = 'in_progress') AS active_agents
     FROM agent_graph.work_items
     WHERE updated_at >= CURRENT_DATE - 1`
  );
  return result.rows[0] || null;
}

async function getLatestBriefing() {
  try {
    const result = await query(
      `SELECT summary, created_at
       FROM signal.briefings
       ORDER BY created_at DESC LIMIT 1`
    );
    return result.rows[0] || null;
  } catch (err) {
    // briefings table may not exist yet
    if (!err.message?.includes('does not exist')) {
      console.warn('[board-query] briefings query failed:', err.message);
    }
    return null;
  }
}

async function getRecentMessages() {
  const result = await query(
    `SELECT m.id, m.from_address, m.from_name, m.subject, m.snippet,
            m.channel, m.triage_category, m.received_at,
            c.name AS contact_name, c.contact_type
     FROM inbox.messages m
     LEFT JOIN signal.contacts c ON lower(c.email_address) = lower(m.from_address)
     WHERE m.received_at >= now() - interval '48 hours'
     ORDER BY m.received_at DESC LIMIT 20`
  );
  return result.rows;
}

async function getRecentOutbound() {
  try {
    const result = await query(
      `SELECT id, channel, recipient, subject, intent_type, status, created_at
       FROM autobot_comms.outbound_intents
       WHERE created_at >= now() - interval '48 hours'
       ORDER BY created_at DESC LIMIT 10`
    );
    return result.rows;
  } catch (err) {
    // outbound_intents table may not exist yet
    if (!err.message?.includes('does not exist')) {
      console.warn('[board-query] outbound query failed:', err.message);
    }
    return [];
  }
}

// ============================================================
// Context formatter
// ============================================================

function formatContext({ signals, drafts, budget, activity, briefing, recentMessages, recentOutbound }) {
  const parts = ['<pipeline_context>'];

  // Recent messages (most valuable for board questions)
  if (recentMessages && recentMessages.length > 0) {
    parts.push(`Recent messages (48h):`);
    for (const m of recentMessages) {
      const sender = m.contact_name || m.from_name || m.from_address;
      const type = m.contact_type ? ` [${m.contact_type}]` : '';
      const triage = m.triage_category ? ` (${m.triage_category})` : '';
      const time = m.received_at ? new Date(m.received_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      parts.push(`  - From: ${sender}${type} | "${(m.subject || 'No subject').slice(0, 60)}" | ${m.channel}${triage} | ${time}`);
      if (m.snippet) {
        parts.push(`    Preview: ${m.snippet.slice(0, 120)}`);
      }
    }
  } else {
    parts.push(`Recent messages (48h): none`);
  }

  // Recent outbound (sent messages, approved drafts)
  if (recentOutbound && recentOutbound.length > 0) {
    parts.push(`Recent outbound (48h):`);
    for (const o of recentOutbound) {
      const time = o.created_at ? new Date(o.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      parts.push(`  - To: ${o.recipient} | "${(o.subject || 'No subject').slice(0, 60)}" | ${o.channel} | ${o.status} | ${time}`);
    }
  }

  // Signals
  if (signals.length > 0) {
    parts.push(`Unresolved signals (7d):`);
    for (const s of signals) {
      parts.push(`  - [${s.id.slice(0, 8)}] ${s.signal_type}: ${(s.content || '').slice(0, 100)}`);
    }
  } else {
    parts.push(`Unresolved signals (7d): none`);
  }

  // Drafts
  if (drafts.length > 0) {
    parts.push(`Pending drafts:`);
    for (const d of drafts) {
      parts.push(`  - [${d.id.slice(0, 8)}] ${(d.subject || 'No subject').slice(0, 80)} (${d.channel || 'email'})`);
    }
  } else {
    parts.push(`Pending drafts: none`);
  }

  // Budget
  if (budget) {
    parts.push(`Budget (today): $${parseFloat(budget.spent_usd || 0).toFixed(2)} / $${parseFloat(budget.allocated_usd || 0).toFixed(2)}`);
  } else {
    parts.push(`Budget (today): no budget record`);
  }

  // Activity
  if (activity) {
    parts.push(`Agent activity: ${activity.active_agents || 0} active agents, ${activity.active_tasks || 0} in-progress tasks, ${activity.completed_today || 0} completed today`);
  }

  // Briefing
  if (briefing) {
    parts.push(`Latest briefing: ${(briefing.summary || '').slice(0, 200)}`);
  }

  parts.push('</pipeline_context>');
  return parts.join('\n');
}
