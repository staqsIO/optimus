/**
 * buildSessionDigest — turn a Claude Code transcript JSONL into a clean,
 * readable markdown digest suitable for ingestion into Optimus.
 *
 * Pure + side-effect-free so it is trivially unit-testable. The HTTP layer
 * (index.js capture-session) reads stdin + the transcript file and calls this.
 *
 * Claude Code transcript format (defensive — the shape is not contractually
 * stable across CC versions): a JSONL file, one JSON object per line. Each line
 * is an event. We only care about conversational turns. Across observed
 * versions a turn looks roughly like:
 *
 *   { "type": "user",      "message": { "role": "user",      "content": ... } }
 *   { "type": "assistant", "message": { "role": "assistant", "content": ... } }
 *
 * `content` is either a plain string, or an array of blocks like
 *   { "type": "text", "text": "..." }
 *   { "type": "tool_use", ... }            <- DROP (tool-call noise)
 *   { "type": "tool_result", ... }         <- DROP (tool-result noise)
 *
 * We extract ONLY user + assistant text, drop everything else, and cap the
 * output well under the 1 MB ingest limit. The parser tolerates malformed
 * lines, missing fields, and alternate shapes (top-level `role`/`content`).
 */

// ~900 KB — comfortably under the 1 MB ingest limit, leaving headroom for the
// title/envelope and multi-byte UTF-8 characters.
export const DIGEST_CAP_BYTES = 900 * 1024;

const TRUNCATION_MARKER = '\n\n…[truncated]';

/**
 * Pull readable text out of a message `content` field.
 * @param {*} content string | array of blocks | anything
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    // Only plain text blocks. tool_use / tool_result / thinking / image -> drop.
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** Drop Claude Code system-reminder noise that rides inside user turns. */
function stripSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Build a cleaned markdown digest from raw transcript JSONL.
 * @param {string} transcriptJsonl Raw file contents (JSONL).
 * @param {object} [opts]
 * @param {number} [opts.capBytes] Override the byte cap (default DIGEST_CAP_BYTES).
 * @returns {string} Markdown digest. Empty string if nothing usable.
 */
export function buildSessionDigest(transcriptJsonl, opts = {}) {
  const capBytes = opts.capBytes ?? DIGEST_CAP_BYTES;
  if (typeof transcriptJsonl !== 'string' || transcriptJsonl.trim() === '') {
    return '';
  }

  const sections = [];
  const lines = transcriptJsonl.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip defensively
    }
    if (!event || typeof event !== 'object') continue;

    // Resolve role + content across observed shapes.
    const msg = event.message && typeof event.message === 'object' ? event.message : event;
    const role = msg.role || event.role || event.type;
    if (role !== 'user' && role !== 'assistant') continue;

    let text = extractText(msg.content);
    if (role === 'user') text = stripSystemReminders(text);
    if (!text) continue;

    const label = role === 'user' ? '## User' : '## Assistant';
    sections.push(`${label}\n\n${text}`);
  }

  if (sections.length === 0) return '';

  const body = sections.join('\n\n');

  // Cap by bytes (UTF-8), not characters, since the ingest limit is bytes.
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(body);
  if (bodyBytes.length <= capBytes) return body;

  const markerBytes = encoder.encode(TRUNCATION_MARKER).length;
  const budget = Math.max(0, capBytes - markerBytes);

  // Slice the byte buffer to budget, then decode tolerating a split multi-byte
  // char at the boundary (TextDecoder drops the partial char by default).
  const sliced = bodyBytes.subarray(0, budget);
  const decoded = new TextDecoder('utf-8').decode(sliced);
  return decoded + TRUNCATION_MARKER;
}
