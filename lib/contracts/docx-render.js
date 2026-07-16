/**
 * Render a contract + signature audit trail to DOCX.
 *
 * Mirrors lib/contracts/pdf-render.js — same query, same content,
 * same audit block. Built with the `docx` library so Word output
 * approximates the PDF's typography (Calibri body, sized headings,
 * bordered audit block, monospaced hashes) rather than passing through
 * raw HTML.
 *
 * The body can arrive as either markdown (fresh contract from a
 * template file) or HTML (TipTap autosave / AI Bar edit). Same detection
 * heuristic as pdf-render.js; both shapes are normalized into a common
 * block stream that emits docx Paragraph/Table elements.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  VerticalAlign,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  ShadingType,
  LevelFormat,
  Header,
  Footer,
  ImageRun,
  PageNumber,
  Tab,
  TabStopType,
  TabStopPosition,
  TableLayoutType,
  convertInchesToTwip,
} from 'docx';

// US Letter at 0.75" margins → 7" usable → 10080 DXA (1" = 1440 DXA).
// Tables MUST set explicit column widths + fixed layout, otherwise Word
// collapses each column to ~10px and wraps every character to its own
// line. Same gotcha that bit lib/engagements/docx-export.js; same fix.
const PAGE_USABLE_DXA = 10080;
import { marked } from 'marked';
import { createChildLogger } from '../logger.js';
import { loadContractRenderContext } from './render-context.js';

const log = createChildLogger({ module: 'contracts/docx-render' });

const TWIP_PER_INCH = 1440;
const MONO_FONT = 'Consolas';

// docx font sizes are in half-points (22 = 11pt). Calibrated against the
// iComply Proposal final docx (the reference brand doc) so generated PDFs/
// DOCXs match: title/H1=22pt, H2=18pt, H3=14pt, body=11pt. See styles.xml
// extraction in the commit message for the source-of-truth audit.
const SIZE = {
  body: 22,        // 11pt
  small: 18,       //  9pt — table cells, footer chrome, audit fields
  tiny: 16,        //  8pt — hash strings, ESIGN footnote
  h1: 44,          // 22pt — section title (## in markdown)
  h2: 36,          // 18pt — sub-section (### in markdown)
  h3: 28,          // 14pt — sub-sub-section
  title: 44,       // 22pt — contract title block (matches H1)
  brand: 18,       //  9pt — small chrome
  meta: 18,        //  9pt — "Prepared for · Created…" line
  auditTitle: 24,  // 12pt — "SIGNATURE AUDIT TRAIL"
};

const COLOR = {
  text: '111111',
  muted: '666666',
  border: '999999',
  softBorder: 'D4D4D8',
  bg: 'FAFAFA',
  signed: '047857',
  declined: 'B91C1C',
  pending: 'B45309',
  expired: '71717A',
};

// Hard fallback when no brand profile resolves at all (fresh DB before
// migration 145 runs, or in tests). The renderer worked with these
// settings before brand profiles existed.
const FALLBACK_BRAND = {
  heading_font_family: 'Calibri',
  body_font_family: 'Calibri',
  brand_color_hex: COLOR.text,
  show_logo_in_header: false,
  footer_left_text: '',
  footer_show_page_number: false,
};

/**
 * @param {Object} opts
 * @param {string} opts.draftId
 * @returns {Promise<Buffer>} DOCX bytes
 */
