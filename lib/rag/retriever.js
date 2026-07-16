/**
 * Vector similarity retriever.
 *
 * Replaces brain-rag's conversation API with local pgvector search.
 * Uses content.match_chunks() SQL function (ported from brain-rag).
 *
 * Designed to be a drop-in replacement for the existing queryRAG() interface
 * in client.js — same return shape, same graceful degradation.
 */

import { query } from '../db.js';
import { embedOne, getEmbeddingInfo } from './embedder.js';
import { rerank } from './reranker.js';
import { rewriteQuery } from './query-rewriter.js';
import { searchGraph } from './graph-retriever.js';
import { detectParticipantsInQuery } from './query-participants.js';
import { validateScope, scopeToFilterOpts, RetrieverScopeError, SCOPE_VALIDATED_BY_PARENT } from './scope.js';
import { CURRENT_ORG_ID } from '../tenancy/scope.js';
import { newRetrievalId, recordSharedDocHitsAsync } from './share-retrieval-audit.js';
import { createLogger } from '../logger.js';
const log = createLogger('rag/retriever');

// Re-export so callers don't need a second import for the typed error.
export { RetrieverScopeError };

const PARTICIPANT_BOOST = 0.05; // applied to chunks where document participants match

const DEFAULT_MATCH_COUNT = parseInt(process.env.RAG_MATCH_COUNT || '30', 10);
const DEFAULT_MIN_SIMILARITY = parseFloat(process.env.RAG_MIN_SIMILARITY || '0.30');
const CONTEXT_MAX_TOKENS = parseInt(process.env.RAG_CONTEXT_MAX_TOKENS || '2200', 10);
const CHARS_PER_TOKEN = 4;

// STAQPRO-310: ordinal mapping for classification filtering.
// The text column on content.documents / content.chunks / content.wiki_pages
// orders by security (PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED) but
// Postgres `<=` on text is lexicographic — CONFIDENTIAL < INTERNAL < PUBLIC
// alphabetically. Migration 108 adds a `classification_level smallint`
// generated column we filter on instead. This map is the canonical
// mirror; keep it in sync with migration 108's CASE expression.
const CLASSIFICATION_LEVELS = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
});

/**
 * Coerce a classification argument to its numeric level. Accepts either
 * a numeric level (0-3) or one of the four text values. Falls back to
 * INTERNAL (1) on unknown input — the same default as the rest of the
 * codebase. Throws never.
 */
function toClassificationLevel(maxClass) {
  if (typeof maxClass === 'number' && Number.isInteger(maxClass) && maxClass >= 0 && maxClass <= 3) {
    return maxClass;
  }
  if (typeof maxClass === 'string' && Object.prototype.hasOwnProperty.call(CLASSIFICATION_LEVELS, maxClass)) {
    return CLASSIFICATION_LEVELS[maxClass];
  }
  return CLASSIFICATION_LEVELS.INTERNAL;
}

export { CLASSIFICATION_LEVELS, toClassificationLevel };

function formatParticipantHeader(metadata) {
  const participants = metadata?.document_participants;
  if (!Array.isArray(participants) || participants.length === 0) return null;
  const label = metadata?.document_source === 'tldv' || metadata?.retrieval_mode === 'vector' && (metadata?.speakers?.length)
    ? 'Meeting participants'
    : metadata?.document_source === 'email'
      ? 'Thread participants'
      : 'Participants';
  const names = participants
    .map(p => p?.name || p?.email)
    .filter(Boolean);
  if (names.length === 0) return null;
  // Keep the header short — the goal is a durable cue for the LLM, not a full roster
  return `[${label}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}]`;
}

function searchTerms(queryText) {
  return String(queryText || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 8);
}

