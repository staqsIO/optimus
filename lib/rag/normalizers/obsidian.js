/**
 * Obsidian markdown normalizer.
 *
 * Handles Obsidian-specific syntax:
 * - YAML frontmatter → extracted as metadata
 * - [[wikilinks]] → converted to plain text
 * - [[wikilinks|display text]] → keeps display text
 * - ![[embeds]] → stripped (can't resolve)
 * - > [!callout] → preserved as text
 * - Heading-based segmentation for better chunking
 */

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;
const WIKILINK_WITH_ALIAS = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
const WIKILINK_SIMPLE = /\[\[([^\]]+)\]\]/g;
const EMBED_LINK = /!\[\[([^\]]+)\]\]/g;
const HEADING_REGEX = /^(#{1,3})\s+(.+)$/gm;

/**
 * Parse YAML frontmatter into a plain object.
 * Simple key: value parser — no external YAML dep (P4: boring infrastructure).
 */
function parseFrontmatter(yamlStr) {
  const meta = {};
  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^\s*(\w[\w-]*):\s*(.+)/);
    if (match) {
      const [, key, value] = match;
      // Handle simple arrays (- item)
      if (value.trim() === '') continue;
      meta[key] = value.replace(/^["']|["']$/g, '').trim();
    }
    // Handle YAML array items under a key
    const arrayMatch = line.match(/^\s*-\s+["']?(.+?)["']?\s*$/);
    if (arrayMatch) {
      const lastKey = Object.keys(meta).pop();
      if (lastKey && typeof meta[lastKey] === 'string' && meta[lastKey] === '') {
        meta[lastKey] = [arrayMatch[1]];
      } else if (lastKey && Array.isArray(meta[lastKey])) {
        meta[lastKey].push(arrayMatch[1]);
      }
    }
  }
  return meta;
}

/**
 * @param {string} input - Raw Obsidian markdown
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalizeObsidian(input) {
  if (!input || !input.trim()) return [];

  let text = input;
  let frontmatter = {};

  // Extract frontmatter
  const fmMatch = text.match(FRONTMATTER_REGEX);
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1]);
    text = text.slice(fmMatch[0].length);
  }

  // Convert Obsidian syntax to plain text
  text = text
    .replace(EMBED_LINK, '')                    // Remove embeds
    .replace(WIKILINK_WITH_ALIAS, '$2')         // [[page|display]] → display
    .replace(WIKILINK_SIMPLE, '$1')             // [[page]] → page
    .replace(/\r/g, '');                        // Normalize line endings

  // Segment by headings for better chunk boundaries
  const segments = [];
  const parts = text.split(HEADING_REGEX);

  // First part is content before any heading
  if (parts[0]?.trim()) {
    segments.push({
      content: parts[0].trim(),
      metadata: { ...frontmatter, section: 'intro' },
    });
  }

  // Rest comes in groups of 3: heading marker, heading text, content
  for (let i = 1; i < parts.length; i += 3) {
    const level = parts[i]?.length || 2;
    const heading = parts[i + 1]?.trim() || '';
    const content = parts[i + 2]?.trim() || '';
    if (!content) continue;

    segments.push({
      content: `${heading}\n\n${content}`,
      metadata: { ...frontmatter, section: heading, headingLevel: level },
    });
  }

  // Fallback: if no headings found, treat as single segment
  if (segments.length === 0 && text.trim()) {
    segments.push({
      content: text.trim(),
      metadata: frontmatter,
    });
  }

  return segments;
}
