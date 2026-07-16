import { createHash } from 'crypto';
import OpenAI from 'openai';
import { query, withSystemOrgScope } from '../db.js';
import { ingestDocument } from '../rag/ingest.js';
import { normalizeUrl } from '../../../lib/rag/normalizers/url.js';
import { recordSpendMetered, dailySpendMeteredUsd } from '../../../lib/llm/record-spend.js';
import { CURRENT_ORG_ID } from '../../../lib/tenancy/scope.js';

const DEFAULT_MAX_ITEMS = 20;

// STAQPRO-601: spend metering. The poller calls OpenAI directly (outside the
// agent loop), so its spend was invisible to G1/G10. We record every web_search
// + embedding spend to agent_graph.llm_invocations under this stable identity
// (registered by migration 144) and self-enforce a daily cap before polling.
const METERING_AGENT_ID = 'rd-feed-poller';
const EMBED_MODEL = 'text-embedding-3-small';

// OPT-166 P2e-E2: the RLS pool-flip makes content.documents writes org-scoped
// (write policy tenancy.visible(..., false) → org-only, system also denied).
// Resolve the subscription's owning org (backfilled non-null by mig149; column
// DEFAULTs to the Staqs org), falling back to CURRENT_ORG_ID defensively.
function subscriptionOrgId(subscription) {
  return subscription.owner_org_id || CURRENT_ORG_ID;
}

// Run a content.documents write under the poller's org scope so it survives the
// flip. Uses withSystemOrgScope — reachable under REQUIRE_AGENT_JWT=true (this
// poller holds no JWT principal), unlike the old withAgentScope path which threw
// for a plain-string id under enforcement and fell back to unscoped writes →
// 42501 post-flip. FAIL CLOSED: no bare-`query` fallback — a scope that can't
// open must not degrade to an unscoped content.documents write.
async function withResearchOrgScope(orgId, fn) {
  const scoped = await withSystemOrgScope(METERING_AGENT_ID, orgId);
  try {
    return await fn(scoped);
  } finally {
    await scoped.release();
  }
}
/** Flat per-call fee for the built-in web_search tool (OpenAI bills per call). */
function webSearchCallCostUsd() {
  const v = Number(process.env.RESEARCH_WEB_SEARCH_COST_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.025;
}
/** Daily USD cap for the poller; polling is skipped once today's spend exceeds it. */
function feedPollDailyCapUsd() {
  const v = Number(process.env.FEED_POLL_DAILY_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 2.0;
}
/**
 * Cheap token estimate (~4 chars/token) for embedding-cost attribution. This is
 * an APPROXIMATION with a known downside bias on multilingual/Unicode-heavy text
 * (real tokens can be several× higher per char), so recorded embedding cost is a
 * floor, not a measurement. Embedding spend is tiny relative to web_search, so a
 * rough estimate is acceptable for visibility; do not treat it as exact.
 */
function estimateTokensFor(text) {
  return Math.ceil(String(text || '').length / 4);
}
/** Distinct compile scopes touched when a poll ingests new document rows. */
const ORG_COMPILE_SCOPE = '__org__';

function wikiAutoCompileExplicitEnabled(explicit) {
  if (explicit === false) return false;
  if (explicit === true) return true;
  const v = String(process.env.WIKI_AUTO_COMPILE_AFTER_RESEARCH_POLL || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function wikiAutoCompileMaxArticles() {
  const n = Number(process.env.WIKI_AUTO_COMPILE_MAX_ARTICLES);
  return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 10;
}

async function compileWikiForPollTouches(touchedScopes, maxArticles) {
  const { compileWiki } = await import('../../../lib/wiki/compiler.js');
  let compiled = 0;
  const writtenBy = 'research-source-poller';
  if (touchedScopes.has(ORG_COMPILE_SCOPE)) {
    const r = await compileWiki({ maxArticles, writtenBy });
    compiled += r.compiled ?? 0;
  }
  for (const projectId of touchedScopes) {
    if (projectId === ORG_COMPILE_SCOPE) continue;
    const r = await compileWiki({ projectId, maxArticles, writtenBy });
    compiled += r.compiled ?? 0;
  }
  return compiled;
}

function hashString(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

/**
 * Stable identity key for a URL: host (sans www) + path, lowercased, trailing
 * slash and query/fragment stripped. Collapses tracking-param and protocol
 * variants (e.g. `https://karpathy.ai/?utm=x` and `http://www.karpathy.ai/`)
 * to one key so the same source dedups across polls.
 */
export function canonicalUrlKey(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Dedup identity for a feed item. Keyed on the item's canonical URL — NOT the
 * LLM-generated title/blurb, which is non-deterministic across web-search polls
 * and previously caused the same source to re-insert as a fresh row every poll.
 * Falls back to a title hash only when no URL is present.
 */
export function itemSourceId(subscriptionId, item) {
  const link = canonicalUrlKey(item?.link);
  const identity = link || `notitle:${hashString(item?.title || item?.id || '')}`;
  return `feed:${subscriptionId}:${hashString(identity).slice(0, 24)}`;
}

/**
 * Normalize text from OpenAI Responses API (shape varies by SDK version and tool use).
 */
function extractOpenAiResponsesText(response) {
  if (!response || typeof response !== 'object') return '';
  const direct = response.output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const out = response.output;
  if (!Array.isArray(out)) return '';
  const chunks = [];
  for (const item of out) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') chunks.push(c.text);
        if (c?.type === 'text' && typeof c.text === 'string') chunks.push(c.text);
      }
    }
    if (item?.type === 'output_text' && typeof item.text === 'string') chunks.push(item.text);
  }
  return chunks.join('\n').trim();
}

function researchWebSearchTool() {
  const t = String(process.env.RESEARCH_SEARCH_WEB_TOOL || 'web_search').trim().toLowerCase();
  if (t === 'preview' || t === 'web_search_preview') return { type: 'web_search_preview' };
  return { type: 'web_search' };
}

function deriveSearchIntent(queryText) {
  const q = String(queryText || '').trim().toLowerCase();
  return {
    mentionsWiki: /\bwiki\b/.test(q),
    mentionsWikipedia: /\bwikipedia\b/.test(q),
  };
}

function parseSearchLine(line) {
  const cleaned = String(line || '').trim().replace(/^[-*]\s+/, '');
  if (!cleaned) return null;
  const urlMatch = cleaned.match(/https?:\/\/[^\s)\]]+/i);
  const link = urlMatch?.[0] || '';
  const title = cleaned
    .replace(/\s*[-|]\s*https?:\/\/[^\s)\]]+/i, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
  return {
    title: (title || cleaned).slice(0, 180),
    link,
    text: cleaned.slice(0, 120000),
  };
}

