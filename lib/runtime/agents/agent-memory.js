/**
 * Agent Memory System (Claude Code Architecture Audit — Change 5).
 *
 * DB-backed persistent memory with Markdown export view.
 * Agents accumulate learnings across sessions — patterns, preferences,
 * context, and failures — that compound over time.
 *
 * Inspired by Claude Code's memdir system with typed memory files
 * (user/feedback/project/reference) and autoDream consolidation.
 *
 * Design decision (confirmed): DB-backed with Markdown export.
 * Postgres table (append-only, hash-chained) for P3 compliance.
 * Board Workstation renders as readable Markdown via API endpoint.
 *
 * Memory types:
 *   pattern    — "When X happens, do Y" (operational learning)
 *   preference — Account/user preferences learned from interactions
 *   context    — Background facts about the environment
 *   failure    — What went wrong and why (prevents repeat mistakes)
 */

import { createHash } from 'crypto';
import { query } from '../../db.js';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/agent-memory');

const VALID_TYPES = ['pattern', 'preference', 'context', 'failure'];
const MAX_MEMORIES_PER_AGENT = 100;  // Prevent unbounded growth
const MAX_MEMORY_CONTENT_LENGTH = 2000;  // ~500 tokens per memory

/**
 * Save a memory for an agent.
 * Append-only: previous memories are never deleted, only superseded.
 *
 * @param {Object} opts
 * @param {string} opts.agentId - Agent saving the memory
 * @param {string} opts.type - 'pattern' | 'preference' | 'context' | 'failure'
 * @param {string} opts.content - Memory content (will be truncated to MAX_MEMORY_CONTENT_LENGTH)
 * @param {string} [opts.workItemId] - Work item that triggered this memory
 * @param {Object} [opts.metadata] - Additional structured data
 * @returns {Promise<{id: string, hash: string} | null>}
 */
