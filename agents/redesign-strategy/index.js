/**
 * Strategic consulting layer for executor-redesign.
 *
 * Extracts business context from already-scraped data ($0 — pure JS)
 * and generates a strategy brief that feeds into the design-brief.md
 * and Claude Code generation prompt.
 *
 * Three psychological principles (source: premium web design strategist videos):
 *   - Halo Effect: 50ms hero impression sets perceived quality
 *   - Cognitive Fluency: reduce load, one goal per section, whitespace as signal
 *   - Peak-End Rule: micro-interactions at key moments define remembered experience
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const designSystem = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/design-system.json', import.meta.url), 'utf-8')
);

/**
 * Emotion mapping by business type.
 * Maps detected business type → target emotions for hero/brand treatment.
 */
const EMOTION_MAP = {
  legal:        { primary: 'authority',   secondary: 'trust' },
  saas:         { primary: 'efficiency',  secondary: 'clarity' },
  healthcare:   { primary: 'care',        secondary: 'competence' },
  agency:       { primary: 'creativity',  secondary: 'confidence' },
  ecommerce:    { primary: 'desire',      secondary: 'urgency' },
  consulting:   { primary: 'expertise',   secondary: 'results' },
  nonprofit:    { primary: 'empathy',     secondary: 'impact' },
  restaurant:   { primary: 'warmth',      secondary: 'appetite' },
  'real-estate': { primary: 'aspiration', secondary: 'trust' },
  finance:      { primary: 'security',    secondary: 'competence' },
  education:    { primary: 'growth',      secondary: 'trust' },
  technology:   { primary: 'innovation',  secondary: 'reliability' },
  'home-services': { primary: 'trust',   secondary: 'reliability' },
  default:      { primary: 'confidence',  secondary: 'clarity' },
};

/**
 * Detect business type from scraped HTML signals.
 * Uses JSON-LD @type, meta description, heading content, nav structure.
 */
function detectBusinessType(scraped, analysis) {
  const signals = [];

  // JSON-LD @type (highest confidence)
  const seoElements = scraped.seoElements || {};
  const jsonLd = seoElements.jsonLd || [];
  for (const block of jsonLd) {
    const type = (block['@type'] || '').toLowerCase();
    if (type.includes('law') || type.includes('attorney')) signals.push('legal');
    if (type.includes('medicalorganization') || type.includes('physician') || type.includes('hospital')) signals.push('healthcare');
    if (type.includes('restaurant') || type.includes('foodestablishment')) signals.push('restaurant');
    if (type.includes('realestate')) signals.push('real-estate');
    if (type.includes('educationalorganization') || type.includes('school')) signals.push('education');
    if (type.includes('financialservice') || type.includes('bankaccount')) signals.push('finance');
    if (type.includes('nonprofit') || type.includes('ngo')) signals.push('nonprofit');
    if (type.includes('product') || type.includes('store')) signals.push('ecommerce');
    if (type.includes('softwareapplication') || type.includes('webapplication')) signals.push('saas');
  }

  // Nav link text analysis
  const navTexts = (seoElements.navLinks || []).map(l => (l.text || '').toLowerCase()).join(' ');
  if (/pricing|plans|signup|free.?trial|demo/i.test(navTexts)) signals.push('saas');
  if (/shop|cart|products|collections/i.test(navTexts)) signals.push('ecommerce');
  if (/practice.?areas|attorneys|cases/i.test(navTexts)) signals.push('legal');
  if (/patients|appointments|providers|health/i.test(navTexts)) signals.push('healthcare');
  if (/listings|properties|agents|mortgage/i.test(navTexts)) signals.push('real-estate');
  if (/menu|reservations|order.?online/i.test(navTexts)) signals.push('restaurant');
  if (/donate|volunteer|mission|impact/i.test(navTexts)) signals.push('nonprofit');
  if (/portfolio|our.?work|clients|case.?stud/i.test(navTexts)) signals.push('agency');
  if (/solutions|enterprise|integrations/i.test(navTexts)) signals.push('consulting');
  if (/courses|enroll|admissions|campus/i.test(navTexts)) signals.push('education');
  if (/services|free.?(?:quote|estimate)|service.?area|our.?team|about.?us|testimonials|reviews/i.test(navTexts)) signals.push('home-services');

  // Home services / local service businesses
  const allNavHead = `${navTexts} ${(seoElements.headings || []).map(h => (h.text || '').toLowerCase()).join(' ')} ${(scraped.meta?.description || '').toLowerCase()}`;
  if (/repair|install|replacement|maintenance|roofing|plumbing|hvac|landscaping|auto\s*glass|windshield|garage\s*door|pest|cleaning|remodel|contractor|handyman|fencing|paving|towing|locksmith/i.test(allNavHead)) {
    signals.push('home-services');
    signals.push('home-services'); // double weight — these are strong signals
  }

  // Meta description keywords
  const metaDesc = (scraped.meta?.description || '').toLowerCase();
  if (/law\s|legal|attorney|lawyer/i.test(metaDesc)) signals.push('legal');
  if (/saas|software|platform|app\b/i.test(metaDesc)) signals.push('saas');
  if (/health|medical|clinic|doctor|patient/i.test(metaDesc)) signals.push('healthcare');
  if (/agency|studio|creative|design\s/i.test(metaDesc)) signals.push('agency');
  if (/shop|store|buy|ecommerce/i.test(metaDesc)) signals.push('ecommerce');

  // Heading content
  const headingTexts = (seoElements.headings || []).map(h => (h.text || '').toLowerCase()).join(' ');
  if (/your\s+(trusted|dedicated|experienced)\s+(law|legal|attorney)/i.test(headingTexts)) signals.push('legal');
  if (/get\s+started|start\s+free|try\s+it/i.test(headingTexts)) signals.push('saas');

  // Analysis recommended_style as fallback
  const style = (analysis?.recommended_style || '').toLowerCase();
  if (/corporate|professional|enterprise/i.test(style)) signals.push('consulting');
  if (/modern|tech|minimal/i.test(style)) signals.push('saas');
  if (/warm|friendly|organic/i.test(style)) signals.push('restaurant');

  // Count votes
  const counts = {};
  for (const s of signals) {
    counts[s] = (counts[s] || 0) + 1;
  }

  // Return highest-voted type (or 'default')
  let best = 'default';
  let bestCount = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > bestCount) { best = type; bestCount = count; }
  }

  return best;
}

