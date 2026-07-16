/**
 * Wiki-compiled article normalizer.
 *
 * Handles compiled wiki articles that have been written back into the knowledge base.
 * Similar to obsidian normalizer but preserves [[wikilinks]] in chunk metadata
 * for graph edge extraction.
 *
 * Reuses the obsidian normalizer for the actual segmentation — the wiki format
 * IS obsidian markdown with frontmatter. The only difference is we extract
 * wikilinks into metadata instead of stripping them.
 */

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;
const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
const HEADING_REGEX = /^(#{1,3})\s+(.+)$/gm;

/**
 * Parse YAML frontmatter (same as obsidian normalizer).
 */
function parseFrontmatter(yamlStr) {
  const meta = {};
  let lastKey = null;
  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^\s*(\w[\w-]*):\s*(.+)/);
    if (match) {
      const [, key, value] = match;
      if (value.trim() === '') {
        meta[key] = [];
        lastKey = key;
      } else {
        meta[key] = value.replace(/^["']|["']$/g, '').trim();
        lastKey = key;
      }
      continue;
    }
    const arrayMatch = line.match(/^\s*-\s+["']?(.+?)["']?\s*$/);
    if (arrayMatch && lastKey && Array.isArray(meta[lastKey])) {
      meta[lastKey].push(arrayMatch[1]);
    }
  }
  return meta;
}

/**
 * Extract all [[wikilinks]] from text.
 * @param {string} text
 * @returns {string[]}
 */
function extractLinks(text) {
  const links = new Set();
  let match;
  const regex = new RegExp(WIKILINK_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    links.add(match[1].trim());
  }
  return [...links];
}

/**
 * Normalize a wiki-compiled article into segments for chunking.
 *
 * Key difference from obsidian normalizer: preserves wikilinks in metadata
 * so the graph layer can create LINKS_TO edges.
 *
 * @param {string} input - Wiki article markdown with frontmatter
 * @returns {import('./types.js').NormalizedSegment[]}
 */
export function normalizeWiki(input) {
  if (!input || !input.trim()) return [];

  let text = input;
  let frontmatter = {};

  // Extract frontmatter
  const fmMatch = text.match(FRONTMATTER_REGEX);
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1]);
    text = text.slice(fmMatch[0].length);
  }

  // Extract wikilinks before stripping (for metadata)
  const wikilinks = extractLinks(text);

  // Strip wikilinks from content (same as obsidian normalizer)
  const cleanText = text
    .replace(/!\[\[([^\]]+)\]\]/g, '')              // Remove embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')  // [[page|display]] → display
    .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[page]] → page
    .replace(/\r/g, '');

  // Segment by headings
  const segments = [];
  const parts = cleanText.split(HEADING_REGEX);

  if (parts[0]?.trim()) {
    segments.push({
      content: parts[0].trim(),
      metadata: { ...frontmatter, section: 'intro', wikilinks, type: 'wiki-compiled' },
    });
  }

  for (let i = 1; i < parts.length; i += 3) {
    const level = parts[i]?.length || 2;
    const heading = parts[i + 1]?.trim() || '';
    const content = parts[i + 2]?.trim() || '';
    if (!content) continue;

    // Extract section-local wikilinks
    const sectionLinks = extractLinks(parts[i + 2] || '');

    segments.push({
      content: `${heading}\n\n${content}`,
      metadata: { ...frontmatter, section: heading, headingLevel: level, wikilinks: sectionLinks, type: 'wiki-compiled' },
    });
  }

  if (segments.length === 0 && cleanText.trim()) {
    segments.push({
      content: cleanText.trim(),
      metadata: { ...frontmatter, wikilinks, type: 'wiki-compiled' },
    });
  }

  return segments;
}
