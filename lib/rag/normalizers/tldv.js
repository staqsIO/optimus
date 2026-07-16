/**
 * TLDv transcript normalizer.
 * Ported from brain-rag src/lib/normalizers/tldv.ts
 *
 * Parses tl;dv transcript format:
 *   [00:00](https://tldv.io/...) Speaker Name: content
 *
 * Extracts timestamp, speaker; content only for embedding.
 */

const TLDV_LINE_REGEX = /^\s*\[([^\]]+)\]\s*\([^)]+\)\s*([^:]+):\s*(.*)$/s;
const TIMESTAMP_URL_REGEX = /\[([^\]]*)\]\([^)]*\)/g;

function stripTimestampUrls(text) {
  return text.replace(TIMESTAMP_URL_REGEX, '$1').trim();
}

/**
 * @param {string} input - Raw tl;dv transcript text
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalizeTldv(input) {
  const segments = [];
  const lines = input.split(/\r?\n/);
  let buffer = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (buffer) {
        segments.push({ content: buffer.trim() });
        buffer = '';
      }
      continue;
    }

    const match = trimmed.match(TLDV_LINE_REGEX);
    if (match) {
      if (buffer) {
        segments.push({ content: buffer.trim() });
        buffer = '';
      }
      const [, timestamp, speaker, content] = match;
      segments.push({
        content: content.trim(),
        metadata: {
          speaker: speaker.trim(),
          timestamp: timestamp.trim(),
        },
      });
    } else {
      // Continuation of previous line or non-matching line
      if (segments.length > 0 && segments[segments.length - 1].content) {
        segments[segments.length - 1].content += ' ' + trimmed;
      } else {
        buffer += (buffer ? ' ' : '') + trimmed;
      }
    }
  }

  if (buffer) {
    segments.push({ content: stripTimestampUrls(buffer) });
  }

  return segments
    .map(s => ({ ...s, content: stripTimestampUrls(s.content) }))
    .filter(s => s.content.length > 0);
}