/**
 * Detect audience type: B2B vs B2C.
 */
function detectAudience(scraped, analysis) {
  const navTexts = (scraped.seoElements?.navLinks || []).map(l => (l.text || '').toLowerCase()).join(' ');
  const metaDesc = (scraped.meta?.description || '').toLowerCase();
  const headingTexts = (scraped.seoElements?.headings || []).map(h => (h.text || '').toLowerCase()).join(' ');
  const allText = `${navTexts} ${metaDesc} ${headingTexts}`;

  const b2bSignals = (allText.match(/enterprise|solutions|integration|api|platform|teams|business|b2b|roi|workflow/gi) || []).length;
  const b2cSignals = (allText.match(/shop|buy|personal|family|home|lifestyle|you\b|your\b|cart|order/gi) || []).length;

  if (b2bSignals > b2cSignals + 2) return 'B2B';
  if (b2cSignals > b2bSignals + 2) return 'B2C';
  return 'mixed';
}

/**
 * Extract conversion goals from CTA button text, forms, phone numbers, scheduling links.
 */
function detectConversionGoals(scraped) {
  const goals = [];
  const seo = scraped.seoElements || {};
  const navTexts = (seo.navLinks || []).map(l => (l.text || '').toLowerCase()).join(' ');
  const headingTexts = (seo.headings || []).map(h => (h.text || '').toLowerCase()).join(' ');
  const allText = `${navTexts} ${headingTexts}`;

  // CTA patterns
  if (/contact\s*us|get\s*in\s*touch|reach\s*out/i.test(allText)) goals.push('contact');
  if (/schedule|book|appointment|calendar|consultation/i.test(allText)) goals.push('schedule');
  if (/sign\s*up|register|create\s*account|get\s*started|free\s*trial|start\s*free/i.test(allText)) goals.push('signup');
  if (/buy|purchase|add\s*to\s*cart|shop\s*now|order/i.test(allText)) goals.push('purchase');
  if (/call\s*us|call\s*now|\(\d{3}\)/i.test(allText)) goals.push('call');
  if (/download|get\s*the\s*(guide|ebook|whitepaper)/i.test(allText)) goals.push('lead-magnet');
  if (/quote|estimate|pricing/i.test(allText)) goals.push('quote');
  if (/donate|give|support/i.test(allText)) goals.push('donate');
  if (/demo|watch|see\s*it\s*in\s*action/i.test(allText)) goals.push('demo');
  if (/subscribe|newsletter|stay\s*updated/i.test(allText)) goals.push('subscribe');

  if (goals.length === 0) goals.push('contact'); // fallback
  return goals;
}