function scoreSearchResult(item, intent) {
  const hay = `${item.title} ${item.link} ${item.text}`.toLowerCase();
  let score = 0;
  if (/(github\.com|gitlab\.com|readthedocs|docs\.)/.test(hay)) score += 3;
  if (/\b(llm|model|ai|repo|repository|guide|docs?)\b/.test(hay)) score += 2;
  if (/\b(wiki|knowledge base|handbook)\b/.test(hay)) score += 1;
  if (intent.mentionsWiki && !intent.mentionsWikipedia && /(wikipedia\.org|biography|born\s+\d{4})/.test(hay)) {
    score -= 4;
  }
  return score;
}

async function openAiWebSearch(queryText, count = 5, { subscriptionId = null } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing for web search');
  }

  const client = new OpenAI({ apiKey });
  // Responses API: use a standard chat model + built-in web_search tool.
  // Do NOT use gpt-4o-search-preview here — those IDs target Chat Completions and often 404 on responses.create.
  const model = process.env.RESEARCH_SEARCH_OPENAI_MODEL || 'gpt-4o-mini';
  const response = await client.responses.create({
    model,
    tools: [researchWebSearchTool()],
    input: [
      {
        role: 'user',
        content: [
          'You are gathering sources to ingest into a highly technical, cutting-edge R&D wiki.',
          'Assume the user is doing advanced engineering and research work; prioritize deep technical substance over general audience summaries.',
          `User query: ${queryText}`,
          'Return concise candidate results as one line each.',
          'Each line format: <title> - <url> - <why this matches query intent>.',
          'Prioritize exact query intent and primary technical/project documentation (specs, repo wikis, papers, benchmarks, architecture docs).',
          'If query contains "wiki", prefer project or repository wiki/docs pages over generic biography pages.',
          'Only include results you believe are strongly relevant.',
        ].join('\n'),
      },
    ],
  });

  // STAQPRO-601: meter the call (token cost + per-call web_search fee) BEFORE
  // parsing — the spend was incurred even if zero results come back.
  await recordSpendMetered({
    agentId: METERING_AGENT_ID,
    model,
    inputTokens: response?.usage?.input_tokens || 0,
    outputTokens: response?.usage?.output_tokens || 0,
    surchargeUsd: webSearchCallCostUsd(),
    taskId: subscriptionId ? `web_search:${subscriptionId}` : 'web_search',
    provider: 'openai',
    kind: 'web_search',
  });

  const intent = deriveSearchIntent(queryText);
  const text = extractOpenAiResponsesText(response);
  const parsed = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseSearchLine)
    .filter(Boolean)
    .map((item) => ({ ...item, score: scoreSearchResult(item, intent) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(10, count)));

  if (parsed.length === 0) {
    throw new Error(
      `OpenAI web search returned no text (model=${model}). Use a Responses-capable model such as gpt-4o-mini or gpt-4o with the web_search tool — not gpt-4o-search-preview.`
    );
  }

  return parsed.map((item, idx) => ({
    id: `openai:${hashString(`${queryText}:${item.title}:${item.link}:${idx}`).slice(0, 24)}`,
    title: item.title,
    link: item.link || '',
    publishedAt: null,
    text: item.text,
  }));
}

