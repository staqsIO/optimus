import { createHash } from 'crypto';
import { query } from '../../db.js';

/**
 * Merkle Proof Publisher -- Phase 4 transparency artifact (spec S14).
 *
 * Computes SHA-256 Merkle roots from hash-chained ledgers and publishes
 * proof artifacts for independent verification.
 *
 * Covers four ledger types:
 *   - agent_graph.state_transitions   (hash_chain_current is BYTEA)
 *   - autobot_finance.ledger          (hash_chain_current is TEXT)
 *   - autobot_distrib.distribution_ledger (hash_chain_current is TEXT)
 *   - agent_graph.audit_findings      (no hash chain; hashed from id + description + evidence)
 *
 * P2: Infrastructure enforces; prompts advise.
 * P3: Transparency by structure.
 * P4: Boring infrastructure.
 */

/**
 * Table configuration for each proof type.
 * Maps proof_type to the SQL needed to extract ordered hashes.
 */
const LEDGER_CONFIG = {
  state_transitions: {
    table: 'agent_graph.state_transitions',
    // #494: order the anchor window by chain_seq, NOT created_at. chain_seq is a
    // strictly-monotonic sequence (migration 091) matching the writer (reads
    // prev_hash by chain_seq DESC) and the now-aligned Tier-1 auditor (#491,
    // lib/audit/tier1-deterministic.js). Under sub-second retry storms created_at
    // is non-monotonic, so ordering by it made anchor composition non-
    // deterministic. created_at is a stable secondary key only for historical
    // rows the mig-091 backfill left with NULL chain_seq (sorted last).
    hashQuery: `SELECT encode(hash_chain_current, 'hex') AS hash_value
                FROM agent_graph.state_transitions
                WHERE created_at >= $1 AND created_at < $2
                  AND hash_chain_current IS NOT NULL
                ORDER BY chain_seq ASC, created_at ASC`,
    countQuery: `SELECT COUNT(*) AS cnt
                 FROM agent_graph.state_transitions
                 WHERE created_at >= $1 AND created_at < $2`,
  },
  financial_ledger: {
    table: 'autobot_finance.ledger',
    hashQuery: `SELECT hash_chain_current AS hash_value
                FROM autobot_finance.ledger
                WHERE recorded_at >= $1 AND recorded_at < $2
                  AND hash_chain_current IS NOT NULL
                ORDER BY recorded_at ASC`,
    countQuery: `SELECT COUNT(*) AS cnt
                 FROM autobot_finance.ledger
                 WHERE recorded_at >= $1 AND recorded_at < $2`,
  },
  distribution_ledger: {
    table: 'autobot_distrib.distribution_ledger',
    hashQuery: `SELECT hash_chain_current AS hash_value
                FROM autobot_distrib.distribution_ledger
                WHERE recorded_at >= $1 AND recorded_at < $2
                  AND hash_chain_current IS NOT NULL
                ORDER BY recorded_at ASC`,
    countQuery: `SELECT COUNT(*) AS cnt
                 FROM autobot_distrib.distribution_ledger
                 WHERE recorded_at >= $1 AND recorded_at < $2`,
  },
  audit_findings: {
    table: 'agent_graph.audit_findings',
    // audit_findings has no hash chain; compute hash from content
    hashQuery: null,
    countQuery: `SELECT COUNT(*) AS cnt
                 FROM agent_graph.audit_findings
                 WHERE created_at >= $1 AND created_at < $2`,
  },
};

/**
 * Compute SHA-256 hash.
 *
 * @param {string} data
 * @returns {string} Hex-encoded SHA-256.
 */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build a Merkle tree root from an array of leaf hashes.
 * If the array is empty, returns SHA-256 of 'EMPTY'.
 *
 * @param {string[]} leaves - Array of hex-encoded hashes.
 * @returns {string} Hex-encoded Merkle root.
 */
