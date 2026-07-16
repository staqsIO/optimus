/**
 * Render a contract + signature audit trail to PDF.
 *
 * Uses Playwright (already a dependency; see lib/scrapers/playwright.js)
 * via setContent + page.pdf() — no network requests, so startup is just
 * Chromium cold-boot (~1-2s). Not fast enough to render on every list
 * request; only call on-demand from the "Download PDF" action.
 *
 * The rendered PDF has three sections:
 *   1. Header — contract title, counterparty, prepared-by, document hash
 *   2. Body  — markdown-rendered contract text
 *   3. Audit trail — per-signer block with completion timestamp, typed
 *      name, IP, and the hash_chain_current from their final event
 *
 * Deliberately includes the hash anchor and per-signer chain hashes in
 * the printed output. That makes the PDF independently verifiable against
 * the DB later — a counsel / auditor can take the printed hashes and ask
 * the board to re-run signatures.verify_signature_chain on the live row.
 */

import { createChildLogger } from '../logger.js';
import { loadContractRenderContext } from './render-context.js';

const log = createChildLogger({ module: 'contracts/pdf-render' });

// Hard fallback when brand resolution fails entirely (pre-migration DB,
// tests). Mirrors the renderer's pre-branding defaults.
const FALLBACK_BRAND = {
  heading_font_family: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
  body_font_family: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
  brand_color_hex: '111111',
  show_logo_in_header: false,
  footer_left_text: '',
  footer_show_page_number: false,
};

/**
 * Shared Chromium instance. Cold-starting per-render was ~1-2s; a
 * long-lived browser makes subsequent renders ~200-400ms each. Crashed
 * browsers are detected via the `disconnected` event and relaunched on
 * next use. SIGTERM/SIGINT handlers close it cleanly so Railway doesn't
 * kill orphaned Chromium processes.
 *
 * This is a singleton, not a pool — one renderer at a time is fine
 * because PDF generation is bursty (signing events, not list loads) and
 * Chromium handles serial page.pdf() calls without contention. If
 * concurrency pressure ever shows up, swap browser.newContext() for a
 * per-render browser or an actual pool.
 */
let sharedBrowserPromise = null;

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    const b = await sharedBrowserPromise;
    if (b.isConnected()) return b;
    // Previous browser died — drop the cached promise and relaunch.
    log.warn('Shared PDF browser lost its connection — relaunching');
    sharedBrowserPromise = null;
  }
  sharedBrowserPromise = (async () => {
    const { chromium } = await import('playwright');
    // In the Alpine Docker image we install Chromium via apk and point
    // Playwright at it via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (the env
    // var Playwright reads natively). In local dev the bundled browser
    // works fine, so we only pass executablePath when the env is set.
    const launchOpts = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      // Alpine's chromium needs --no-sandbox unless the container is
      // granted SYS_ADMIN. Railway containers aren't, so pass it.
      launchOpts.args = ['--no-sandbox', '--disable-setuid-sandbox'];
    }
    const browser = await chromium.launch(launchOpts);
    browser.on('disconnected', () => {
      log.warn('Shared PDF browser disconnected');
      sharedBrowserPromise = null;
    });
    // Graceful shutdown — only register once per process.
    if (!globalThis.__pdfBrowserShutdownHooked) {
      globalThis.__pdfBrowserShutdownHooked = true;
      for (const sig of ['SIGTERM', 'SIGINT', 'beforeExit']) {
        process.on(sig, () => {
          if (!sharedBrowserPromise) return;
          sharedBrowserPromise.then(b => b.close()).catch(() => {});
        });
      }
    }
    log.info('Shared PDF browser launched');
    return browser;
  })();
  return sharedBrowserPromise;
}

/**
 * @param {Object} opts
 * @param {string} opts.draftId
 * @returns {Promise<Buffer>} PDF bytes
 */
