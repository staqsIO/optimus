import { embedOne, embedMany } from '../../lib/rag/embedder.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'executor-redesign' });

const TOP_N = 3;
const CANDIDATE_CAP = 12; // products to hand the generator when embeddings are unavailable

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function productText(p) {
  return [p.title, p.description, p.category].filter(Boolean).join('. ').slice(0, 1000);
}

/**
 * Rank a product catalog against a visitor intent using embedding cosine
 * similarity. Deterministic ranking — the persuasive "why it fits" copy is left
 * to the generator. Falls back gracefully when embeddings are unavailable
 * (no OPENAI_API_KEY): returns the first CANDIDATE_CAP products unscored so the
 * generator can still make a semantic selection.
 *
 * @returns {Promise<{ matched: Array, ranked: boolean }>}
 */
export async function matchProductsToIntent(intent, products, { topN = TOP_N } = {}) {
  if (!products || products.length === 0) return { matched: [], ranked: false };

  const [intentVec, productVecs] = await Promise.all([
    embedOne(intent),
    embedMany(products.map(productText)),
  ]);

  if (!intentVec) {
    log.warn(' Intent matching: embeddings unavailable — passing candidate catalog unranked');
    return { matched: products.slice(0, CANDIDATE_CAP).map((p) => ({ ...p, score: null })), ranked: false };
  }

  if (productVecs.length !== products.length) {
    log.warn(` Intent matching: embedded ${productVecs.length}/${products.length} products — unembedded items rank last`);
  }

  const scored = products
    .map((p, i) => ({ ...p, score: cosine(intentVec, productVecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return { matched: scored, ranked: true };
}

function fmtPct(score) {
  return typeof score === 'number' && score >= 0 ? `${Math.round(score * 100)}% match` : 'candidate';
}

/**
 * Render intent-brief.md — the context file that flips the generator into
 * intent-targeted landing-page mode. Handles three cases:
 *   - matched products (catalog + ranking)
 *   - unranked candidates (catalog, embeddings unavailable)
 *   - no catalog (content/section emphasis fallback)
 */
export function renderIntentBrief(intent, { matched = [], ranked = false, headings = [] } = {}) {
  // Neutralize Markdown control chars so a crafted intent can't restructure the
  // brief or attempt to override the directives below (generator-context safety).
  const safeIntent = String(intent).replace(/[`*_#\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = [];
  lines.push('# Visitor Intent — Targeted Landing Page');
  lines.push('');
  lines.push(`The visiting customer's intent is: **"${safeIntent}"**`);
  lines.push('');

  if (matched.length > 0) {
    lines.push(
      ranked
        ? 'These products were matched to that intent (ranked best-first by semantic similarity).'
        : 'These are candidate products from the catalog — select the ones that best fit the intent.'
    );
    lines.push('Foreground them as the primary content of the page.');
    lines.push('');
    matched.forEach((p, i) => {
      lines.push(`## ${i + 1}. ${p.title} ${ranked ? `(${fmtPct(p.score)})` : ''}`.trim());
      if (p.price) lines.push(`- Price: ${p.price}`);
      if (p.category) lines.push(`- Category: ${p.category}`);
      if (p.image) lines.push(`- Image (use this exact URL): ${p.image}`);
      if (p.url) lines.push(`- Product URL (CTA must link here): ${p.url}`);
      if (p.description) lines.push(`- Description: ${p.description}`);
      lines.push('');
    });
  } else {
    // No catalog — emphasize the most relevant existing content instead.
    lines.push('No product catalog was detected on this site. Do NOT invent products.');
    lines.push('Instead, recalibrate the page around this intent: lead with a hero that speaks');
    lines.push('directly to it, and reorder/emphasize the existing sections most relevant to it.');
    lines.push('');
    if (headings.length > 0) {
      lines.push('Existing page sections/headings to draw from:');
      for (const h of headings.slice(0, 25)) {
        const text = typeof h === 'string' ? h : h.text;
        if (text) lines.push(`- ${text}`);
      }
      lines.push('');
    }
  }

  lines.push('## Intent-Targeted Mode Directives');
  lines.push('- The hero headline + subhead must directly address the visitor intent above.');
  lines.push('- Lead with the matched products (cards: image, name, price, a one-line');
  lines.push('  "why it fits this intent" benefit, and a CTA linking the real product URL).');
  lines.push('- Write the persuasive "why it fits" copy yourself from each product\'s data — be specific to the intent.');
  lines.push('- This is a bespoke landing page, NOT a faithful clone of the original homepage.');
  lines.push('- Keep all brand, SEO, image-URL, accessibility and quality rules from the main blueprint.');
  lines.push('');

  return lines.join('\n');
}