export async function saveMemory({ agentId, type, content, workItemId = null, metadata = {} }) {
  if (!VALID_TYPES.includes(type)) {
    log.warn(`Invalid memory type '${type}' — must be one of: ${VALID_TYPES.join(', ')}`);
    return null;
  }

  const truncated = content.slice(0, MAX_MEMORY_CONTENT_LENGTH);
  const contentHash = createHash('sha256').update(`${agentId}:${type}:${truncated}`).digest('hex').slice(0, 16);

  try {
    // Dedup: don't save identical memories
    const existing = await query(
      `SELECT id FROM agent_graph.agent_memories
       WHERE agent_id = $1 AND content_hash = $2 AND superseded_by IS NULL`,
      [agentId, contentHash]
    );
    if (existing.rows[0]) {
      return { id: existing.rows[0].id, hash: contentHash, deduplicated: true };
    }

    const result = await query(
      `INSERT INTO agent_graph.agent_memories (agent_id, memory_type, content, content_hash, work_item_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [agentId, type, truncated, contentHash, workItemId, JSON.stringify(metadata)]
    );

    return { id: result.rows[0].id, hash: contentHash };
  } catch (err) {
    log.warn(`Save failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Load active memories for an agent (not superseded).
 * Returns newest first, capped at MAX_MEMORIES_PER_AGENT.
 *
 * @param {string} agentId
 * @param {Object} [opts]
 * @param {string} [opts.type] - Filter by memory type
 * @param {number} [opts.limit] - Override default limit
 * @returns {Promise<Array<{id, type, content, created_at, metadata}>>}
 */
export async function loadMemory(agentId, opts = {}) {
  const limit = opts.limit || MAX_MEMORIES_PER_AGENT;
  const queryFn = opts.query || query;

  try {
    const typeFilter = opts.type ? `AND memory_type = $2` : '';
    const params = opts.type ? [agentId, opts.type, limit] : [agentId, limit];
    const limitParam = opts.type ? '$3' : '$2';

    const result = await queryFn(
      `SELECT id, memory_type, content, created_at, metadata
       FROM agent_graph.agent_memories
       WHERE agent_id = $1 AND superseded_by IS NULL
       ${typeFilter}
       ORDER BY created_at DESC
       LIMIT ${limitParam}`,
      params
    );

    return result.rows;
  } catch {
    // Table may not exist yet — graceful degradation
    return [];
  }
}

// ── 010-D: relevance-scored recall (entity overlap with the current turn) ──────
// Canonical entity key: email (lowercased) when present, else kind:name.
// Mirrors normalizeEntities' dedup scheme so detection and memory keys align.

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Canonical key for one entity ({kind,name,email}); null if it has neither. */
export function entityKey(kind, name, email) {
  const e = String(email || '').trim().toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  if (!e && !n) return null;
  return `${kind}:${e || n}`;
}

/** Keys for the entities a memory is tagged with (010-C metadata.entities). */
export function memoryEntityKeys(metadata) {
  const ents = metadata?.entities;
  if (!Array.isArray(ents)) return [];
  const keys = [];
  for (const e of ents) {
    const k = entityKey(e?.kind, e?.name, e?.email);
    if (k) keys.push(k);
  }
  return keys;
}

/**
 * Which known entities does the current turn mention? Cheap, sync (AC-6):
 * email substring match (emails are distinctive) or whole-word name match.
 * Detection is vocabulary-bounded to avoid false positives from stray
 * capitalized words.
 * @returns {Set<string>} detected entity keys
 */
export function detectTurnEntities(turnText, vocab) {
  const text = String(turnText || '');
  const lower = text.toLowerCase();
  const detected = new Set();
  for (const v of vocab || []) {
    const email = String(v.email || '').trim().toLowerCase();
    const name = String(v.name || '').trim();
    const key = entityKey(v.kind, name, email);
    if (!key) continue;
    if (email && lower.includes(email)) { detected.add(key); continue; }
    if (name.length >= 3) {
      const re = new RegExp(`(^|[^\\w])${escapeRegExp(name)}([^\\w]|$)`, 'i');
      if (re.test(text)) detected.add(key);
    }
  }
  return detected;
}

/**
 * Rank memories by entity overlap with the current turn, then recency. Failure
 * memories with overlap get a boost so corrections outrank conveniences (§2.C).
 * `memories` MUST already be recency-DESC ordered — original index is the
 * recency tiebreak (stable). Pure; does not mutate input.
 */
export function rankMemoriesByRelevance(memories, detectedKeys) {
  const detected = detectedKeys instanceof Set ? detectedKeys : new Set(detectedKeys || []);
  return memories
    .map((m, i) => {
      let overlap = 0;
      for (const k of memoryEntityKeys(m.metadata)) if (detected.has(k)) overlap++;
      let score = overlap * 10;
      if (overlap > 0 && m.memory_type === 'failure') score += 5;
      return { m, i, score };
    })
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((s) => s.m);
}

/**
 * The member's distinct entity vocabulary — one cheap DISTINCT over
 * metadata.entities (GIN-aided). Used to detect which known entities the
 * current turn names, independent of the recency window (so OPT-134's recall
 * isn't capped at a fixed pool). Returns [{kind, email, name}]; [] on error.
 */
export async function loadEntityVocab(agentId, queryFn) {
  try {
    const { rows } = await queryFn(
      `SELECT DISTINCT e->>'kind' AS kind, lower(e->>'email') AS email, e->>'name' AS name
         FROM agent_graph.agent_memories, LATERAL jsonb_array_elements(metadata->'entities') e
        WHERE agent_id = $1 AND superseded_by IS NULL
          AND jsonb_typeof(metadata->'entities') = 'array'`,
      [agentId],
    );
    return rows;
  } catch {
    return [];
  }
}

// Build GIN-friendly jsonb containment probes for the entities the turn named.
// Each probe is `[{"email":..}]` / `[{"name":..}]` using the EXACT stored form
// (email lowercased, name original-case) so `metadata->'entities' @> probe`
// matches. Returns [] when nothing detected.
function entityContainmentProbes(detectedKeys, vocab) {
  const probes = [];
  const seen = new Set();
  for (const v of vocab || []) {
    const key = entityKey(v.kind, v.name, v.email);
    if (!key || !detectedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (v.email) probes.push(JSON.stringify([{ email: v.email }]));
    else if (v.name) probes.push(JSON.stringify([{ name: v.name }]));
  }
  return probes;
}

/**
 * Pull entity-matched memories of ANY age via jsonb containment (GIN-indexed),
 * so a relevant memory older than the recency window still surfaces (AC-2 at
 * scale). Returns [] when there are no probes.
 */
export async function loadMemoriesByEntities(agentId, detectedKeys, vocab, limit, queryFn) {
  const probes = entityContainmentProbes(detectedKeys, vocab);
  if (probes.length === 0) return [];
  // OR of single-value containments — each `@>` can use the GIN index on
  // (metadata->'entities'); bitmap-OR'd by the planner.
  const conds = probes.map((_, i) => `metadata->'entities' @> $${i + 2}::jsonb`).join(' OR ');
  try {
    const { rows } = await queryFn(
      `SELECT id, memory_type, content, created_at, metadata
         FROM agent_graph.agent_memories
        WHERE agent_id = $1 AND superseded_by IS NULL AND (${conds})
        ORDER BY created_at DESC
        LIMIT $${probes.length + 2}`,
      [agentId, ...probes, limit * 3],
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * 010-D / OPT-134: recall the most RELEVANT memories for the current turn within
 * the same ≤limit budget — entity-overlapping memories rank first, recency
 * breaks ties. Falls back to pure recency when the turn names no known entity,
 * so non-entity turns behave exactly as the prior "20 most recent" recall.
 *
 * Scale path (replaces the old fixed ≤200 pool): the recency set is the budget
 * itself; entity matches are pulled SEPARATELY via a GIN-indexed jsonb
 * containment query (any age), then unioned and ranked. So an entity-relevant
 * memory surfaces regardless of how many newer memories exist. Detection runs
 * against the member's full entity vocabulary, not just the recency window.
 *
 * Non-entity turns cost one query; entity turns cost three cheap, bounded ones.
 */
export async function loadRelevantMemories(agentId, opts = {}) {
  const limit = opts.limit || MAX_MEMORIES_PER_AGENT;
  const turnText = opts.turnText || '';
  const queryFn = opts.query || query;

  // Recency set = the budget + the fallback. Always included.
  const recency = await loadMemory(agentId, { limit, query: queryFn });
  if (!turnText) return recency;

  // Detect named entities against the FULL vocabulary (not just `recency`),
  // so a match older than `limit` rows is still detectable.
  const vocab = await loadEntityVocab(agentId, queryFn);
  const detected = detectTurnEntities(turnText, vocab);
  if (detected.size === 0) return recency; // no entity signal → recency

  const matched = await loadMemoriesByEntities(agentId, detected, vocab, limit, queryFn);
  // Union recency + matched, dedup by id, sort recency-DESC for a stable
  // tiebreak, then rank by entity overlap and take the budget.
  const byId = new Map();
  for (const m of [...recency, ...matched]) if (!byId.has(m.id)) byId.set(m.id, m);
  const merged = [...byId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return rankMemoriesByRelevance(merged, detected).slice(0, limit);
}

/**
 * Consolidate memories: merge similar memories into summaries.
 * Inspired by Claude Code's autoDream — runs during idle time.
 * Supersedes older memories with a consolidated version.
 *
 * @param {string} agentId
 * @param {Object} agent - AgentLoop instance (for callLLM with budget tracking)
 * @returns {Promise<{consolidated: number, remaining: number}>}
 */
export async function consolidateMemory(agentId, agent) {
  const memories = await loadMemory(agentId, { limit: 200 });
  if (memories.length < 10) {
    return { consolidated: 0, remaining: memories.length };
  }

  // Group by type
  const byType = {};
  for (const mem of memories) {
    const type = mem.memory_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(mem);
  }

  let totalConsolidated = 0;

  for (const [type, mems] of Object.entries(byType)) {
    if (mems.length < 5) continue; // Only consolidate when there's enough

    // Take the oldest N-2 and consolidate them
    const toConsolidate = mems.slice(2); // Keep 2 most recent verbatim
    if (toConsolidate.length < 3) continue;

    try {
      const response = await agent.callLLM(
        `You consolidate agent memories. Merge these ${type} memories into 2-3 concise, actionable memories. Remove contradictions. Convert vague observations into specific rules. Output each memory on a new line, prefixed with "- ".`,
        toConsolidate.map(m => `- ${m.content}`).join('\n'),
        {
          taskId: `consolidate-${agentId}-${type}`,
          maxTokens: 500,
          temperature: 0.1,
        }
      );

      // Parse consolidated memories
      const consolidated = response.text
        .split('\n')
        .map(line => line.replace(/^-\s*/, '').trim())
        .filter(line => line.length > 10);

      // Save consolidated memories
      for (const content of consolidated) {
        await saveMemory({ agentId, type, content, metadata: { consolidated: true, sources: toConsolidate.length } });
      }

      // Mark old memories as superseded
      const oldIds = toConsolidate.map(m => m.id);
      await query(
        `UPDATE agent_graph.agent_memories
         SET superseded_by = 'consolidated'
         WHERE id = ANY($1)`,
        [oldIds]
      );

      totalConsolidated += toConsolidate.length;
    } catch (err) {
      log.warn(`Consolidation failed for ${type} (non-fatal): ${err.message}`);
    }
  }

  const remaining = await loadMemory(agentId);
  return { consolidated: totalConsolidated, remaining: remaining.length };
}

/**
 * Export memories as Markdown (for Board Workstation display).
 *
 * @param {string} agentId
 * @returns {Promise<string>} Markdown-formatted memory document
 */
export async function exportMemoryAsMarkdown(agentId) {
  const memories = await loadMemory(agentId);
  if (memories.length === 0) return `# Agent Memory: ${agentId}\n\nNo memories recorded yet.`;

  const byType = {};
  for (const mem of memories) {
    const type = mem.memory_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(mem);
  }

  const sections = [];
  sections.push(`# Agent Memory: ${agentId}`);
  sections.push(`\n*${memories.length} active memories*\n`);

  for (const type of VALID_TYPES) {
    const mems = byType[type];
    if (!mems || mems.length === 0) continue;

    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1) + 's';
    sections.push(`## ${typeLabel}\n`);
    for (const mem of mems) {
      const date = new Date(mem.created_at).toISOString().split('T')[0];
      sections.push(`- **[${date}]** ${mem.content}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
