import { query } from '../db.js';

/**
 * Embedding generation for voice similarity search (spec §4, D3).
 * Supports Voyage AI (voyage-3.5-lite) and OpenAI (text-embedding-3-small).
 * Both produce 1024-dim vectors for pgvector storage.
 * Embeddings enable vector similarity few-shot selection in executor-responder.
 */

const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 20;

/**
 * Auto-detect embedding provider and generate embeddings.
 * Prefers Voyage AI (Anthropic's recommended partner) over OpenAI.
 * @param {string[]} texts - Texts to embed
 * @param {string} [inputType] - 'document' for storage, 'query' for search
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function getEmbeddings(texts, inputType = 'document') {
  if (process.env.VOYAGE_API_KEY) {
    return getVoyageEmbeddings(texts, inputType);
  }
  if (process.env.OPENAI_API_KEY) {
    return getOpenAIEmbeddings(texts);
  }
  throw new Error('No embedding API key configured (set VOYAGE_API_KEY or OPENAI_API_KEY)');
}

/**
 * Voyage AI embeddings (voyage-3.5-lite, 1024 dimensions).
 */
async function getVoyageEmbeddings(texts, inputType = 'document') {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3.5-lite',
      input: texts.map(t => t.slice(0, 8000)),
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

/**
 * OpenAI embeddings (text-embedding-3-small, 1024 dimensions).
 */
async function getOpenAIEmbeddings(texts) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts.map(t => t.slice(0, 8000)),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

/**
 * Check if any embedding provider is configured.
 * @returns {boolean}
 */
export function hasEmbeddingProvider() {
  return !!(process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY);
}

/**
 * Generate embeddings for sent emails that don't have them yet.
 * @param {number} batchSize - Emails to process per batch
 * @returns {Promise<number>} Number of emails processed
 */
export async function generateEmbeddings(batchSize = 50) {
  const result = await query(
    `SELECT id, body, subject, to_address FROM voice.sent_emails WHERE embedding IS NULL LIMIT $1`,
    [batchSize]
  );

  if (result.rows.length === 0) {
    console.log('[embeddings] All sent emails have embeddings');
    return 0;
  }

  console.log(`[embeddings] Generating embeddings for ${result.rows.length} emails...`);

  let processed = 0;
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map(row => {
      // Combine subject + body for richer embedding
      const parts = [];
      if (row.subject) parts.push(`Subject: ${row.subject}`);
      if (row.to_address) parts.push(`To: ${row.to_address}`);
      parts.push(row.body);
      return parts.join('\n');
    });

    try {
      const embeddings = await getEmbeddings(texts, 'document');

      for (let j = 0; j < batch.length; j++) {
        await query(
          `UPDATE voice.sent_emails SET embedding = $1 WHERE id = $2`,
          [`[${embeddings[j].join(',')}]`, batch[j].id]
        );
        processed++;
      }
    } catch (err) {
      console.error(`[embeddings] Batch ${i} failed:`, err.message);
    }
  }

  console.log(`[embeddings] Processed ${processed} emails`);
  return processed;
}

/**
 * Generate a single embedding for a query text.
 * @param {string} text - Query text
 * @returns {Promise<number[]>} Embedding vector
 */
export async function embedText(text) {
  const [embedding] = await getEmbeddings([text], 'query');
  return embedding;
}

/**
 * Generate embeddings for email-draft action_proposals that don't have them yet.
 *
 * STAQPRO-301: backfills agent_graph.action_proposals.embedding so the
 * v_phase1_metrics M3 voice-similarity metric (migration 104) has draft-side
 * vectors to cosine-compare against voice.sent_emails.embedding. Same Voyage
 * model + 1024-dim space as the sent-email side so the cosine math is valid.
 *
 * Mirrors generateEmbeddings() above. Scoped to action_type='email_draft'
 * (content drafts and other proposal types don't feed M3). Newest-first so
 * the metric reflects recent activity first under a partial backlog.
 *
 * Errors per-batch are logged and skipped — a Voyage rate-limit during one
 * sweep leaves the affected rows NULL for the next tick to retry. The
 * idx_action_proposals_embed_pending partial index keeps the queue scan cheap.
 *
 * @param {number} batchSize - Drafts to claim per sweep (default 50)
 * @returns {Promise<number>} Number of drafts embedded
 */
export async function generateDraftEmbeddings(batchSize = 50) {
  const result = await query(
    `SELECT id, body, subject, to_addresses
       FROM agent_graph.action_proposals
      WHERE action_type = 'email_draft' AND embedding IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [batchSize]
  );

  if (result.rows.length === 0) {
    return 0;
  }

  console.log(`[embeddings] Generating embeddings for ${result.rows.length} drafts...`);

  let processed = 0;
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map(row => {
      const parts = [];
      if (row.subject) parts.push(`Subject: ${row.subject}`);
      if (Array.isArray(row.to_addresses) && row.to_addresses.length) {
        parts.push(`To: ${row.to_addresses.join(', ')}`);
      }
      parts.push(row.body);
      return parts.join('\n');
    });

    try {
      const embeddings = await getEmbeddings(texts, 'document');

      for (let j = 0; j < batch.length; j++) {
        await query(
          `UPDATE agent_graph.action_proposals SET embedding = $1 WHERE id = $2`,
          [`[${embeddings[j].join(',')}]`, batch[j].id]
        );
        processed++;
      }
    } catch (err) {
      console.error(`[embeddings] Draft batch ${i} failed:`, err.message);
    }
  }

  console.log(`[embeddings] Processed ${processed} drafts`);
  return processed;
}

/**
 * Find similar sent emails using pgvector cosine distance.
 * @param {string} text - Query text
 * @param {number} limit - Max results
 * @param {string} [recipientEmail] - Optional filter by recipient
 * @returns {Promise<Array>} Similar sent emails with distance scores
 */
export async function findSimilar(text, limit = 5, recipientEmail = null) {
  // Check if we have any embeddings
  const countResult = await query(
    `SELECT COUNT(*) as cnt FROM voice.sent_emails WHERE embedding IS NOT NULL`
  );
  if (parseInt(countResult.rows[0]?.cnt || '0', 10) === 0) {
    return []; // No embeddings yet — fall back to non-vector selection
  }

  try {
    const queryEmbedding = await embedText(text);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const sql = recipientEmail
      ? `SELECT id, provider_msg_id, to_address, subject, body, word_count, sent_at,
                embedding <=> $1::vector AS distance
         FROM voice.sent_emails
         WHERE embedding IS NOT NULL AND to_address = $3
         ORDER BY embedding <=> $1::vector
         LIMIT $2`
      : `SELECT id, provider_msg_id, to_address, subject, body, word_count, sent_at,
                embedding <=> $1::vector AS distance
         FROM voice.sent_emails
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`;

    const params = recipientEmail
      ? [embeddingStr, limit, recipientEmail]
      : [embeddingStr, limit];

    const result = await query(sql, params);
    return result.rows;
  } catch (err) {
    console.warn('[embeddings] Vector search failed, falling back:', err.message);
    return [];
  }
}
