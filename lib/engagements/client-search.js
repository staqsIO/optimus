/**
 * Free-text client → knowledge-base candidate search.
 *
 * Flow:
 *   1. Expand "Xyz Corp" → { domains, names, aliases } via an LLM call.
 *      User can edit the expansion before retrieval runs (precision dial).
 *   2. Query four sources in parallel with the expanded keys:
 *        - inbox.calendar_events: attendee email matches domain
 *        - content.documents (tldv/gemini): title matches alias OR
 *          any chunk.metadata.speakers entry matches a name
 *        - inbox.messages: from/to/cc matches domain
 *        - inbox.signals: signal.domain matches OR back-linked message matches
 *   3. Return grouped candidates with enough metadata for the UI to render
 *      checkbox lists (title, date, participants/senders, snippet).
 *
 * Precision strategy: free-text input is fuzzy. We surface the expanded
 * candidates to the user BEFORE querying so they can drop bad domain/name
 * guesses. We do not run a per-item LLM relevance pass — the user does
 * that via the checkbox UI.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';
import { createLogger } from '../logger.js';
import { getClientDomainMemory } from './db.js';

const log = createLogger('engagements/client-search');
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL_KEY = 'claude-haiku-4-5-20251001';
const EXPAND_TOOL = {
  name: 'emit_client_expansion',
  description: 'Return candidate identifiers for the named client.',
  input_schema: {
    type: 'object',
    required: ['domains', 'names', 'aliases'],
    properties: {
      domains: {
        type: 'array',
        description: 'Likely email domains for the client (e.g. ["xyzcorp.com", "xyz.com"]). Lowercase, no protocol, no @ prefix.',
        items: { type: 'string' },
      },
      names: {
        type: 'array',
        description: 'Likely person names of contacts at this client (best-effort — leave empty if you genuinely have no idea).',
        items: { type: 'string' },
      },
      aliases: {
        type: 'array',
        description: 'Variations of the company name to match document/meeting titles ("Xyz Corp", "Xyz", "XYZ Corporation", possibly with common typos).',
        items: { type: 'string' },
      },
      rationale: {
        type: 'string',
        description: 'One short sentence on how confident you are and what assumptions you made.',
      },
    },
  },
};

const EXPAND_SYSTEM = `You take a free-text client name (e.g. "Xyz Corp", "Acme", "Principal Venture Partners") and produce candidate identifiers used to search a knowledge base for content about that client.

Be conservative — better to return 2 high-confidence guesses than 8 wide ones. The user will review and edit your expansion before any retrieval runs, but bad guesses still cost their attention.

Domains: produce up to 4 plausible domains. Common patterns: companyname.com, company.com, company-inc.com, companycorp.com. If the company name is ambiguous (e.g. "Acme" could be many companies), return only the most natural single-word domain and rely on aliases for the rest.

Names: only include person names if you're highly confident they're real contacts at this client. Most of the time leave this empty.

Aliases: include 2-4 natural variations of the company name as it might appear in document titles, calendar event titles, or email subjects. Include the input as-is.

Call emit_client_expansion with your result.`;

export async function expandClientName(clientName, opts = {}) {
  if (!clientName || typeof clientName !== 'string') {
    throw new Error('clientName is required');
  }
  const trimmed = clientName.trim();
  if (!trimmed) throw new Error('clientName is empty');

  // Domain memory: if we've previously confirmed domains for this client
  // name, skip the LLM expansion entirely. Cheaper, more accurate.
  const remembered = await getClientDomainMemory(trimmed);
  if (remembered.length > 0 && !opts.forceLlmExpansion) {
    log.info(`expand "${trimmed}" → ${remembered.length} domains from memory (no LLM call)`);
    return {
      domains: remembered.map((r) => r.domain),
      names: [],
      aliases: [trimmed],
      rationale: `${remembered.length} domain${remembered.length === 1 ? '' : 's'} recalled from past auto-builds for this client.`,
      costUsd: 0,
      fromMemory: true,
    };
  }

  const modelKey = opts.modelKey || DEFAULT_MODEL_KEY;
  const modelsConfig = loadModelsConfig();
  const llm = createLLMClient(modelKey, modelsConfig.models);

  const response = await callProvider(llm, {
    system: EXPAND_SYSTEM,
    messages: [{ role: 'user', content: `Client: ${trimmed}` }],
    maxTokens: 1024,
    temperature: 0.2,
    tools: [EXPAND_TOOL],
    toolChoice: { type: 'tool', name: 'emit_client_expansion' },
  });

  const toolCall = (response.toolCalls || []).find((t) => t.name === 'emit_client_expansion');
  if (!toolCall?.input) {
    throw new Error('Client expansion failed — LLM did not call the tool');
  }
  const out = toolCall.input;
  const domains = (out.domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '').trim()).filter(Boolean);
  const names = (out.names || []).map((n) => String(n).trim()).filter(Boolean);
  const aliases = (out.aliases || []).map((a) => String(a).trim()).filter(Boolean);
  // Always include the input itself as an alias.
  if (!aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
    aliases.push(trimmed);
  }

  const costUsd = computeCost(response.inputTokens, response.outputTokens, llm.modelConfig);
  log.info(`expand "${trimmed}" → ${domains.length} domains, ${names.length} names, ${aliases.length} aliases (cost $${costUsd.toFixed(4)})`);

  return { domains, names, aliases, rationale: out.rationale || null, costUsd, modelKey };
}

// ============================================================
// Source queries
// ============================================================

/**
 * Build a SQL fragment that matches an email column against any of the
 * provided domains. Returns { sql, params } where sql is an ILIKE
 * disjunction and params are %@domain.com style patterns.
 */
