/**
 * Agent Chat — Messenger-style per-agent chat for board members.
 *
 * Separate lightweight path: chat does NOT go through the task graph.
 * If a user asks an agent to *do something*, that action creates a work_item
 * via the normal path.
 *
 * Security (Linus review):
 *  #1 chatTools separate from operational tools — read-only by default
 *  #2 Server-side session IDs (crypto.randomUUID)
 *  #3 G1 budget enforcement — per-session cost cap
 *  #4 Full audit trail via llm_invocations
 *  #5 Context/input separation — pipeline context in system prompt only
 *  #6 Model ID locked at invocation time, logged in response
 *  #7 Per-agent LLM client cache
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../db.js';
import { createLLMClient, callProvider, callProviderStream, computeCost } from '../llm/provider.js';
import { loadMergedConfig } from '../../../lib/runtime/config-loader.js';
import { saveMemory, loadRelevantMemories } from '../../../lib/runtime/agents/agent-memory.js';
import { runGraphTemplate, GRAPH_TEMPLATE_NAMES } from '../../../lib/graph/chat-query-templates.js';

/**
 * Load agents config with DB overrides merged on top of disk defaults.
 * Cached for 30s in config-loader. Replaces direct readFileSync of agents.json.
 */
async function loadConfig() {
  return loadMergedConfig();
}

// P3 latency: the ONLY messages allowed to skip RAG retrieval. Deliberately
// narrow — pure greetings/acks/courtesies with no content. The Phase-0
// lesson stands: short queries ("Ladd status") and pronoun follow-ups
// ("what did he say?") MUST hit the KB, so anything not on this list (or
// containing a question mark) retrieves as usual.
export const SMALL_TALK_RE = /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|cool|got it|sounds good|nice|great|perfect|awesome|good morning|good afternoon|good evening|good night|bye|goodbye|see ya|never ?mind|stop|cancel|yes|no|yep|nope|yeah|nah|sure)[\s.!,]*$/i;

// P4 memory: partition key shape. Built ONLY from the GitHub OAuth username
// forwarded as X-Board-User (1-39 chars, alphanumeric + hyphens). Linus M3:
// never fall back to display names — an invalid or missing user gets NO
// memory bucket, not a shared one.
const MEMORY_BOARDUSER_RE = /^[A-Za-z0-9-]{1,39}$/;

/** Memory partition key for a board member's chat memories, or null. */
export function chatMemoryKey(boardUser) {
  if (typeof boardUser !== 'string' || !MEMORY_BOARDUSER_RE.test(boardUser)) return null;
  return `chat:${boardUser}`;
}

/**
 * Parse the memory-extraction model's output: a JSON array of
 * {type:'preference'|'context', content} — tolerant of code fences and
 * surrounding prose, strict about shape. Caps at 3 memories per turn.
 */
export function parseExtractedMemories(text) {
  const match = String(text).match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(m => m && (m.type === 'preference' || m.type === 'context') && typeof m.content === 'string')
      .map(m => ({ type: m.type, content: m.content.trim().slice(0, 500), entities: normalizeEntities(m.entities) }))
      .filter(m => m.content.length >= 10)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * 010-C: validate/normalize the entities a memory is "about" — the people and
 * orgs that ground it. Canonical key is email (lowercased), name as fallback
 * (OQ-2: human-legible, survives graph rebuilds). Dropped if neither is present;
 * deduped; capped. Returns [] for anything malformed — entity tagging is
 * best-effort and never blocks a memory write.
 */
export function normalizeEntities(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!e || (e.kind !== 'person' && e.kind !== 'org')) continue;
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 120) : '';
    const email = typeof e.email === 'string' ? e.email.trim().toLowerCase().slice(0, 160) : '';
    if (!name && !email) continue;
    const key = `${e.kind}:${email || name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ent = { kind: e.kind, name };
    if (email) ent.email = email;
    out.push(ent);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * 010-C: parse a distilled failure memory. The model emits JSON
 * {"lesson":"...","entities":[…]} or the literal NONE; falls back to treating a
 * bare sentence as the lesson (backward-compatible with the pre-010-C prompt).
 */
export function parseDistilledFailure(text) {
  const t = String(text || '').trim();
  if (!t || t.toUpperCase() === 'NONE') return null;
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o.lesson === 'string' && o.lesson.trim().length >= 15) {
        return { lesson: o.lesson.trim().slice(0, 400), entities: normalizeEntities(o.entities) };
      }
    } catch { /* fall through to sentence */ }
  }
  // Bare-sentence fallback (pre-010-C compatibility): use the text as the lesson
  // when it reads as prose. A leading '{'/'[' with no valid lesson above means
  // the model attempted JSON and botched it — drop that rather than store junk.
  if (t.length >= 15 && !t.startsWith('{') && !t.startsWith('[')) {
    return { lesson: t.slice(0, 400), entities: [] };
  }
  return null;
}

const MEMORY_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

export function pickCheapModel(config) {
  if (config.models[MEMORY_EXTRACTION_MODEL]) return MEMORY_EXTRACTION_MODEL;
  // Fallback: any metered haiku-class model (claudeCode excluded — subprocess
  // startup cost defeats the purpose of a cheap background pass).
  return Object.keys(config.models).find(
    k => k.toLowerCase().includes('haiku') && (config.models[k].provider || 'anthropic') !== 'claudeCode'
  ) || null;
}

/**
 * Post-turn memory extraction (P4) — fire-and-forget, off the critical path.
 * A cheap Haiku pass decides whether the exchange contains anything durable:
 * an explicitly stated preference or a stable fact about the board member or
 * org. Almost all turns yield nothing; the prompt is strict on purpose.
 * Dedup is handled by saveMemory's content_hash.
 */
async function extractChatMemories({ memoryKey, sessionId, message, responseText, config }) {
  const modelKey = pickCheapModel(config);
  if (!modelKey) return;

  const llm = createLLMClient(modelKey, config.models);
  const response = await callProvider(llm, {
    system: 'You extract durable memories from a board-member chat exchange. Output ONLY a JSON array, no prose. Each element: {"type":"preference"|"context","content":"...","entities":[{"kind":"person"|"org","name":"...","email":"..."}]}. Include ONLY facts worth remembering across future conversations: explicitly stated preferences about how to communicate or work ("keep answers short", "always loop in Dustin"), or stable facts about the member or organization stated BY THE MEMBER. The "entities" array names the specific people or organizations the memory is ABOUT (a client, a colleague, a company) — include "email" only if the member stated it, otherwise just "name"; use [] when the memory references no specific person or org. NEVER include: questions, task requests, one-off instructions scoped to this conversation, anything the assistant said, or speculation. Almost all exchanges contain nothing durable — then output [].',
    messages: [{
      role: 'user',
      content: `Board member message:\n${message.slice(0, 2000)}\n\nAssistant reply (context only — never extract from it):\n${String(responseText).slice(0, 1000)}`,
    }],
    maxTokens: 300,
    temperature: 0,
  });

  const memories = parseExtractedMemories(response.text);
  for (const m of memories) {
    await saveMemory({
      agentId: memoryKey,
      type: m.type,
      content: m.content,
      // 010-C: tag the entities this memory is about; 010-D scores recall on
      // overlap with the current turn. Omitted when empty to keep metadata lean.
      metadata: { source: 'chat-extraction', sessionId, ...(m.entities.length > 0 && { entities: m.entities }) },
    });
  }

  // G1 audit trail — extraction is a metered LLM call like any other
  const costUsd = computeCost(response.inputTokens || 0, response.outputTokens || 0, llm.modelConfig);
  try {
    await query(
      `INSERT INTO agent_graph.llm_invocations (agent_id, model, input_tokens, output_tokens, cost_usd, task_id, created_at) VALUES ('chat-memory', $1, $2, $3, $4, $5, now())`,
      [modelKey, response.inputTokens || 0, response.outputTokens || 0, costUsd, sessionId]
    );
  } catch { /* non-fatal */ }
}

/**
 * Resolve the chat caller's RAG tenancy scope (fail-closed).
 *
 * Worktree 1 (RAG tenancy hardening): resolve the caller's ownerId once for
 * all RAG calls in a turn. Preference:
 *   1. process.env.GBRAIN_OWNER_ID (explicit override for CLI tooling)
 *   2. agent_graph.board_members lookup by github_username (boardUser)
 * If neither resolves, returns null and the caller skips RAG rather than
 * falling through to org-wide. (CLI callers MUST set GBRAIN_OWNER_ID or have
 * a matching board_members row — there is no implicit default.)
 *
 * Phase-2 tenancy: attaches the user's readable orgs so RAG fails closed on
 * owner_org_id — a user with no readable orgs gets readOrgIds:[] → 0 rows,
 * never an unfiltered read.
 */
async function resolveChatRetrieverScope(boardUser) {
  let chatOwnerId = process.env.GBRAIN_OWNER_ID || null;
  if (!chatOwnerId && boardUser) {
    try {
      const r = await query(
        `SELECT id FROM agent_graph.board_members WHERE github_username = $1 LIMIT 1`,
        [boardUser]
      );
      chatOwnerId = r.rows[0]?.id || null;
    } catch { /* fall through */ }
  }
  if (!chatOwnerId) return null;

  let chatReadOrgIds = [];
  try {
    const { resolvePrincipal } = await import('../../../lib/tenancy/scope.js');
    const principal = await resolvePrincipal({ userId: String(chatOwnerId) });
    chatReadOrgIds = principal.readOrgIds || [];
  } catch { /* fail-closed: empty org set → 0 rows */ }
  return { ownerId: String(chatOwnerId), readOrgIds: chatReadOrgIds };
}

// Linus #7: per-agent LLM client cache, keyed by agentId:model
// Invalidated when model changes (key includes model ID).
const _llmClients = new Map();

function getLLMForAgent(agentId, config) {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const cacheKey = `${agentId}:${agent.model}`;
  if (!_llmClients.has(cacheKey)) {
    _llmClients.set(cacheKey, createLLMClient(agent.model, config.models));
  }
  return _llmClients.get(cacheKey);
}

/** Sanitize strings before injecting into system prompt (Linus: prevent injection via error messages). */
function sanitize(str, maxLen = 100) {
  return String(str).replace(/[^\x20-\x7E]/g, '').slice(0, maxLen);
}

/**
 * Build system prompt from agent config.
 * Linus #5: pipeline context goes here, NOT in user turn.
 * Liotta: agent metrics injected for self-awareness (under 200 tokens).
 */
/**
 * Validate an IANA timezone identifier (e.g. "America/Los_Angeles"). Returns
 * the input when valid, null otherwise. We never trust client-supplied strings
 * to flow into Postgres `AT TIME ZONE` or `Intl.DateTimeFormat` without this
 * gate — bad input would either crash the query or silently warp "today".
 */
function validateTz(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function buildChatSystemPrompt(agentConfig, pipelineContext, agentMetrics, { tz } = {}) {
  const tier = agentConfig.type;
  const caps = (agentConfig.capabilities || []).join(', ');
  const hierarchy = agentConfig.hierarchy || {};
  const mode = agentConfig.mode || 'normal';

  // Anchor every chat turn in the user's local time. The chat caller sends
  // their IANA timezone (Intl.DateTimeFormat().resolvedOptions().timeZone);
  // when it's missing/invalid we fall back to UTC and label the prompt
  // accordingly so the agent can still operate, but with a known caveat.
  const validTz = validateTz(tz);
  const effectiveTz = validTz || 'UTC';
  const tzLabel = validTz ? validTz : 'UTC (client did not supply a timezone)';
  const now = new Date();
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: effectiveTz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: effectiveTz, weekday: 'long',
  }).format(now);

  let prompt = `You are ${agentConfig.id}, a ${tier}-tier agent in the Optimus organization.`;
  prompt += ` Your capabilities: ${caps || 'general'}.`;
  prompt += ` You report to: ${hierarchy.reportsTo || 'board'}.`;
  prompt += ` Your current model: ${agentConfig.model}, temperature: ${agentConfig.temperature ?? 'default'}.`;
  prompt += ` Today is ${dayName}, ${todayLocal} in the user's timezone (${tzLabel}).

