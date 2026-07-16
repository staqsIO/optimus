/**
 * Flow-tool: html_to_text
 *
 * Strip HTML tags and decode entities, producing readable plain text.
 * Zero dependencies — regex-based. Good enough for email bodies and basic
 * scraped content; not a full-fidelity HTML parser.
 *
 * Behavior:
 *   - <script> and <style> blocks (with contents) removed entirely
 *   - <br>, <p>, <div>, <li>, <h1>-<h6>, <tr> -> newline boundaries
 *   - Remaining tags stripped, attributes discarded
 *   - Common HTML entities decoded (&amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN;)
 *   - Consecutive whitespace collapsed; leading/trailing trimmed
 *   - Optional maxLength truncates with a trailing ellipsis
 */

const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|aside|blockquote)\b[^>]*>/gi;
const SCRIPT_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const ANY_TAG = /<\/?[a-z][\s\S]*?>/gi;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (match, name) => {
      const lowered = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lowered)
        ? NAMED_ENTITIES[lowered]
        : match;
    });
}

function htmlToText({ html, maxLength }) {
  if (html === '' || html === null || html === undefined) {
    return { text: '' };
  }

  let s = String(html);
  s = s.replace(COMMENT, '');
  s = s.replace(SCRIPT_STYLE, '');
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(ANY_TAG, '');
  s = decodeEntities(s);

  // Collapse whitespace but preserve single newlines between blocks.
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  if (typeof maxLength === 'number' && maxLength > 0 && s.length > maxLength) {
    s = s.slice(0, maxLength).trimEnd() + '…';
  }

  return { text: s };
}

export default {
  id: 'html_to_text',
  description: 'Strip HTML tags and decode entities, returning readable plain text.',
  inputSchema: {
    html: { type: 'string', required: true },
    maxLength: { type: 'number', default: 0 },  // 0 = no truncation
  },
  outputSchema: {
    text: 'string',
  },
  handler: htmlToText,
};