export async function renderContractDocx({ draftId }) {
  // Data load + brand resolution shared with renderContractPdf; see
  // render-context.js. FALLBACK_BRAND stays local — it differs by output
  // substrate (Word needs a real font name; the PDF path uses a CSS stack).
  const { row, request, signers, latestEvents, profile, assets } =
    await loadContractRenderContext({ draftId, fallbackBrand: FALLBACK_BRAND });

  const startedAt = Date.now();

  const meta = typeof row.seo_metadata === 'string'
    ? JSON.parse(row.seo_metadata)
    : (row.seo_metadata || {});

  const titleBlockChildren = buildTitleBlock({
    title: row.title,
    meta,
    createdAt: row.created_at,
    brand: profile,
  });
  const bodyChildren = buildBody(row.body || '', profile);
  const auditChildren = request
    ? buildAudit({ request, signers, latestEvents }, profile)
    : [];

  // Embedded fonts — pass every TTF asset that's present so the recipient
  // sees the brand even if they don't have the fonts installed locally.
  const fontEmbeds = [];
  const fontKindToFamily = {
    font_heading_regular:     [profile.heading_font_family, false, false],
    font_heading_bold:        [profile.heading_font_family, true,  false],
    font_heading_italic:      [profile.heading_font_family, false, true],
    font_heading_bold_italic: [profile.heading_font_family, true,  true],
    font_body_regular:        [profile.body_font_family,    false, false],
    font_body_bold:           [profile.body_font_family,    true,  false],
    font_body_italic:         [profile.body_font_family,    false, true],
    font_body_bold_italic:    [profile.body_font_family,    true,  true],
  };
  for (const [kind, asset] of Object.entries(assets)) {
    if (!asset || !kind.startsWith('font_')) continue;
    const [family] = fontKindToFamily[kind] || [];
    if (!family) continue;
    fontEmbeds.push({
      name: family,
      data: Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data),
    });
  }

  // Page header (logo) + footer (confidentiality label + page number).
  const header = buildPageHeader({ brand: profile, assets });
  const footer = buildPageFooter({ brand: profile });

  const doc = new Document({
    creator: 'UMB Advisors',
    title: row.title,
    ...(fontEmbeds.length ? { fonts: fontEmbeds } : {}),
    styles: {
      default: {
        document: {
          run: { font: profile.body_font_family, size: SIZE.body, color: COLOR.text },
        },
        heading1: {
          run: { font: profile.heading_font_family, color: profile.brand_color_hex, size: SIZE.h1, bold: false },
          paragraph: { spacing: { before: 360, after: 160 } },
        },
        heading2: {
          run: { font: profile.heading_font_family, color: profile.brand_color_hex, size: SIZE.h2, bold: false },
          paragraph: { spacing: { before: 280, after: 120 } },
        },
        heading3: {
          run: { font: profile.heading_font_family, color: profile.brand_color_hex, size: SIZE.h3, bold: true },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'ol-default',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: '%2.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 }, // US Letter in twips
            margin: {
              top: convertInchesToTwip(0.75),
              bottom: convertInchesToTwip(0.75),
              left: convertInchesToTwip(0.75),
              right: convertInchesToTwip(0.75),
              header: convertInchesToTwip(0.4),
              footer: convertInchesToTwip(0.4),
            },
          },
        },
        headers: header ? { default: header } : undefined,
        footers: footer ? { default: footer } : undefined,
        children: [...titleBlockChildren, ...bodyChildren, ...auditChildren],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  log.info({
    draftId,
    profileId: profile?.id || null,
    profileSlug: profile?.slug || null,
    fontEmbeds: fontEmbeds.length,
    sizeBytes: buffer.length,
    renderMs: Date.now() - startedAt,
  }, 'Contract DOCX rendered');
  return buffer;
}

// ─── In-document title block ──────────────────────────────────────────────
// Renders right after the page header (logo). The title uses the brand's
// heading font + color (via the heading1 style applied through HeadingLevel)
// — no need to repeat the brand wordmark since the logo is in the page
// header.

function buildTitleBlock({ title, meta, createdAt, brand }) {
  const metaParts = [];
  if (meta?.client_name) metaParts.push(`Prepared for ${meta.client_name}`);
  if (meta?.proposal_number) metaParts.push(`Proposal ${meta.proposal_number}`);
  metaParts.push(`Created ${new Date(createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);

  return [
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [
        new TextRun({
          text: title,
          font: brand.heading_font_family,
          color: brand.brand_color_hex,
          size: SIZE.title,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 280 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.border, space: 6 } },
      children: [
        new TextRun({ text: metaParts.join(' · '), size: SIZE.meta, color: COLOR.muted, font: brand.body_font_family }),
      ],
    }),
  ];
}

// ─── Page header (logo) ───────────────────────────────────────────────────

function buildPageHeader({ brand, assets }) {
  if (!brand.show_logo_in_header) return null;
  const logo = assets.logo;
  if (!logo?.data) return null;

  // Word treats `transformation` in EMU-derived units; docx accepts pixels at
  // 96 dpi and converts. Cap the displayed logo at ~150 px wide so it sits
  // unobtrusively in the header strip; preserve aspect via the stored dims.
  const targetWidth = 150;
  const aspect = (logo.height || 81) / (logo.width || 444);
  const targetHeight = Math.round(targetWidth * aspect);

  return new Header({
    children: [
      new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [
          new ImageRun({
            type: 'png',
            data: Buffer.isBuffer(logo.data) ? logo.data : Buffer.from(logo.data),
            transformation: { width: targetWidth, height: targetHeight },
          }),
        ],
      }),
    ],
  });
}

// ─── Page footer (confidentiality + page number) ──────────────────────────

function buildPageFooter({ brand }) {
  const leftText = brand.footer_left_text || '';
  const showPage = brand.footer_show_page_number;
  if (!leftText && !showPage) return null;
  const bodyFont = brand.body_font_family;

  const children = [];
  if (leftText) children.push(new TextRun({ text: leftText, size: SIZE.tiny, color: COLOR.muted, font: bodyFont }));
  if (leftText && showPage) {
    children.push(new TextRun({ children: [new Tab()], size: SIZE.tiny, font: bodyFont }));
  }
  if (showPage) {
    children.push(
      new TextRun({
        children: [PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
        size: SIZE.tiny,
        color: COLOR.muted,
        font: bodyFont,
      })
    );
  }

  return new Footer({
    children: [
      new Paragraph({
        // Right-align via a single tab-stop pinned to the right margin.
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children,
      }),
    ],
  });
}

// ─── Body ──────────────────────────────────────────────────────────────────

function buildBody(rawBody, brand) {
  // Same detection as pdf-render: tag-like sequence ⇒ HTML; otherwise markdown.
  const isHtml = /<[a-z][\s\S]*?>/i.test(rawBody);
  const tokens = isHtml ? htmlToTokens(rawBody) : marked.lexer(rawBody);
  return tokensToBlocks(tokens, brand);
}

// ─── Marked / token-tree → docx blocks ────────────────────────────────────

function tokensToBlocks(tokens, brand) {
  const out = [];
  for (const t of tokens) {
    const blocks = tokenToBlocks(t, brand);
    if (blocks) out.push(...blocks);
  }
  return out;
}

function tokenToBlocks(t, brand) {
  if (!t) return [];
  switch (t.type) {
    case 'heading': {
      return [makeHeadingParagraph({
        depth: t.depth || 1,
        inline: inlineTokensFrom(t),
        brand,
      })];
    }
    case 'paragraph': {
      const tokens = t.tokens || [{ type: 'text', text: t.text || '' }];
      // Fallback: section-label-shaped paragraphs (e.g. "1. SCOPE OF SERVICES",
      // "RETAINER HOURS INCLUDED") that the upstream LLM emitted as flat text
      // without ## markers. Promote to an H2 so the doc has a visible section
      // structure instead of a wall of body text. See contract-drafter.js's
      // SYSTEM_PROMPT rule E — the prompt now demands proper heading syntax,
      // but pre-existing drafts and any LLM regression still need this safety net.
      const inferred = inferSectionHeadingDepth(tokens);
      if (inferred) {
        return [makeHeadingParagraph({ depth: inferred, inline: tokens, brand })];
      }
      return [
        new Paragraph({
          spacing: { after: 160 },
          children: inlineToRuns(tokens, { font: brand.body_font_family, size: SIZE.body }),
        }),
      ];
    }
    case 'space':
      return [];
    case 'hr':
      return [
        new Paragraph({
          spacing: { before: 120, after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.border, space: 1 } },
        }),
      ];
    case 'list': {
      const items = [];
      for (const item of t.items || []) {
        const inline = collectListItemInlines(item);
        items.push(
          new Paragraph({
            spacing: { after: 80 },
            ...(t.ordered
              ? { numbering: { reference: 'ol-default', level: 0 } }
              : { bullet: { level: 0 } }),
            children: inlineToRuns(inline, { font: brand.body_font_family, size: SIZE.body }),
          })
        );
        // Nested list, if any
        for (const nested of item.tokens || []) {
          if (nested.type === 'list') items.push(...tokenToBlocks(nested, brand));
        }
      }
      return items;
    }
    case 'code':
      return [
        new Paragraph({
          spacing: { after: 160 },
          shading: { type: ShadingType.CLEAR, fill: 'F4F4F5' },
          children: [
            new TextRun({ text: t.text || '', font: MONO_FONT, size: SIZE.small }),
          ],
        }),
      ];
    case 'blockquote':
      return (t.tokens || []).map((sub) => {
        const blocks = tokenToBlocks(sub, brand);
        for (const b of blocks) {
          // dodge non-Paragraph (e.g., Table) — only indent paragraphs
          if (b instanceof Paragraph) {
            b.options ??= {};
          }
        }
        return blocks;
      }).flat();
    case 'table':
      return [buildMarkdownTable(t, brand)];
    case 'html':
      // Inline HTML mixed into a markdown doc — re-tokenize via the HTML path.
      return tokensToBlocks(htmlToTokens(t.text || ''), brand);
    default:
      if (t.text) {
        return [
          new Paragraph({
            spacing: { after: 160 },
            children: [new TextRun({ text: t.text, font: brand.body_font_family, size: SIZE.body })],
          }),
        ];
      }
      return [];
  }
}

function makeHeadingParagraph({ depth, inline, brand }) {
  const level = Math.min(Math.max(depth, 1), 3);
  const headingLevel = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1];
  const size = [SIZE.h1, SIZE.h2, SIZE.h3][level - 1];
  // Brand heading runs use the heading font + brand color. H1/H2 are not
  // bold (serif display faces look heavy when bolded); H3 stays bold so
  // it reads as a sub-section heading rather than body text.
  const base = {
    font: brand.heading_font_family,
    color: brand.brand_color_hex,
    size,
    bold: level === 3,
  };
  return new Paragraph({
    heading: headingLevel,
    spacing: { before: 240, after: 120 },
    children: inlineToRuns(inline, base),
  });
}

// Detect "this paragraph is actually a section header the LLM forgot to
// mark with ##". Conservative — we only promote when the paragraph text
// is clearly a section label, not when it could plausibly be body text.
// Returns the heading depth (2 or 3) or 0 if no promotion should happen.
function inferSectionHeadingDepth(tokens) {
  // Reduce token tree to bare text + a "wholly wrapped in bold" flag, so we
  // can recognize both plain-text and **fully bolded** labels.
  const { text, plainOnly, fullyBold } = flattenInlineForHeuristic(tokens);
  if (!plainOnly && !fullyBold) return 0;
  const t = text.trim();
  if (!t || t.length > 80) return 0;
  // Numbered top-level section, e.g. "1. SCOPE OF SERVICES",
  // "10. LIMITATION OF LIABILITY". Must lead with a number, dot, space.
  if (/^\d+\.\s+[A-Z][A-Z0-9 &,'/()\-.]+$/.test(t)) return 2;
  // Unnumbered sub-section label that's entirely uppercase / mostly-uppercase,
  // e.g. "SCOPE OF WORK", "RETAINER HOURS INCLUDED". At least 2 uppercase
  // words and no terminal colon (colons signal a label-with-value, not a
  // section header).
  if (!t.endsWith(':') && /^[A-Z][A-Z &,'/()\-.]{3,}(?:\s+[A-Z&][A-Z &,'/()\-.]*){1,}$/.test(t)) return 3;
  return 0;
}

function flattenInlineForHeuristic(tokens) {
  let text = '';
  let plainOnly = true;
  let fullyBold = false;
  if (tokens.length === 1 && tokens[0].type === 'strong') {
    // The entire paragraph is one **...** — treat as plain-text candidate but
    // remember it was bolded (LLMs sometimes bold a "section header" instead
    // of marking it with ##).
    fullyBold = true;
    for (const sub of tokens[0].tokens || []) {
      if (sub.type === 'text' || sub.type === 'escape') text += sub.text || '';
      else { plainOnly = false; break; }
    }
  } else {
    for (const t of tokens) {
      if (t.type === 'text' || t.type === 'escape') text += t.text || '';
      else { plainOnly = false; break; }
    }
  }
  return { text, plainOnly, fullyBold };
}

function collectListItemInlines(item) {
  // marked list items: { tokens: [{type:'text', tokens:[...]}|{type:'paragraph', tokens:[...]}|...] }
  const inlines = [];
  for (const tok of item.tokens || []) {
    if (tok.type === 'text' || tok.type === 'paragraph') {
      inlines.push(...(tok.tokens || [{ type: 'text', text: tok.text || '' }]));
    } else if (tok.type === 'list') {
      // handled by caller
    } else if (tok.text) {
      inlines.push({ type: 'text', text: tok.text });
    }
  }
  return inlines;
}

function inlineTokensFrom(t) {
  if (t.tokens && t.tokens.length) return t.tokens;
  if (t.text != null) return [{ type: 'text', text: t.text }];
  return [];
}

function inlineToRuns(tokens, base = {}) {
  const runs = [];
  for (const t of tokens || []) {
    if (!t) continue;
    switch (t.type) {
      case 'text':
      case 'escape':
        runs.push(new TextRun({ ...base, text: t.text ?? '' }));
        break;
      case 'strong':
        runs.push(...inlineToRuns(t.tokens, { ...base, bold: true }));
        break;
      case 'em':
        runs.push(...inlineToRuns(t.tokens, { ...base, italics: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({ ...base, text: t.text ?? '', font: MONO_FONT, size: SIZE.small }));
        break;
      case 'del':
        runs.push(...inlineToRuns(t.tokens, { ...base, strike: true }));
        break;
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      case 'link':
        runs.push(
          ...inlineToRuns(
            t.tokens || [{ type: 'text', text: t.text ?? t.href ?? '' }],
            { ...base, color: '2563EB' }
          )
        );
        break;
      case 'html':
        // Inline html (e.g., <br/>); re-flatten if recognizable, else drop.
        if (/^<br\s*\/?>$/i.test(t.text)) {
          runs.push(new TextRun({ break: 1 }));
        } else {
          // Strip tags so the text isn't lost.
          const stripped = String(t.text || '').replace(/<[^>]+>/g, '');
          if (stripped) runs.push(new TextRun({ ...base, text: stripped }));
        }
        break;
      default:
        if (t.text) runs.push(new TextRun({ ...base, text: t.text }));
    }
  }
  return runs;
}

// ─── Markdown table → docx Table ──────────────────────────────────────────

function buildMarkdownTable(t, brand) {
  // colCount drives both per-cell width and the table's columnWidths array.
  // Without these + layout: FIXED, Word collapses each column to ~10px and
  // breaks every character onto its own line (the iComply rendering bug).
  const headerArr = t.header || [];
  const colCount = Math.max(1, headerArr.length, ...(t.rows || []).map((r) => r.length));
  const colWidth = Math.floor(PAGE_USABLE_DXA / colCount);
  const columnWidths = Array(colCount).fill(colWidth);

  const padTo = (arr) => {
    if (arr.length >= colCount) return arr;
    const out = arr.slice();
    while (out.length < colCount) out.push({ tokens: [{ type: 'text', text: '' }], text: '' });
    return out;
  };

  // Header cells: bold body font (NOT heading font / brand color). Using the
  // heading font here made table headers look like document headings —
  // gold serif text inside the table cell — which read as broken structure
  // in Pages. Keep them as bold sans body text instead.
  const headerCells = padTo(headerArr).map((cell) => {
    const inline = cell.tokens || [{ type: 'text', text: cell.text || '' }];
    return new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: inlineToRuns(inline, {
        bold: true,
        size: SIZE.small,
        font: brand?.body_font_family,
      }) })],
    });
  });

  const headerRow = new TableRow({ tableHeader: true, children: headerCells });

  const bodyRows = (t.rows || []).map(
    (row) =>
      new TableRow({
        children: padTo(row).map(
          (cell) =>
            new TableCell({
              width: { size: colWidth, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: inlineToRuns(
                    cell.tokens || [{ type: 'text', text: cell.text || '' }],
                    { size: SIZE.small, font: brand?.body_font_family }
                  ),
                }),
              ],
            })
        ),
      })
  );

  return new Table({
    width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths,
    rows: [headerRow, ...bodyRows],
    borders: cellBorders('CCCCCC'),
  });
}

function cellBorders(color) {
  const b = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
}

// ─── HTML parser → marked-shaped token tree ───────────────────────────────
//
// TipTap emits a constrained subset of HTML, so a tiny tag-stack parser is
// enough. We deliberately don't pull in a full DOM library — the surface we
// support is enumerated below.

const VOID_TAGS = new Set(['br', 'hr', 'img']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'pre', 'hr']);

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function tokenizeHtml(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;
  while (i < len) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { tokens.push({ kind: 'text', text: html.slice(i) }); break; }
      const inner = html.slice(i + 1, end);
      i = end + 1;
      if (inner.startsWith('!--')) continue;
      if (inner.startsWith('!')) continue;
      if (inner.startsWith('/')) {
        tokens.push({ kind: 'close', tag: inner.slice(1).trim().toLowerCase() });
        continue;
      }
      const selfClose = inner.endsWith('/');
      const cleaned = selfClose ? inner.slice(0, -1).trim() : inner.trim();
      const m = cleaned.match(/^([a-zA-Z][a-zA-Z0-9-]*)(\s[\s\S]*)?$/);
      if (!m) continue;
      const tag = m[1].toLowerCase();
      const attrsRaw = (m[2] || '').trim();
      tokens.push({
        kind: 'open',
        tag,
        attrs: parseAttrs(attrsRaw),
        selfClose: selfClose || VOID_TAGS.has(tag),
      });
    } else {
      const next = html.indexOf('<', i);
      const text = decodeEntities(next === -1 ? html.slice(i) : html.slice(i, next));
      if (text) tokens.push({ kind: 'text', text });
      i = next === -1 ? len : next;
    }
  }
  return tokens;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * Parse HTML into a tree of nodes: { tag, attrs, children }.
 */
function parseHtmlTree(html) {
  const tokens = tokenizeHtml(html);
  const root = { tag: '__root__', children: [] };
  const stack = [root];
  for (const tk of tokens) {
    const top = stack[stack.length - 1];
    if (tk.kind === 'text') {
      top.children.push({ type: 'text', text: tk.text });
    } else if (tk.kind === 'open') {
      const node = { tag: tk.tag, attrs: tk.attrs || {}, children: [] };
      top.children.push(node);
      if (!tk.selfClose) stack.push(node);
    } else if (tk.kind === 'close') {
      // Pop until the matching tag, tolerating mismatched tags.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tk.tag) {
          stack.length = i;
          break;
        }
      }
    }
  }
  return root;
}

/**
 * Convert the HTML tree into the same token shape marked.lexer produces, so
 * tokenToBlocks() can render both paths uniformly.
 */
function htmlToTokens(html) {
  const root = parseHtmlTree(html);
  const out = [];
  collectBlocks(root, out);
  // Merge consecutive li nodes outside ul/ol — defensive against malformed input
  return out;
}

function collectBlocks(node, out) {
  for (const child of node.children) {
    if (child.type === 'text') {
      const text = child.text.replace(/\s+/g, ' ').trim();
      if (text) {
        out.push({ type: 'paragraph', tokens: [{ type: 'text', text }] });
      }
      continue;
    }
    const tag = child.tag;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      out.push({
        type: 'heading',
        depth: parseInt(tag.slice(1), 10),
        tokens: inlineFromChildren(child.children),
      });
    } else if (tag === 'p' || tag === 'div') {
      const inline = inlineFromChildren(child.children);
      if (inline.length) out.push({ type: 'paragraph', tokens: inline });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [];
      for (const c of child.children) {
        if (c.type === 'text') continue;
        if (c.tag === 'li') {
          const liInline = [];
          const nested = [];
          for (const lc of c.children) {
            if (lc.type === 'text') {
              const t = lc.text.replace(/\s+/g, ' ');
              if (t.trim()) liInline.push({ type: 'text', text: t });
            } else if (lc.tag === 'ul' || lc.tag === 'ol') {
              const sub = [];
              collectBlocks({ children: [lc] }, sub);
              nested.push(...sub);
            } else if (lc.tag === 'p') {
              liInline.push(...inlineFromChildren(lc.children));
            } else {
              liInline.push(...inlineFromChildren([lc]));
            }
          }
          items.push({ tokens: [{ type: 'text', tokens: liInline }, ...nested.map(n => n)] });
        }
      }
      out.push({ type: 'list', ordered: tag === 'ol', items });
    } else if (tag === 'table') {
      out.push(htmlTableToToken(child));
    } else if (tag === 'blockquote') {
      const inner = [];
      collectBlocks(child, inner);
      out.push({ type: 'blockquote', tokens: inner });
    } else if (tag === 'pre') {
      // Treat <pre> contents as code block
      const text = textContent(child);
      out.push({ type: 'code', text });
    } else if (tag === 'hr') {
      out.push({ type: 'hr' });
    } else if (tag === 'br') {
      // standalone <br> at block level — emit empty paragraph spacer
      out.push({ type: 'paragraph', tokens: [{ type: 'text', text: '' }] });
    } else {
      // Treat unknown blocks as paragraphs of their inline content
      const inline = inlineFromChildren(child.children);
      if (inline.length) out.push({ type: 'paragraph', tokens: inline });
    }
  }
}

function htmlTableToToken(tableNode) {
  const headerCells = [];
  const rows = [];
  let inHead = false;
  let firstRowAsHeader = true;

  // Walk thead/tbody/tr
  for (const child of tableNode.children) {
    if (child.type === 'text') continue;
    if (child.tag === 'thead') {
      inHead = true;
      for (const tr of child.children) {
        if (tr.type === 'text' || tr.tag !== 'tr') continue;
        for (const cell of tr.children) {
          if (cell.type === 'text' || (cell.tag !== 'th' && cell.tag !== 'td')) continue;
          headerCells.push({ tokens: inlineFromChildren(cell.children), text: textContent(cell) });
        }
        firstRowAsHeader = false;
      }
      inHead = false;
    } else if (child.tag === 'tbody' || child.tag === 'tr') {
      const trList = child.tag === 'tr' ? [child] : child.children.filter((c) => c.tag === 'tr');
      for (const tr of trList) {
        const cells = [];
        for (const cell of tr.children) {
          if (cell.type === 'text' || (cell.tag !== 'th' && cell.tag !== 'td')) continue;
          if (firstRowAsHeader && headerCells.length === 0 && cell.tag === 'th') {
            headerCells.push({ tokens: inlineFromChildren(cell.children), text: textContent(cell) });
          } else {
            cells.push({ tokens: inlineFromChildren(cell.children), text: textContent(cell) });
          }
        }
        if (firstRowAsHeader && headerCells.length > 0 && cells.length === 0) {
          firstRowAsHeader = false;
          continue;
        }
        if (cells.length) rows.push(cells);
        firstRowAsHeader = false;
      }
    }
  }

  return { type: 'table', header: headerCells, rows };
}

function textContent(node) {
  if (node.type === 'text') return node.text;
  let s = '';
  for (const c of node.children || []) s += textContent(c);
  return s;
}

function inlineFromChildren(children) {
  const out = [];
  for (const c of children) {
    if (c.type === 'text') {
      const text = c.text.replace(/\s+/g, ' ');
      if (text) out.push({ type: 'text', text });
    } else if (c.tag === 'strong' || c.tag === 'b') {
      out.push({ type: 'strong', tokens: inlineFromChildren(c.children) });
    } else if (c.tag === 'em' || c.tag === 'i') {
      out.push({ type: 'em', tokens: inlineFromChildren(c.children) });
    } else if (c.tag === 'code') {
      out.push({ type: 'codespan', text: textContent(c) });
    } else if (c.tag === 'br') {
      out.push({ type: 'br' });
    } else if (c.tag === 'a') {
      out.push({ type: 'link', href: c.attrs?.href || '', tokens: inlineFromChildren(c.children) });
    } else if (c.tag === 's' || c.tag === 'del') {
      out.push({ type: 'del', tokens: inlineFromChildren(c.children) });
    } else if (c.tag === 'span' || c.tag === 'u') {
      // Pass-through unknown inline wrappers
      out.push(...inlineFromChildren(c.children));
    } else {
      // Drop unknown block-ish tags inside inline context, but keep their text.
      const text = textContent(c).replace(/\s+/g, ' ').trim();
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
}

// ─── Audit trail ──────────────────────────────────────────────────────────

function buildAudit({ request, signers, latestEvents }, brand) {
  const eventsById = new Map(latestEvents.map((e) => [e.signer_id, e]));

  const children = [];

  // Section heading rule — uses brand heading font/color so the audit
  // section reads as part of the document, not a foreign block.
  children.push(
    new Paragraph({
      spacing: { before: 480, after: 120 },
      border: { top: { style: BorderStyle.SINGLE, size: 12, color: brand.brand_color_hex || '111111', space: 6 } },
      children: [
        new TextRun({
          text: 'SIGNATURE AUDIT TRAIL',
          font: brand.heading_font_family,
          color: brand.brand_color_hex,
          size: SIZE.auditTitle,
          bold: true,
          characterSpacing: 20,
        }),
      ],
    })
  );

  // Request metadata box
  children.push(buildAuditMetaTable(request, brand));

  // Per-signer blocks
  for (const s of signers) {
    children.push(buildSignerBlock(s, eventsById.get(s.id), brand));
  }

  // Footer note
  children.push(
    new Paragraph({
      spacing: { before: 240 },
      children: [
        new TextRun({
          text:
            'Electronic signatures captured under the ESIGN Act and UETA. Each signer event is linked via a SHA-256 hash chain verifiable against the source of truth in signatures.signature_events.',
          size: SIZE.tiny,
          italics: true,
          color: COLOR.expired,
          font: brand.body_font_family,
        }),
      ],
    })
  );

  return children;
}

function buildAuditMetaTable(request, brand) {
  const bodyFont = brand?.body_font_family;
  const rows = [
    ['Request ID', request.id],
    ['Signing mode', request.signing_mode],
    ['Request status', request.status],
    ['Sent by', request.created_by || 'unknown'],
    ['Sent at', new Date(request.created_at).toISOString()],
    ['Hash formula', `v${request.hash_version}`],
    ['Document hash', request.document_hash],
  ];

  // 30/70 split in DXA, fixed layout — percentage widths alone aren't enough
  // to keep Word from collapsing cells to single-char columns.
  const labelCol = Math.floor(PAGE_USABLE_DXA * 0.30);
  const valueCol = PAGE_USABLE_DXA - labelCol;
  return new Table({
    width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [labelCol, valueCol],
    borders: cellBorders('E4E4E7'),
    rows: rows.map(([label, value], i) =>
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR.bg },
            width: { size: labelCol, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: label, size: SIZE.small, color: COLOR.muted, font: bodyFont })],
              }),
            ],
          }),
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR.bg },
            width: { size: valueCol, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [
                  label === 'Document hash'
                    ? new TextRun({ text: String(value), size: SIZE.tiny, font: MONO_FONT })
                    : new TextRun({ text: String(value), size: SIZE.small, font: bodyFont }),
                ],
              }),
            ],
          }),
        ],
      })
    ),
  });
}

function buildSignerBlock(signer, event, brand) {
  const bodyFont = brand?.body_font_family;
  const statusColor =
    signer.status === 'signed' ? COLOR.signed
    : signer.status === 'declined' ? COLOR.declined
    : signer.status === 'pending' ? COLOR.pending
    : COLOR.expired;

  // Fixed-layout 30/70 split in DXA. Percentage widths alone don't survive
  // Word's auto-collapse; the audit table needs explicit twip widths or
  // the IP-address / hash columns wrap each character to a new line.
  const labelColDxa = Math.floor(PAGE_USABLE_DXA * 0.30);
  const valueColDxa = PAGE_USABLE_DXA - labelColDxa;

  const labelCell = (text) =>
    new TableCell({
      width: { size: labelColDxa, type: WidthType.DXA },
      margins: { top: 40, bottom: 40, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, size: SIZE.small, color: COLOR.muted, font: bodyFont })],
        }),
      ],
    });

  const valueCell = (run) =>
    new TableCell({
      width: { size: valueColDxa, type: WidthType.DXA },
      margins: { top: 40, bottom: 40, left: 120, right: 120 },
      children: [new Paragraph({ children: Array.isArray(run) ? run : [run] })],
    });

  const rows = [
    new TableRow({
      children: [
        new TableCell({
          columnSpan: 2,
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [new TextRun({ text: signer.display_name || '(unnamed signer)', size: SIZE.small, bold: true, font: bodyFont })],
            }),
          ],
        }),
      ],
    }),
    new TableRow({
      children: [labelCell('Email'), valueCell(new TextRun({ text: signer.email || '', size: SIZE.small, font: bodyFont }))],
    }),
    new TableRow({
      children: [
        labelCell('Status'),
        valueCell(new TextRun({ text: String(signer.status || ''), size: SIZE.small, color: statusColor, bold: true, font: bodyFont })),
      ],
    }),
  ];

  if (signer.completed_at) {
    rows.push(
      new TableRow({
        children: [
          labelCell('Completed'),
          valueCell(new TextRun({ text: new Date(signer.completed_at).toISOString(), size: SIZE.small, font: bodyFont })),
        ],
      })
    );
  }
  if (event?.typed_name) {
    rows.push(
      new TableRow({
        children: [labelCell('Typed name'), valueCell(new TextRun({ text: `"${event.typed_name}"`, size: SIZE.small, font: bodyFont }))],
      })
    );
  }
  if (event?.ip_address) {
    rows.push(
      new TableRow({
        children: [labelCell('IP address'), valueCell(new TextRun({ text: String(event.ip_address), size: SIZE.small, font: bodyFont }))],
      })
    );
  }
  if (event?.hash_chain_current_hex) {
    rows.push(
      new TableRow({
        children: [
          labelCell('Final chain hash'),
          valueCell(new TextRun({ text: event.hash_chain_current_hex, size: SIZE.tiny, font: MONO_FONT })),
        ],
      })
    );
  }

  return new Table({
    width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [labelColDxa, valueColDxa],
    borders: cellBorders(COLOR.softBorder),
    rows,
  });
}
