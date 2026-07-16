/**
 * Normalizer registry.
 * Ported from brain-rag src/lib/normalizers/index.ts
 *
 * Routes raw text through the appropriate normalizer based on format.
 */

import { normalizeTldv } from './tldv.js';
import { normalizeGemini } from './gemini.js';
import { normalizePlain } from './plain.js';
import { normalizeObsidian } from './obsidian.js';
import { normalizeWiki } from './wiki.js';

const normalizers = {
  tldv: normalizeTldv,
  gemini: normalizeGemini,
  plain: normalizePlain,
  obsidian: normalizeObsidian,
  markdown: normalizeObsidian, // Obsidian normalizer handles standard markdown too
  wiki: normalizeWiki,         // Wiki-compiled articles (preserves wikilink metadata)
};

/**
 * Normalize raw text into segments for chunking.
 *
 * @param {string} input - Raw document text
 * @param {'tldv'|'plain'} [format='plain'] - Document format
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalize(input, format = 'plain') {
  const fn = normalizers[format] ?? normalizers.plain;
  return fn(input, format);
}

export { normalizeTldv, normalizeGemini, normalizePlain, normalizeObsidian, normalizeWiki };
