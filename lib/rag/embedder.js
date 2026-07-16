/**
 * Model-agnostic embedding provider.
 *
 * Abstracts the embedding API so we can swap models without changing consumers.
 * Currently supports OpenAI (text-embedding-3-small, 1536 dims).
 * Carlos's requirement: must be model-agnostic for future-proofing.
 *
 * Provider is selected via EMBEDDING_PROVIDER env var (default: 'openai').
 * Each provider implements: embedOne(text) → number[], embedMany(texts) → number[][]
 *
 * Env vars:
 *   EMBEDDING_PROVIDER    — 'openai' (default). Future: 'voyage', 'cohere', etc.
 *   OPENAI_API_KEY        — Required for OpenAI provider
 *   EMBEDDING_MODEL       — Override model name (default per provider)
 *   EMBEDDING_DIMENSIONS  — Override dimensions (default per provider)
 *   EMBEDDING_BATCH_SIZE  — Max texts per API call (default: 20)
 */

import { createLogger } from '../logger.js';
const log = createLogger('rag/embedder');
const PROVIDER = process.env.EMBEDDING_PROVIDER || 'openai';
const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '20', 10);
const BATCH_DELAY_MS = 100; // Rate limit courtesy

// Provider registry — add new providers here
const providers = {
  openai: {
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
    url: 'https://api.openai.com/v1/embeddings',
    keyEnv: 'OPENAI_API_KEY',

    async embed(texts, apiKey, model) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI embedding API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      return json.data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map(d => d.embedding);
    },
  },

  // Future providers go here:
  // voyage: { model: 'voyage-3-large', dimensions: 1024, ... },
  // cohere: { model: 'embed-english-v3.0', dimensions: 1024, ... },
};

function getProvider() {
  const provider = providers[PROVIDER];
  if (!provider) {
    throw new Error(`Unknown embedding provider: ${PROVIDER}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

function getApiKey(provider) {
  const key = process.env[provider.keyEnv];
  if (!key) return null;
  return key;
}

/**
 * Get current embedding model info.
 * @returns {{ provider: string, model: string, dimensions: number } | null}
 */
export function getEmbeddingInfo() {
  const provider = providers[PROVIDER];
  if (!provider) return null;
  const apiKey = getApiKey(provider);
  if (!apiKey) return null;
  return {
    provider: PROVIDER,
    model: provider.model,
    dimensions: provider.dimensions,
  };
}

/**
 * Embed a single text.
 * @param {string} text
 * @returns {Promise<number[] | null>} Embedding vector, or null if unavailable
 */
export async function embedOne(text) {
  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    log.info(`Skipped: ${provider.keyEnv} not set`);
    return null;
  }

  try {
    const results = await provider.embed([text], apiKey, provider.model);
    return results[0] || null;
  } catch (err) {
    log.error(`Error: ${err.message}`);
    return null;
  }
}

/**
 * Embed multiple texts in batches.
 * @param {string[]} texts
 * @returns {Promise<(number[] | null)[]>} Array of embeddings (null for failed items)
 */
export async function embedMany(texts) {
  if (texts.length === 0) return [];

  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    log.info(`Skipped: ${provider.keyEnv} not set`);
    return texts.map(() => null);
  }

  const results = new Array(texts.length).fill(null);

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const embeddings = await provider.embed(batch, apiKey, provider.model);
      for (let j = 0; j < embeddings.length; j++) {
        results[i + j] = embeddings[j];
      }
    } catch (err) {
      log.error(`Batch ${i}-${i + batch.length} failed: ${err.message}`);
      // Individual items in failed batch remain null — document still stored, just not searchable
    }

    // Rate limit courtesy between batches
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return results;
}