export async function renderContractPdf({ draftId }) {
  // Data load + brand resolution shared with renderContractDocx; see
  // render-context.js. FALLBACK_BRAND stays local — it differs by output
  // substrate (the PDF/CSS path uses a system-font stack; Word needs a real
  // font name). Asset bytes (logo PNG + TTFs) are inlined as data: URLs in
  // the HTML so the render is hermetic — no fetches, no font surprises.
  const { row, request, signers, latestEvents, profile, assets } =
    await loadContractRenderContext({ draftId, fallbackBrand: FALLBACK_BRAND });

  const html = buildHtml({ row, request, signers, latestEvents, profile, assets });
  const headerTemplate = buildHeaderTemplate({ profile, assets });
  const footerTemplate = buildFooterTemplate({ profile });
  const useChrome = Boolean(headerTemplate || footerTemplate);

  const browser = await getSharedBrowser();
  // Fresh context per render — isolated cookies / storage, disposed at
  // the end so one render's JS errors can't leak into the next.
  const context = await browser.newContext();
  const startedAt = Date.now();
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      // Chromium needs displayHeaderFooter to be true for the
      // header/footer templates to render; we only enable when there's
      // something to show (otherwise it injects default date/URL chrome).
      displayHeaderFooter: useChrome,
      ...(useChrome ? { headerTemplate, footerTemplate } : {}),
      // When chrome is enabled, leave a tiny extra top/bottom so the
      // header logo and footer text don't collide with body content.
      margin: useChrome
        ? { top: '1.1in', bottom: '0.85in', left: '0.75in', right: '0.75in' }
        : { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' },
    });
    log.info({
      draftId,
      profileId: profile?.id || null,
      profileSlug: profile?.slug || null,
      sizeBytes: pdfBuffer.length,
      renderMs: Date.now() - startedAt,
    }, 'Contract PDF rendered');
    return pdfBuffer;
  } finally {
    await context.close().catch(() => {});
  }
}

// ─── Header / footer templates (Chromium's printable header/footer) ──────
//
// Chromium accepts a tiny HTML fragment per page header/footer. Standard
// classes (.title, .pageNumber, .totalPages) get substituted at print
// time. We keep the header logo as a data: URL so no fetch happens.

function buildHeaderTemplate({ profile, assets }) {
  if (!profile.show_logo_in_header) return '';
  const logo = assets?.logo;
  if (!logo?.data) return '';
  const b64 = (Buffer.isBuffer(logo.data) ? logo.data : Buffer.from(logo.data)).toString('base64');
  const aspect = (logo.height || 81) / (logo.width || 444);
  const w = 150; // px in PDF
  const h = Math.round(w * aspect);
  return `<div style="font-size:8px; width:100%; padding:0 0.75in; box-sizing:border-box; text-align:left;">
    <img src="data:image/png;base64,${b64}" style="width:${w}px; height:${h}px;" />
  </div>`;
}

function buildFooterTemplate({ profile }) {
  const leftText = profile.footer_left_text || '';
  const showPage = profile.footer_show_page_number;
  if (!leftText && !showPage) return '';
  const left = leftText ? escapeHtml(leftText) : '';
  const right = showPage
    ? '<span class="pageNumber"></span> of <span class="totalPages"></span>'
    : '';
  return `<div style="font-size:8px; color:#71717a; width:100%; padding:0 0.75in; box-sizing:border-box; display:flex; justify-content:space-between; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">
    <span>${left}</span>
    <span>${right}</span>
  </div>`;
}

/**
 * Build the full HTML document for Playwright to render.
 * Intentionally inline-styled — no external stylesheets so the render is
 * deterministic and doesn't depend on fetched resources.
 */