export async function lexicalChunkSearch(queryText, opts = {}, scope) {
  // Tenancy gate (Worktree 1). validateScope throws RetrieverScopeError on
  // missing/ambiguous/invalid scope; legacy callers that still pass
  // ownerId/includeOrgWide/sharedDocumentsOnly directly are accepted with
  // a deprecation log so the existing classification/wiki tests do not
  // regress. Once those migrate, validateScope hardens to throw-only.
  const normalizedScope = validateScope({ entryPoint: 'lexicalChunkSearch', scope, opts });
  const filterOpts = scopeToFilterOpts(normalizedScope);

  const terms = searchTerms(queryText);
  if (terms.length === 0) return { chunks: [] };

  const ownerId = filterOpts.ownerId;
  // STAQPRO-310: pass the numeric ordinal, not the text. Filter at line
  // below was lexicographic on the text column (CONFIDENTIAL < INTERNAL
  // < PUBLIC alphabetically) which leaked CONFIDENTIAL up and hid PUBLIC
  // down for any caller passing maxClassification='INTERNAL'.
  const maxClassificationLevel = toClassificationLevel(opts.maxClassification ?? 'INTERNAL');
  const includeOrgWide = filterOpts.includeOrgWide;
  const sharedDocumentsOnly = filterOpts.sharedDocumentsOnly;
  // Phase-2 tenancy (live read-leak): the cross-tenant org gate, mirroring the
  // vector path (searchChunks → content.match_chunks filter_org_ids, migration
  // 135). The vector path got this in commit 0a8aa1e but the lexical path was
  // missed, half-applying the org gate. Sourced from the validated scope's
  // readOrgIds via scopeToFilterOpts. Empty → fail-closed (0 rows), enforced
  // both by the explicit guard below and by `= ANY('{}'::uuid[])` semantics.
  const filterOrgIds = Array.isArray(filterOpts.filterOrgIds) ? filterOpts.filterOrgIds : [];
  // ADR-017: caller's group memberships, used as the target principal set for
  // share_grants with target_type='group'. Empty when none.
  const filterGroupIds = Array.isArray(filterOpts.filterGroupIds) ? filterOpts.filterGroupIds : [];
  // Fail-closed: a caller with no readable orgs AND no caller userId cannot
  // match anything (the share-grant target arms cannot resolve). Mirrors the
  // updated content.match_chunks() early-return contract (mig 182).
  if (filterOrgIds.length === 0 && !ownerId) {
    log.warn('[lexicalChunkSearch] no readable orgs and no ownerId — failing closed (0 rows)');
    return { chunks: [] };
  }
  const documentIds = opts.documentIds ?? null;
  const temporalRange = opts.temporalRange ?? null;
  const participantFilter = Array.isArray(opts.participantFilter) && opts.participantFilter.length > 0
    ? opts.participantFilter : null;
  const participantBoost = Array.isArray(opts.participantBoost) && opts.participantBoost.length > 0
    ? opts.participantBoost : null;
  const matchCount = Math.max(10, Math.min(30, opts.matchCount ?? DEFAULT_MATCH_COUNT));

  // $1..$5 fixed; $6 = filterOrgIds (mig 135 org gate);
  // $7 = filterGroupIds (mig 182 share-grant target-group set). Dynamic filters
  // below continue from $8 via `idx`.
  const params = [terms, ownerId, maxClassificationLevel, includeOrgWide, sharedDocumentsOnly, filterOrgIds, filterGroupIds];
  let idx = params.length + 1;
  const filters = [];
  if (documentIds && documentIds.length > 0) {
    filters.push(`c.document_id = ANY($${idx++})`);
    params.push(documentIds);
  }
  if (temporalRange?.from && temporalRange?.to) {
    filters.push(`d.created_at >= $${idx++}::timestamptz AND d.created_at < $${idx++}::timestamptz`);
    params.push(temporalRange.from, temporalRange.to);
  }
  if (participantFilter) {
    // Match if ANY filter id appears in d.participants — mirrors the match_chunks
    // semantics (migration 058). Ambiguous names like "Glenn" often resolve
    // to several contacts, and we want any of them to satisfy the filter.
    filters.push(`EXISTS (
      SELECT 1 FROM unnest($${idx}::uuid[]) fid
      WHERE d.participants @> jsonb_build_array(jsonb_build_object('contact_id', fid::text))
    )`);
    params.push(participantFilter);
    idx++;
  }

  let participantMatchExpr = 'FALSE';
  if (participantBoost) {
    participantMatchExpr = `EXISTS (
      SELECT 1 FROM unnest($${idx}::uuid[]) bid
      WHERE d.participants @> jsonb_build_array(jsonb_build_object('contact_id', bid::text))
    )`;
    params.push(participantBoost);
    idx++;
  }

  const sql = `SELECT
      c.document_id,
      c.text,
      c.metadata,
      d.title,
      d.source,
      d.created_at,
      d.participants AS document_participants,
      (${participantMatchExpr}) AS participant_match,
      -- ADR-017: provenance + scope. Null when visible via own/org-wide;
      -- otherwise { granter_type, granter_id, scope_type, scope_ref }.
      -- Narrowed to grants that apply to 'documents' (mig 183).
      (
        SELECT jsonb_build_object(
                 'granter_type', g.granter_type, 'granter_id', g.granter_id,
                 'scope_type',   g.scope_type,   'scope_ref',  g.scope_ref,
                 'grant_id',     g.id
               )
          FROM tenancy.share_grants g
         WHERE g.status = 'active'
           AND 'documents' = ANY(g.applies_to)
           AND (
             (g.granter_type = 'user' AND g.granter_id = d.owner_id)
             OR (g.granter_type = 'org' AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
           )
           AND (
             g.scope_type = 'all'
             OR (g.scope_type = 'document'   AND g.scope_ref = d.id::text)
             OR (g.scope_type = 'collection' AND d.collection_id IS NOT NULL AND g.scope_ref = d.collection_id::text)
             OR (g.scope_type = 'topic'      AND EXISTS (
                   SELECT 1 FROM content.document_topics dt
                    WHERE dt.document_id = d.id AND dt.topic_id::text = g.scope_ref
                 ))
           )
           AND (
             (g.target_type='user'  AND $2::uuid IS NOT NULL AND g.target_id = $2)
             OR (g.target_type='org'   AND g.target_id = ANY($6::uuid[]))
             OR (g.target_type='group' AND g.target_id = ANY($7::uuid[]))
           )
         LIMIT 1
      ) AS shared_via,
      (
        SELECT COUNT(*)
        FROM unnest($1::text[]) term
        WHERE lower(c.text) LIKE '%' || term || '%'
           OR lower(COALESCE(d.title, '')) LIKE '%' || term || '%'
           OR lower(COALESCE(c.metadata::text, '')) LIKE '%' || term || '%'
      ) AS term_hits
    FROM content.chunks c
    JOIN content.documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND d.classification_level <= $3
      -- Visibility: (owner_gate AND org_gate) OR share_grant_match.
      -- Mirrors content.match_chunks (mig 182) exactly.
      AND (
        (
          (
            ($2::uuid IS NOT NULL AND ((d.owner_id = $2) OR ($4 = true AND d.owner_id IS NULL)))
            OR ($5 = true AND d.owner_id IS NULL)
            OR ($2::uuid IS NULL AND $5 = false)
          )
          AND COALESCE(d.owner_org_id, '${CURRENT_ORG_ID}'::uuid) = ANY($6::uuid[])
        )
        OR EXISTS (
          SELECT 1 FROM tenancy.share_grants g
           WHERE g.status = 'active'
             AND 'documents' = ANY(g.applies_to)
             AND (
               (g.granter_type = 'user' AND g.granter_id = d.owner_id)
               OR (g.granter_type = 'org' AND g.granter_id = d.owner_org_id AND d.owner_id IS NULL)
             )
             AND (
               g.scope_type = 'all'
               OR (g.scope_type = 'document'   AND g.scope_ref = d.id::text)
               OR (g.scope_type = 'collection' AND d.collection_id IS NOT NULL AND g.scope_ref = d.collection_id::text)
             )
             AND (
               (g.target_type='user'  AND $2::uuid IS NOT NULL AND g.target_id = $2)
               OR (g.target_type='org'   AND g.target_id = ANY($6::uuid[]))
               OR (g.target_type='group' AND g.target_id = ANY($7::uuid[]))
             )
        )
      )
      ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      AND EXISTS (
        SELECT 1
        FROM unnest($1::text[]) term
        WHERE lower(c.text) LIKE '%' || term || '%'
           OR lower(COALESCE(d.title, '')) LIKE '%' || term || '%'
           OR lower(COALESCE(c.metadata::text, '')) LIKE '%' || term || '%'
      )
    ORDER BY term_hits DESC, d.created_at DESC
    LIMIT ${matchCount}`;

  try {
    const result = await query(sql, params);
    const retrievalId = newRetrievalId();
    // Fire-and-forget audit for any shared-doc hits (ADR-017 #12).
    recordSharedDocHitsAsync({
      retrievalId,
      results: result.rows.map((r) => ({ documentId: r.document_id, shared_via: r.shared_via })),
      callerUserId: ownerId,
      callerOrgIds: filterOrgIds,
      queryText,
    });
    return {
      retrievalId,
      chunks: result.rows.map((r) => {
        const participantMatch = r.participant_match === true;
        const termSim = 0.42 + Math.min(0.22, Number(r.term_hits || 0) * 0.06);
        return {
          text: r.text,
          similarity: participantMatch ? termSim + PARTICIPANT_BOOST : termSim,
          metadata: {
            ...(r.metadata || {}),
            document_title: r.title || null,
            document_source: r.source || null,
            document_created_at: r.created_at || null,
            document_participants: r.document_participants || [],
            participant_match: participantMatch,
            // ADR-017: surface share_grant provenance for the UI's "shared by"
            // chip. null = own/org-wide; otherwise { granter_type, granter_id }.
            shared_via: r.shared_via || null,
            retrieval_mode: 'lexical',
          },
          documentId: r.document_id,
        };
      }),
    };
  } catch (err) {
    log.warn(`Lexical search failed: ${err.message}`);
    return { chunks: [] };
  }
}

