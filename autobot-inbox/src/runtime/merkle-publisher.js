// Re-export shim — real implementation in lib/runtime/merkle-publisher.js
export {
  computeMerkleRoot, publishMerkleProof, publishAllProofs, verifyMerkleProof,
  getMerkleProofHistory
} from '../../../lib/runtime/merkle-publisher.js';