function buildHtml({ row, request, signers, latestEvents, profile, assets }) {
  // The body can arrive in two shapes:
  //   1. Markdown — freshly-created contracts use the template files verbatim
  //      until the operator starts editing.
  //   2. HTML — once the TipTap editor's autosave fires, or after an AI Bar
  //      edit, the body is HTML. Running HTML through renderMarkdown()
  //      escapes the tags and they print as literal text.
  // Detect and branch. Same heuristic as ContractEditor.tsx's replaceBody().
  const isHtml = /<[a-z][\s\S]*?>/i.test(row.body || '');
  const renderedBody = promoteSectionHeaders(isHtml ? row.body : renderMarkdown(row.body));
  const meta = typeof row.seo_metadata === 'string'
    ? JSON.parse(row.seo_metadata)
    : (row.seo_metadata || {});

  const auditBlock = request ? buildAuditHtml({ request, signers, latestEvents, profile }) : '';
  const fontFaceCss = buildFontFaceCss({ profile, assets });
  const brandColor = `#${profile.brand_color_hex || '111111'}`;

  // Quoted family names so multi-word fonts ("DM Sans", "Cormorant Garamond")
  // resolve correctly when used directly in CSS; fall through to system fonts
  // when no custom font was loaded.
  const headingFamily = `"${cssEscape(profile.heading_font_family)}", Georgia, serif`;
  const bodyFamily    = `"${cssEscape(profile.body_font_family)}", -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(row.title)}</title>
  <style>
    ${fontFaceCss}
    @page { size: Letter; }
    * { box-sizing: border-box; }
    body {
      font-family: ${bodyFamily};
      font-size: 11pt;
      line-height: 1.55;
      color: #111;
      margin: 0;
    }
    .header {
      border-bottom: 1px solid #999;
      padding-bottom: 12px;
      margin-bottom: 18px;
    }
    /* Heading sizes match the iComply reference brand doc (the
       source-of-truth audit) — H1=22pt, H2=18pt, H3=14pt. font-weight 600
       on the brand serif looks ok in print but the heading style itself
       carries enough visual weight; H1/H2 stay 500 so the serif strokes
       don't fatten. H3 stays bolder so it reads as a sub-section label. */
    .header h1 { font-family: ${headingFamily}; color: ${brandColor}; font-size: 22pt; margin: 0 0 6px; font-weight: 500; }
    .header .meta { font-size: 9pt; color: #666; }
    .body h1, .body h2, .body h3 { font-family: ${headingFamily}; color: ${brandColor}; margin-top: 16pt; margin-bottom: 6pt; }
    .body h1 { font-size: 22pt; font-weight: 500; }
    .body h2 { font-size: 18pt; font-weight: 500; }
    .body h3 { font-size: 14pt; font-weight: 700; }
    .body p { margin: 0 0 8pt; }
    .body ul, .body ol { padding-left: 20pt; margin: 0 0 8pt; }
    .body table {
      border-collapse: collapse;
      width: 100%;
      margin: 8pt 0;
      font-size: 10pt;
    }
    .body th, .body td {
      border: 1px solid #ccc;
      padding: 4pt 6pt;
      text-align: left;
    }
    .body th { background: #f5f5f5; font-weight: 600; }
    .body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10pt;
      background: #f4f4f5;
      padding: 1pt 3pt;
      border-radius: 2pt;
    }
    .audit {
      margin-top: 32pt;
      padding-top: 16pt;
      border-top: 2px solid #111;
      page-break-inside: avoid;
    }
    .audit h2 {
      font-family: ${headingFamily};
      color: ${brandColor};
      font-size: 12pt;
      font-weight: 600;
      margin: 0 0 10pt;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .audit-meta {
      background: #fafafa;
      border: 1px solid #e4e4e7;
      padding: 8pt 10pt;
      margin-bottom: 10pt;
      font-size: 9pt;
    }
    .audit-meta dt { color: #666; display: inline-block; min-width: 110pt; }
    .audit-meta dd { display: inline; margin: 0; color: #111; }
    .audit-meta .row { display: block; margin: 2pt 0; }
    .audit-meta .hash { font-family: ui-monospace, monospace; font-size: 8pt; word-break: break-all; }
    .signer {
      border: 1px solid #d4d4d8;
      padding: 8pt 10pt;
      margin-bottom: 6pt;
      font-size: 9pt;
    }
    .signer-name { font-weight: 600; font-size: 10pt; margin-bottom: 4pt; }
    .signer-row { margin: 2pt 0; }
    .signer-label { color: #666; display: inline-block; min-width: 100pt; }
    .signer-value { color: #111; }
    .signer-hash { font-family: ui-monospace, monospace; font-size: 8pt; word-break: break-all; }
    .status-signed   { color: #047857; font-weight: 600; }
    .status-declined { color: #b91c1c; font-weight: 600; }
    .status-pending  { color: #b45309; }
    .status-expired  { color: #71717a; }
    .footer-note {
      font-size: 8pt;
      color: #71717a;
      margin-top: 16pt;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(row.title)}</h1>
    <div class="meta">
      ${meta.client_name ? `Prepared for ${escapeHtml(meta.client_name)}` : ''}
      ${meta.proposal_number ? ` · Proposal ${escapeHtml(meta.proposal_number)}` : ''}
      · Created ${new Date(row.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
    </div>
  </div>

  <div class="body">${renderedBody}</div>

  ${auditBlock}
</body>
</html>`;
}