/** Minimum fetched-page length (chars) to prefer it over the search summary. */
const MIN_PAGE_CONTENT_CHARS = 200;

/**
 * Decide a feed item's title/body/kind from the search result + an optionally
 * fetched page (STAQPRO-603). Pure — no I/O — so the fetch-vs-fallback policy is
 * unit-testable. Prefers real page content; falls back to the LLM search summary
 * when the page is missing/too thin so the URL is still recorded.
 *
 * @param {{title?:string,link?:string,text?:string}} item  search result
 * @param {{title?:string,content?:string}|null} page        fetched page or null
 * @param {string|null} fetchErr                             fetch error, if any
 * @returns {{title:string, bodyText:string, sourceKind:string, fetchError:string|null}}
 */
export function resolveFeedBody(item, page, fetchErr = null) {
  let title = item.title || item.link || 'Feed item';
  let bodyText = item.text || '';
  let sourceKind = 'feed_item';
  let fetchError = fetchErr || null;
  const content = String(page?.content || '').trim();
  if (content.length >= MIN_PAGE_CONTENT_CHARS) {
    title = page.title || title;
    bodyText = content;
    sourceKind = 'feed_page';
  } else if (page && !fetchError) {
    fetchError = 'fetched page had too little content; kept search summary';
  }
  return { title, bodyText, sourceKind, fetchError };
}

