/**
 * Cross-encoder reranker for RAG retrieval.
 *
 * Takes top-N chunks from cosine similarity search and re-scores them
 * using a cross-encoder model for dramatically better precision.
 *
 * Provider priority: Voyage (best quality) > Cohere > Jina > fallback.
 *
 * Cosine similarity is a coarse filter (embedding space neighborhoods).
 * Cross-encoder reranking uses full query-document attention to find
 * the actually relevant chunks. Typically improves p@5 from ~0.45 to ~0.75.
 *
 * Rate limit handling: 429s trigger exponential backoff retry (up to 3 attempts).
 * Short-TTL cache deduplicates identical queries within 60s window.
 *
 * Falls back gracefully if no rerank API key is configured.
 */

import { createLogger } from '../logger.js';
import { createHash } from 'crypto';

const log = createLogger('rag/reranker');
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const JINA_API_KEY = process.env.JINA_API_KEY;

// ── Cache ────────────────────────────────────────────────────────────
// 60s TTL cache keyed on query + chunk IDs. Prevents burning RPM on
// identical retrievals within the same pipeline run.
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function cacheKey(query, chunks) {
  const h = createHash('md5');
  h.update(query);
  // Use first 50 chars of each chunk as fingerprint (fast, collision-resistant enough)
  for (const c of chunks) h.update(c.text.slice(0, 50));
  return h.digest('hex');
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key, result) {
  cache.set(key, { result, ts: Date.now() });
  // Evict old entries if cache grows beyond 100
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

// ── Retry helper ─────────────────────────────────────────────────────
async function fetchWithRetry(url, opts, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429 && attempt < maxRetries - 1) {
      // Exponential backoff with jitter: 2s, 5s, 12s
      const baseDelay = 2000 * Math.pow(2.5, attempt);
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay + jitter, 20000);
      log.warn(`429 rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  // Should not reach here, but return a failed response shape
  return { ok: false, status: 429, json: async () => ({}) };
}

/**
 * Rerank chunks using the best available provider.
 *
 * @param {string} query - The user's question
 * @param {Array<{ text: string, similarity: number, metadata: Object, documentId: string }>} chunks
 * @param {number} [topK=5] - Number of top results to return after reranking
 * @returns {Promise<Array>} Reranked chunks (best first)
 */
export async function rerank(query, chunks, topK = 5) {
  if (!chunks || chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  // Check cache first
  const key = cacheKey(query, chunks);
  const cached = getCached(key);
  if (cached) {
    log.info(`Reranker cache hit (${chunks.length} chunks)`);
    return cached;
  }

  let result;
  if (VOYAGE_API_KEY) {
    log.info(`Reranking ${chunks.length} chunks via Voyage`);
    result = await rerankVoyage(query, chunks, topK);
  } else if (COHERE_API_KEY) {
    log.info(`Reranking ${chunks.length} chunks via Cohere`);
    result = await rerankCohere(query, chunks, topK);
  } else if (JINA_API_KEY) {
    log.info(`Reranking ${chunks.length} chunks via Jina`);
    result = await rerankJina(query, chunks, topK);
  } else {
    log.warn('No rerank API key configured (need VOYAGE_API_KEY, COHERE_API_KEY, or JINA_API_KEY)');
    result = chunks.slice(0, topK);
  }

  setCache(key, result);
  return result;
}

async function rerankVoyage(query, chunks, topK) {
  try {
    const res = await fetchWithRetry('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'rerank-2',
        query,
        documents: chunks.map(c => c.text),
        top_k: topK,
      }),
      signal: AbortSignal.timeout(30000), // Allow time for retries
    });

    if (!res.ok) {
      log.warn(`Voyage API error: ${res.status} (after retries)`);
      // Fall through to other providers
      if (COHERE_API_KEY) return rerankCohere(query, chunks, topK);
      if (JINA_API_KEY) return rerankJina(query, chunks, topK);
      return chunks.slice(0, topK);
    }

    const data = await res.json();
    return data.data.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  } catch (err) {
    log.warn(`Voyage failed: ${err.message}, falling back`);
    if (COHERE_API_KEY) return rerankCohere(query, chunks, topK);
    if (JINA_API_KEY) return rerankJina(query, chunks, topK);
    return chunks.slice(0, topK);
  }
}

async function rerankCohere(query, chunks, topK) {
  try {
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'rerank-v3.5',
        query,
        documents: chunks.map(c => c.text),
        top_n: topK,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log.warn(`Cohere API error: ${res.status}`);
      return chunks.slice(0, topK);
    }

    const data = await res.json();
    return data.results.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  } catch (err) {
    log.warn(`Cohere failed: ${err.message}, falling back`);
    return chunks.slice(0, topK);
  }
}

async function rerankJina(query, chunks, topK) {
  try {
    const res = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${JINA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jina-reranker-v2-base-multilingual',
        query,
        documents: chunks.map(c => ({ text: c.text })),
        top_n: topK,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log.warn(`Jina API error: ${res.status}`);
      return chunks.slice(0, topK);
    }

    const data = await res.json();
    return data.results.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  } catch (err) {
    log.warn(`Jina failed: ${err.message}, falling back`);
    return chunks.slice(0, topK);
  }
}