/**
 * STAQPRO-311 Phase 1: FTS lookup against content.wiki_pages.
 *
 * Parallel to lexicalChunkSearch, but for the compiled wiki layer
 * (curated org knowledge: meeting notes, email summaries, vault
 * compilations). Uses Postgres FTS (tsvector content_tsv from
 * migration 109) with classification filtering on classification_level
 * (smallint ordinal from migration 108). Sub-10ms in-transaction —
 * that's the FTS-first justification over embeddings (per Liotta).
 *
 * Returns *structured citations*, not raw text dumps, so downstream
 * agent prompts can emit `[wiki:${slug}]` references the dashboard
 * can hyperlink (per Neo Architect).
 *
 * Audit: every call optionally logs to content.retrieval_events when
 * agentId is provided. Append-only, P3-compliant.
 *
 * @param {string} queryText
 * @param {Object} [opts]
 * @param {string|number} [opts.maxClassification='INTERNAL'] - tier cap
 * @param {number} [opts.matchCount=5] - max pages to return
 * @param {string} [opts.agentId] - for retrieval_events audit
 * @param {string} [opts.workItemId] - for retrieval_events audit
 * @param {number} [opts.excerptMaxChars=600] - ts_headline cap per page
 * @returns {Promise<{ pages: Array<{ id, slug, title, excerpt, classificationLevel, score, sourceType: 'wiki_pages' }> }>}
 */
