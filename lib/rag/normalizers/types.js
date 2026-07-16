/**
 * Normalized segment — the universal unit between normalizers and chunker.
 * Ported from brain-rag src/lib/normalizers/types.ts
 *
 * @typedef {Object} NormalizedSegment
 * @property {string} content - Text content of the segment
 * @property {Object} [metadata] - Optional metadata
 * @property {string} [metadata.speaker] - Speaker name (transcripts)
 * @property {string} [metadata.timestamp] - Timestamp string (transcripts)
 */

/**
 * @typedef {function(string, string=): NormalizedSegment[]} Normalizer
 */

export {};
