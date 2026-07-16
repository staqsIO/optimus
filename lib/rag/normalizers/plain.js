/**
 * Plain text normalizer.
 * Ported from brain-rag src/lib/normalizers/plain.ts
 *
 * Splits text by double newlines (paragraphs).
 * Strips markdown-style timestamp URLs.
 */

const TIMESTAMP_URL_REGEX = /\[([^\]]*)\]\([^)]*\)/g;

function stripTimestampUrls(text) {
  return text.replace(TIMESTAMP_URL_REGEX, '$1').trim();
}

/**
 * @param {string} input - Raw plain text
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalizePlain(input) {
  const cleaned = stripTimestampUrls(input.replace(/\r/g, ''));
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);

  return paragraphs.map(content => ({ content }));
}