export async function wikiPageSearch(queryText, opts = {}, scope) {
  // Tenancy gate. ADR-017 follow-up (mig 185) added owner_id + owner_org_id to
  // wiki_pages, so wiki visibility now mirrors the lexical-chunks path:
  //   (own ∪ org-wide-in-readable-orgs) ∪ share_grants(applies_to='wiki_pages')
  const normalizedScope = validateScope({ entryPoint: 'wikiPageSearch', scope, opts });
  const filterOpts = scopeToFilterOpts(normalizedScope);
  const ownerId = filterOpts.ownerId;
  const filterOrgIds = Array.isArray(filterOpts.filterOrgIds) ? filterOpts.filterOrgIds : [];
  const filterGroupIds = Array.isArray(filterOpts.filterGroupIds) ? filterOpts.filterGroupIds : [];
  if (filterOrgIds.length === 0 && !ownerId) {
    log.warn('[wikiPageSearch] no readable orgs and no ownerId — failing closed (0 pages)');
    return { pages: [] };
  }

  const q = String(queryText || '').trim();
  if (!q) return { pages: [] };

  const maxLevel = toClassificationLevel(opts.maxClassification ?? 'INTERNAL');
  const matchCount = Math.max(1, Math.min(20, opts.matchCount ?? 5));
  const excerptMaxChars = Math.max(120, Math.min(2000, opts.excerptMaxChars ?? 600));

  // ts_headline options: plain text (no HTML tags), single snippet,
  // capped at MaxFragments=1 to ensure we get one excerpt per page.
  // StartSel/StopSel empty so the LLM sees clean text — we keep the
  // citation slug/title as the human-trackable handle.
  const headlineOpts = `StartSel="", StopSel="", MaxWords=${Math.floor(excerptMaxChars / 6)}, MinWords=${Math.floor(excerptMaxChars / 12)}, ShortWord=3, MaxFragments=1, FragmentDelimiter=" ... "`;

  // Positional params:
  //   $1 = query text
  //   $2 = max classification level
  //   $3 = match count
  //   $4 = headline opts
  //   $5 = ownerId (nullable)
  //   $6 = filterOrgIds (uuid[])
  //   $7 = filterGroupIds (uuid[])
  const sql = `
    WITH q AS (SELECT plainto_tsquery('english', $1::text) AS query)
    SELECT
      wp.id,
      wp.slug,
      wp.title,
      wp.classification_level,
      ts_rank_cd(wp.content_tsv, q.query) AS score,
      ts_headline('english', wp.content, q.query, $4) AS excerpt,
      -- Provenance: which share grant made this page visible (null when own/org-wide).
      (
        SELECT jsonb_build_object(
                 'granter_type', g.granter_type, 'granter_id', g.granter_id,
                 'scope_type',   g.scope_type,   'scope_ref',  g.scope_ref,
                 'grant_id',     g.id
               )
          FROM tenancy.share_grants g
         WHERE g.status = 'active'
           AND 'wiki_pages' = ANY(g.applies_to)
           AND (
             (g.granter_type = 'user' AND g.granter_id = wp.owner_id)
             OR (g.granter_type = 'org' AND g.granter_id = wp.owner_org_id AND wp.owner_id IS NULL)
           )
           AND (
             g.scope_type = 'all'
             OR (g.scope_type = 'document' AND g.scope_ref = wp.id::text)
             OR (g.scope_type = 'topic'    AND EXISTS (
                   SELECT 1 FROM content.wiki_page_topics wpt
                    WHERE wpt.wiki_page_id = wp.id AND wpt.topic_id::text = g.scope_ref
                 ))
           )
           AND (
             (g.target_type='user'  AND $5::uuid IS NOT NULL AND g.target_id = $5)
             OR (g.target_type='org'   AND g.target_id = ANY($6::uuid[]))
             OR (g.target_type='group' AND g.target_id = ANY($7::uuid[]))
           )
         LIMIT 1
      ) AS shared_via
    FROM content.wiki_pages wp, q
    WHERE wp.content_tsv @@ q.query
      AND wp.classification_level <= $2
      -- Owner gate ∪ share-grant arm (mirrors lexicalChunkSearch).
      AND (
        (
          ($5::uuid IS NOT NULL AND (wp.owner_id = $5 OR wp.owner_id IS NULL))
          OR ($5::uuid IS NULL)
        )
        AND COALESCE(wp.owner_org_id, '${CURRENT_ORG_ID}'::uuid) = ANY($6::uuid[])
        OR EXISTS (
          SELECT 1 FROM tenancy.share_grants g
           WHERE g.status = 'active'
             AND 'wiki_pages' = ANY(g.applies_to)
             AND (
               (g.granter_type = 'user' AND g.granter_id = wp.owner_id)
               OR (g.granter_type = 'org' AND g.granter_id = wp.owner_org_id AND wp.owner_id IS NULL)
             )
             AND (
               g.scope_type = 'all'
               OR (g.scope_type = 'document' AND g.scope_ref = wp.id::text)
             )
             AND (
               (g.target_type='user'  AND $5::uuid IS NOT NULL AND g.target_id = $5)
               OR (g.target_type='org'   AND g.target_id = ANY($6::uuid[]))
               OR (g.target_type='group' AND g.target_id = ANY($7::uuid[]))
             )
        )
      )
    ORDER BY score DESC
    LIMIT $3
  `;

  let rows;
  try {
    const result = await query(sql, [q, maxLevel, matchCount, headlineOpts, ownerId, filterOrgIds, filterGroupIds]);
    rows = result.rows;
  } catch (err) {
    log.warn(`Wiki search failed: ${err.message}`);
    return { pages: [] };
  }

  const pages = rows.map(r => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: (r.excerpt || '').slice(0, excerptMaxChars),
    classificationLevel: r.classification_level,
    score: parseFloat(r.score) || 0,
    // ADR-017: null when own/org-wide; { granter_type, granter_id, scope_type, scope_ref, grant_id }
    // when visible via a share grant. UI consumers render the SharedViaChip.
    shared_via: r.shared_via || null,
    sourceType: 'wiki_pages',
  }));

  // Fire-and-forget audit for any shared wiki hits (ADR-017 #12).
  const retrievalId = newRetrievalId();
  recordSharedDocHitsAsync({
    retrievalId,
    results: pages.map((p) => ({ documentId: p.id, shared_via: p.shared_via })),
    callerUserId: ownerId,
    callerOrgIds: filterOrgIds,
    queryText: q,
  });

  // Audit — fire-and-forget so a failed insert never breaks retrieval.
  // Only logs when an agent is identified (system-level / test calls
  // skip the audit row).
  if (opts.agentId) {
    const tokenEstimate = Math.ceil(
      pages.reduce((sum, p) => sum + (p.excerpt?.length || 0), 0) / CHARS_PER_TOKEN
    );
    query(
      `INSERT INTO content.retrieval_events
         (agent_id, work_item_id, corpus, query, result_ids, result_count, token_count)
       VALUES ($1, $2, 'wiki_pages', $3, $4, $5, $6)`,
      [
        opts.agentId,
        opts.workItemId ?? null,
        q,
        pages.map(p => p.id),
        pages.length,
        tokenEstimate,
      ]
    ).catch(err => log.warn(`Wiki retrieval audit insert failed: ${err.message}`));
  }

  return { pages };
}