DATE-HANDLING RULES (read carefully, you have failed at this before):
- The <today> and <recent_meetings> blocks below list every meeting in the past 30 days with its real date. They are the ONLY source of truth for which meetings happened on which dates.
- When the user asks about a specific date (e.g. "May 7", "yesterday", "last Monday"), look for a matching entry in <recent_meetings>. If no entry matches that date, say so clearly: "I don't see a meeting recorded on <date>." Do NOT substitute an older meeting with a similar title.
- KB search results often surface meetings from prior years. Their date metadata (e.g. "2025-05-07") is the truth — never relabel them with a different year. If a KB hit is older than 30 days, say so explicitly when citing it.
- Never fabricate or assume a year. The year of a meeting is whatever the <today>/<recent_meetings>/citation metadata says, full stop.`;

  if (mode === 'suggest') {
    prompt += ` IMPORTANT: You operate in SUGGEST mode. You may propose actions but cannot execute them directly. Frame recommendations as suggestions for the board to approve.`;
  }

  if (tier === 'strategist') {
    prompt += ` You provide strategic analysis and priority recommendations. Be thoughtful and thorough.`;
  } else if (tier === 'orchestrator') {
    prompt += ` You coordinate pipeline operations. Be concise and action-oriented.`;
  } else if (tier === 'architect') {
    prompt += ` You analyze system patterns and suggest optimizations. Be analytical.`;
  } else if (tier === 'executor') {
    prompt += ` You handle specific execution tasks. Be precise and efficient.`;
  } else if (tier === 'reviewer') {
    prompt += ` You review quality and enforce constitutional gates. Be thorough and specific.`;
  }

  prompt += `\n\nYou are chatting with a board member. Be conversational but substantive. Answer questions about your domain, provide status updates, and offer recommendations. When asked about your performance or efficiency, use your metrics data to give grounded answers.

CRITICAL: You MUST use your tools to answer questions. NEVER describe what you would do — actually call the tool. NEVER say "I'll search the knowledge base" — call search_knowledge_base immediately. NEVER say "I'll create a campaign" — call create_campaign immediately.

Your tools:
- search_knowledge_base: ALWAYS call this when asked about decisions, architecture, people, projects, or anything that might be in the knowledge base. Call it FIRST, then answer using the results.
- create_campaign: Call when asked to build or create something.
- check_pipeline: Call when asked about status, budget, or what's happening.
- list_campaigns: Call when asked about recent campaigns.
- list_drafts: Call when asked about pending approvals.
- approve_proposal: Call when asked to approve something.

If you're unsure whether to use a tool, USE IT. Tools give you real data. Without tools you are guessing. Never narrate your intentions — execute them.`;

  prompt += `\n\nSPECIAL COMMANDS the board member may use:
- "review task <id>" or "task #<id>" — they want to discuss a specific work item. Use the task context provided below.
- "flag this" or "this was wrong" — they are flagging a decision for review. Acknowledge and confirm the feedback was logged.`;

  if (agentMetrics) {
    prompt += `\n\n${agentMetrics}`;
  }

  if (pipelineContext) {
    prompt += `\n\n${pipelineContext}`;
  }

  return prompt;
}

/**
 * Map raw RAG citations into a chat-friendly shape with numbered markers,
 * source kind, human label, and snippet. The chat backend includes the
 * [N] tags in the system prompt; the frontend renders them as chips.
 */
function formatCitationsForChat(citations, max = 8) {
  const SOURCE_LABEL = {
    tldv: 'TL;DV',
    gemini: 'Meeting',
    wiki: 'Wiki',
    'wiki-compiled': 'Wiki',
    email: 'Email',
    drive: 'Drive',
    github: 'GitHub',
    obsidian: 'Vault',
    'brain-rag': 'KB',
  };

  const SOURCE_KIND = {
    tldv: 'meeting', gemini: 'meeting',
    wiki: 'wiki', 'wiki-compiled': 'wiki',
    email: 'email', drive: 'drive',
    github: 'github', obsidian: 'vault', 'brain-rag': 'kb',
  };

  return citations.slice(0, max).map((c, i) => {
    const meta = c.metadata || {};
    const source = (meta.source || 'kb').toLowerCase();
    const kind = SOURCE_KIND[source] || 'kb';
    const sourceLabel = SOURCE_LABEL[source] || 'KB';

    let label = sourceLabel;
    if (meta.title) {
      label = `${sourceLabel} · ${String(meta.title).slice(0, 60)}`;
    } else if (meta.participants && Array.isArray(meta.participants) && meta.participants[0]) {
      const name = meta.participants[0].name || meta.participants[0].email;
      if (name) label = `${sourceLabel} · ${name}`;
    }
    if (meta.happened_at || meta.date) {
      const d = new Date(meta.happened_at || meta.date);
      if (!isNaN(d.getTime())) {
        label += ` (${d.toISOString().slice(0, 10)})`;
      }
    }

    return {
      n: i + 1,
      kind,
      label,
      snippet: (c.text || '').slice(0, 240),
      documentId: c.documentId,
      similarity: c.similarity,
    };
  });
}

/**
 * Gather lightweight pipeline context for the system prompt.
 */