function buildMerkleRoot(leaves) {
  if (leaves.length === 0) return sha256('EMPTY');
  if (leaves.length === 1) return leaves[0];

  // Build tree bottom-up
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(level[i] + level[i + 1]));
      } else {
        // Odd number of nodes: promote the last one
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

/**
 * Compute the Merkle root for a given table and date range.
 *
 * For tables with hash_chain_current, uses those hashes as leaves.
 * For audit_findings (no hash chain), computes leaf hashes from row content.
 *
 * @param {string} proofType - One of: state_transitions, financial_ledger, distribution_ledger, audit_findings.
 * @param {string|Date} fromDate - Start of the period (inclusive).
 * @param {string|Date} toDate - End of the period (exclusive).
 * @returns {Promise<{rootHash: string, rowCount: number}|null>} Root hash and row count, or null if table not available.
 */
export async function computeMerkleRoot(proofType, fromDate, toDate) {
  const config = LEDGER_CONFIG[proofType];
  if (!config) {
    return null;
  }

  const from = new Date(fromDate).toISOString();
  const to = new Date(toDate).toISOString();

  try {
    // Get row count
    const countResult = await query(config.countQuery, [from, to]);
    const rowCount = parseInt(countResult.rows[0]?.cnt || '0', 10);

    let leaves;

    if (config.hashQuery) {
      // Tables with hash chain: use existing hashes as leaves
      const hashResult = await query(config.hashQuery, [from, to]);
      leaves = hashResult.rows
        .map(r => r.hash_value)
        .filter(h => h != null);
    } else {
      // audit_findings: compute hashes from row content
      const findingsResult = await query(
        `SELECT id, finding_type, severity, description, evidence, created_at
         FROM agent_graph.audit_findings
         WHERE created_at >= $1 AND created_at < $2
         ORDER BY created_at ASC`,
        [from, to]
      );
      leaves = findingsResult.rows.map(r =>
        sha256([r.id, r.finding_type, r.severity, r.description, JSON.stringify(r.evidence || {}), r.created_at].join('|'))
      );
    }

    const rootHash = buildMerkleRoot(leaves);

    return { rootHash, rowCount };
  } catch (err) {
    if (err.message?.includes('does not exist')) return null;
    throw err;
  }
}

/**
 * Publish a Merkle proof for a given proof type and date range.
 * Stores the proof artifact in agent_graph.merkle_proofs.
 *
 * @param {string} proofType - One of: state_transitions, financial_ledger, distribution_ledger, audit_findings.
 * @param {string|Date} fromDate - Start of the period (inclusive).
 * @param {string|Date} toDate - End of the period (exclusive).
 * @returns {Promise<{published: boolean, proofId: string|null, rootHash: string|null, rowCount: number|null, reason: string|null}>}
 */
export async function publishMerkleProof(proofType, fromDate, toDate) {
  const computed = await computeMerkleRoot(proofType, fromDate, toDate);

  if (!computed) {
    return { published: false, proofId: null, rootHash: null, rowCount: null, reason: `Table not available for ${proofType}` };
  }

  const { rootHash, rowCount } = computed;
  const from = new Date(fromDate).toISOString();
  const to = new Date(toDate).toISOString();

  try {
    const result = await query(
      `INSERT INTO agent_graph.merkle_proofs
       (proof_type, root_hash, row_count, covers_from, covers_to, proof_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, published_at`,
      [
        proofType,
        rootHash,
        rowCount,
        from,
        to,
        JSON.stringify({ computed_at: new Date().toISOString(), algorithm: 'sha256-merkle' }),
      ]
    );

    const row = result.rows[0];
    return {
      published: true,
      proofId: row.id,
      rootHash,
      rowCount,
      publishedAt: row.published_at,
      reason: null,
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { published: false, proofId: null, rootHash, rowCount, reason: 'merkle_proofs table not ready' };
    }
    throw err;
  }
}

/**
 * Publish Merkle proofs for all 4 ledger types since the last publication.
 * Uses the most recent proof's covers_to as the start for the next proof.
 * If no prior proof exists, defaults to 30 days ago.
 *
 * @returns {Promise<{results: Object[]}>}
 */
export async function publishAllProofs() {
  const proofTypes = Object.keys(LEDGER_CONFIG);
  const now = new Date();
  const results = [];

  for (const proofType of proofTypes) {
    // Find the last publication's end date for this proof type
    let fromDate;
    try {
      const lastProof = await query(
        `SELECT covers_to FROM agent_graph.merkle_proofs
         WHERE proof_type = $1
         ORDER BY published_at DESC
         LIMIT 1`,
        [proofType]
      );

      if (lastProof.rows.length > 0 && lastProof.rows[0].covers_to) {
        fromDate = new Date(lastProof.rows[0].covers_to);
      } else {
        // Default: 30 days ago
        fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
    } catch (err) {
      if (err.message?.includes('does not exist')) {
        fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      } else {
        throw err;
      }
    }

    const result = await publishMerkleProof(proofType, fromDate, now);
    results.push({ proofType, ...result });
  }

  return { results };
}

/**
 * Verify a previously published Merkle proof by recomputing the root.
 *
 * @param {string} proofId - The proof ID to verify.
 * @returns {Promise<{verified: boolean, match: boolean|null, storedHash: string|null, recomputedHash: string|null, reason: string|null}>}
 */
export async function verifyMerkleProof(proofId) {
  if (!proofId) {
    return { verified: false, match: null, storedHash: null, recomputedHash: null, reason: 'proofId is required' };
  }

  try {
    const proofResult = await query(
      `SELECT id, proof_type, root_hash, covers_from, covers_to
       FROM agent_graph.merkle_proofs
       WHERE id = $1`,
      [proofId]
    );

    if (proofResult.rows.length === 0) {
      return { verified: false, match: null, storedHash: null, recomputedHash: null, reason: `Proof ${proofId} not found` };
    }

    const proof = proofResult.rows[0];
    const recomputed = await computeMerkleRoot(proof.proof_type, proof.covers_from, proof.covers_to);

    if (!recomputed) {
      return { verified: false, match: null, storedHash: proof.root_hash, recomputedHash: null, reason: 'Could not recompute (table not available)' };
    }

    const match = proof.root_hash === recomputed.rootHash;

    return {
      verified: true,
      match,
      storedHash: proof.root_hash,
      recomputedHash: recomputed.rootHash,
      reason: match ? 'Proof verified: hashes match' : 'VERIFICATION FAILED: hashes do not match',
    };
  } catch (err) {
    if (err.message?.includes('does not exist')) {
      return { verified: false, match: null, storedHash: null, recomputedHash: null, reason: 'merkle_proofs table not ready' };
    }
    throw err;
  }
}

/**
 * Get the publication history for a given proof type.
 *
 * @param {string} proofType - One of: state_transitions, financial_ledger, distribution_ledger, audit_findings.
 * @returns {Promise<Object[]>} Array of proof records, newest first.
 */
export async function getMerkleProofHistory(proofType) {
  if (!proofType || !LEDGER_CONFIG[proofType]) {
    return [];
  }

  try {
    const result = await query(
      `SELECT id, proof_type, root_hash, row_count, covers_from, covers_to,
              published_at, verification_url, proof_data
       FROM agent_graph.merkle_proofs
       WHERE proof_type = $1
       ORDER BY published_at DESC
       LIMIT 100`,
      [proofType]
    );

    return result.rows.map(r => ({
      proofId: r.id,
      proofType: r.proof_type,
      rootHash: r.root_hash,
      rowCount: parseInt(r.row_count || '0', 10),
      coversFrom: r.covers_from,
      coversTo: r.covers_to,
      publishedAt: r.published_at,
      verificationUrl: r.verification_url,
      proofData: r.proof_data,
    }));
  } catch (err) {
    if (err.message?.includes('does not exist')) return [];
    throw err;
  }
}