/**
 * Search the local knowledge base for relevant chunks.
 *
 * @param {string} queryText - Natural language query
 * @param {Object} [opts]
 * @param {number} [opts.matchCount] - Max chunks to return
 * @param {number} [opts.minSimilarity] - Minimum cosine similarity threshold
 * @param {string} [opts.ownerId] - Board member UUID for corpus filter (see includeOrgWide)
 * @param {string} [opts.maxClassification='INTERNAL'] - Max classification level to return
 * @param {boolean} [opts.includeOrgWide=true] - When ownerId set, also include documents with owner_id NULL (shared org corpus)
 * @param {boolean} [opts.sharedDocumentsOnly=false] - Only owner_id IS NULL documents (ignores ownerId)
 * @param {string[]} [opts.documentIds] - Filter to specific document IDs (for project-scoped search)
 * @param {{ from: string, to: string }} [opts.temporalRange] - Optional time window (content.documents.created_at)
 * @returns {Promise<{ chunks: Array<{ text: string, similarity: number, metadata: Object, documentId: string }>, model: string } | null>}
 */
export async function searchChunks(queryText, opts = {}, scope) {
  // Tenancy gate (Worktree 1). validateScope throws on missing/ambiguous
  // scope; legacy callers (test rigs) still pass the old options triple
  // and are accepted with a deprecation log.
  const normalizedScope = validateScope({ entryPoint: 'searchChunks', scope, opts });
  const filterOpts = scopeToFilterOpts(normalizedScope);

  const info = getEmbeddingInfo();
  if (!info) {
    log.info('No embedding provider configured — skipping local search');
    return null;
  }

  // Embed the query
  const queryEmbedding = await embedOne(queryText);
  if (!queryEmbedding) return null;

  const matchCount = opts.matchCount ?? DEFAULT_MATCH_COUNT;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const ownerId = filterOpts.ownerId;
  const maxClassification = opts.maxClassification ?? 'INTERNAL';
  const includeOrgWide = filterOpts.includeOrgWide;
  const sharedDocumentsOnly = filterOpts.sharedDocumentsOnly;
  // Phase-2 tenancy (live read-leak): the org gate threaded into
  // content.match_chunks(filter_org_ids). Empty → match_chunks returns 0 rows
  // (fail-closed, migration 135). Sourced from the validated scope's readOrgIds.
  const filterOrgIds = Array.isArray(filterOpts.filterOrgIds) ? filterOpts.filterOrgIds : [];
  // ADR-017: filter_group_ids carries the caller's tenancy.group_memberships,
  // used as the target principal set for share_grants with target_type='group'.
  // Empty when the caller belongs to no groups — the group target arm is then
  // a no-op inside match_chunks.
  const filterGroupIds = Array.isArray(filterOpts.filterGroupIds) ? filterOpts.filterGroupIds : [];
  const documentIds = opts.documentIds ?? null;
  const temporalRange = opts.temporalRange ?? null;
  const participantFilter = Array.isArray(opts.participantFilter) && opts.participantFilter.length > 0
    ? opts.participantFilter : null;
  const participantBoost = Array.isArray(opts.participantBoost) && opts.participantBoost.length > 0
    ? opts.participantBoost : null;

  // STAQPRO-313: match_chunks() now takes a SMALLINT ordinal ceiling
  // (migration 118) instead of the TEXT value + CASE-IN block. Convert here
  // via the same toClassificationLevel() used by lexicalChunkSearch so both
  // retrieval paths share one classification filter.
  const maxClassificationLevel = toClassificationLevel(maxClassification);
  const baseParams = [
    `[${queryEmbedding.join(',')}]`,
    matchCount,
    minSimilarity,
    ownerId,
    maxClassificationLevel,
    includeOrgWide,
    sharedDocumentsOnly,
    participantFilter,
    participantBoost,
    filterOrgIds,
    filterGroupIds,
  ];
  // $10 = filter_org_ids (mig 135). $11 = filter_group_ids (mig 182, ADR-017).
  // The remaining positional params ($12+) for the documentIds / temporalRange
  // variants below continue from $12.
  const matchCall = `content.match_chunks($1::vector, $2, $3, $4, $5::smallint, $6, $7, $8::uuid[], $9::uuid[], $10::uuid[], $11::uuid[])`;
  const selectCols = `mc.id, mc.document_id, mc.text, mc.metadata, mc.similarity, mc.document_participants, mc.participant_match, mc.shared_via, d.title, d.source, d.created_at`;

  try {
    let result;
    if (documentIds && documentIds.length > 0 && temporalRange?.from && temporalRange?.to) {
      result = await query(
        `SELECT ${selectCols}
         FROM ${matchCall} mc
         JOIN content.documents d ON d.id = mc.document_id
         WHERE mc.document_id = ANY($12)
           AND d.created_at >= $13::timestamptz
           AND d.created_at < $14::timestamptz`,
        [...baseParams, documentIds, temporalRange.from, temporalRange.to]
      );
    } else if (documentIds && documentIds.length > 0) {
      result = await query(
        `SELECT ${selectCols}
         FROM ${matchCall} mc
         JOIN content.documents d ON d.id = mc.document_id
         WHERE mc.document_id = ANY($12)`,
        [...baseParams, documentIds]
      );
    } else if (temporalRange?.from && temporalRange?.to) {
      result = await query(
        `SELECT ${selectCols}
         FROM ${matchCall} mc
         JOIN content.documents d ON d.id = mc.document_id
         WHERE d.created_at >= $12::timestamptz
           AND d.created_at < $13::timestamptz`,
        [...baseParams, temporalRange.from, temporalRange.to]
      );
    } else {
      result = await query(
        `SELECT ${selectCols}
         FROM ${matchCall} mc
         JOIN content.documents d ON d.id = mc.document_id`,
        baseParams
      );
    }

    const retrievalId = newRetrievalId();
    recordSharedDocHitsAsync({
      retrievalId,
      results: result.rows.map((r) => ({ documentId: r.document_id, shared_via: r.shared_via })),
      callerUserId: ownerId,
      callerOrgIds: filterOrgIds,
      queryText,
    });
    return {
      retrievalId,
      chunks: result.rows.map(r => {
        const participantMatch = r.participant_match === true;
        const baseSim = parseFloat(r.similarity);
        return {
          text: r.text,
          similarity: participantMatch ? Math.min(1, baseSim + PARTICIPANT_BOOST) : baseSim,
          metadata: {
            ...(r.metadata || {}),
            document_title: r.title || null,
            document_source: r.source || null,
            document_created_at: r.created_at || null,
            document_participants: r.document_participants || [],
            participant_match: participantMatch,
            // ADR-017: provenance — null when the row was visible via
            // (owner_gate AND org_gate); a { granter_type, granter_id } object
            // when visible via an active share_grant. The board UI renders a
            // "shared by X" chip when this is non-null.
            shared_via: r.shared_via || null,
            retrieval_mode: 'vector',
          },
          documentId: r.document_id,
        };
      }),
      model: info.model,
    };
  } catch (err) {
    log.error(`Search failed: ${err.message}`);
    return null;
  }
}