async function gatherPipelineContext() {
  const parts = ['<pipeline_context>'];

  try {
    const [budget, activity] = await Promise.all([
      query(`SELECT allocated_usd, spent_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'in_progress') AS active_tasks, COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= CURRENT_DATE) AS completed_today, COUNT(DISTINCT assigned_to) FILTER (WHERE status = 'in_progress') AS active_agents FROM agent_graph.work_items WHERE updated_at >= CURRENT_DATE - 1`),
    ]);

    const b = budget.rows[0];
    if (b) {
      parts.push(`Budget (today): $${parseFloat(b.spent_usd || 0).toFixed(2)} / $${parseFloat(b.allocated_usd || 0).toFixed(2)}`);
    }

    const a = activity.rows[0];
    if (a) {
      parts.push(`Agent activity: ${a.active_agents || 0} active agents, ${a.active_tasks || 0} in-progress, ${a.completed_today || 0} completed today`);
    }
  } catch (err) {
    // Linus: sanitize error strings before prompt injection
    parts.push(`(pipeline context unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</pipeline_context>');
  return parts.join('\n');
}

// Shared SQL fragment that resolves a meeting doc's "real" happened_at:
//   1. Gemini docs → parse the title (Drive watcher historically didn't set
//      metadata.happenedAt, so the fallback would otherwise land on
//      file-creation time, hours after the meeting).
//   2. metadata.happenedAt when ISO-prefixed (tldv writes ISO; legacy rows
//      with JS Date.toString() can't be cast safely so fall through).
//   3. created_at as last resort.
// Mirrors api-routes/calendar.js and api-routes/meetings.js — those copies
// remain intact deliberately to keep each query module self-contained.
const HAPPENED_AT_SQL = `
  COALESCE(
    CASE
      WHEN (d.source = 'gemini' OR (d.source = 'drive' AND d.format = 'gemini'))
       AND d.title ~ '[0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT)'
      THEN (
        replace(
          (regexp_match(
            d.title,
            '([0-9]{4}[/-][0-9]{2}[/-][0-9]{2}\\s+[0-9]{1,2}:[0-9]{2}\\s+(PDT|PST|EDT|EST|MDT|MST|CDT|CST|UTC|GMT))'
          ))[1],
          '/', '-'
        )
      )::timestamptz
      ELSE NULL
    END,
    CASE WHEN d.metadata->>'happenedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         THEN (d.metadata->>'happenedAt')::timestamptz ELSE NULL END,
    d.created_at
  )
`;

/**
 * Gather today's meetings + open obligations for the board user.
 *
 * Phase 0: chat orchestrator was blind to today's calendar and unresolved
 * commitments. Inject the same data the Today view already fetches so the
 * model can reference "today's standup" or "the obligation I owe Ladd"
 * without the user having to copy-paste.
 */
async function gatherTodayContext(tz) {
  const parts = ['<today>'];
  // Match the system-prompt anchor — the caller's local timezone (IANA name
  // from the browser), with UTC fallback if missing/invalid.
  const validTz = validateTz(tz);
  const effectiveTz = validTz || 'UTC';
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: effectiveTz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  parts.push(`Today (${effectiveTz}): ${todayLocal}`);

  try {
    // Filter by the caller's calendar day, not server-UTC and not a rolling
    // window. Action items are embedded inline so the agent can answer
    // "what happened today" directly from this block — no KB round-trip
    // needed (which has surfaced stale older transcripts).
    const meetings = await query(
      `WITH parsed AS (
         SELECT d.id          AS document_id,
                d.title,
                d.participants,
                d.source       AS source,
                d.source_id    AS source_id,
                ${HAPPENED_AT_SQL} AS happened_at
         FROM content.documents d
         WHERE d.deleted_at IS NULL
           AND (d.source IN ('tldv','gemini')
                OR (d.source = 'drive' AND d.format IN ('tldv','gemini')))
       )
       SELECT
         p.title, p.participants, p.happened_at, p.document_id,
         m.id AS message_id,
         (
           SELECT COALESCE(json_agg(s ORDER BY s.created_at), '[]'::json)
           FROM (
             SELECT signal_type, content, due_date, direction, created_at
             FROM inbox.signals
             WHERE message_id = m.id
               AND signal_type IN ('action_item','commitment','request','decision')
               AND resolved = false
             ORDER BY created_at
             LIMIT 8
           ) s
         ) AS action_items
       FROM parsed p
       LEFT JOIN inbox.messages m
         ON m.channel = 'webhook'
        AND m.channel_id = p.source_id
       WHERE (p.happened_at AT TIME ZONE $1::text)::date
           = (now() AT TIME ZONE $1::text)::date
       ORDER BY p.happened_at DESC
       LIMIT 5`,
      [effectiveTz],
    );

    if (meetings.rows.length > 0) {
      parts.push(`Meetings on ${todayLocal} ${effectiveTz} (${meetings.rows.length}):`);
      for (const m of meetings.rows) {
        const time = new Date(m.happened_at).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: effectiveTz,
        });
        const attendees = Array.isArray(m.participants)
          ? m.participants.slice(0, 4).map(p => p.name || p.email).filter(Boolean).join(', ')
          : '';
        parts.push(`  - ${time} · ${m.title || 'Untitled'}${attendees ? ` (${attendees})` : ''}`);
        const items = Array.isArray(m.action_items) ? m.action_items : [];
        if (items.length > 0) {
          for (const ai of items) {
            const due = ai.due_date
              ? ` (due ${new Date(ai.due_date).toISOString().slice(0, 10)})`
              : '';
            const text = (ai.content || '').slice(0, 160).replace(/\s+/g, ' ');
            parts.push(`      • [${ai.signal_type}]${due} ${text}`);
          }
        }
      }
    } else {
      parts.push(`No meetings recorded yet on ${todayLocal} ${effectiveTz}.`);
    }

    // Open obligations — outbound action items / commitments not yet resolved.
    const obligations = await query(
      `SELECT s.content, s.due_date, s.signal_type, s.created_at
       FROM inbox.signals s
       WHERE s.resolved = false
         AND s.signal_type IN ('action_item','commitment')
         AND s.direction = 'outbound'
         AND s.created_at > now() - interval '30 days'
       ORDER BY (s.due_date IS NULL), s.due_date ASC, s.created_at DESC
       LIMIT 5`
    );

    if (obligations.rows.length > 0) {
      parts.push(`Open obligations (${obligations.rows.length}):`);
      for (const o of obligations.rows) {
        const dueLabel = o.due_date
          ? ` (due ${new Date(o.due_date).toISOString().slice(0, 10)})`
          : '';
        const text = (o.content || '').slice(0, 120).replace(/\s+/g, ' ');
        parts.push(`  - [${o.signal_type}]${dueLabel} ${text}`);
      }
    }
  } catch (err) {
    parts.push(`(today context unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</today>');
  return parts.join('\n');
}

/**
 * Gather meetings from the past 30 days as a date-anchored reference list.
 *
 * Why: when a user asks "what happened on May 7", the agent previously fell
 * back to KB search, which returned year-old meetings (same month/day, prior
 * year) and the agent confidently relabeled them as "this year." This block
 * gives the agent the actual list of recent meetings with their real dates,
 * so it can reject stale KB hits.
 *
 * Format is intentionally minimal — date, time, title, attendees — to keep
 * the token cost bounded. The agent should call search_knowledge_base only
 * for content (transcript snippets, decisions), never for date validation.
 */
async function gatherRecentMeetingsContext(tz) {
  const parts = ['<recent_meetings>'];
  const validTz = validateTz(tz);
  const effectiveTz = validTz || 'UTC';
  parts.push(`Past 30 days of meetings (dates in ${effectiveTz}). This is the definitive list — if a date the user asks about isn't here, no meeting was recorded that day.`);

  try {
    const result = await query(
      `WITH parsed AS (
         SELECT d.id, d.title, d.participants, d.source, d.source_id,
                ${HAPPENED_AT_SQL} AS happened_at
         FROM content.documents d
         WHERE d.deleted_at IS NULL
           AND (d.source IN ('tldv','gemini')
                OR (d.source = 'drive' AND d.format IN ('tldv','gemini')))
       )
       SELECT title, participants, happened_at
       FROM parsed
       WHERE (happened_at AT TIME ZONE $1::text)::date
             >= ((now() AT TIME ZONE $1::text)::date - INTERVAL '30 days')
         AND (happened_at AT TIME ZONE $1::text)::date
             <= ((now() AT TIME ZONE $1::text)::date)
       ORDER BY happened_at DESC
       LIMIT 50`,
      [effectiveTz],
    );

    if (result.rows.length === 0) {
      parts.push('(no meetings recorded in the past 30 days)');
    } else {
      for (const m of result.rows) {
        const date = new Intl.DateTimeFormat('en-CA', {
          timeZone: effectiveTz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(m.happened_at));
        const time = new Date(m.happened_at).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: effectiveTz,
        });
        const attendees = Array.isArray(m.participants)
          ? m.participants.slice(0, 3).map(p => p.name || p.email).filter(Boolean).join(', ')
          : '';
        parts.push(`  ${date} ${time} — ${m.title || 'Untitled'}${attendees ? ` (${attendees})` : ''}`);
      }
    }
  } catch (err) {
    parts.push(`(recent meetings unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</recent_meetings>');
  return parts.join('\n');
}

/**
 * Gather agent-specific performance metrics for self-awareness.
 * Liotta: single SQL query, under 200 tokens, O(log n) with existing indexes.
 */
async function gatherAgentMetrics(agentId) {
  const parts = ['<agent_metrics>'];

  try {
    // 7-day performance summary from llm_invocations
    const metricsResult = await query(
      `SELECT
         count(*) AS invocations,
         COALESCE(SUM(cost_usd), 0) AS total_cost,
         COALESCE(AVG(cost_usd), 0) AS avg_cost,
         COALESCE(AVG(input_tokens + output_tokens), 0) AS avg_tokens,
         COALESCE(SUM(input_tokens), 0) AS total_input,
         COALESCE(SUM(output_tokens), 0) AS total_output
       FROM agent_graph.llm_invocations
       WHERE agent_id = $1 AND created_at > now() - interval '7 days'`,
      [agentId]
    );

    const m = metricsResult.rows[0];
    if (m && parseInt(m.invocations) > 0) {
      parts.push(`Your performance (last 7 days):`);
      parts.push(`  Invocations: ${m.invocations}`);
      parts.push(`  Total cost: $${parseFloat(m.total_cost).toFixed(4)}`);
      parts.push(`  Avg cost/invocation: $${parseFloat(m.avg_cost).toFixed(4)}`);
      parts.push(`  Avg tokens/invocation: ${Math.round(parseFloat(m.avg_tokens))}`);
      parts.push(`  Total tokens: ${parseInt(m.total_input).toLocaleString()} in / ${parseInt(m.total_output).toLocaleString()} out`);
    } else {
      parts.push(`No invocations recorded in the last 7 days.`);
    }

    // Task completion stats (if this agent has work_items)
    const taskResult = await query(
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
         count(*) FILTER (WHERE status IN ('in_progress', 'assigned')) AS active
       FROM agent_graph.work_items
       WHERE assigned_to = $1 AND created_at > now() - interval '7 days'`,
      [agentId]
    );

    const t = taskResult.rows[0];
    if (t && parseInt(t.total) > 0) {
      const completionRate = parseInt(t.total) > 0
        ? ((parseInt(t.completed) / parseInt(t.total)) * 100).toFixed(0)
        : '0';
      parts.push(`  Tasks (7d): ${t.total} total, ${t.completed} completed, ${t.cancelled} cancelled, ${t.active} active (${completionRate}% completion rate)`);
    }
  } catch (err) {
    // Linus: sanitize error strings before prompt injection
    parts.push(`(metrics unavailable: ${sanitize(err.message)})`);
  }

  parts.push('</agent_metrics>');
  return parts.join('\n');
}

/**
 * Create a new chat session. Linus #2: server-generated UUID.
 * @param {string} agentId
 * @param {string} boardUser
 * @returns {{ sessionId: string }}
 */
export async function createChatSession(agentId, _boardUser) {
  const config = await loadConfig();
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (!agent.chat?.enabled) throw new Error(`Chat not enabled for agent: ${agentId}`);

  return { sessionId: randomUUID() };
}

/**
 * Handle a chat message from a board member.
 *
 * When `onEvent` is provided the turn streams: tokens and tool progress are
 * emitted as they happen ({type:'status'|'token'|'tool_result'}), the user
 * message is persisted at entry, and the assistant row is inserted up front
 * with status='streaming' then updated incrementally — a crash or abort never
 * silently eats the turn. Without `onEvent`, behavior matches the legacy
 * blocking path (full response, single insert at the end).
 *
 * @param {string} agentId
 * @param {string} message
 * @param {{ boardUser: string, sessionId: string, onEvent?: (ev: object) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, costUsd: number, sessionId: string, model: string, messageId?: string }>}
 */
export async function handleAgentChat(agentId, message, { boardUser, sessionId, _mode, pageContext, tz, onEvent, signal }) {
  const emit = typeof onEvent === 'function'
    ? (ev) => { try { onEvent(ev); } catch { /* never let a client write kill the turn */ } }
    : null;
  const config = await loadConfig();
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (!agent.chat?.enabled) throw new Error(`Chat not enabled for agent: ${agentId}`);

  // Linus #6: lock model at invocation time (from fresh config)
  const model = agent.model;
  const maxCostPerSession = agent.chat.maxCostPerSession || 1.00;

  // --- Stage A (P3 latency): independent preamble reads, in parallel ---
  // History, work-item context, tenancy resolution, and flag logging have no
  // ordering dependencies — running them serially was pure wasted wall-clock.
  // History MUST be read before the user-message insert below so the current
  // turn never appears in its own history.
  const flagMatch = message.match(/\b(flag\s+(?:this|decision|that)|this\s+was\s+wrong|incorrect|bad\s+decision)\b/i);
  const taskRefMatch = message.match(/(?:review\s+task|task\s*#?|work\s*item\s*#?)(\d+)/i);

  const memoryKey = chatMemoryKey(boardUser);
  const [history, taskContext, chatRetrieverScope, boardMemories] = await Promise.all([
    // Conversation history — the MOST RECENT 20 messages, oldest-first.
    // (An earlier `ORDER BY created_at ASC LIMIT 20` silently pinned context
    // to the first 20 messages of the session ever; long sessions lost all
    // recency.) Streaming-partial and errored rows are excluded — a crashed
    // turn's fragment is not conversation.
    query(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM agent_graph.board_chat_messages
         WHERE session_id = $1 AND status = 'complete' AND content <> ''
         ORDER BY created_at DESC LIMIT 20
       ) h ORDER BY created_at ASC`,
      [sessionId]
    ).then(r => r.rows.map(row => ({ role: row.role, content: row.content }))),
    // Work item context (item 4: "review task 1234")
    taskRefMatch ? loadWorkItemContext(parseInt(taskRefMatch[1], 10)) : Promise.resolve(''),
    // Tenancy scope for all RAG calls this turn (fail-closed)
    resolveChatRetrieverScope(boardUser),
    // P4/010-D: this board member's durable memories (preferences, facts, past
    // mistakes), recalled by relevance to THIS turn (entity overlap) within the
    // same ≤20 budget — falls back to recency when the turn names no known
    // entity. Degrades to [] if the table is missing.
    memoryKey ? loadRelevantMemories(memoryKey, { limit: 20, turnText: message }) : Promise.resolve([]),
    // Flag decision detection (item 4: board feedback loop)
    flagMatch ? logBoardFeedback(agentId, sessionId, boardUser, message) : Promise.resolve(),
  ]);

  // Budget gate + user-message insert, atomic under a per-session advisory
  // lock (Linus M1: a bare SELECT SUM + app-side compare let two concurrent
  // sends both read the stale total and both pass). xact-scoped lock —
  // released at COMMIT, safe through the Supabase transaction pooler.
  // Streaming path persists the user message inside the same transaction so
  // a mid-turn crash can't silently eat the question (Linus B3); the legacy
  // blocking path keeps its tail insert.
  await withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [sessionId]);
    const r = await tx.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost FROM agent_graph.board_chat_messages WHERE session_id = $1`,
      [sessionId]
    );
    const sessionCost = parseFloat(r.rows[0]?.total_cost || 0);
    if (sessionCost >= maxCostPerSession) {
      throw new Error(`Session budget exceeded ($${sessionCost.toFixed(4)} / $${maxCostPerSession.toFixed(2)}). Start a new session.`);
    }
    if (emit) {
      await tx.query(
        `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content) VALUES ($1, $2, $3, 'user', $4)`,
        [sessionId, agentId, boardUser, message]
      );
    }
  });
  if (emit) {
    emit({ type: 'status', phase: 'context', label: 'Gathering context…' });
  }

  // RAG knowledge retrieval — Phase 0: keyword gate killed. Always run for
  // anything that could be a question: short queries ("Ladd status") and
  // pronouns ("what did he say?") were silently bypassing the 863-doc KB.
  // P3 carves out ONLY unambiguous courtesy turns ("thanks", "ok", "hi") via
  // SMALL_TALK_RE below — never content-bearing messages.
  //
  // Meeting + temporal queries ("what happened on the formul8 meeting today")
  // get the same treatment as /api/search: parse temporal range, detect
  // meeting intent, anchor on docs whose envelope matches the intent
  // tokens, scope retrieval to those docs + that window, and surface the
  // meeting's extracted signals (commitments / decisions / action items)
  // separately so the LLM sees them as evidence.
  const runRagRetrieval = async () => {
    let ragContext = null;
    let meetingSignalChunks = [];
    try {
      const { retrieveContext } = await import('../../../lib/rag/retriever.js');
      const {
        parseTemporalRange,
        extractMeetingIntent,
        findMeetingDocsByIntent,
        fetchMeetingSignalChunks,
      } = await import('../api-routes/search.js');

      if (!chatRetrieverScope) {
        console.warn(`[agent-chat] no ownerId for ${boardUser} — skipping RAG (deny-by-default)`);
        throw new Error('no chat retriever scope');
      }

      const tzOffsetMin = (() => {
        // tz arrives as an IANA name (e.g. "America/Chicago") or undefined;
        // when absent, fall back to the server's local offset so "today"
        // doesn't slide by a day for chat sessions without timezone.
        if (!tz) return new Date().getTimezoneOffset();
        try {
          // Compute the offset for the current moment in the user's tz.
          const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
          const parts = fmt.formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
          const m = parts.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
          if (!m) return new Date().getTimezoneOffset();
          const sign = m[1] === '-' ? 1 : -1; // getTimezoneOffset is inverted
          const hours = parseInt(m[2], 10);
          const minutes = m[3] ? parseInt(m[3], 10) : 0;
          return sign * (hours * 60 + minutes);
        } catch {
          return new Date().getTimezoneOffset();
        }
      })();

      const temporalRange = parseTemporalRange(message, new Date(), tzOffsetMin);
      const meetingIntent = extractMeetingIntent(message);

      const ragOpts = { maxClassification: 'INTERNAL', history };
      if (temporalRange) ragOpts.temporalRange = temporalRange;

      // Project-scoped RAG: try project documents first, fall back to global
      let projectDocIds = null;
      if (pageContext?.entityType === 'project' && pageContext?.entityId) {
        try {
          const projLookup = await query(
            `SELECT id FROM agent_graph.projects WHERE slug = $1`, [pageContext.entityId]
          );
          if (projLookup.rows[0]) {
            const docResult = await query(
              `SELECT entity_id FROM agent_graph.project_memberships WHERE project_id = $1 AND entity_type = 'document'`,
              [projLookup.rows[0].id]
            );
            if (docResult.rows.length > 0) {
              projectDocIds = docResult.rows.map(r => r.entity_id);
            }
          }
        } catch { /* non-critical — fall through to global RAG */ }
      }

      // Meeting anchor: resolve "the X meeting" to specific doc IDs by
      // structured match on title/participants/email-domain/organization
      // BEFORE vector search. When matched, the chunk search is scoped to
      // those docs — even a generically-titled meeting like "5/11/2026-
      // Meeting" surfaces when an attendee email domain matches the token.
      let meetingAnchorIds = null;
      if (
        meetingIntent?.isMeetingQuery
        && temporalRange
        && (meetingIntent.requiredTokens || []).length > 0
      ) {
        try {
          const anchored = await findMeetingDocsByIntent(meetingIntent.requiredTokens, temporalRange);
          if (anchored.length > 0) meetingAnchorIds = anchored;
        } catch { /* non-fatal — fall through to standard retrieval */ }
      }

      const scopedDocIds = meetingAnchorIds
        || (projectDocIds && projectDocIds.length > 0 ? projectDocIds : null);

      if (scopedDocIds) {
        // When the anchor matched, drop temporalRange from retrieveContext.
        // The anchor already filtered by *meeting happened time* (the SQL
        // uses metadata.happenedAt when present), but retriever.js applies
        // temporalRange against d.created_at — which is the ingest time. A
        // legitimate yesterday-meeting that was backfilled today (or vice
        // versa) would get re-filtered out by retriever even though the
        // anchor correctly picked it. Anchor wins; skip the second filter.
        const scopedOpts = meetingAnchorIds
          ? { ...ragOpts, documentIds: scopedDocIds, temporalRange: undefined }
          : { ...ragOpts, documentIds: scopedDocIds };
        ragContext = await retrieveContext(message, scopedOpts, chatRetrieverScope);
        // Project-scoped only: fall back to global if the project surface
        // returned nothing. Meeting-anchored doesn't fall back — when we
        // resolved to specific meetings, "no answer" is the right answer.
        if (!ragContext?.answer && !meetingAnchorIds) {
          ragContext = await retrieveContext(message, ragOpts, chatRetrieverScope);
        }
      } else {
        ragContext = await retrieveContext(message, ragOpts, chatRetrieverScope);
      }

      // Surface extracted signals for whichever meeting documents the
      // retrieval landed on. Prefer the anchored set when present; else
      // pull from the returned chunks' documentIds.
      const meetingDocIds = meetingAnchorIds
        ? meetingAnchorIds
        : [...new Set((ragContext?.chunks || []).map((c) => c?.documentId).filter(Boolean))];
      if (meetingDocIds.length > 0) {
        try {
          meetingSignalChunks = await fetchMeetingSignalChunks(meetingDocIds);
        } catch { /* non-fatal */ }
      }
    } catch { /* RAG unavailable — degrade gracefully */ }
    return { ragContext, meetingSignalChunks };
  };

  // --- Stage B (P3 latency): RAG + the four context gathers, concurrent ---
  // RAG (embed → vector search → rerank, ~0.5–1.5s) previously ran serially
  // BEFORE the gathers; overlapping them is the biggest structural cut in
  // the preamble. Courtesy turns skip retrieval entirely — but only the
  // unambiguous ones (see Phase 0 note above), and never questions.
  const skipRag = SMALL_TALK_RE.test(message.trim()) && !message.includes('?');
  const [ragResult, pipelineContext, agentMetrics, todayContext, recentMeetingsContext] = await Promise.all([
    skipRag ? Promise.resolve({ ragContext: null, meetingSignalChunks: [] }) : runRagRetrieval(),
    gatherPipelineContext(),
    gatherAgentMetrics(agentId),
    gatherTodayContext(tz),
    gatherRecentMeetingsContext(tz),
  ]);
  const { ragContext, meetingSignalChunks } = ragResult;
  let systemPrompt = buildChatSystemPrompt(agent, pipelineContext, agentMetrics, { tz });
  systemPrompt += `\n\n${todayContext}`;
  systemPrompt += `\n\n${recentMeetingsContext}`;

  // P4: board-member memory — the compounding context layer. Extracted from
  // past chats (preferences, durable facts) and board feedback (failures).
  // Applied silently: the model uses them, it doesn't recite the list.
  if (boardMemories.length > 0) {
    const memoryLines = boardMemories.map(m => `- [${m.memory_type}] ${m.content}`).join('\n');
    systemPrompt += `\n\n<board_member_memory>\nDurable memory about this board member from previous conversations and feedback. Apply silently when relevant — never recite or mention this list. Treat [failure] entries as past mistakes you must not repeat.\n${memoryLines}\n</board_member_memory>`;
  }

  // Inject RAG knowledge base context.
  //
  // The citations block (numbered [1]..[N]) is the reference scaffolding
  // — short labels + 240-char snippets — that lets the LLM emit inline
  // [N] markers the frontend renders as chips. But the snippets alone
  // aren't enough substance for a transcript-style question; ragContext.
  // answer carries the full reranked content (top-10 chunks, ~2200
  // tokens) and that's what the LLM actually needs to read.
  //
  // Include both: the answer block for substance, the citations block
  // for marker discipline. Their ordering matches — ragContext.citations
  // is built in the same order chunks are appended to .answer, so
  // citation [1] really is the first chunk in the block.
  let formattedCitations = [];
  if (ragContext?.answer && ragContext.citations?.length > 0) {
    formattedCitations = formatCitationsForChat(ragContext.citations);

    const citationsBlock = formattedCitations
      .map(c => `[${c.n}] ${c.label}`)
      .join('\n');

    systemPrompt += `\n\n<knowledge_base>\nRelevant context from the Optimus knowledge base (${formattedCitations.length} sources). Cite inline using [N] markers that correspond to the sources listed at the bottom — e.g. "We decided X [1] and shipped Y last week [2]." Do NOT invent citation numbers; only use the ones below.\n\nContent:\n${ragContext.answer}\n\nSources:\n${citationsBlock}\n</knowledge_base>`;
  } else if (ragContext?.answer) {
    // Fallback: answer text with no structured citations
    systemPrompt += `\n\n<knowledge_base>\nRelevant context from the Optimus knowledge base:\n\n${ragContext.answer}\n</knowledge_base>`;
  }

  // Surface extracted meeting signals (decisions / commitments / action
  // items) for the meeting(s) the query landed on. The transcript chunks
  // are the prose; these are the structured "what did we decide" — the
  // LLM is told to use them as authoritative for any decision/action
  // question and cite the originating meeting by title.
  if (meetingSignalChunks.length > 0) {
    const signalsText = meetingSignalChunks.map((c) => c.text).join('\n\n---\n\n');
    systemPrompt += `\n\n<meeting_signals>\nExtracted decisions, commitments, and action items from the meeting(s) most relevant to this question. Treat these as authoritative when answering "what did we decide / commit to / agree on" — they are post-meeting structured signals, not transcript prose. Reference the meeting by title.\n\n${signalsText}\n</meeting_signals>`;
  }

  // Inject page context if the board member is viewing a specific page
  if (pageContext?.route) {
    let contextBlock = `The user is currently viewing: ${pageContext.title || pageContext.route} (${pageContext.route}).`;
    if (pageContext.entityType) contextBlock += ` Entity type: ${pageContext.entityType}.`;
    if (pageContext.entityId) contextBlock += ` Entity ID: ${pageContext.entityId}.`;

    // Enrich with entity-specific data from the database
    if (pageContext.entityType === 'campaign' && pageContext.entityId) {
      try {
        const camp = await query(
          `SELECT goal_description, campaign_status, campaign_mode, completed_iterations, max_iterations, spent_usd, success_criteria
           FROM agent_graph.campaigns WHERE id = $1`, [pageContext.entityId]
        );
        if (camp.rows[0]) {
          const c = camp.rows[0];
          contextBlock += `\nCampaign: "${c.goal_description?.slice(0, 200)}"`;
          contextBlock += `\nStatus: ${c.campaign_status}, Mode: ${c.campaign_mode}, Iterations: ${c.completed_iterations}/${c.max_iterations}, Spent: $${parseFloat(c.spent_usd || 0).toFixed(2)}`;
          if (c.success_criteria) contextBlock += `\nSuccess criteria: ${JSON.stringify(c.success_criteria).slice(0, 300)}`;
        }
      } catch { /* non-critical */ }
    }

    if (pageContext.entityType === 'project' && pageContext.entityId) {
      try {
        const proj = await query(
          `SELECT id, name, description, instructions, classification_floor FROM agent_graph.projects WHERE slug = $1`,
          [pageContext.entityId]
        );
        if (proj.rows[0]) {
          const p = proj.rows[0];
          contextBlock += `\nProject: "${p.name}"${p.description ? ` — ${p.description}` : ''}`;
          contextBlock += `\nClassification: ${p.classification_floor}`;
          if (p.instructions) contextBlock += `\nProject instructions: ${p.instructions.slice(0, 500)}`;
          // Load active project memory
          const mem = await query(
            `SELECT key, value FROM agent_graph.project_memory WHERE project_id = $1 AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 10`,
            [p.id]
          );
          if (mem.rows.length > 0) {
            contextBlock += `\nProject memory:\n${mem.rows.map(m => `- ${m.key}: ${m.value.slice(0, 200)}`).join('\n')}`;
          }
        }
      } catch { /* non-critical */ }
    }

    // Pass through any additional metadata from the page
    if (pageContext.metadata && Object.keys(pageContext.metadata).length > 0) {
      contextBlock += `\nPage data: ${JSON.stringify(pageContext.metadata).slice(0, 500)}`;
    }

    systemPrompt += `\n\n<page_context>${contextBlock}\nUse this context when answering questions about the current page.</page_context>`;
  }

  // Append work item context if referenced
  if (taskContext) {
    systemPrompt += `\n\n<work_item_context>\n${taskContext}\n</work_item_context>`;
  }

  // Build messages: history + current user message (standalone, Linus #5)
  const llmMessages = [...history, { role: 'user', content: message }];

  // Linus #7: per-agent cached client (cache key includes model for invalidation)
  const llm = getLLMForAgent(agentId, config);

  // Phase 0: Plan/Build toggle removed. Tool authorization is the model's
  // responsibility under the existing guardrails (G1-G11) — a UI toggle
  // that defaulted to "crippled" was the wrong abstraction. The orchestrator
  // gets the full tool list and decides whether to act.
  const activeTools = CHAT_TOOLS;

  // Streaming path: insert the assistant row up front (status='streaming',
  // empty content) so the turn is durable from the first token. Periodic
  // flushes below update it; the tail of this function finalizes it.
  let assistantMessageId = null;
  if (emit) {
    const ins = await query(
      `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content, model, status)
       VALUES ($1, $2, $3, 'assistant', '', $4, 'streaming') RETURNING id`,
      [sessionId, agentId, boardUser, model]
    );
    assistantMessageId = ins.rows[0]?.id || null;
  }

  // Tool-use loop: agent can call tools, we execute and feed results back
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let responseText = '';
  let lastAction = null;       // track structured actions from tool calls
  let lastCampaignId = null;
  let lastArtifactType = null;
  let completedNaturally = false; // model finished with prose (vs. round cap)
  const MAX_TOOL_ROUNDS = 6;

  // Streaming: accumulate per-round text so the persisted content matches
  // what the user watched stream (tool-round commentary + final answer),
  // and flush partial content to Postgres every ~600 chars for durability.
  const textParts = [];
  let unflushedChars = 0;
  const flushPartial = async () => {
    if (!assistantMessageId) return;
    unflushedChars = 0;
    try {
      await query(
        `UPDATE agent_graph.board_chat_messages SET content = $1 WHERE id = $2`,
        [textParts.join('\n\n'), assistantMessageId]
      );
    } catch { /* durability flush is best-effort; final update still runs */ }
  };

  // One streamed LLM round: forwards tokens to the client, accumulates text
  // for persistence, returns the normalized final response.
  const streamRound = async (params) => {
    emit({ type: 'status', phase: 'thinking' });
    let resp = null;
    let startedRound = false;
    for await (const ev of callProviderStream(llm, params)) {
      if (ev.type === 'token') {
        if (!startedRound) {
          startedRound = true;
          // Visual gap between tool-round commentary and the next round
          if (textParts.length > 0) emit({ type: 'token', delta: '\n\n' });
          textParts.push('');
        }
        textParts[textParts.length - 1] += ev.delta;
        emit({ type: 'token', delta: ev.delta });
        unflushedChars += ev.delta.length;
        if (unflushedChars >= 600) await flushPartial();
      } else if (ev.type === 'final') {
        resp = ev.response;
      }
    }
    if (!resp) throw new Error('LLM stream ended without a final frame');
    return resp;
  };

  // 010-B: graph-kind provenance chips accumulated across tool rounds, merged
  // into the response citations the same (ephemeral) way RAG citations are.
  const graphCitations = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const callParams = {
      system: systemPrompt,
      messages: llmMessages,
      maxTokens: agent.maxTokens || 2048,
      temperature: agent.temperature ?? 0.3,
      tools: activeTools,
      signal,
      // Caps thinking-model reasoning budget (chat TTFT is dominated by it).
      // Config-driven per agent; unset = provider default, unchanged behavior.
      reasoningEffort: agent.chat?.reasoningEffort,
    };

    const response = emit
      ? await streamRound(callParams)
      : await callProvider(llm, callParams);

    totalInputTokens += response.inputTokens || 0;
    totalOutputTokens += response.outputTokens || 0;

    // If no tool calls, we're done — capture text response
    if (!response.toolCalls || response.toolCalls.length === 0 || response.stopReason !== 'tool_use') {
      responseText = response.text || 'No response generated.';
      completedNaturally = true;
      break;
    }

    // Tool calls: execute each one and add results to messages
    // First, add the assistant's response (with tool_use blocks) to messages
    llmMessages.push({ role: 'assistant', content: response.raw?.content || [] });

    for (const toolCall of response.toolCalls) {
      if (emit) emit({ type: 'status', phase: 'tool', tool: toolCall.name, label: chatToolLabel(toolCall.name) });
      // Worktree 1: thread the chat caller's retriever scope into tool
      // invocations so tools that touch RAG (search_knowledge_base) run
      // under the right ownerId.
      const toolResult = await executeChatTool(toolCall.name, toolCall.input || {}, chatRetrieverScope);
      if (emit) emit({ type: 'tool_result', tool: toolCall.name, summary: String(toolResult).slice(0, 200) });
      llmMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: toolResult }],
      });
      console.log(`[agent-chat] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)}) → ${toolResult.slice(0, 100)}`);

      // Track structured actions for frontend
      if (toolCall.name === 'create_campaign') {
        try {
          const parsed = JSON.parse(toolResult);
          if (parsed.ok && parsed.campaign_id) {
            lastAction = 'campaign_created';
            lastCampaignId = parsed.campaign_id;
            // Detect content vs build from the goal
            const goal = (toolCall.input?.goal || '').toLowerCase();
            lastArtifactType = /\b(blog|article|linkedin|content|write|post)\b/.test(goal) ? 'content' : 'build';
          }
        } catch { /* non-fatal */ }
      }

      // 010-B: turn graph rows into provenance chips (kind:'graph').
      if (toolCall.name === 'query_graph') {
        try {
          const parsed = JSON.parse(toolResult);
          if (parsed.ok && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
            graphCitations.push(...formatGraphCitations(parsed.rows, parsed.template));
          }
        } catch { /* non-fatal */ }
      }
    }

    // Capture any text from tool-calling turn (agent may say something + call a tool)
    if (response.text) {
      responseText = response.text;
    }
  }

  // Loop exhausted while still calling tools (or the model never produced
  // prose): force one final synthesis round that cannot call tools, so the
  // user gets an actual answer about what was done instead of the old
  // canned 'Action completed.'. Anthropic requires the tools param when
  // tool blocks exist in the message history, so it gets tool_choice:'none';
  // OpenAI-format providers get no tools at all (tool_choice:'none' is not
  // reliably honored across OpenRouter models, but tool history without a
  // tools param is). Runs both when there is no text at all and when the
  // round cap was hit with only mid-round commentary captured.
  if (!completedNaturally || !responseText) {
    const synthParams = {
      system: systemPrompt,
      messages: llmMessages,
      maxTokens: agent.maxTokens || 2048,
      temperature: agent.temperature ?? 0.3,
      signal,
      reasoningEffort: agent.chat?.reasoningEffort,
      ...(llm.provider === 'anthropic'
        ? { tools: activeTools, toolChoice: { type: 'none' } }
        : {}),
    };
    const synth = emit
      ? await streamRound(synthParams)
      : await callProvider(llm, synthParams);
    totalInputTokens += synth.inputTokens || 0;
    totalOutputTokens += synth.outputTokens || 0;
    responseText = synth.text || 'No response generated.';
  }

  const costUsd = computeCost(totalInputTokens, totalOutputTokens, llm.modelConfig);

  // Persist. Streaming path: the user row was inserted at entry and the
  // assistant row exists with status='streaming' — finalize it with content
  // that matches exactly what streamed to the client. Legacy path: both
  // inserts at the tail, as before.
  const finalContent = emit ? (textParts.join('\n\n') || responseText) : responseText;

  // 010-B: merge graph provenance chips after any RAG chips (continuing the [N]
  // numbering) BEFORE persisting, so the durable row carries the full set (OQ-4).
  if (graphCitations.length > 0) {
    const base = formattedCitations.length;
    formattedCitations = [
      ...formattedCitations,
      ...graphCitations.map((c, i) => ({ ...c, n: base + i + 1 })),
    ];
  }
  // OQ-4: persist citations (RAG + graph) on the message row for audit (P3).
  const citationsJson = formattedCitations.length > 0 ? JSON.stringify(formattedCitations) : null;

  if (assistantMessageId) {
    await query(
      `UPDATE agent_graph.board_chat_messages SET content = $1, cost_usd = $2, model = $3, status = 'complete', citations = $5 WHERE id = $4`,
      [finalContent, costUsd, model, assistantMessageId, citationsJson]
    );
  } else {
    await query(
      `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content) VALUES ($1, $2, $3, 'user', $4)`,
      [sessionId, agentId, boardUser, message]
    );
    await query(
      `INSERT INTO agent_graph.board_chat_messages (session_id, agent_id, board_user, role, content, cost_usd, model, citations) VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7)`,
      [sessionId, agentId, boardUser, responseText, costUsd, model, citationsJson]
    );
  }

  // Linus #4: audit trail in llm_invocations
  try {
    await query(
      `INSERT INTO agent_graph.llm_invocations (agent_id, model, input_tokens, output_tokens, cost_usd, task_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [agentId, model, totalInputTokens, totalOutputTokens, costUsd, sessionId]
    );
  } catch (err) {
    console.warn(`[agent-chat] Failed to log invocation: ${err.message}`);
  }

  console.log(`[agent-chat] ${boardUser} → ${agentId} (${model}): ${totalInputTokens}+${totalOutputTokens} tokens, $${costUsd.toFixed(4)}`);

  // P4: fire-and-forget memory extraction — never blocks or fails the turn.
  // Courtesy turns (skipRag) can't contain anything durable; skip the call.
  if (memoryKey && !skipRag) {
    extractChatMemories({ memoryKey, sessionId, message, responseText: finalContent, config })
      .catch((err) => console.warn(`[agent-chat] memory extraction failed (non-fatal): ${err.message}`));
  }

  return {
    text: finalContent, costUsd, sessionId, model,
    ...(assistantMessageId && { messageId: assistantMessageId }),
    ...(formattedCitations.length > 0 && { citations: formattedCitations }),
    ...(lastAction && { action: lastAction }),
    ...(lastCampaignId && { campaign_id: lastCampaignId }),
    ...(lastArtifactType && { artifact_type: lastArtifactType }),
  };
}

/**
 * Human-readable progress label for a chat tool invocation (streamed to the
 * board UI while the tool runs).
 */
function chatToolLabel(name) {
  const labels = {
    search_knowledge_base: 'Searching the knowledge base…',
    create_campaign: 'Creating campaign…',
    check_pipeline: 'Checking the pipeline…',
    list_campaigns: 'Listing campaigns…',
    list_drafts: 'Listing drafts…',
    approve_proposal: 'Approving proposal…',
    query_graph: 'Querying the knowledge graph…',
  };
  return labels[name] || `Running ${name}…`;
}

/**
 * Get chat history for a session.
 * @param {string} sessionId
 * @returns {Promise<{ messages: Array<{ role: string, content: string, cost_usd: number, model: string, created_at: string }> }>}
 */
export async function getChatHistory(sessionId) {
  const result = await query(
    `SELECT id, role, content, cost_usd, model, agent_id, created_at, status, feedback, citations FROM agent_graph.board_chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId]
  );
  return { messages: result.rows };
}