function buildAuditHtml({ request, signers, latestEvents, profile }) {
  // Profile is currently used indirectly via the .audit h2 style hook (the
  // CSS in buildHtml() already applies the brand color). Passed through for
  // future audit-block branding hooks.
  void profile;
  const eventsById = new Map(latestEvents.map((e) => [e.signer_id, e]));

  const signerBlocks = signers.map((s) => {
    const ev = eventsById.get(s.id);
    const statusClass = `status-${s.status}`;
    return `
      <div class="signer">
        <div class="signer-name">${escapeHtml(s.display_name)}</div>
        <div class="signer-row">
          <span class="signer-label">Email</span>
          <span class="signer-value">${escapeHtml(s.email)}</span>
        </div>
        <div class="signer-row">
          <span class="signer-label">Status</span>
          <span class="signer-value ${statusClass}">${escapeHtml(s.status)}</span>
        </div>
        ${s.completed_at ? `
        <div class="signer-row">
          <span class="signer-label">Completed</span>
          <span class="signer-value">${new Date(s.completed_at).toISOString()}</span>
        </div>` : ''}
        ${ev?.typed_name ? `
        <div class="signer-row">
          <span class="signer-label">Typed name</span>
          <span class="signer-value">“${escapeHtml(ev.typed_name)}”</span>
        </div>` : ''}
        ${ev?.ip_address ? `
        <div class="signer-row">
          <span class="signer-label">IP address</span>
          <span class="signer-value">${escapeHtml(ev.ip_address)}</span>
        </div>` : ''}
        ${ev?.hash_chain_current_hex ? `
        <div class="signer-row">
          <span class="signer-label">Final chain hash</span>
          <span class="signer-value signer-hash">${ev.hash_chain_current_hex}</span>
        </div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="audit">
      <h2>Signature Audit Trail</h2>
      <div class="audit-meta">
        <div class="row"><dt>Request ID</dt><dd>${request.id}</dd></div>
        <div class="row"><dt>Signing mode</dt><dd>${escapeHtml(request.signing_mode)}</dd></div>
        <div class="row"><dt>Request status</dt><dd class="status-${request.status}">${escapeHtml(request.status)}</dd></div>
        <div class="row"><dt>Sent by</dt><dd>${escapeHtml(request.created_by || 'unknown')}</dd></div>
        <div class="row"><dt>Sent at</dt><dd>${new Date(request.created_at).toISOString()}</dd></div>
        <div class="row"><dt>Hash formula</dt><dd>v${request.hash_version}</dd></div>
        <div class="row"><dt>Document hash</dt><dd class="hash">${escapeHtml(request.document_hash)}</dd></div>
      </div>
      ${signerBlocks}
      <p class="footer-note">
        Electronic signatures captured under the ESIGN Act and UETA. Each signer event is linked
        via a SHA-256 hash chain verifiable against the source of truth in signatures.signature_events.
      </p>
    </div>`;
}

/**
 * Minimal markdown renderer — no external dep. Handles the markdown
 * features our templates actually use: headings, bold, italic, lists,
 * tables, paragraphs. Not a general-purpose renderer.
 */
function renderMarkdown(md) {
  const lines = (md || '').split('\n');
  const out = [];
  let inList = null;        // 'ul' | 'ol' | null
  let inTable = false;
  let tableAlignments = [];
  let paragraph = [];

  const flushPara = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineFormat(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };
  const flushTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
      tableAlignments = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Heading
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushPara(); flushList(); flushTable();
      const level = h[1].length;
      out.push(`<h${level}>${inlineFormat(h[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      flushPara(); flushList(); flushTable();
      out.push('<hr>');
      continue;
    }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      const nextLine = lines[i + 1] || '';
      const isHeader = !inTable && /^\|[\s:|-]+\|\s*$/.test(nextLine);
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!inTable && isHeader) {
        flushPara(); flushList();
        tableAlignments = nextLine.split('|').slice(1, -1).map((c) => {
          const t = c.trim();
          if (/^:.*:$/.test(t)) return 'center';
          if (/:$/.test(t)) return 'right';
          return 'left';
        });
        out.push('<table><thead><tr>' +
          cells.map((c, idx) => `<th style="text-align:${tableAlignments[idx] || 'left'}">${inlineFormat(c)}</th>`).join('') +
          '</tr></thead><tbody>');
        inTable = true;
        i += 1; // skip alignment row
        continue;
      }
      if (inTable) {
        out.push('<tr>' + cells.map((c, idx) =>
          `<td style="text-align:${tableAlignments[idx] || 'left'}">${inlineFormat(c)}</td>`
        ).join('') + '</tr>');
        continue;
      }
    } else if (inTable) {
      flushTable();
    }

    // Unordered list
    const ul = line.match(/^[\s]*[-*]\s+(.+)$/);
    if (ul) {
      flushPara(); flushTable();
      if (inList !== 'ul') { flushList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${inlineFormat(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^[\s]*\d+\.\s+(.+)$/);
    if (ol) {
      flushPara(); flushTable();
      if (inList !== 'ol') { flushList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${inlineFormat(ol[1])}</li>`);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      flushPara(); flushList(); flushTable();
      continue;
    }

    // Default: paragraph
    flushList(); flushTable();
    paragraph.push(line);
  }

  flushPara(); flushList(); flushTable();
  return out.join('\n');
}

function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Heading promotion (safety net for LLM-generated bodies) ─────────────
//
// The contract-drafter LLM was historically allowed to emit section labels
// as plain paragraphs ("1. SCOPE OF SERVICES") or bold paragraphs
// ("<p><strong>SCOPE OF WORK</strong></p>") instead of proper "## " /
// "### " markdown. The prompt now demands real headings, but pre-existing
// drafts (and any future regression) would render as a wall of body text.
// This pass detects label-shaped paragraphs and rewrites them as the right
// heading element. Conservative — only matches paragraphs whose ENTIRE
// content is a section-label-shaped string.

function promoteSectionHeaders(html) {
  if (!html) return html;
  // Allowed label chars after the leading uppercase letter. Letters/digits/
  // spaces plus the punctuation that shows up in real contract section
  // titles ("SCOPE OF WORK", "PAYMENTS, FEES & TAXES", "INDEMNIFICATION",
  // "REPORTS & DOCUMENTATION"). 4–80 chars after the lead.
  const labelInner = "[A-Z][A-Z0-9 &,'\\/().\\-]{3,79}";
  // Optional <strong>...</strong> wrapper because LLMs love bolding things.
  const wrap = (re) => new RegExp(re, 'g');
  // Numbered top-level — "1. SCOPE OF SERVICES" → <h2>.
  html = html.replace(
    wrap(`<p>\\s*(?:<strong>\\s*)?(\\d+\\.\\s+${labelInner})\\s*(?:<\\/strong>\\s*)?<\\/p>`),
    '<h2>$1</h2>'
  );
  // Unnumbered all-caps sub-section — "SCOPE OF WORK", "RETAINER HOURS INCLUDED" → <h3>.
  // Requires at least one space (so single-word ALL-CAPS labels like
  // "WARRANTIES" don't get promoted; they'd be ambiguous with body emphasis).
  html = html.replace(
    wrap(`<p>\\s*(?:<strong>\\s*)?(${labelInner}\\s+[A-Z&][A-Z &,'\\/().\\-]*)\\s*(?:<\\/strong>\\s*)?<\\/p>`),
    '<h3>$1</h3>'
  );
  return html;
}

// ─── Brand asset helpers ──────────────────────────────────────────────────

// Emit @font-face rules for every TTF in the brand profile. Embedding as
// base64 data URLs keeps the page render hermetic — Chromium never fetches
// the network and there's no font-substitution surprise at print time.
function buildFontFaceCss({ profile, assets }) {
  const rules = [];
  const map = [
    ['font_heading_regular',     profile.heading_font_family, 'normal', 'normal'],
    ['font_heading_bold',        profile.heading_font_family, 'bold',   'normal'],
    ['font_heading_italic',      profile.heading_font_family, 'normal', 'italic'],
    ['font_heading_bold_italic', profile.heading_font_family, 'bold',   'italic'],
    ['font_body_regular',        profile.body_font_family,    'normal', 'normal'],
    ['font_body_bold',           profile.body_font_family,    'bold',   'normal'],
    ['font_body_italic',         profile.body_font_family,    'normal', 'italic'],
    ['font_body_bold_italic',    profile.body_font_family,    'bold',   'italic'],
  ];
  for (const [kind, family, weight, style] of map) {
    const a = assets[kind];
    if (!a?.data || !family) continue;
    const buf = Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data);
    const b64 = buf.toString('base64');
    rules.push(
      `@font-face { font-family: "${cssEscape(family)}"; src: url(data:font/ttf;base64,${b64}) format("truetype"); font-weight: ${weight}; font-style: ${style}; font-display: block; }`
    );
  }
  return rules.join('\n    ');
}

// Strip characters that would break out of a CSS string context. Font
// family names from the brand profile are operator-supplied, so don't trust
// them.
function cssEscape(name) {
  return String(name || '').replace(/["\\<>]/g, '');
}
