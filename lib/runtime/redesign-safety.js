/**
 * Redesign landing-page safety gate (Optimus P1 deny-by-default, P2 infra-enforces).
 *
 * The redesign path takes UNTRUSTED inputs — visitor_intent (user-supplied) and
 * scraped third-party page content — fuses them into a Sonnet generation prompt,
 * and serves the generated HTML PUBLICLY under a staqs.io URL. This module is the
 * constitutional gate on both ends of that flow:
 *
 *   INBOUND  (screenRedesignInput) — Model Armor screens untrusted text BEFORE it
 *            reaches the model. Fail-CLOSED when Model Armor is unconfigured in
 *            production (deny-by-default); overridable via MODEL_ARMOR_FAIL_OPEN
 *            for local/dev/test so the pipeline runs without gcloud/ADC.
 *
 *   OUTBOUND (sanitizeUntrustedHtml + publish-gate fields) — the generated HTML is
 *            untrusted model output. Strip active content (<script>, on* handlers,
 *            javascript: URLs, <iframe>/<object>/<embed>) and mark the page
 *            UNPUBLISHED-until-passed so it is never served before the gate clears.
 *
 *   CACHE    (REDESIGN_SAFETY_VERSION) — a monotonic version stamp folded into the
 *            dedup key and the serve check, so a page persisted before today's
 *            safety logic can never be served from cache without re-screening.
 *
 * Shared by the API (Railway) and the executor (M1) — they live on different
 * machines and only share state through agent_graph.work_items.metadata, so the
 * version constant and HTML sanitizer MUST be defined once, here.
 */

import { detectAndRecordThreats, getModelArmorConfig } from './sanitizer.js';

/**
 * Bump this whenever the inbound screen or outbound sanitizer changes in a way
 * that should invalidate previously-published pages. Pages persisted with an older
 * (or missing) safety_version are treated as unsafe at serve time and on dedup.
 */
export const REDESIGN_SAFETY_VERSION = 1;

/**
 * Whether to fail OPEN (allow) when Model Armor is not configured.
 *
 * Production default is fail-CLOSED (deny-by-default, P1): if Model Armor cannot
 * screen the input, the input is rejected. Local/dev/test set MODEL_ARMOR_FAIL_OPEN=true
 * to run the pipeline without gcloud/ADC/gws on PATH.
 *
 * Read at call time (not import time) so dotenv/test setup can toggle it.
 */
export function redesignFailOpen() {
  return process.env.MODEL_ARMOR_FAIL_OPEN === 'true';
}

/**
 * Screen an untrusted text input through Model Armor before it enters the
 * generation prompt. Constitutional gate G8, applied to the redesign path.
 *
 * @param {string} text - Untrusted input (visitor_intent, scraped content).
 * @param {string} agentId - Agent/principal id for threat recording.
 * @param {object} [opts]
 * @param {string} [opts.label] - Human label for the input (for the block reason).
 * @returns {Promise<{ ok: boolean, reason: string|null, detail: object }>}
 *   ok=false means REJECT — do not call the LLM.
 */
export async function screenRedesignInput(text, agentId, opts = {}) {
  const label = opts.label || 'input';

  // Nothing to screen — pass. (Empty intent is the common no-intent case.)
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: true, reason: null, detail: { label, skipped: 'empty' } };
  }

  const { template } = getModelArmorConfig();

  // Deny-by-default: if Model Armor is unconfigured we cannot screen this input.
  // Production rejects (fail-closed); dev/test may opt into fail-open.
  if (!template) {
    if (redesignFailOpen()) {
      return { ok: true, reason: null, detail: { label, modelArmor: 'unconfigured-fail-open' } };
    }
    return {
      ok: false,
      reason: `Safety screening unavailable (Model Armor not configured); ${label} rejected (deny-by-default).`,
      detail: { label, modelArmor: 'unconfigured-fail-closed' },
    };
  }

  let verdict;
  try {
    verdict = await detectAndRecordThreats(text, agentId, 'redesign');
  } catch (err) {
    // Screening errored. Deny-by-default in production; fail-open only if opted in.
    if (redesignFailOpen()) {
      return { ok: true, reason: null, detail: { label, modelArmor: 'error-fail-open', error: err.message } };
    }
    return {
      ok: false,
      reason: `Safety screening failed; ${label} rejected (deny-by-default).`,
      detail: { label, modelArmor: 'error-fail-closed', error: err.message },
    };
  }

  if (verdict.blocked) {
    return {
      ok: false,
      reason: `Input flagged by Model Armor (prompt injection / unsafe content); ${label} rejected.`,
      detail: {
        label,
        modelArmor: 'blocked',
        confidence: verdict.confidence,
        severity: verdict.severity,
      },
    };
  }

  return {
    ok: true,
    reason: null,
    detail: { label, modelArmor: 'passed', count: verdict.count, severity: verdict.severity },
  };
}

/**
 * Sanitize untrusted model-generated HTML before it is persisted-as-published.
 *
 * Removes active-content vectors that the serve-time CSP does not fully cover and
 * that the old <script>-only stripper missed:
 *   - <script> ... </script>           (preserve type="application/ld+json" for SEO)
 *   - on* inline event-handler attrs    (onclick, onload, onerror, ...)
 *   - javascript:/vbscript:/data:text/html URLs in href/src/action/etc.
 *   - <iframe> / <object> / <embed>     (framing + plugin content)
 *
 * Regex-based, intentionally aggressive: this is a publish gate, not a rich-text
 * editor. Defense-in-depth on top of the serve-time CSP (script-src 'none').
 *
 * @param {string} html
 * @returns {string} sanitized HTML
 */