/**
 * List all chat sessions for an agent, grouped by session.
 * @param {string} agentId
 * @param {number} [limit=20]
 * @returns {Promise<{ sessions: Array<{ sessionId: string, boardUser: string, messageCount: number, totalCost: number, firstMessage: string, lastActive: string }> }>}
 */
export async function listChatSessions(agentId, limit = 20) {
  const result = await query(
    `SELECT
       session_id,
       board_user,
       COUNT(*) AS message_count,
       COALESCE(SUM(cost_usd), 0) AS total_cost,
       MIN(created_at) AS first_message,
       MAX(created_at) AS last_active,
       (SELECT content FROM agent_graph.board_chat_messages m2
        WHERE m2.session_id = m.session_id AND m2.role = 'user'
        ORDER BY m2.created_at ASC LIMIT 1) AS first_user_message
     FROM agent_graph.board_chat_messages m
     WHERE agent_id = $1
     GROUP BY session_id, board_user
     ORDER BY MAX(created_at) DESC
     LIMIT $2`,
    [agentId, limit]
  );

  return {
    sessions: result.rows.map(r => ({
      sessionId: r.session_id,
      boardUser: r.board_user,
      messageCount: parseInt(r.message_count),
      totalCost: parseFloat(r.total_cost),
      firstMessage: r.first_user_message,
      lastActive: r.last_active,
    })),
  };
}