/**
 * Extract value proposition from H1/H2 text and differentiator language.
 */
function extractValueProp(scraped) {
  const headings = scraped.seoElements?.headings || [];
  const h1 = headings.find(h => h.tag === 'h1');
  const h2s = headings.filter(h => h.tag === 'h2').slice(0, 3);

  const valueProp = {
    headline: h1?.text || scraped.title || '',
    subheadlines: h2s.map(h => h.text),
    differentiators: [],
  };

  // Look for differentiator language
  const allHeadingText = headings.map(h => h.text || '').join(' ');
  const diffPatterns = [
    /only\s+.{5,40}/gi,
    /first\s+.{5,40}/gi,
    /unlike\s+.{5,40}/gi,
    /the\s+(?:leading|#1|top|premier|best)\s+.{5,40}/gi,
    /\d+\+?\s+(?:years|clients|projects|customers|companies)/gi,
  ];
  for (const pattern of diffPatterns) {
    const matches = allHeadingText.match(pattern);
    if (matches) valueProp.differentiators.push(...matches.map(m => m.trim()));
  }

  return valueProp;
}

/**
 * Inventory trust signals: testimonials, client logos, certifications, team photos, stats.
 */
function inventoryTrustSignals(scraped) {
  const navTexts = (scraped.seoElements?.navLinks || []).map(l => (l.text || '').toLowerCase()).join(' ');
  const headingTexts = (scraped.seoElements?.headings || []).map(h => (h.text || '').toLowerCase()).join(' ');
  const images = scraped.images || [];
  const allText = `${navTexts} ${headingTexts}`;

  const signals = {
    testimonials: /testimonial|review|what\s+(our\s+)?clients\s+say|customer\s+stories/i.test(allText),
    clientLogos: /trusted\s*by|our\s*clients|partners|as\s*seen/i.test(allText) || images.some(i => /client|partner|logo/i.test(i.context || '')),
    certifications: /certified|accredited|award|recognized|iso\s/i.test(allText),
    teamPhotos: /our\s*team|meet\s*the|about\s*us/i.test(allText),
    stats: /\d{2,}[+%]\s/i.test(headingTexts) || /years\s*of\s*experience|\d+\s*clients/i.test(allText),
    socialProof: /\d+[+k]?\s*(customers|users|clients|businesses|companies)/i.test(allText),
  };

  const present = Object.entries(signals).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(signals).filter(([, v]) => !v).map(([k]) => k);

  return { signals, present, missing };
}

/**
 * Assess content maturity from nav links.
 */
function assessContentMaturity(scraped) {
  const navTexts = (scraped.seoElements?.navLinks || []).map(l => (l.text || '').toLowerCase());
  const present = [];

  if (navTexts.some(t => /blog|news|article|insight/i.test(t))) present.push('blog');
  if (navTexts.some(t => /case.?stud|success.?stor|portfolio|our.?work/i.test(t))) present.push('case-studies');
  if (navTexts.some(t => /about|our.?story|who.?we/i.test(t))) present.push('about');
  if (navTexts.some(t => /faq|help|support|knowledge/i.test(t))) present.push('faq');
  if (navTexts.some(t => /resource|guide|whitepaper|download/i.test(t))) present.push('resources');
  if (navTexts.some(t => /career|job|join.?us|hiring/i.test(t))) present.push('careers');

  return { present, depth: present.length >= 4 ? 'mature' : present.length >= 2 ? 'moderate' : 'thin' };
}

/**
 * Select a font pairing from the design system based on emotion.
 * Uses MD5(URL)[0:8] for deterministic rotation — same URL always gets same fonts.
 *
 * @param {string} emotion - Target primary emotion (e.g. 'authority', 'trust')
 * @param {string} urlHash - MD5 hex hash of the target URL
 * @returns {object} { heading, body, accent?, weights, vibe, googleFontsUrl }
 */
function selectFontPairing(emotion, urlHash) {
  const pairings = designSystem.fontPairings[emotion] || designSystem.fontPairings.confidence;
  const index = parseInt(urlHash.slice(0, 8), 16) % pairings.length;
  const pairing = pairings[index];

  // Build Google Fonts URL from weights
  const families = [];
  const headingWeights = pairing.weights.heading.join(';');
  families.push(`family=${pairing.heading.replace(/ /g, '+')}:wght@${headingWeights}`);
  const bodyWeights = pairing.weights.body.join(';');
  families.push(`family=${pairing.body.replace(/ /g, '+')}:wght@${bodyWeights}`);
  if (pairing.accent && pairing.weights.accent) {
    const accentWeights = pairing.weights.accent.join(';');
    families.push(`family=${pairing.accent.replace(/ /g, '+')}:wght@${accentWeights}`);
  }
  const googleFontsUrl = `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;

  return { ...pairing, googleFontsUrl };
}

/**
 * Select a layout style from the design system based on business type.
 * Uses MD5(URL)[8:16] for deterministic rotation — independent from font rotation.
 *
 * @param {string} businessType - Detected business type (e.g. 'agency', 'saas')
 * @param {string} urlHash - MD5 hex hash of the target URL
 * @returns {object} { style, description }
 */
function selectLayoutStyle(businessType, urlHash) {
  const styles = designSystem.layoutStyles[businessType] || designSystem.layoutStyles.default;
  const index = parseInt(urlHash.slice(8, 16), 16) % styles.length;
  const style = styles[index];
  const description = designSystem.layoutDescriptions[style] || designSystem.layoutDescriptions['clean-grid'];
  return { style, description };
}

/**
 * Extract business context from already-scraped data.
 * Pure JS, $0 cost — no LLM calls.
 *
 * @param {object} scraped - Output from scrapeUrl()
 * @param {object} analysis - Output from analyzeDesign()
 * @param {string} [targetUrl] - Target URL for deterministic font/layout selection
 * @returns {object} businessContext
 */
export function extractBusinessContext(scraped, analysis, targetUrl) {
  // Load seoElements from scraped data (written to file by scrapeUrl, also available in-memory)
  const seoElements = scraped.seoElements || {};

  const businessType = detectBusinessType(scraped, analysis);
  const audience = detectAudience(scraped, analysis);
  const conversionGoals = detectConversionGoals(scraped);
  const valueProp = extractValueProp(scraped);
  const trustSignals = inventoryTrustSignals(scraped);
  const contentMaturity = assessContentMaturity(scraped);
  const targetEmotion = EMOTION_MAP[businessType] || EMOTION_MAP.default;

  // Deterministic font/layout selection based on URL hash
  let fontPairing = null;
  let layoutStyle = null;
  if (targetUrl) {
    const urlHash = createHash('md5').update(targetUrl).digest('hex');
    fontPairing = selectFontPairing(targetEmotion.primary, urlHash);
    layoutStyle = selectLayoutStyle(businessType, urlHash);
  }

  return {
    businessType,
    audience,
    conversionGoals,
    primaryConversionGoal: conversionGoals[0],
    valueProp,
    trustSignals,
    contentMaturity,
    targetEmotion,
    navItemCount: (seoElements.navLinks || []).length,
    fontPairing,
    layoutStyle,
  };
}

/**
 * Generate a strategy brief from the business context.
 * Pure template, $0 cost.
 *
 * @param {object} businessContext - Output from extractBusinessContext()
 * @param {object} analysis - Output from analyzeDesign()
 * @returns {string} Markdown strategy brief
 */
export function generateStrategyBrief(businessContext, analysis) {
  const bc = businessContext;
  const lines = [];

  // ── Section 1: Business Context ──
  lines.push('# Strategy Brief\n');
  lines.push('## 1. Business Context\n');
  lines.push(`- **Business type**: ${bc.businessType}`);
  lines.push(`- **Audience**: ${bc.audience}`);
  lines.push(`- **Primary conversion goal**: ${bc.primaryConversionGoal}`);
  lines.push(`- **All conversion goals**: ${bc.conversionGoals.join(', ')}`);
  lines.push(`- **Value proposition**: "${bc.valueProp.headline}"`);
  if (bc.valueProp.subheadlines.length) {
    lines.push(`- **Supporting messages**: ${bc.valueProp.subheadlines.map(s => `"${s}"`).join('; ')}`);
  }
  if (bc.valueProp.differentiators.length) {
    lines.push(`- **Differentiators**: ${bc.valueProp.differentiators.join('; ')}`);
  }
  lines.push(`- **Trust signals present**: ${bc.trustSignals.present.join(', ') || 'none detected'}`);
  lines.push(`- **Trust signals missing**: ${bc.trustSignals.missing.join(', ') || 'none'}`);
  lines.push(`- **Content maturity**: ${bc.contentMaturity.depth} (${bc.contentMaturity.present.join(', ') || 'minimal'})`);
  lines.push('');

  // ── Section 2: Hero Section Engineering (Halo Effect) ──
  lines.push('## 2. Hero Section Engineering (Halo Effect)\n');
  lines.push('The hero section forms the first impression in ~50ms. It must engineer a specific emotional response.\n');
  lines.push(`- **Target emotion**: ${bc.targetEmotion.primary} + ${bc.targetEmotion.secondary}`);
  lines.push(`- **Single promise**: Distill the value prop into ONE clear sentence visible without scrolling`);
  lines.push(`- **Visual hierarchy**: Eye path must reach the primary CTA within 2 seconds`);
  lines.push(`- **Hero pattern**: Large heading → supporting text → CTA button, all above the fold`);
  lines.push(`- **Emotional design cues for ${bc.targetEmotion.primary}**:`);

  const emotionDesignCues = {
    authority: '  - Strong serif/display typography, dark or navy palette, generous negative space, structured grid',
    trust: '  - Clean layout, real photography (no stock), consistent color system, visible credentials',
    efficiency: '  - Minimal UI, ample whitespace, clear data hierarchy, no decorative elements',
    clarity: '  - High contrast, simple navigation, one action per view, descriptive headings',
    care: '  - Warm palette, rounded shapes, human photography, accessible font sizes',
    competence: '  - Structured layout, data visualization, credential badges, professional photography',
    creativity: '  - Bold typography, asymmetric layout, dynamic color, portfolio previews',
    confidence: '  - Strong brand colors, direct language, clear CTAs, professional imagery',
    desire: '  - High-quality product photography, lifestyle imagery, rich colors, elegant typography',
    urgency: '  - Countdown elements, limited-availability signals, high-contrast CTAs, action verbs',
    expertise: '  - Case study previews, data/metrics, thought leadership indicators, structured content',
    results: '  - Before/after, metrics, testimonials, ROI calculators, proof points',
    empathy: '  - Human faces, warm colors, impact stories, community imagery',
    impact: '  - Statistics, progress indicators, beneficiary stories, strong mission statement',
    warmth: '  - Rich warm colors, food photography, cozy textures, inviting language',
    appetite: '  - Close-up food imagery, rich tones (red, orange, brown), sensory language',
    aspiration: '  - Aspirational lifestyle imagery, premium typography, elegant whitespace, property showcases',
    innovation: '  - Tech-forward design, gradients, animation, clean geometric shapes',
    reliability: '  - Consistent design system, grid structure, professional photography, uptime stats',
    security: '  - Shield iconography, trust badges, muted professional palette, structured data display',
    growth: '  - Upward visual motifs, student success stories, progress indicators, clear pathways',
  };
  lines.push(emotionDesignCues[bc.targetEmotion.primary] || '  - Professional, clean, and intentional design');
  lines.push(emotionDesignCues[bc.targetEmotion.secondary] || '');
  lines.push('');

  // ── Section 2.5: Typography & Font Pairing ──
  if (bc.fontPairing) {
    const fp = bc.fontPairing;
    lines.push('## 2.5 Typography & Font Pairing (MUST USE)\n');
    lines.push(`You MUST use the following fonts. Do NOT pick your own.\n`);
    lines.push(`- **Heading font**: ${fp.heading} (weights: ${fp.weights.heading.join(', ')})`);
    lines.push(`- **Body font**: ${fp.body} (weights: ${fp.weights.body.join(', ')})`);
    if (fp.accent) {
      lines.push(`- **Accent font**: ${fp.accent} (weights: ${fp.weights.accent.join(', ')}) — use for code snippets, labels, or data callouts`);
    }
    lines.push(`- **Vibe**: ${fp.vibe}`);
    lines.push(`- **Google Fonts link**: \`${fp.googleFontsUrl}\``);
    lines.push('');
    lines.push('### Typography Scale');
    lines.push('- Hero heading: `font-size: clamp(2.5rem, 5vw, 4.5rem); line-height: 1.1;`');
    lines.push('- Section heading (H2): `font-size: clamp(1.75rem, 3vw, 2.5rem); line-height: 1.2;`');
    lines.push('- Body text: `font-size: clamp(1rem, 1.1vw, 1.125rem); line-height: 1.6;`');
    lines.push('');
    lines.push('### Typography Rules');
    lines.push('- Apply `text-wrap: balance` on all headings (h1-h3)');
    lines.push('- Apply `text-wrap: pretty` on paragraphs');
    lines.push('- Use `font-display: swap` on Google Fonts for performance');
    lines.push('- Maximum 3 font sizes per section (heading, body, caption)');
    lines.push('- Use `letter-spacing: -0.02em` on large headings for tighter display type');
    lines.push('');
  }

  // ── Section 3: Cognitive Fluency Directives ──
  lines.push('## 3. Cognitive Fluency Directives\n');
  lines.push('Every design choice should reduce cognitive load. Simplicity signals competence.\n');
  lines.push('- **ONE goal per section**: Each section should have exactly one purpose and one action');
  lines.push('- **Generous whitespace**: Whitespace is a premium signal, not wasted space. Use padding >=60px between sections');
  lines.push(`- **Navigation**: ${bc.navItemCount > 7 ? `Current site has ${bc.navItemCount} nav items — reduce to 5-7 max. Group secondary items under dropdowns.` : `${bc.navItemCount} nav items is good — keep it focused.`}`);
  lines.push('- **Visual hierarchy tells the story**: A visitor should understand the offering by scrolling without reading details');
  lines.push('- **Progressive disclosure**: Lead with the essential, reveal details on interaction (accordion, tabs, modals)');
  lines.push('- **Typography scale**: Use no more than 3 font sizes per section (heading, body, caption)');
  lines.push('');

  // ── Section 3.5: Layout Style ──
  if (bc.layoutStyle) {
    const ls = bc.layoutStyle;
    lines.push(`## 3.5 Layout Style: ${ls.style}\n`);
    lines.push(ls.description);
    lines.push('');

    const snippets = designSystem.cssSnippets;
    if (ls.style === 'organic') {
      lines.push('### Organic Layout Patterns');
      lines.push(`- **Wave divider between sections**: \`${snippets.organicShapes.waveDivider}\``);
      lines.push(`- **Blob background accents**: \`${snippets.organicShapes.blobBackground}\``);
      lines.push(`- **Diagonal sections**: \`${snippets.organicShapes.diagonalSection}\``);
      lines.push('- Use asymmetric grids: `grid-template-columns: 1fr 1.3fr` or `2fr 1fr`');
      lines.push('- Overlap elements with negative margins or `position: relative; top: -40px`');
    } else if (ls.style === 'editorial') {
      lines.push('### Editorial Layout Patterns');
      lines.push('- Vary column widths: full-width hero, then constrained content (max-width: 65ch)');
      lines.push('- Include at least one pull quote with oversized typography');
      lines.push(`- Pull quote style: \`${snippets.antiAIMarkers.editorialPullQuote}\``);
      lines.push('- Mix grid layouts: `1fr 1.3fr` for feature sections, full-width for testimonials');
      lines.push('- Use generous line-height (1.6-1.8) for body text');
    } else if (ls.style === 'archival') {
      lines.push('### Archival Layout Patterns');
      lines.push('- Clean grid with precise alignment and minimal decoration');
      lines.push('- Use subtle borders (`1px solid rgba(0,0,0,0.08)`) instead of background colors');
      lines.push('- Monospaced font for labels, categories, dates, and data points');
      lines.push('- Generous whitespace (padding: 80px+ between major sections)');
      lines.push('- Museum-catalog labeling: small caps, letter-spacing, muted colors');
    }
    lines.push('');
  }

  // ── Section 4: Motion & Micro-Interactions (2026 — Peak-End Rule) ──
  lines.push('## 4. Motion & Micro-Interactions (2026 — Peak-End Rule)\n');
  lines.push('The last impression matters as much as the first. Motion creates "moments" that define the remembered experience.\n');
  lines.push('All interactions MUST be CSS-only (no JavaScript).\n');

  lines.push('### Scroll-Driven Animations (2026 standard)');
  lines.push('Use `animation-timeline: view()` — no IntersectionObserver, no JS.\n');
  lines.push('```css');
  lines.push(designSystem.cssSnippets.scrollAnimations.keyframes);
  lines.push('');
  lines.push(designSystem.cssSnippets.scrollAnimations.usage);
  lines.push('```\n');
  lines.push('Apply different animation classes to different sections for visual rhythm:');
  lines.push('- Hero: no animation (immediate)');
  lines.push('- Features/services: `.animate-on-scroll` (fadeInUp)');
  lines.push('- Testimonials: `.slide-left` or `.slide-right` (alternate)');
  lines.push('- Stats/metrics: `.scale-reveal`');
  lines.push('- CTA sections: `.animate-on-scroll`');
  lines.push('');

  lines.push('### Accessibility: Reduced Motion');
  lines.push('```css');
  lines.push(designSystem.cssSnippets.scrollAnimations.reducedMotion);
  lines.push('```\n');

  lines.push('### Enhanced Micro-Interactions');
  lines.push('Use spring cubic-bezier `(0.34, 1.56, 0.64, 1)` instead of linear easing.\n');
  lines.push('- **Magnetic button hover**: `transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease; transform: translateY(-3px) scale(1.02)`');
  lines.push('- **Card reveal**: `transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); transform: translateY(-6px)` with layered box-shadow');
  lines.push('- **Sliding underline on links**: Pseudo-element `::after` width transition from 0 to 100%');
  lines.push('- **Image zoom on hover**: `overflow: hidden` container, `img { transition: transform 0.6s; } &:hover img { transform: scale(1.05) }`');
  lines.push('- **Focus ring**: `:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px }`');
  lines.push('- **Smooth scroll**: `html { scroll-behavior: smooth }`');
  lines.push('');

  // ── Section 5: Conversion Architecture ──
  lines.push('## 5. Conversion Architecture\n');
  lines.push(`Primary conversion goal: **${bc.primaryConversionGoal}**\n`);

  const ctaGuidance = {
    contact: 'Place "Contact Us" / "Get in Touch" CTA in hero AND after social proof section. Include phone number visible above fold if detected.',
    schedule: 'Place "Schedule / Book" CTA in hero. Repeat after testimonials section. Include availability hint if possible.',
    signup: 'Place "Get Started" / "Start Free Trial" in hero. Repeat in sticky header on scroll. Minimize form fields.',
    purchase: 'Place "Shop Now" / "Buy" in hero. Product cards with quick-add. Cart icon always visible.',
    call: 'Phone number prominent in header (click-to-call on mobile). "Call Now" as secondary CTA throughout.',
    'lead-magnet': 'Place download CTA in hero. Repeat mid-page with value summary. Use social proof near form.',
    quote: 'Place "Get a Quote" in hero. Simple form with 3-5 fields max. Include trust signals near form.',
    donate: 'Place "Donate" CTA in hero with impact framing. Repeat after impact stories section.',
    demo: 'Place "See Demo" / "Watch" in hero. Include video thumbnail if available. Follow with feature summary.',
    subscribe: 'Email capture in hero or mid-page. Offer value exchange (newsletter benefit). Minimal fields.',
  };
  lines.push(`- **Primary CTA guidance**: ${ctaGuidance[bc.primaryConversionGoal] || ctaGuidance.contact}`);
  lines.push('- **Objection handling**: Place FAQ or "Why Choose Us" section BEFORE the final CTA — answer objections, then ask for action');
  lines.push('- **Social proof near CTAs**: Testimonials, client logos, or stats should appear within one scroll of every CTA');
  lines.push('- **Trust signals above fold**: At minimum, one trust indicator visible without scrolling (rating, client count, certification)');
  lines.push('');

  // Recommended page section order
  lines.push('### Recommended Section Order\n');
  const sectionOrder = [
    '1. Hero: Headline + value prop + primary CTA + trust signal (above fold)',
    '2. Social proof / logos: "Trusted by..." strip',
    '3. Problem/solution: Empathize with the pain, introduce the solution',
    '4. Features/services: What you offer (one goal per card/section)',
    '5. Results/testimonials: Proof that it works',
    '6. FAQ / objection handling: Remove friction before the ask',
    '7. Final CTA: Clear, confident, single action',
    '8. Footer: Contact info, nav links, certifications',
  ];
  for (const section of sectionOrder) {
    lines.push(`- ${section}`);
  }
  lines.push('');

  // ── Section 6: Depth & Glassmorphism ──
  lines.push('## 6. Depth & Glassmorphism\n');
  lines.push('Create visual depth through layered shadows and frosted-glass effects.\n');
  lines.push('### Where to Use');
  lines.push(`- **Navigation bar**: \`${designSystem.cssSnippets.glassmorphism.nav}\``);
  lines.push(`- **Feature cards**: \`${designSystem.cssSnippets.depthLayers.elevatedCard}\``);
  lines.push(`- **Hero overlay**: \`${designSystem.cssSnippets.glassmorphism.heroOverlay}\``);
  lines.push(`- **Floating elements (CTAs, badges)**: \`${designSystem.cssSnippets.depthLayers.floatingElement}\``);
  lines.push(`- **Form inputs**: \`${designSystem.cssSnippets.depthLayers.sunkenInput}\``);
  lines.push('');
  lines.push('### Where NOT to Use');
  lines.push('- Body text backgrounds (readability hazard)');
  lines.push('- Footer (keep grounded and solid)');
  lines.push('- Mobile viewports < 768px (performance concern — reduce blur radius to 8px)');
  lines.push('');
  lines.push('### Shadow System');
  lines.push('- Small (buttons, tags): `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`');
  lines.push('- Medium (cards): `box-shadow: 0 4px 6px rgba(0,0,0,0.04), 0 10px 24px rgba(0,0,0,0.08)`');
  lines.push('- Large (modals, floating): `box-shadow: 0 8px 30px rgba(0,0,0,0.12)`');
  lines.push('- Hover elevation: increase shadow spread by 50% and add translateY(-2px to -6px)');
  lines.push('');

  // ── Section 7: Anti-AI Design Markers ──
  lines.push('## 7. Anti-AI Design Markers\n');
  lines.push('The redesign should feel like a human designer with a specific point of view created it.\n');
  lines.push('### DO');
  lines.push('- Use imperfect grids: `grid-template-columns: 1fr 1.3fr` or `2fr 1fr 1.5fr` — NEVER equal-width columns everywhere');
  lines.push('- Vary card sizes and image aspect ratios within the same section');
  lines.push('- Include at least one editorial pull quote with oversized typography');
  lines.push('- Apply `text-wrap: balance` on headings, `text-wrap: pretty` on paragraphs');
  lines.push('- Use a custom scrollbar that matches the brand');
  lines.push('- Mix section backgrounds (solid, gradient, image, transparent) — no two adjacent sections should look the same');
  lines.push('');
  lines.push('### AVOID (AI tells that make redesigns look generated)');
  lines.push('- Perfectly centered everything with identical padding');
  lines.push('- Three identical cards in a `repeat(3, 1fr)` grid');
  lines.push('- Symmetric layouts where left mirrors right');
  lines.push('- Generic headlines like "Welcome to [Company]" or "Your Trusted Partner"');
  lines.push('- Identical card heights via `height: 100%` (let content breathe)');
  lines.push('- Pure white (#ffffff) backgrounds on every section (vary with off-whites, brand tints)');
  lines.push('- Default 1rem/16px body text with no typographic hierarchy');
  lines.push('');

  return lines.join('\n');
}
