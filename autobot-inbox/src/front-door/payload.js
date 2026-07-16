/**
 * Feature 008 — shared intent-payload schema, sanitization, and validation.
 *
 * Single source of truth for the v1 payload shape, used by BOTH:
 *   - the offline seed CLI (tools/front-door/seed-corpus.js, Sonnet copy)
 *   - the runtime cold-tail generator (src/front-door/cold-tail.js, templated)
 * Extracted per Liotta/Linus review (2026-06-10): a second copy of the schema
 * validator would drift; the handle/CTA whitelists and plain-text sanitize are
 * the critical defenses and must be identical on every path.
 *
 * Payload v1 (rendered by ag-webapp /intent/[slug], which re-fetches products
 * LIVE by handle — payloads never carry price/stock):
 *   { version: 1, intent_slug, headline, subhead,
 *     sections: [{ heading, body }], products: [{ handle, title, reason, score }],
 *     faq: [{ q, a }], cta: { label, collection_handle } | null }
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const PAYLOAD_LIMITS = {
  headline: 120, subhead: 200, sectionHeading: 80, sectionBody: 800,
  reason: 160, faqQ: 160, faqA: 500, ctaLabel: 60,
  sections: 4, products: 6, faq: 4,
};

/** Plain-text sanitize: strip tags, control chars, collapse whitespace, cap. */
export function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    // eslint-disable-next-line no-control-regex -- intentionally stripping C0 controls + DEL
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Validate + sanitize a candidate payload against the v1 schema. Fail-closed:
 * returns null when the result would not be a servable page.
 *
 * Critical defenses (identical on every generation path):
 *   - products may ONLY reference handles the matcher actually offered
 *     (allowedHandles) — a generator (LLM or template) cannot invent products
 *   - cta may ONLY reference a real collection handle from the site
 *   - every string is plain-text sanitized + length-capped
 *
 * @param {object} raw - candidate payload
 * @param {string} slug - intent slug for the row
 * @param {Set<string>} allowedHandles - matcher-offered Shopify handles
 * @param {Array<{handle:string}>} collections - real site collections
 * @returns {object|null}
 */
export function normalizePayload(raw, slug, allowedHandles, collections) {
  if (!raw || typeof raw !== 'object') return null;
  const headline = cleanText(raw.headline, PAYLOAD_LIMITS.headline);
  const subhead = cleanText(raw.subhead, PAYLOAD_LIMITS.subhead);
  if (!headline) return null;

  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .slice(0, PAYLOAD_LIMITS.sections)
    .map((s) => ({
      heading: cleanText(s?.heading, PAYLOAD_LIMITS.sectionHeading),
      body: cleanText(s?.body, PAYLOAD_LIMITS.sectionBody),
    }))
    .filter((s) => s.heading && s.body);

  const products = (Array.isArray(raw.products) ? raw.products : [])
    .slice(0, PAYLOAD_LIMITS.products)
    .map((p) => ({
      handle: typeof p?.handle === 'string' ? p.handle : '',
      title: cleanText(p?.title, 150),
      reason: cleanText(p?.reason, PAYLOAD_LIMITS.reason),
      score: typeof p?.score === 'number' ? p.score : null,
    }))
    // The generator may only recommend products the matcher actually offered.
    .filter((p) => p.handle && allowedHandles.has(p.handle));
  if (products.length === 0) return null;

  const faq = (Array.isArray(raw.faq) ? raw.faq : [])
    .slice(0, PAYLOAD_LIMITS.faq)
    .map((f) => ({ q: cleanText(f?.q, PAYLOAD_LIMITS.faqQ), a: cleanText(f?.a, PAYLOAD_LIMITS.faqA) }))
    .filter((f) => f.q && f.a);

  const collectionHandles = new Set(collections.map((c) => c.handle));
  const ctaHandle = typeof raw.cta?.collection_handle === 'string' ? raw.cta.collection_handle : '';
  const cta = collectionHandles.has(ctaHandle)
    ? { label: cleanText(raw.cta?.label, PAYLOAD_LIMITS.ctaLabel) || 'Shop the collection', collection_handle: ctaHandle }
    : null;

  return { version: 1, intent_slug: slug, headline, subhead, sections, products, faq, cta };
}