// ============================================================
// Chat Tools — actions agents can take during conversation
// ============================================================

const CHAT_TOOLS = [
  {
    name: 'create_campaign',
    description: 'Create a new campaign for the agent organization to execute. Use when the user wants to build something, create content, or run an iterative task.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What to build or do — be specific' },
        budget_usd: { type: 'number', description: 'Budget in USD (default 10)' },
        campaign_mode: { type: 'string', enum: ['stateless', 'stateful'], description: 'stateless for builds, stateful for system modifications' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'check_pipeline',
    description: 'Check the current pipeline status — active tasks, queue depth, agent activity, budget.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description: 'List recent campaigns with their status, score, and iteration count.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: running, succeeded, failed, pending_approval' },
      },
    },
  },
  {
    name: 'approve_proposal',
    description: 'Approve a pending draft, proposal, or action item.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Proposal/draft UUID' } },
      required: ['id'],
    },
  },
  {
    name: 'list_drafts',
    description: 'List pending drafts and action proposals awaiting board review.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_knowledge_base',
    description: 'Search the Optimus knowledge base (documents, meeting transcripts, vault notes) for specific information. Use when the board member asks about past decisions, project context, or institutional knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for — be specific' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_graph',
    description: 'Answer relational questions about people and organizations from the Optimus knowledge graph — who someone is connected to, who works at an org, how two people are connected, or recent collaborators. Use for "who do we know at X?", "who has been in the Y conversations?", "how are A and B connected?". Prefer this over search_knowledge_base for relationship/connection questions.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', enum: GRAPH_TEMPLATE_NAMES, description: 'person_connections (who someone is connected to) | org_people (people at an org) | shared_context (how two people connect) | recent_collaborators (recent co-attendance)' },
        person: { type: 'string', description: 'Email (preferred) or name — for person_connections / recent_collaborators' },
        org: { type: 'string', description: 'Organization name, slug, or domain — for org_people' },
        a: { type: 'string', description: 'First person, email preferred — for shared_context' },
        b: { type: 'string', description: 'Second person, email preferred — for shared_context' },
        days: { type: 'number', description: 'Recency window in days (default 30) — for recent_collaborators' },
      },
      required: ['template'],
    },
  },
];