/**
 * Build a context block for agent prompts from local knowledge base.
 * Drop-in replacement for brain-rag's getRAGContext().
 *
 * Uses multi-query retrieval: rewrites the query into 2-3 search-optimized
 * variants, searches each, deduplicates, then reranks the combined results.
 *
 * @param {string} queryText - What to search for
 * @param {Object} [opts]
 * @param {string} [opts.scope] - Unused (kept for API compat with brain-rag client)
 * @param {string} [opts.ownerId] - Board member UUID (with includeOrgWide, shared corpus + theirs)
 * @param {boolean} [opts.includeOrgWide=true]
 * @param {boolean} [opts.sharedDocumentsOnly=false]
 * @param {string} [opts.maxClassification='INTERNAL']
 * @param {Array} [opts.history] - Recent conversation turns for coreference resolution
 * @param {string[]} [opts.documentIds] - Filter to specific document IDs (for project-scoped search)
 * @param {{ from: string, to: string }} [opts.temporalRange] - Optional time window (content.documents.created_at)
 * @returns {Promise<{ answer: string, citations: Array } | null>}
 */
export async function retrieveContext(queryText, opts = {}, scope) {
  // Tenancy gate (Worktree 1). MUST run outside the try/catch below —
  // that catch returns null on any throw, which would silently mask
  // scope violations and leak documents the caller is not permitted
  // to see. Scope errors propagate to the caller as RetrieverScopeError.
  const normalizedScope = validateScope({ entryPoint: 'retrieveContext', scope, opts });
  const filterOpts = scopeToFilterOpts(normalizedScope);
  // Stamp filterOpts onto opts so downstream searchChunks / lexicalChunkSearch
  // see the validated values (we override caller-supplied ownerId/etc).
  // __scopeValidatedByParent silences the inner deprecation log — the parent
  // already ran the gate; the inner calls are an implementation detail.
  // Phase-2 tenancy: also pass `readOrgIds` through so the inner entry points'
  // validateScope (Mode 2 legacy path) re-derives the SAME org gate instead of
  // failing closed to an empty set on the passthrough.
  opts = {
    ...opts,
    ...filterOpts,
    readOrgIds: normalizedScope.readOrgIds || [],
    [SCOPE_VALIDATED_BY_PARENT]: true,
  };

  try {
  // Step 0: Detect participants in the query. Named contacts become filters
  // (strong intent: "meeting with John") or boosts (softer: "John's project").
  // When no contact matches the name, fall back to a direct lookup against
  // content.documents.participants so name-only tl;dv speakers still anchor
  // the search — this is the case that caused the original "there was no
  // meeting with John" bug.
  // Caller-supplied participantFilter wins — when the caller already knows
  // who the search is scoped to (e.g. /contacts/[id] page), skip auto-detection
  // entirely. Otherwise detect from the query text.
  let participantFilter = Array.isArray(opts.participantFilter) && opts.participantFilter.length > 0
    ? opts.participantFilter
    : null;
  let participantBoost = Array.isArray(opts.participantBoost) && opts.participantBoost.length > 0
    ? opts.participantBoost
    : null;
  let mergedDocumentIds = opts.documentIds ?? null;
  let participantAnchored = participantFilter !== null;

  if (!participantAnchored) {
    try {
      const detected = await detectParticipantsInQuery(queryText);
      if (detected.filterIds.length > 0) {
        participantFilter = detected.filterIds;
        participantAnchored = true;
      }
      if (detected.boostIds.length > 0) participantBoost = detected.boostIds;
      if (Array.isArray(detected.documentIds) && detected.documentIds.length > 0) {
        mergedDocumentIds = mergedDocumentIds
          ? mergedDocumentIds.filter(id => detected.documentIds.includes(id))
          : detected.documentIds;
        participantAnchored = true;
        // If the caller already had a narrower scope and it intersects to empty,
        // respect the caller by leaving mergedDocumentIds as an empty array
        // (match_chunks will then return nothing for this participant query).
      }
    } catch (err) {
      log.warn(`Participant detection failed: ${err.message}`);
    }
  }
  // When participant detection anchors the search to a known-good set of
  // documents, the chunk text may not semantically match a meta-question like
  // "how did the meeting with Glenn go". Drop the similarity floor so those
  // chunks aren't filtered out at the SQL layer — rerank + synthesis downstream
  // still decide quality. Also tag each chunk so downstream filters (e.g.,
  // hasSufficientEvidence in api-routes/search.js) can recognize the anchor.
  const searchOpts = {
    ...opts,
    participantFilter,
    participantBoost,
    documentIds: mergedDocumentIds,
    ...(participantAnchored ? { minSimilarity: Math.min(opts.minSimilarity ?? 0.05, 0.05) } : {}),
    __participantAnchored: participantAnchored,
  };

  // Step 1: Query rewriting — resolve coreferences, generate search variants
  let queries;
  try {
    queries = await rewriteQuery(queryText, opts.history || []);
  } catch {
    queries = [queryText]; // Rewriter failed — use original
  }

  // Step 2: Hybrid search — vector + graph in parallel
  const allChunks = new Map(); // keyed by chunk ID for dedup

  // Run vector + lexical searches for each query variant, then graph search if allowed.
  // For the inner entry-point calls, fall through the validated filterOpts as
  // a legacy-shape (already on `searchOpts`) — the parent retrieveContext
  // already ran the scope gate. Pass `scope=undefined` deliberately so the
  // inner validateScope hits the legacy-opts branch (no double tier check
  // and no spurious tier failure when the parent was itself in legacy mode).
  const searchPromises = queries.flatMap(q => [
    searchChunks(q, searchOpts).catch(() => null),
    lexicalChunkSearch(q, searchOpts).catch(() => ({ chunks: [] })),
  ]);
  // Temporal queries should be strict on dated corpus hits only.
  if (!opts.temporalRange) {
    searchPromises.push(
      searchGraph(queryText).then(graphResults => ({
        chunks: graphResults.map(r => ({
          text: r.text,
          similarity: 0.5,
          metadata: { ...r.metadata, source: 'knowledge_graph' },
          documentId: 'graph',
        })),
      })).catch(() => ({ chunks: [] }))
    );
  }

  const results = await Promise.all(searchPromises);
  for (const result of results) {
    if (result?.chunks) {
      for (const chunk of result.chunks) {
        const key = (chunk.documentId || 'graph') + ':' + chunk.text.slice(0, 50);
        if (!allChunks.has(key) || chunk.similarity > allChunks.get(key).similarity) {
          allChunks.set(key, chunk);
        }
      }
    }
  }

  const mergedChunks = [...allChunks.values()].sort((a, b) => b.similarity - a.similarity);
  if (mergedChunks.length === 0) return null;

  // Tag chunks that reached us via participant anchoring, so downstream
  // similarity-based filters (e.g. hasSufficientEvidence in the search route)
  // can skip the score floor — we retrieved these because the participant
  // matched, not because of semantic similarity to the raw question.
  if (participantAnchored) {
    for (const ch of mergedChunks) {
      if (!ch.metadata) ch.metadata = {};
      ch.metadata.participant_anchored = true;
    }
  }

  // Step 3: Rerank — cross-encoder re-scores for precision
  const reranked = await rerank(queryText, mergedChunks, 10);

  // Step 4: Build context from reranked chunks.
  // Prepend a "[Participants: …]" line for each chunk whose document has
  // structured participants. Without this, the LLM only sees the chunk text
  // — which may never contain a participant's name even when they attended.
  const maxChars = CONTEXT_MAX_TOKENS * CHARS_PER_TOKEN;
  let answer = '';
  const citations = [];

  for (const chunk of reranked) {
    const header = formatParticipantHeader(chunk.metadata);
    const block = header ? `${header}\n${chunk.text}` : chunk.text;
    if (answer.length + block.length > maxChars) break;

    answer += block + '\n\n';
    citations.push({
      text: chunk.text.slice(0, 200),
      similarity: chunk.similarity,
      rerankScore: chunk.rerankScore,
      documentId: chunk.documentId,
      metadata: chunk.metadata,
    });
  }

  if (!answer.trim()) return null;

  return {
    answer: answer.trim(),
    citations,
    chunks: reranked.map((chunk) => ({
      text: chunk.text,
      similarity: chunk.similarity,
      rerankScore: chunk.rerankScore,
      documentId: chunk.documentId,
      metadata: chunk.metadata,
    })),
  };
  } catch (err) {
    log.error('retrieveContext failed:', err.message);
    return null;
  }
}