export function sanitizeUntrustedHtml(html) {
  if (typeof html !== 'string') return '';
  let out = html;

  // 1. <script>...</script> — keep INLINE JSON-LD (SEO), drop everything else.
  //    A JSON-LD <script> is only preserved when it carries NO src — an
  //    external-src JSON-LD script (`<script type="application/ld+json" src=...>`)
  //    is an active-content vector and must be stripped, not preserved.
  const isInlineJsonLd = (tag) =>
    /type\s*=\s*["']application\/ld\+json["']/i.test(tag)
    && !/\ssrc\s*=/i.test(tag);
  out = out.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*<\/script>/gi, (match) => {
    const openTag = match.match(/<script\b[^>]*>/i)?.[0] || '';
    if (isInlineJsonLd(openTag)) return match;
    return '';
  });
  // Stray/unterminated opening <script ...> with no closer — but never strip a
  // genuine inline JSON-LD opener (its full block was preserved above).
  out = out.replace(/<script\b[^>]*>/gi, (m) => (isInlineJsonLd(m) ? m : ''));

  // 2. <iframe>/<object>/<embed> — framing + plugin content (with and without closers).
  out = out.replace(/<iframe\b[^>]*>(?:(?!<\/iframe>)[\s\S])*<\/iframe>/gi, '');
  out = out.replace(/<\/?(?:iframe|object|embed)\b[^>]*>/gi, '');

  // 3. Inline event-handler attributes: on*="..." | on*='...' | on*=bare.
  //    Anchor on whitespace + `on` + a LETTER so real event handlers (onclick,
  //    onload, onmouseover, …) are stripped but `data-*`, `aria-*`, and non-handler
  //    `on`-prefixed names are NOT mangled. The bare-unquoted-value pass is the
  //    last resort and uses the same tightened anchor.
  out = out.replace(/\s+on[a-z][a-z]*\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z][a-z]*\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\s+on[a-z][a-z]*\s*=\s*[^\s">]+/gi, '');

  // 4. javascript:/vbscript: and dangerous data: URLs in any attribute value.
  //    Neutralize the scheme so the attribute becomes inert rather than active.
  out = out.replace(
    /(\s(?:href|src|action|formaction|xlink:href|background|poster)\s*=\s*["'])\s*(?:javascript|vbscript)\s*:/gi,
    '$1#blocked:',
  );
  // data: — block ALL non-raster-image data: URIs (data:text/html, data:application/*,
  //   and crucially data:image/svg+xml, which can carry script). Only raster images
  //   (png/jpeg/gif/webp) are allowed through; everything else is neutralized.
  out = out.replace(
    /(\s(?:href|src|action|formaction|xlink:href|background|poster)\s*=\s*["'])\s*data\s*:\s*([^"';,)\s]*)/gi,
    (full, prefix, mime) =>
      /^image\/(?:png|jpeg|jpg|gif|webp)\b/i.test(mime) ? full : `${prefix}#blocked:`,
  );

  return out;
}

/**
 * Run the outbound publish gate over generated HTML.
 *
 * Sanitizes the HTML and decides publish status. Deny-by-default: a page is
 * 'published' only when it passes. The caller persists publish_status +
 * safety_version + publish_block_reason so the serve route can enforce the gate.
 *
 * @param {string} html - Raw model-generated HTML.
 * @returns {{ html: string, publishStatus: 'published'|'blocked', safetyVersion: number, blockReason: string|null }}
 */
export function runPublishGate(html) {
  if (typeof html !== 'string' || html.trim().length === 0) {
    return {
      html: '',
      publishStatus: 'blocked',
      safetyVersion: REDESIGN_SAFETY_VERSION,
      blockReason: 'Empty or missing generated HTML',
    };
  }

  const sanitized = sanitizeUntrustedHtml(html);

  // Cheap pragmatic check: after sanitization, no executable <script> (other than
  // inline JSON-LD) and no surviving javascript:/vbscript: scheme should remain.
  // If any did, the sanitizer has a bug and the page does NOT pass the gate.
  // An external-src JSON-LD script is NOT exempt (the sanitizer strips it), so the
  // exemption here also requires src to be absent.
  const hasExecutableScript =
    /<script\b(?![^>]*type\s*=\s*["']application\/ld\+json["'])[^>]*>/i.test(sanitized)
    || /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*\ssrc\s*=/i.test(sanitized);
  // Residual javascript:/vbscript: in any of the SAME attributes the sanitizer
  // targets (href/src/action/formaction/xlink:href/background/poster). Kept
  // consistent with the sanitizer's attribute list so a future sanitizer bug on
  // any of those attributes is still caught by the gate — without false-positiving
  // on the scheme merely appearing in visible prose/text content.
  const hasJsScheme =
    /(?:href|src|action|formaction|xlink:href|background|poster)\s*=\s*["']\s*(?:javascript|vbscript)\s*:/i.test(sanitized);

  if (hasExecutableScript || hasJsScheme) {
    return {
      html: sanitized,
      publishStatus: 'blocked',
      safetyVersion: REDESIGN_SAFETY_VERSION,
      blockReason: 'Generated HTML failed publish gate (residual active content after sanitization)',
    };
  }

  return {
    html: sanitized,
    publishStatus: 'published',
    safetyVersion: REDESIGN_SAFETY_VERSION,
    blockReason: null,
  };
}

/**
 * Is a persisted work_item safe to serve publicly?
 * Deny-by-default: must be explicitly published AND stamped with the current
 * safety version (so pages predating the current gate logic are re-screened).
 *
 * @param {object} metadata - work_items.metadata jsonb.
 * @returns {boolean}
 */
export function isServable(metadata) {
  if (!metadata || typeof metadata !== 'object') return false;
  return metadata.publish_status === 'published'
    && metadata.safety_version === REDESIGN_SAFETY_VERSION;
}