export async function executeChatTool(toolName, toolInput, retrieverScope = null) {
  switch (toolName) {
    case 'create_campaign': {
      // Match the proper campaigns API POST handler (campaigns.js) exactly
      const goal = toolInput.goal || 'Campaign from chat';
      const budgetUsd = toolInput.budget_usd || 10;
      const title = `Campaign: ${goal.slice(0, 60)}`;

      // Dedup: check if same goal was created in last 60s
      const existing = await query(
        `SELECT id FROM agent_graph.campaigns
         WHERE created_by = 'board-chat'
         AND created_at > now() - interval '60 seconds'
         AND goal_description = $1 LIMIT 1`,
        [goal]
      );
      if (existing.rows.length > 0) {
        return JSON.stringify({ ok: true, campaign_id: existing.rows[0].id, status: 'already_exists', message: 'Campaign already created.' });
      }

      // Work item (type 'campaign', not 'task') — required for campaign list queries
      const wi = await query(
        `INSERT INTO agent_graph.work_items (id, type, title, description, status, priority, assigned_to, created_by, delegation_depth)
         VALUES (gen_random_uuid(), 'campaign', $1, $2, 'assigned', 5, 'claw-campaigner', 'board-chat', 0)
         RETURNING id`,
        [title, goal]
      );
      const workItemId = wi.rows[0]?.id;
      if (!workItemId) return JSON.stringify({ ok: false, error: 'Failed to create work item' });

      // Detect content/contract campaigns from goal text
      const goalLower = (goal || '').toLowerCase();
      const isBlog = /\b(blog\s*post|write\s+(a\s+)?(blog|article)|article\s+about)\b/.test(goalLower);
      const isLinkedIn = /\blinkedin\s*(post)?\b/.test(goalLower);
      const isContract = /\b(contract|proposal|service\s*plan|agreement|sow|scope\s*of\s*work|engagement\s*letter)\b/.test(goalLower);
      const isContent = isBlog || isLinkedIn;

      const metadata = {
        campaign_type: isContract ? 'contract' : isContent ? 'content' : 'build',
        source: 'board_chat',
        ...(isContract && {
          content_type: 'contract',
          topic: goal,
          client_name: toolInput.client_name || goal.replace(/.*(?:for|with)\s+/i, '').replace(/[.!?].*/, '').trim(),
        }),
        ...(isContent && {
          content_type: isLinkedIn ? 'linkedin' : 'blog',
          topic: goal,
          author: 'UMB Advisors',
          target_audience: 'Growth-stage company operators and founders',
          tone: 'Calm experienced operator, thinking in public',
        }),
      };
      const result = await query(
        `INSERT INTO agent_graph.campaigns (
          id, work_item_id, goal_description, budget_envelope_usd, campaign_mode,
          campaign_status, max_iterations, iteration_time_budget,
          success_criteria, constraints, created_by, metadata
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 'stateless',
          'approved', 20, '5 minutes'::interval,
          $4::jsonb, '{"tool_allowlist": ["llm_invoke"], "max_cost_per_iteration": 0.50}'::jsonb,
          'board-chat', $5::jsonb
        ) RETURNING id`,
        [
          workItemId, goal, budgetUsd,
          JSON.stringify([{ metric: 'quality_score', operator: '>=', threshold: 0.85 }]),
          JSON.stringify(metadata),
        ]
      );
      const campaignId = result.rows[0]?.id;

      // Publish event for SSE listeners + campaigner wake
      try {
        const { publishEvent } = await import('../runtime/infrastructure.js');
        await publishEvent('campaign_approved', `Campaign ${campaignId} created via board chat`, 'board-chat', null, { campaign_id: campaignId });
      } catch { /* non-fatal */ }

      return JSON.stringify({ ok: true, campaign_id: campaignId, work_item_id: workItemId, status: 'approved', message: `Campaign ${campaignId} created and approved.` });
    }
    case 'check_pipeline': {
      const [budget, activity, health] = await Promise.all([
        query(`SELECT allocated_usd, spent_usd FROM agent_graph.budgets WHERE scope = 'daily' AND period_start = CURRENT_DATE LIMIT 1`),
        query(`SELECT status, COUNT(*) AS count FROM agent_graph.work_items WHERE updated_at >= CURRENT_DATE - 1 GROUP BY status`),
        query(`SELECT assigned_to AS agent, COUNT(*) AS tasks FROM agent_graph.work_items WHERE status IN ('assigned', 'in_progress') GROUP BY assigned_to ORDER BY COUNT(*) DESC`),
      ]);
      return JSON.stringify({
        budget: budget.rows[0] || {},
        task_counts: Object.fromEntries(activity.rows.map(r => [r.status, parseInt(r.count)])),
        active_agents: health.rows.map(r => ({ agent: r.agent, tasks: parseInt(r.tasks) })),
      });
    }
    case 'list_campaigns': {
      const statusFilter = toolInput.status ? `WHERE campaign_status = $1` : '';
      const params = toolInput.status ? [toolInput.status] : [];
      const result = await query(
        `SELECT id, goal_description, campaign_status, completed_iterations, max_iterations, budget_envelope_usd, spent_usd, created_at,
           (SELECT MAX(quality_score) FROM agent_graph.campaign_iterations ci WHERE ci.campaign_id = campaigns.id AND ci.decision IN ('keep', 'stop_success')) AS best_score
         FROM agent_graph.campaigns ${statusFilter} ORDER BY created_at DESC LIMIT 10`,
        params
      );
      return JSON.stringify({ campaigns: result.rows });
    }
    case 'approve_proposal': {
      await query(
        `UPDATE agent_graph.action_proposals SET board_action = 'approved', acted_at = now() WHERE id = $1`,
        [toolInput.id]
      );
      return JSON.stringify({ ok: true, message: `Proposal ${toolInput.id} approved.` });
    }
    case 'list_drafts': {
      const result = await query(
        `SELECT id, action_type, LEFT(body, 200) AS summary, reviewer_verdict, created_at
         FROM agent_graph.action_proposals WHERE board_action IS NULL ORDER BY created_at DESC LIMIT 10`
      );
      return JSON.stringify({ drafts: result.rows });
    }
    case 'search_knowledge_base': {
      try {
        // Worktree 1 (RAG tenancy hardening): require an explicit
        // retriever scope from the chat handler. Tool invocations from
        // an unauthenticated context return empty (deny-by-default).
        if (!retrieverScope) {
          return JSON.stringify({ results: [], message: 'Knowledge base unavailable (no scope).' });
        }
        const { retrieveContext } = await import('../../../lib/rag/retriever.js');
        const result = await retrieveContext(toolInput.query, { maxClassification: 'INTERNAL' }, retrieverScope);
        if (!result) return JSON.stringify({ results: [], message: 'No relevant documents found.' });
        return JSON.stringify({
          results: result.citations.map(c => ({
            text: c.text,
            similarity: c.similarity.toFixed(3),
            source: c.metadata?.source || 'unknown',
          })),
          summary: result.answer.slice(0, 2000),
        });
      } catch (err) {
        return JSON.stringify({ error: `Knowledge base search failed: ${err.message}` });
      }
    }
    case 'query_graph': {
      // Tenancy: retrieverScope = {ownerId, readOrgIds} from
      // resolveChatRetrieverScope; runGraphTemplate fails closed on an empty
      // org set. Chat passes NO opts, so trusted=false — no org-wide bypass.
      if (!retrieverScope) {
        return JSON.stringify({ ok: false, rows: [], message: 'Knowledge graph unavailable (no scope).' });
      }
      const { template, ...params } = toolInput || {};
      const result = await runGraphTemplate(template, params, retrieverScope);
      if (!result.available) {
        return JSON.stringify({ ok: false, rows: [], template, message: 'Knowledge graph is temporarily unavailable.' });
      }
      if (result.error) {
        return JSON.stringify({ ok: false, rows: [], template, message: `Invalid graph query: ${result.error}` });
      }
      return JSON.stringify({ ok: true, template, count: result.rows.length, rows: result.rows });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

/**
 * 010-B: format graph-template rows into chat citation chips (kind:'graph'),
 * mirroring formatCitationsForChat's shape so the board renders them as chips.
 * `n` is assigned when merged into the response citations.
 */
export function formatGraphCitations(rows, template) {
  const chips = [];
  for (const r of rows) {
    if (template === 'shared_context') {
      const conns = (r.connections || []).join(', ');
      const orgs = (r.sharedOrgs || []).join(', ');
      const detail = [conns && `via ${conns}`, orgs && `shared orgs: ${orgs}`].filter(Boolean).join(' · ');
      chips.push({ kind: 'graph', label: `Graph · connection`, snippet: (detail || 'no direct connection found').slice(0, 240) });
      continue;
    }
    const who = r.name || r.email || 'unknown';
    const extra = r.org ? ` · ${r.org}` : (r.tier ? ` · ${r.tier}` : '');
    chips.push({
      kind: 'graph',
      label: `Graph · ${String(who).slice(0, 50)}${extra}`.slice(0, 80),
      snippet: [r.email, r.org, r.tier, r.lastAt && `last: ${String(r.lastAt).slice(0, 10)}`]
        .filter(Boolean).join(' · ').slice(0, 240),
    });
  }
  return chips.slice(0, 25);
}

/**
 * Auto-route a board member's message to the best agent.
 * Uses keyword heuristics first (zero cost), falls back to the orchestrator
 * for ambiguous messages. Returns the selected agentId.
 */
export function autoRouteMessage(message) {
  const msg = message.toLowerCase();

  // Campaign/build requests → orchestrator
  if (/\b(build|campaign|create|launch|deploy|ship|implement)\b/.test(msg)) return 'orchestrator';

  // Strategy/priority questions → strategist
  if (/\b(priorit|strateg|recommend|what should|most important|focus)\b/.test(msg)) return 'strategist';

  // Code/PR/bug questions → architect or coder context
  if (/\b(code|bug|pr |pull request|refactor|fix|error|stack trace|test)\b/.test(msg)) return 'architect';

  // Review/quality/gate questions → reviewer
  if (/\b(review|approve|reject|gate|quality|tone|draft)\b/.test(msg)) return 'reviewer';

  // Status/pipeline/what's happening → orchestrator
  if (/\b(status|pipeline|what.s (going|happening)|active|running|stuck|queue)\b/.test(msg)) return 'orchestrator';

  // Research → claw-explorer
  if (/\b(research|explore|investigate|deep dive|analyze)\b/.test(msg)) return 'claw-explorer';

  // Default: orchestrator handles general queries
  return 'orchestrator';
}

/**
 * Load work item context for chat — allows board members to discuss specific tasks.
 * @param {number} workItemId
 * @returns {Promise<string>} Formatted context block
 */
async function loadWorkItemContext(workItemId) {
  try {
    const result = await query(
      `SELECT id, title, status, assigned_to, created_by, priority, routing_class,
              metadata, created_at, updated_at
       FROM agent_graph.work_items WHERE id = $1`,
      [workItemId]
    );

    if (result.rows.length === 0) return `Work item #${workItemId} not found.`;

    const wi = result.rows[0];
    const parts = [
      `Work Item #${wi.id}: ${wi.title}`,
      `Status: ${wi.status} | Assigned to: ${wi.assigned_to} | Created by: ${wi.created_by}`,
      `Priority: ${wi.priority} | Routing class: ${wi.routing_class || 'n/a'}`,
      `Created: ${wi.created_at} | Updated: ${wi.updated_at}`,
    ];

    // Include relevant metadata (sanitized)
    if (wi.metadata) {
      const meta = typeof wi.metadata === 'string' ? JSON.parse(wi.metadata) : wi.metadata;
      if (meta.triage_result) parts.push(`Triage: category=${meta.triage_result.category}, needs_strategist=${meta.triage_result.needs_strategist}`);
      if (meta.strategy_result) parts.push(`Strategy: urgency=${meta.strategy_result.urgency}, recommendation=${meta.strategy_result.recommendation}`);
      if (meta.draft_id) parts.push(`Draft ID: ${meta.draft_id}`);
      if (meta.ticket_result) parts.push(`Ticket: category=${meta.ticket_result.category}, severity=${meta.ticket_result.severity}`);
    }

    // Load state transitions for this work item
    const transitions = await query(
      `SELECT from_state, to_state, agent_id, reason, created_at
       FROM agent_graph.state_transitions
       WHERE work_item_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [workItemId]
    );
    if (transitions.rows.length > 0) {
      parts.push('', 'State transitions:');
      for (const t of transitions.rows) {
        parts.push(`  ${t.from_state || 'n/a'} → ${t.to_state} by ${t.agent_id} (${t.reason || 'no reason'})`);
      }
    }

    // Load child work items
    const children = await query(
      `SELECT id, title, status, assigned_to FROM agent_graph.work_items
       WHERE parent_id = $1 ORDER BY created_at ASC LIMIT 10`,
      [workItemId]
    );
    if (children.rows.length > 0) {
      parts.push('', 'Child tasks:');
      for (const c of children.rows) {
        parts.push(`  #${c.id}: ${c.title} (${c.status}, assigned to ${c.assigned_to})`);
      }
    }

    return parts.join('\n');
  } catch (err) {
    return `Error loading work item #${workItemId}: ${sanitize(err.message)}`;
  }
}

/**
 * Log board feedback as an audit entry when a board member flags a decision.
 * Creates a state_transition-like audit record for accountability (P3).
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @param {string} boardUser
 * @param {string} message
 */
async function logBoardFeedback(agentId, sessionId, boardUser, message) {
  try {
    // Find the most recent work item this agent completed (for context)
    const recentWork = await query(
      `SELECT id FROM agent_graph.work_items
       WHERE assigned_to = $1 AND status = 'completed'
       ORDER BY updated_at DESC LIMIT 1`,
      [agentId]
    );
    const workItemId = recentWork.rows[0]?.id || null;

    // Log to task events (P3: transparency by structure)
    await query(
      `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, event_data)
       VALUES ('board_feedback', $1, $2, $3::jsonb)`,
      [
        workItemId,
        agentId,
        JSON.stringify({ board_user: boardUser, session_id: sessionId, feedback: message.slice(0, 500), flagged_at: new Date().toISOString() }),
      ]
    );

    console.log(`[agent-chat] Board feedback logged: ${boardUser} flagged ${agentId} (workItem: ${workItemId || 'n/a'})`);

    // P5: a flag is also a failure memory — the chat must stop repeating
    // whatever prompted it. The flag message itself carries the why, so it
    // goes in verbatim (trimmed); content_hash dedup absorbs repeats.
    const memoryKey = chatMemoryKey(boardUser);
    if (memoryKey) {
      await saveMemory({
        agentId: memoryKey,
        type: 'failure',
        content: `Board member flagged a decision/response: ${message.slice(0, 400)}`,
        metadata: { source: 'flag', sessionId },
      });
    }
  } catch (err) {
    console.warn(`[agent-chat] Failed to log board feedback: ${err.message}`);
  }
}

/**
 * P5: record thumbs feedback on an assistant message and, on a downvote,
 * distill a failure memory so the mistake compounds into avoidance instead
 * of repetition.
 *
 * Ownership is enforced in the UPDATE predicate: only the row's own
 * board_user can rate it (viewer-scoped; 0 rows updated → not found).
 *
 * @param {{ sessionId: string, messageId: string, boardUser: string, feedback: 1|-1|null }} opts
 * @returns {Promise<{ ok: boolean }>}
 */
export async function recordChatFeedback({ sessionId, messageId, boardUser, feedback }) {
  if (feedback !== 1 && feedback !== -1 && feedback !== null) {
    const err = new Error('feedback must be 1, -1, or null');
    err.statusCode = 400;
    throw err;
  }

  const updated = await query(
    `UPDATE agent_graph.board_chat_messages SET feedback = $1
     WHERE id = $2 AND session_id = $3 AND board_user = $4 AND role = 'assistant'
     RETURNING content`,
    [feedback, messageId, sessionId, boardUser]
  );
  if (updated.rows.length === 0) {
    const err = new Error('message not found');
    err.statusCode = 404;
    throw err;
  }

  // Downvote → fire-and-forget failure distillation (never blocks the ack).
  const memoryKey = chatMemoryKey(boardUser);
  if (feedback === -1 && memoryKey) {
    distillFailureMemory({ memoryKey, sessionId, messageId, answer: updated.rows[0].content })
      .catch((err) => console.warn(`[agent-chat] failure distillation failed (non-fatal): ${err.message}`));
  }

  return { ok: true };
}

/**
 * Distill a downvoted exchange into one failure memory via a cheap Haiku
 * pass. The preceding user message provides the question context.
 */
async function distillFailureMemory({ memoryKey, sessionId, messageId, answer }) {
  const config = await loadConfig();
  const modelKey = pickCheapModel(config);
  if (!modelKey) return;

  // The user message immediately before the downvoted assistant message
  const prior = await query(
    `SELECT content FROM agent_graph.board_chat_messages
     WHERE session_id = $1 AND role = 'user'
       AND created_at < (SELECT created_at FROM agent_graph.board_chat_messages WHERE id = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId, messageId]
  );
  const question = prior.rows[0]?.content || '';

  const llm = createLLMClient(modelKey, config.models);
  const response = await callProvider(llm, {
    system: 'A board member downvoted an assistant reply. Output ONLY JSON (no preamble): {"lesson":"...","entities":[{"kind":"person"|"org","name":"...","email":"..."}]}. "lesson" is ONE sentence (max 30 words) stating what the assistant should avoid repeating — concrete and behavioral, e.g. "Don\'t answer meeting questions without checking the knowledge base first." "entities" names the specific people or organizations the exchange was about (include "email" only if present in the text, else just "name"; use [] if none). If the exchange gives no usable signal, output exactly: NONE',
    messages: [{
      role: 'user',
      content: `Question:\n${question.slice(0, 1500)}\n\nDownvoted reply:\n${String(answer).slice(0, 1500)}`,
    }],
    maxTokens: 80,
    temperature: 0,
  });

  const distilled = parseDistilledFailure(response.text);
  if (distilled) {
    await saveMemory({
      agentId: memoryKey,
      type: 'failure',
      content: distilled.lesson,
      // 010-C: entity-tag the correction so 010-D surfaces it contextually —
      // corrections trigger on-topic rather than being injected blindly.
      metadata: { source: 'thumbs-down', sessionId, messageId, ...(distilled.entities.length > 0 && { entities: distilled.entities }) },
    });
  }

  const costUsd = computeCost(response.inputTokens || 0, response.outputTokens || 0, llm.modelConfig);
  try {
    await query(
      `INSERT INTO agent_graph.llm_invocations (agent_id, model, input_tokens, output_tokens, cost_usd, task_id, created_at) VALUES ('chat-memory', $1, $2, $3, $4, $5, now())`,
      [modelKey, response.inputTokens || 0, response.outputTokens || 0, costUsd, sessionId]
    );
  } catch { /* non-fatal */ }
}
