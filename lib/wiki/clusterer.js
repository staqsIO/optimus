/**
 * Topic clustering for wiki compilation.
 *
 * Groups related vault documents by cosine similarity on their existing
 * chunk embeddings. Each cluster becomes one compiled wiki article.
 *
 * Algorithm: greedy single-linkage — pick the unassigned doc with the most
 * neighbors above threshold, pull them into a cluster, repeat. Simple,
 * deterministic, no external deps (P4).
 */

import { query } from '../db.js';
import { createLogger } from '../logger.js';
const log = createLogger('wiki/clusterer');

const DEFAULT_SIMILARITY_THRESHOLD = 0.35; // Minimum cosine similarity to cluster together
const MAX_CLUSTER_SIZE = 8;                // Cap to keep compiled articles focused
const MIN_CLUSTER_SIZE = 1;                // Single docs get their own article

/**
 * Fetch pending vault documents with their average chunk embeddings.
 * Uses the centroid of all chunks as the document-level embedding.
 *
 * @param {string} [projectId] - Optional project ID filter (via project_memberships)
 * @returns {Promise<Array<{ id: string, title: string, source_id: string, classification: string, embedding: number[] }>>}
 */
async function fetchPendingDocuments(projectId) {
  let sql = `
    SELECT d.id, d.title, d.source_id, d.classification,
           (SELECT avg(c.embedding) FROM content.chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL) AS centroid
    FROM content.documents d
    WHERE d.compile_status = 'pending'
      AND d.source != 'wiki-compiled'
  `;
  const params = [];

  if (projectId) {
    params.push(projectId);
    sql += ` AND d.id::text IN (
      SELECT pm.entity_id
      FROM agent_graph.project_memberships pm
      WHERE pm.project_id = $1 AND pm.entity_type = 'document'
    )`;
  } else {
    // Global compile should only process truly org-wide docs.
    // Exclude any document already scoped to a project via memberships.
    sql += ` AND NOT EXISTS (
      SELECT 1
      FROM agent_graph.project_memberships pm
      WHERE pm.entity_type = 'document'
        AND pm.entity_id = d.id::text
    )`;
  }

  sql += ` ORDER BY d.created_at DESC`;

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Compute cosine similarity between two vectors.
 * Vectors stored as Postgres avg(vector) come back as strings — parse if needed.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Parse a Postgres vector string into a number array.
 * Handles both "[1,2,3]" and raw array formats.
 */
function parseVector(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v.replace(/[\[\]]/g, '').split(',').map(Number);
  }
  return null;
}

/**
 * Cluster pending documents by embedding similarity.
 *
 * @param {Object} [opts]
 * @param {string} [opts.projectId] - Scope to a project
 * @param {number} [opts.threshold] - Similarity threshold (default 0.35)
 * @param {number} [opts.maxClusterSize] - Max docs per cluster (default 8)
 * @returns {Promise<Array<{ docs: Array<{ id: string, title: string, classification: string }>, topTitle: string }>>}
 */
export async function clusterDocuments(opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxSize = opts.maxClusterSize ?? MAX_CLUSTER_SIZE;

  const docs = await fetchPendingDocuments(opts.projectId);
  if (docs.length === 0) return [];

  // Parse embeddings (docs without vectors are still eligible as singleton clusters)
  const parsed = docs.map(d => ({
    ...d,
    vec: parseVector(d.centroid),
  }));
  const withVec = parsed.filter(d => d.vec !== null);
  const withoutVec = parsed.filter(d => d.vec === null);

  // Build similarity matrix (upper triangular)
  const neighbors = new Map(); // docId → Set of similar docIds
  for (let i = 0; i < withVec.length; i++) {
    for (let j = i + 1; j < withVec.length; j++) {
      const sim = cosineSimilarity(withVec[i].vec, withVec[j].vec);
      if (sim >= threshold) {
        if (!neighbors.has(withVec[i].id)) neighbors.set(withVec[i].id, new Set());
        if (!neighbors.has(withVec[j].id)) neighbors.set(withVec[j].id, new Set());
        neighbors.get(withVec[i].id).add(withVec[j].id);
        neighbors.get(withVec[j].id).add(withVec[i].id);
      }
    }
  }

  // Greedy clustering: pick doc with most neighbors, pull cluster, repeat
  const assigned = new Set();
  const clusters = [];
  const docMap = new Map(withVec.map(d => [d.id, d]));

  // Sort by neighbor count descending (most connected first)
  const sorted = [...withVec].sort((a, b) => {
    const na = neighbors.get(a.id)?.size || 0;
    const nb = neighbors.get(b.id)?.size || 0;
    return nb - na;
  });

  for (const doc of sorted) {
    if (assigned.has(doc.id)) continue;

    const cluster = [doc];
    assigned.add(doc.id);

    // Pull in unassigned neighbors up to maxSize
    const docNeighbors = neighbors.get(doc.id) || new Set();
    for (const nId of docNeighbors) {
      if (assigned.has(nId) || cluster.length >= maxSize) break;
      const neighbor = docMap.get(nId);
      if (neighbor) {
        cluster.push(neighbor);
        assigned.add(nId);
      }
    }

    clusters.push({
      docs: cluster.map(d => ({
        id: d.id,
        title: d.title,
        classification: d.classification,
        sourceId: d.source_id,
      })),
      // Use the most descriptive title as the cluster label
      topTitle: cluster.reduce((best, d) =>
        d.title.length > best.length ? d.title : best, cluster[0].title),
    });
  }

  // Add any remaining unassigned docs as single-doc clusters
  for (const doc of withVec) {
    if (!assigned.has(doc.id)) {
      clusters.push({
        docs: [{ id: doc.id, title: doc.title, classification: doc.classification, sourceId: doc.source_id }],
        topTitle: doc.title,
      });
    }
  }

  // Docs without embeddings: compile as singleton clusters
  for (const doc of withoutVec) {
    clusters.push({
      docs: [{ id: doc.id, title: doc.title, classification: doc.classification, sourceId: doc.source_id }],
      topTitle: doc.title,
    });
  }

  log.info(`${docs.length} docs (${withVec.length} embedded, ${withoutVec.length} unembedded) → ${clusters.length} clusters (threshold=${threshold})`);
  return clusters;
}