async function ingestFeedItem(subscription, item) {
  const sourceId = itemSourceId(subscription.id, item);
  // Key the content hash on the canonical URL (the stable identity), not the
  // volatile LLM title/blurb. For a topic-search result the "text" is just a
  // one-line match rationale that the model rewords every poll; hashing it
  // produced a fresh hash each time → endless near-duplicate inserts. With no
  // URL we fall back to the title/text so distinct untitled items still differ.
  const linkKey = canonicalUrlKey(item.link);
  const contentHash = hashString(
    linkKey || `${item.title}\n${item.text}\n${item.publishedAt || ''}`
  ).slice(0, 24);

  // OPT-166 P2e-E2: scope this content.documents read — post-flip a bare read
  // black-holes to 0 rows, so hash-based content refresh (forceUpdate) would
  // silently stop working. Scoping keeps dedup correct under RLS.
  const existing = await withResearchOrgScope(subscriptionOrgId(subscription), exec => exec(
    `SELECT id, metadata
     FROM content.documents
     WHERE source = 'feed' AND source_id = $1
     LIMIT 1`,
    [sourceId]
  ));
  const existingHash = existing.rows[0]?.metadata?.content_hash || null;
  if (existingHash && existingHash === contentHash) {
    return { ingested: 0, skipped: 1, errors: 0 };
  }

  // STAQPRO-603: a topic_search result is just a URL + a one-line LLM rationale.
  // Fetch the ACTUAL page content (same path url_watch uses) so feed docs carry
  // real, multi-chunk source material for RAG — not a 2-chunk blurb stub. Fall
  // back to the search summary only when the page can't be fetched
  // (paywall/404/JS-only/too thin), so the URL is still recorded + dedup-skipped
  // next poll rather than re-fetched forever.
  let page = null;
  let fetchErr = null;
  if (item.link && /^https?:\/\//i.test(item.link)) {
    try {
      page = await normalizeUrl(item.link);
    } catch (err) {
      fetchErr = `page fetch failed: ${String(err.message || err).slice(0, 120)}`;
    }
  }
  const { title, bodyText, sourceKind, fetchError } = resolveFeedBody(item, page, fetchErr);

  const rawText = [
    `# ${title}`,
    '',
    item.link ? `Source URL: ${item.link}` : '',
    item.publishedAt ? `Published: ${item.publishedAt}` : '',
    '',
    bodyText,
  ].filter(Boolean).join('\n');

  const ingest = await ingestDocument({
    source: 'feed',
    sourceId,
    title,
    rawText,
    format: 'plain',
    metadata: {
      // Canonical keys
      research_source_id: subscription.id,
      research_source_url: subscription.url,
      // Backward-compatibility aliases
      feed_subscription_id: subscription.id,
      feed_url: subscription.url,
      item_id: item.id,
      item_url: item.link || null,
      published_at: item.publishedAt,
      content_hash: contentHash,
      tags: subscription.tags || [],
      source_kind: sourceKind,
      // STAQPRO-603: keep the LLM match rationale + fetch outcome for debugging.
      search_summary: item.text || null,
      fetch_error: fetchError,
    },
    forceUpdate: !!existing.rows[0]?.id,
    writerOrgScope: { actorId: METERING_AGENT_ID, orgId: subscriptionOrgId(subscription) },
  });

  if (!ingest?.documentId) return { ingested: 0, skipped: 1, errors: 0 };

  // STAQPRO-601: meter the embedding spend for the newly-ingested content.
  await recordSpendMetered({
    agentId: METERING_AGENT_ID,
    model: EMBED_MODEL,
    inputTokens: estimateTokensFor(rawText),
    taskId: `embed:${subscription.id}`,
    provider: 'openai',
    kind: 'embedding',
  });

  // Feed docs should enter wiki compilation queue. ingestDocument already sets
  // this for source='feed', but keep the belt-and-suspenders UPDATE for the edge
  // where a G8-sanitized body early-returns before ingestDocument's internal set
  // — scoped (D2) so it survives the flip rather than being deleted on an
  // unprovable redundancy assumption.
  await withResearchOrgScope(subscriptionOrgId(subscription), exec =>
    exec(`UPDATE content.documents SET compile_status = 'pending' WHERE id = $1`, [ingest.documentId]));

  if (subscription.project_id) {
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, 'document', $2, $3)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [subscription.project_id, ingest.documentId, 'research-source-poller']
    );
  }

  return { ingested: 1, skipped: 0, errors: 0 };
}

async function ingestWatchedPage(subscription) {
  const page = await normalizeUrl(subscription.url);
  const sourceId = `watch:${subscription.id}:${hashString(subscription.url).slice(0, 16)}`;
  const contentHash = hashString(`${page.title}\n${page.content || ''}`).slice(0, 24);
  // OPT-166 P2e-E2: scope this content.documents read (see ingestFeedItem).
  const existing = await withResearchOrgScope(subscriptionOrgId(subscription), exec => exec(
    `SELECT id, metadata
     FROM content.documents
     WHERE source = 'feed' AND source_id = $1
     LIMIT 1`,
    [sourceId]
  ));
  const existingHash = existing.rows[0]?.metadata?.content_hash || null;
  if (existingHash && existingHash === contentHash) {
    return { scanned: 1, ingested: 0, skipped: 1, errors: 0, pageTitle: page.title || '' };
  }

  const ingest = await ingestDocument({
    source: 'feed',
    sourceId,
    title: page.title || subscription.title || subscription.url,
    rawText: page.content || '',
    format: 'plain',
    metadata: {
      // Canonical keys
      research_source_id: subscription.id,
      research_source_url: subscription.url,
      // Backward-compatibility aliases
      feed_subscription_id: subscription.id,
      feed_url: subscription.url,
      item_id: sourceId,
      item_url: subscription.url,
      published_at: null,
      content_hash: contentHash,
      tags: subscription.tags || [],
      source_kind: 'watched_page',
    },
    forceUpdate: !!existing.rows[0]?.id,
    writerOrgScope: { actorId: METERING_AGENT_ID, orgId: subscriptionOrgId(subscription) },
  });
  if (!ingest?.documentId) {
    return { scanned: 1, ingested: 0, skipped: 1, errors: 0, pageTitle: page.title || '' };
  }

  // STAQPRO-601: meter the embedding spend for the newly-ingested page content.
  await recordSpendMetered({
    agentId: METERING_AGENT_ID,
    model: EMBED_MODEL,
    inputTokens: estimateTokensFor(page.content || ''),
    taskId: `embed:${subscription.id}`,
    provider: 'openai',
    kind: 'embedding',
  });

  // OPT-166 P2e-E2: scoped belt-and-suspenders compile_status set (see ingestFeedItem).
  await withResearchOrgScope(subscriptionOrgId(subscription), exec =>
    exec(`UPDATE content.documents SET compile_status = 'pending' WHERE id = $1`, [ingest.documentId]));
  if (subscription.project_id) {
    await query(
      `INSERT INTO agent_graph.project_memberships (project_id, entity_type, entity_id, added_by)
       VALUES ($1, 'document', $2, $3)
       ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING`,
      [subscription.project_id, ingest.documentId, 'research-source-poller']
    );
  }
  return { scanned: 1, ingested: 1, skipped: 0, errors: 0, pageTitle: page.title || '' };
}