function emailDomainMatchClause(column, domains, paramOffset) {
  if (!domains.length) return { sql: 'FALSE', params: [] };
  const clauses = domains.map((_, i) => `${column} ILIKE $${paramOffset + i}`);
  const params = domains.map((d) => `%@${d}`);
  return { sql: `(${clauses.join(' OR ')})`, params };
}

export async function searchCalendarEvents({ domains, aliases, since, until, limit = 50 }) {
  if (!domains.length && !aliases.length) return [];

  const params = [];
  const ors = [];
  const wheres = [`status <> 'cancelled'`];

  if (domains.length) {
    const conds = domains.map((d) => {
      params.push(`%@${d}%`);
      return `attendees::text ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }
  if (aliases.length) {
    const conds = aliases.map((a) => {
      params.push(`%${a}%`);
      return `title ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }
  if (domains.length) {
    const conds = domains.map((d) => {
      params.push(`%@${d}`);
      return `organizer_email ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }
  wheres.push(`(${ors.join(' OR ')})`);

  if (since) { params.push(since); wheres.push(`start_at >= $${params.length}`); }
  if (until) { params.push(until); wheres.push(`start_at <= $${params.length}`); }

  params.push(limit);
  const r = await query(
    `SELECT id, title, description, organizer_email, start_at, end_at,
            attendees, status
       FROM inbox.calendar_events
      WHERE ${wheres.join(' AND ')}
      ORDER BY start_at DESC
      LIMIT $${params.length}`,
    params
  );

  return r.rows.map((row) => ({
    id: row.id,
    kind: 'calendar_event',
    title: row.title || '(untitled meeting)',
    date: row.start_at,
    organizer: row.organizer_email,
    attendee_emails: Array.isArray(row.attendees)
      ? row.attendees.map((a) => a?.email).filter(Boolean)
      : [],
    snippet: (row.description || '').slice(0, 200),
    raw: row,
  }));
}

export async function searchTranscripts({ domains, names, aliases, since, until, limit = 30 }) {
  if (!aliases.length && !names.length && !domains.length) return [];

  const params = [];
  const ors = [];
  const wheres = [
    `d.deleted_at IS NULL`,
    `(d.source IN ('tldv', 'gemini') OR (d.source = 'drive' AND d.format IN ('tldv', 'gemini')))`,
  ];

  // Title matches any alias
  if (aliases.length) {
    const conds = aliases.map((a) => {
      params.push(`%${a}%`);
      return `d.title ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }

  // Chunk speakers match any name
  if (names.length) {
    const conds = names.map((n) => {
      params.push(n);
      return `EXISTS (
        SELECT 1 FROM content.chunks c
         WHERE c.document_id = d.id
           AND c.metadata->'speakers' @> jsonb_build_array($${params.length}::text)
        LIMIT 1
      )`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }

  if (!ors.length) return [];
  wheres.push(`(${ors.join(' OR ')})`);

  if (since) { params.push(since); wheres.push(`COALESCE(d.metadata->>'happenedAt', d.created_at::text) >= $${params.length}::text`); }
  if (until) { params.push(until); wheres.push(`COALESCE(d.metadata->>'happenedAt', d.created_at::text) <= $${params.length}::text`); }

  params.push(limit);
  const r = await query(
    `SELECT d.id, d.title, d.source, d.format, d.metadata,
            d.created_at,
            (SELECT array_agg(DISTINCT speaker)
               FROM content.chunks c,
                    LATERAL jsonb_array_elements_text(COALESCE(c.metadata->'speakers', '[]'::jsonb)) AS speaker
              WHERE c.document_id = d.id) AS speakers
       FROM content.documents d
      WHERE ${wheres.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}`,
    params
  );

  return r.rows.map((row) => ({
    id: row.id,
    kind: 'transcript',
    title: row.title || '(untitled transcript)',
    date: row.metadata?.happenedAt || row.created_at,
    source: row.source,
    speakers: row.speakers || [],
    snippet: '',
    raw: row,
  }));
}

export async function searchEmails({ domains, since, until, limit = 30 }) {
  if (!domains.length) return [];

  const params = [];
  const ors = [];
  const wheres = [`channel = 'email'`];

  {
    const conds = domains.map((d) => {
      params.push(`%@${d}`);
      return `from_address ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }
  for (const col of ['to_addresses', 'cc_addresses']) {
    const conds = domains.map((d) => {
      params.push(`%@${d}%`);
      return `array_to_string(${col}, ',') ILIKE $${params.length}`;
    });
    ors.push(`(${conds.join(' OR ')})`);
  }
  wheres.push(`(${ors.join(' OR ')})`);

  if (since) { params.push(since); wheres.push(`received_at >= $${params.length}`); }
  if (until) { params.push(until); wheres.push(`received_at <= $${params.length}`); }

  params.push(limit);
  const r = await query(
    `SELECT id, channel, subject, from_address, to_addresses, cc_addresses,
            provider_msg_id, account_id, snippet, received_at
       FROM inbox.messages
      WHERE ${wheres.join(' AND ')}
      ORDER BY received_at DESC NULLS LAST
      LIMIT $${params.length}`,
    params
  );

  return r.rows.map((row) => ({
    id: row.id,
    kind: 'email',
    title: row.subject || '(no subject)',
    date: row.received_at,
    from: row.from_address,
    to: row.to_addresses || [],
    snippet: (row.snippet || '').slice(0, 200),
    raw: row,
  }));
}

export async function searchSignals({ domains, since, until, limit = 50 }) {
  if (!domains.length) return [];

  const params = [...domains];
  const placeholders = domains.map((_, i) => `$${i + 1}`).join(',');
  const wheres = [`domain = ANY(ARRAY[${placeholders}]::text[])`, `resolved = false`];
  if (since) { params.push(since); wheres.push(`created_at >= $${params.length}`); }
  if (until) { params.push(until); wheres.push(`created_at <= $${params.length}`); }
  params.push(limit);

  const r = await query(
    `SELECT id, signal_type, content, confidence, due_date, direction, domain,
            message_id, created_at
       FROM inbox.signals
      WHERE ${wheres.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );

  return r.rows.map((row) => ({
    id: row.id,
    kind: 'signal',
    title: row.signal_type,
    date: row.created_at,
    signal_type: row.signal_type,
    direction: row.direction,
    domain: row.domain,
    snippet: (row.content || '').slice(0, 200),
    raw: row,
  }));
}

/**
 * Top-level: expand the client name, then query each source in parallel.
 *
 * Pass `expanded` to skip the LLM step (e.g. if the user already edited it).
 */
export async function findClientCandidates(clientName, opts = {}) {
  const expanded = opts.expanded || (await expandClientName(clientName, opts));
  const { domains, names, aliases } = expanded;
  const { since, until } = opts;

  let [calendar, transcripts, emails, signals] = await Promise.all([
    searchCalendarEvents({ domains, aliases, since, until }),
    searchTranscripts({ domains, names, aliases, since, until }),
    searchEmails({ domains, since, until }),
    searchSignals({ domains, since, until }),
  ]);

  // Dedup recurring series. A weekly meeting that's been running for a year
  // produces 50+ rows that all look the same and clobber the precision of
  // any one-off scoping meeting. Group by normalized title (calendar +
  // transcripts) or thread (emails); mark the most-recent of each group as
  // is_group_primary=true so the UI defaults to selecting just that one.
  calendar = annotateGroupsByTitle(calendar);
  transcripts = annotateGroupsByTitle(transcripts);
  emails = annotateGroupsByEmailThread(emails);
  // Signals are atomic facts — each is unique, no grouping.
  signals = signals.map((s) => ({ ...s, group_key: s.id, group_size: 1, is_group_primary: true }));

  return {
    client_name: clientName,
    expanded,
    sources: { calendar, transcripts, emails, signals },
    counts: {
      calendar: calendar.length,
      transcripts: transcripts.length,
      emails: emails.length,
      signals: signals.length,
      total: calendar.length + transcripts.length + emails.length + signals.length,
    },
  };
}

/**
 * Strip date/time suffixes from titles so recurring meetings collapse.
 *   "Listing Generator Weekly"                              → "listing generator weekly"
 *   "Dev Daily - 2026/05/07 13:00 PDT - Notes by Gemini"   → "dev daily"
 *   "Standup (2026-05-19)"                                  → "standup"
 */
function normalizeTitleForGrouping(t) {
  if (!t) return '';
  let s = String(t).trim();
  // " Notes by Gemini" / " - Notes by Gemini" trailing suffix
  s = s.replace(/\s*[-—]?\s*Notes by Gemini\s*$/i, '');
  // " - YYYY/MM/DD HH:MM TZ" or " - YYYY-MM-DD HH:MM TZ"
  s = s.replace(/\s+[-—]\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}(\s+\d{1,2}:\d{2}(\s+[A-Z]{3,4})?)?\s*$/, '');
  // " - YYYY/MM/DD" (no time)
  s = s.replace(/\s+[-—]\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*$/, '');
  // Trailing standalone date "(2026-05-19)" or "2026-05-19"
  s = s.replace(/\s*\(?\d{4}[-/]\d{1,2}[-/]\d{1,2}\)?\s*$/, '');
  return s.toLowerCase().trim();
}

/**
 * Group items by normalized title. Marks the most-recent item in each
 * group as is_group_primary=true and attaches group_key + group_size to
 * every item. Items keep their original order (already date desc).
 */
function annotateGroupsByTitle(items) {
  const byKey = new Map();
  for (const it of items) {
    const key = normalizeTitleForGrouping(it.title) || it.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  const out = [];
  for (const [key, list] of byKey.entries()) {
    list.sort((a, b) => {
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return tb - ta;
    });
    for (let i = 0; i < list.length; i++) {
      out.push({
        ...list[i],
        group_key: key,
        group_size: list.length,
        is_group_primary: i === 0,
      });
    }
  }
  // Restore date-desc order overall (groups stay together via the dedup UI).
  out.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });
  return out;
}

/**
 * Group emails by thread_id (which inbox.messages already provides). Same
 * primary-marking logic as title-based grouping. Falls back to "no group"
 * when thread_id is null.
 */
function annotateGroupsByEmailThread(items) {
  const byKey = new Map();
  for (const it of items) {
    const key = it.raw?.thread_id || `__solo_${it.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  const out = [];
  for (const [key, list] of byKey.entries()) {
    list.sort((a, b) => {
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return tb - ta;
    });
    for (let i = 0; i < list.length; i++) {
      out.push({
        ...list[i],
        group_key: key,
        group_size: list.length,
        is_group_primary: i === 0,
      });
    }
  }
  out.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });
  return out;
}

function loadModelsConfig() {
  const candidates = [
    join(__dirname, '..', '..', 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'autobot-inbox', 'config', 'agents.json'),
    join(process.cwd(), 'config', 'agents.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not locate autobot-inbox/config/agents.json from client-search.js');
}
