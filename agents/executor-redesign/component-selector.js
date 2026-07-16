import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ module: 'component-selector' });
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load and hash-check component library at module init (immutable at runtime)
const LIBRARY_PATH = join(__dirname, '..', '..', 'autobot-inbox', 'config', 'component-library.json');
let _library = null;
let _libraryHash = null;

function loadLibrary() {
  if (_library) return _library;
  const raw = readFileSync(LIBRARY_PATH, 'utf-8');
  _library = JSON.parse(raw);
  _libraryHash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  log.info(`Component library loaded: ${_library.components.length} components, hash: ${_libraryHash}`);
  return _library;
}

/**
 * Get the library integrity hash (for audit logging).
 */
export function getLibraryHash() {
  loadLibrary();
  return _libraryHash;
}

/**
 * Select relevant components for a redesign based on design system and strategy brief.
 *
 * @param {Object} designSystem - The extracted design system (colors, typography, etc.)
 * @param {string} strategyBrief - The strategy brief markdown
 * @returns {Array<{ id, section, prompt }>} Selected component prompts
 */
export function selectComponents(designSystem, strategyBrief) {
  const library = loadLibrary();
  const briefLower = (strategyBrief || '').toLowerCase();

  // Detect what sections are needed from strategy brief
  const sectionSignals = {
    hero: /hero|above.?fold|landing|headline|banner/i,
    features: /feature|benefit|capability|what we (do|offer)/i,
    pricing: /pricing|plan|tier|subscription|cost/i,
    testimonials: /testimonial|review|social.?proof|customer.?stor/i,
    cta: /call.?to.?action|cta|convert|sign.?up|get.?started/i,
    navbar: /nav|header|menu|navigation/i,
    footer: /footer|bottom|copyright/i,
    stats: /stat|metric|number|count|achievement/i,
    faq: /faq|question|q\s*&\s*a/i,
    contact: /contact|form|reach|get.?in.?touch/i,
    trust: /trust|logo|partner|client|company/i,
  };

  // Always include: navbar, hero, footer (every site needs these)
  const neededSections = new Set(['navbar', 'hero', 'footer']);

  // Detect additional sections from brief
  for (const [section, pattern] of Object.entries(sectionSignals)) {
    if (pattern.test(briefLower)) {
      neededSections.add(section);
    }
  }

  // If brief is thin, include common defaults
  if (neededSections.size < 5) {
    neededSections.add('features');
    neededSections.add('cta');
  }

  // Select best component for each needed section
  const selected = [];
  for (const section of neededSections) {
    const candidates = library.components.filter(c => c.section === section);
    if (candidates.length === 0) continue;

    // Prefer first matching candidate (ordered by quality in the JSON)
    // Future: score by businessType match and emotionFit
    const pick = candidates[0];
    selected.push({
      id: pick.id,
      section: pick.section,
      prompt: pick.prompt,
    });
  }

  log.info(`Selected ${selected.length} components for sections: ${[...neededSections].join(', ')}`);
  return selected;
}