async function pollOneSubscription(subscription, maxItems = DEFAULT_MAX_ITEMS) {
  if (subscription.source_mode === 'topic_search') {
    if (!subscription.topic_query) {
      await query(
        `UPDATE content.research_sources
         SET last_polled_at = now(), last_error = 'topic_query missing'
         WHERE id = $1`,
        [subscription.id]
      );
      return { scanned: 0, ingested: 0, skipped: 0, errors: 1 };
    }
    const items = await openAiWebSearch(subscription.topic_query, Math.min(maxItems, subscription.max_items_per_poll || DEFAULT_MAX_ITEMS), { subscriptionId: subscription.id });
    let ingested = 0;
    let skipped = 0;
    let errors = 0;
    for (const item of items) {
      try {
        const r = await ingestFeedItem(subscription, item);
        ingested += r.ingested;
        skipped += r.skipped;
      } catch {
        errors += 1;
      }
    }
    let lastError = null;
    if (errors > 0 && ingested === 0) {
      lastError = `${errors} topic result(s) failed ingestion (check API logs / classification).`;
    }
    await query(
      `UPDATE content.research_sources
       SET last_polled_at = now(),
           last_success_at = CASE WHEN $2::int > 0 THEN now() ELSE last_success_at END,
           last_error = $3
       WHERE id = $1`,
      [subscription.id, ingested, lastError]
    );
    return { scanned: items.length, ingested, skipped, errors };
  }

  // url_watch: HTML page snapshot via normalizeUrl + optional overlapping OpenAI web search (topic_query)
  if (!subscription.url || !/^https?:\/\//i.test(String(subscription.url))) {
    await query(
      `UPDATE content.research_sources
       SET last_polled_at = now(), last_error = 'Valid https URL required'
       WHERE id = $1`,
      [subscription.id]
    );
    return { scanned: 0, ingested: 0, skipped: 0, errors: 1 };
  }

  let scanned = 0;
  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  const errParts = [];
  let pageTitle = '';

  try {
    const pageRes = await ingestWatchedPage(subscription);
    scanned += pageRes.scanned;
    ingested += pageRes.ingested;
    skipped += pageRes.skipped;
    errors += pageRes.errors;
    pageTitle = pageRes.pageTitle || '';
  } catch (err) {
    errParts.push(`page: ${String(err.message || err)}`);
    errors += 1;
  }

  const q = subscription.topic_query && String(subscription.topic_query).trim();
  if (q) {
    try {
      const cap = Math.min(maxItems, subscription.max_items_per_poll || DEFAULT_MAX_ITEMS);
      const items = await openAiWebSearch(q, cap, { subscriptionId: subscription.id });
      scanned += items.length;
      for (const item of items) {
        try {
          const r = await ingestFeedItem(subscription, item);
          ingested += r.ingested;
          skipped += r.skipped;
          errors += r.errors;
        } catch {
          errors += 1;
        }
      }
    } catch (err) {
      errParts.push(`search: ${String(err.message || err)}`);
      errors += 1;
    }
  }

  let lastError = null;
  if (errors > 0 && ingested === 0) {
    lastError = (errParts.join(' · ') || `${errors} error(s) on last poll`).slice(0, 500);
  }

  await query(
    `UPDATE content.research_sources
     SET last_polled_at = now(),
         last_success_at = CASE WHEN $2::int > 0 THEN now() ELSE last_success_at END,
         last_error = $3,
         title = COALESCE(NULLIF($4, ''), title)
     WHERE id = $1`,
    [subscription.id, ingested, lastError, pageTitle]
  );

  return { scanned, ingested, skipped, errors };
}

export async function pollResearchSources(opts = {}) {
  const {
    subscriptionId = null,
    projectId = null,
    maxItems = DEFAULT_MAX_ITEMS,
    force = false,
    autoCompileWiki = null,
  } = opts;
  const params = [];
  const where = [`is_active = true`];
  if (subscriptionId) {
    params.push(subscriptionId);
    where.push(`id = $${params.length}`);
  }
  if (projectId) {
    params.push(projectId);
    where.push(`project_id::text = $${params.length}::text`);
  }
  const result = await query(
    `SELECT id, project_id, url, source_mode, topic_query, title, tags, last_etag, last_modified, max_items_per_poll,
            poll_interval_ms, last_polled_at, owner_org_id
     FROM content.research_sources
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`,
    params
  );

  const totals = {
    subscriptions: result.rows.length,
    scanned: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
    deferred: 0,
  };
  const touchedCompileScopes = new Set();

  // STAQPRO-601: self-enforced daily spend cap (G10-style). guard-check's G10
  // only runs inside the agent loop, so the poller checks its own recorded daily
  // spend and skips this run entirely once over the cap. This is a START-OF-RUN
  // check, not per-call: the run that crosses the cap still completes (no DB
  // re-query per item), so actual spend can overshoot by up to one run's worth —
  // bounded and acceptable at a $2/day cap. Fail-safe: unknown spend reads as 0
  // and does not block. `force` (manual/operator runs) bypasses.
  if (!force) {
    const capUsd = feedPollDailyCapUsd();
    const spentUsd = await dailySpendMeteredUsd(METERING_AGENT_ID);
    if (spentUsd >= capUsd) {
      console.warn(
        `[rd-feed-poller] daily spend cap reached ($${spentUsd.toFixed(4)}/$${capUsd.toFixed(2)}) — skipping ${result.rows.length} subscription(s) this run.`
      );
      totals.skipped += result.rows.length;
      totals.deferred += result.rows.length;
      totals.capped = true;
      totals.daily_spend_usd = spentUsd;
      return totals;
    }
  }

  for (const sub of result.rows) {
    if (!force) {
      const intervalMs = Math.max(60_000, Number(sub.poll_interval_ms) || 900_000);
      const lastPolledAtMs = sub.last_polled_at ? Date.parse(sub.last_polled_at) : Number.NaN;
      const dueAtMs = Number.isFinite(lastPolledAtMs) ? lastPolledAtMs + intervalMs : 0;
      if (dueAtMs > Date.now()) {
        totals.skipped += 1;
        totals.deferred += 1;
        continue;
      }
    }
    try {
      const per = await pollOneSubscription(sub, Math.min(maxItems, sub.max_items_per_poll || DEFAULT_MAX_ITEMS));
      totals.scanned += per.scanned;
      totals.ingested += per.ingested;
      totals.skipped += per.skipped;
      totals.errors += per.errors;
      if (per.ingested > 0) {
        if (sub.project_id == null || sub.project_id === '') {
          touchedCompileScopes.add(ORG_COMPILE_SCOPE);
        } else {
          touchedCompileScopes.add(String(sub.project_id));
        }
      }
    } catch (err) {
      totals.errors += 1;
      await query(
        `UPDATE content.research_sources
         SET last_polled_at = now(), last_error = $2
         WHERE id = $1`,
        [sub.id, String(err.message || err).slice(0, 500)]
      );
    }
  }

  if (
    wikiAutoCompileExplicitEnabled(autoCompileWiki) &&
    totals.ingested > 0 &&
    touchedCompileScopes.size > 0
  ) {
    try {
      const wikiCompiled = await compileWikiForPollTouches(
        touchedCompileScopes,
        wikiAutoCompileMaxArticles()
      );
      Object.assign(totals, { wiki_compiled: wikiCompiled });
    } catch (err) {
      console.error(`[research-source-poller] wiki auto-compile failed: ${err.message || err}`);
      Object.assign(totals, { wiki_compiled: 0, wiki_compile_error: String(err.message || err).slice(0, 200) });
    }
  }

  return totals;
}


// Backward-compatible export name.
export const pollResearchFeeds = pollResearchSources;
