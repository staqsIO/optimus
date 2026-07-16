/**
 * DOCX exporter for engagement specs — mirrors lib/contracts/docx-render.js
 * so spec exports carry the same brand (fonts, sizes, colors, header logo,
 * footer chrome) as contracts.
 *
 * Resolution order for the brand:
 *   1. engagement.client → counterparty.name match → counterparty.brand_profile_id
 *   2. is_default = true                                  (house default)
 *   3. FALLBACK_BRAND constant                            (renderer-only guarantee)
 *
 * The body is markdown — engagement specs are markdown-canonical, unlike
 * contracts which can be HTML (TipTap autosave). We keep the engagement-
 * specific block parser (handles fences, blockquotes, pipe tables, nested
 * bullets) and thread brand fonts/sizes through every TextRun so the
 * rendered DOCX matches the contract typography pixel-for-pixel where the
 * structure overlaps.
 *
 * Two entry points:
 *   - markdownToDocxBuffer(markdown)              back-compat; uses default brand
 *   - renderEngagementSpecDocx({ markdown, engagement, spec })  brand-resolved
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  ShadingType,
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

import { getCapability } from '../runtime/capability-registry.js';

// Plan 037: brand-profile loaders are injected by the product via the capability
// registry (lib/* no longer imports lib/contracts/*). These thin resolvers keep
// the call sites below unchanged. When the capability is unregistered (e.g. the
// markdown-only path in tests), getCapability throws inside safeLoad(), which
// swallows it and buildDoc() falls back to FALLBACK_BRAND — byte-for-byte the
// same behaviour as the pre-inversion "brand load failed" path.
function loadBrandProfileForEngagement(engagementId) {
  return getCapability('contracts/brand-profile').loadBrandProfileForEngagement(engagementId);
}
function loadDefaultBrandProfile() {
  return getCapability('contracts/brand-profile').loadDefaultBrandProfile();
}

// docx font sizes are half-points. Calibrated against the iComply Proposal
// reference doc so contract + engagement exports look identical:
//   body=11pt, small=9pt, tiny=8pt, h1=22pt, h2=18pt, h3=14pt, title=22pt.
const SIZE = {
  body: 22,
  small: 18,
  tiny: 16,
  h1: 44,
  h2: 36,
  h3: 28,
  h4: 24,
  h5: 22,
  h6: 22,
  title: 44,
  meta: 18,
};

const COLOR = {
  text: '111111',
  muted: '666666',
  border: '999999',
  softBorder: 'D4D4D8',
  bg: 'FAFAFA',
};

const MONO_FONT = 'Consolas';

// Hard fallback when no brand profile resolves (fresh DB pre-mig 145, tests).
// Matches FALLBACK_BRAND in lib/contracts/docx-render.js byte-for-byte.
const FALLBACK_BRAND = {
  heading_font_family: 'Calibri',
  body_font_family: 'Calibri',
  brand_color_hex: COLOR.text,
  show_logo_in_header: false,
  footer_left_text: '',
  footer_show_page_number: false,
};

// US Letter at 0.75" margins → 7" usable → 10080 DXA. Same as contracts.
const PAGE_USABLE_DXA = 10080;

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: COLOR.softBorder };
const TABLE_FALLBACK_MAX_CELL_CHARS = 200;

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const HEADING_SIZES = [SIZE.h1, SIZE.h2, SIZE.h3, SIZE.h4, SIZE.h5, SIZE.h6];

// ───────────────────────────────────────────────────────────────────────────
// Public entry points
// ───────────────────────────────────────────────────────────────────────────

/**
 * Back-compat: convert markdown → docx Buffer using the house default brand.
 * No title block, no logo header, no footer chrome — those require engagement
 * + spec context. Use renderEngagementSpecDocx() for the full branded export.
 */
export async function markdownToDocxBuffer(markdown) {
  const brand = await safeLoad(loadDefaultBrandProfile);
  return buildDoc({
    markdown,
    brand,
    title: null,
    metaParts: [],
  });
}

/**
 * Branded engagement spec DOCX. Resolves the brand profile from the
 * engagement, builds a title block + logo header + footer to match the
 * contract template, and threads the brand through every text run in the
 * body.
 */
export async function renderEngagementSpecDocx({ markdown, engagement, spec }) {
  const brand = engagement?.id
    ? (await safeLoad(() => loadBrandProfileForEngagement(engagement.id))) || (await safeLoad(loadDefaultBrandProfile))
    : await safeLoad(loadDefaultBrandProfile);

  const title = engagement?.name || 'Engagement spec';
  const metaParts = [];
  if (engagement?.client) metaParts.push(`Client: ${engagement.client}`);
  if (engagement?.is_master) metaParts.push('Role: Master spec (baseline standards)');
  else if (engagement?.kind) metaParts.push(`Kind: ${engagement.kind}`);
  if (spec?.version != null) metaParts.push(`Spec v${spec.version}`);
  if (spec?.last_synth_at) {
    metaParts.push(`Synthesized ${new Date(spec.last_synth_at).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  }

  // The markdown renderer in lib/engagements/exporter.js leads with a `# title`
  // and a `> meta` blockquote. We render those structurally via the title
  // block instead, so strip them from the body to avoid duplication.
  const cleanedMarkdown = stripLeadingTitleAndMeta(markdown);

  return buildDoc({
    markdown: cleanedMarkdown,
    brand,
    title,
    metaParts,
  });
}

async function safeLoad(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Document assembly
// ───────────────────────────────────────────────────────────────────────────

async function buildDoc({ markdown, brand, title, metaParts }) {
  const profile = brand?.profile || FALLBACK_BRAND;
  const assets = brand?.assets || {};

  const blocks = parseMarkdownBlocks(markdown || '');
  const titleBlock = title ? buildTitleBlock({ title, metaParts, profile }) : [];
  const bodyChildren = blocksToDocxChildren(blocks, profile);

  // Font embeds — include every available TTF so the recipient sees the
  // brand even without the fonts installed. Mirrors contracts.
  const fontEmbeds = collectFontEmbeds(profile, assets);

  const header = buildPageHeader({ profile, assets });
  const footer = buildPageFooter({ profile });

  const doc = new Document({
    creator: 'UMB Advisors',
    title: title || 'Engagement spec',
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
        heading4: {
          run: { font: profile.heading_font_family, color: profile.brand_color_hex, size: SIZE.h4, bold: true },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 }, // US Letter
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
        children: [...titleBlock, ...bodyChildren],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function collectFontEmbeds(profile, assets) {
  const out = [];
  const kindToFamily = {
    font_heading_regular:     profile.heading_font_family,
    font_heading_bold:        profile.heading_font_family,
    font_heading_italic:      profile.heading_font_family,
    font_heading_bold_italic: profile.heading_font_family,
    font_body_regular:        profile.body_font_family,
    font_body_bold:           profile.body_font_family,
    font_body_italic:         profile.body_font_family,
    font_body_bold_italic:    profile.body_font_family,
  };
  for (const [kind, asset] of Object.entries(assets || {})) {
    if (!asset || !kind.startsWith('font_')) continue;
    const family = kindToFamily[kind];
    if (!family) continue;
    out.push({
      name: family,
      data: Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data),
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Title block + header + footer (mirror of contracts/docx-render.js)
// ───────────────────────────────────────────────────────────────────────────

function buildTitleBlock({ title, metaParts, profile }) {
  return [
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [
        new TextRun({
          text: title,
          font: profile.heading_font_family,
          color: profile.brand_color_hex,
          size: SIZE.title,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 280 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.border, space: 6 } },
      children: [
        new TextRun({
          text: metaParts.length ? metaParts.join(' · ') : '',
          size: SIZE.meta,
          color: COLOR.muted,
          font: profile.body_font_family,
        }),
      ],
    }),
  ];
}

function buildPageHeader({ profile, assets }) {
  if (!profile.show_logo_in_header) return null;
  const logo = assets?.logo;
  if (!logo?.data) return null;

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

function buildPageFooter({ profile }) {
  const leftText = profile.footer_left_text || '';
  const showPage = profile.footer_show_page_number;
  if (!leftText && !showPage) return null;
  const bodyFont = profile.body_font_family;

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
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children,
      }),
    ],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Block stream → docx children, brand-threaded
// ───────────────────────────────────────────────────────────────────────────

function blocksToDocxChildren(blocks, profile) {
  const children = [];
  const headingBase = { font: profile.heading_font_family, color: profile.brand_color_hex };
  const bodyBase    = { font: profile.body_font_family, color: COLOR.text };

  for (const block of blocks) {
    if (block.type === 'heading') {
      const lvl = Math.min(block.level, 6);
      const size = HEADING_SIZES[lvl - 1] || SIZE.h3;
      children.push(new Paragraph({
        heading: HEADING_LEVELS[lvl],
        spacing: { before: 240, after: 120 },
        children: renderInline(block.text, { ...headingBase, size, bold: lvl >= 3 }),
      }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({
        spacing: { after: 160 },
        children: renderInline(block.text, { ...bodyBase, size: SIZE.body }),
      }));
    } else if (block.type === 'bullet') {
      children.push(new Paragraph({
        bullet: { level: block.level || 0 },
        spacing: { after: 80 },
        children: renderInline(block.text, { ...bodyBase, size: SIZE.body }),
      }));
    } else if (block.type === 'blockquote') {
      children.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 160 },
        children: renderInline(block.text, { ...bodyBase, size: SIZE.body, italics: true }),
      }));
    } else if (block.type === 'code') {
      for (const line of block.lines) {
        children.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F4F4F5' },
          children: [new TextRun({ text: line, font: MONO_FONT, size: SIZE.small })],
        }));
      }
    } else if (block.type === 'hr') {
      children.push(new Paragraph({
        spacing: { before: 120, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.border, space: 1 } },
        children: [new TextRun({ text: '' })],
      }));
    } else if (block.type === 'table') {
      const maxCellLen = Math.max(
        ...block.header.map((c) => c.length),
        ...block.rows.flatMap((r) => r.map((c) => c.length))
      );
      if (maxCellLen > TABLE_FALLBACK_MAX_CELL_CHARS) {
        // Prose-heavy cells render as "Header: value" paragraphs.
        for (const row of block.rows) {
          for (let i = 0; i < row.length; i++) {
            const label = block.header[i] || `Column ${i + 1}`;
            children.push(new Paragraph({
              spacing: { after: 80 },
              children: [
                new TextRun({ text: `${label}: `, bold: true, font: profile.body_font_family, size: SIZE.body, color: COLOR.text }),
                ...renderInline(row[i] || '', { ...bodyBase, size: SIZE.body }),
              ],
            }));
          }
          children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
        }
      } else {
        children.push(buildTable(block, profile));
      }
    }
    // Blank-line markdown tokens are intentionally NOT emitted as empty
    // paragraphs. Paragraph/heading/bullet `spacing` properties carry the
    // visual rhythm; emitting an empty paragraph per blank line stacks ~14pt
    // of dead air on top of intentional spacing and bloats every section
    // break to ~25pt+ instead of the intended ~12pt.
  }
  return children;
}

function buildTable(block, profile) {
  const colCount = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  const colWidth = Math.floor(PAGE_USABLE_DXA / colCount);
  const columnWidths = Array(colCount).fill(colWidth);
  const bodyFont = profile.body_font_family;

  const headerCell = (text) =>
    new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [
            new TextRun({ text, bold: true, font: bodyFont, size: SIZE.small, color: COLOR.text }),
          ],
        }),
      ],
    });

  const bodyCell = (text) =>
    new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: renderInline(text, { font: bodyFont, size: SIZE.small, color: COLOR.text }),
        }),
      ],
    });

  const headerRow = new TableRow({
    tableHeader: true,
    children: padCells(block.header, colCount).map(headerCell),
  });
  const bodyRows = block.rows.map(
    (row) => new TableRow({ children: padCells(row, colCount).map(bodyCell) })
  );
  return new Table({
    width: { size: PAGE_USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths,
    rows: [headerRow, ...bodyRows],
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER },
  });
}

function padCells(cells, n) {
  const out = cells.slice();
  while (out.length < n) out.push('');
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Markdown parser (engagement-specific; unchanged contract from the
// pre-branding version)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Strip the leading `# title` heading and `> meta` blockquote that
 * exporter.renderSpecAsMarkdown writes. Those are rendered structurally as
 * the title block now.
 */
function stripLeadingTitleAndMeta(md) {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // Skip leading blanks.
  while (i < lines.length && !lines[i].trim()) i++;
  // First non-blank is "# title"? skip it.
  if (i < lines.length && /^#\s+/.test(lines[i])) i++;
  // Then any blank lines.
  while (i < lines.length && !lines[i].trim()) i++;
  // Then a "> meta" blockquote — skip the contiguous quote block.
  if (i < lines.length && lines[i].startsWith('>')) {
    while (i < lines.length && (lines[i].startsWith('>') || !lines[i].trim())) {
      // Stop when we hit a blank that's followed by non-quote content.
      if (!lines[i].trim()) {
        if (i + 1 < lines.length && !lines[i + 1].startsWith('>')) { i++; break; }
      }
      i++;
    }
  }
  return lines.slice(i).join('\n');
}

function parseMarkdownBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { blocks.push({ type: 'blank' }); i++; continue; }

    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      blocks.push({ type: 'heading', level: hMatch[1].length, text: hMatch[2].trim() });
      i++; continue;
    }

    if (/^\s*(\*\*\*|---|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' }); i++; continue;
    }

    if (line.startsWith('```')) {
      const codeLines = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lines: codeLines });
      continue;
    }

    if (line.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, '')); i++;
      }
      blocks.push({ type: 'blockquote', text: quoted.join(' ').trim() });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(lines[i]); i++;
      }
      if (rows.length >= 2) {
        const header = splitTableRow(rows[0]);
        const body = rows.slice(2).map(splitTableRow);
        blocks.push({ type: 'table', header, rows: body });
        continue;
      }
    }

    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      blocks.push({
        type: 'bullet',
        level: Math.min(Math.floor(indent / 2), 4),
        text: bulletMatch[3].trim(),
      });
      i++; continue;
    }

    const numMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numMatch) {
      blocks.push({ type: 'paragraph', text: line.trim() });
      i++; continue;
    }

    const paraLines = [line]; i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !lines[i].startsWith('```')
    ) { paraLines.push(lines[i]); i++; }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ').trim() });
  }
  return blocks;
}

function splitTableRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/**
 * Inline → TextRun[]. base carries the brand font + size + color; emphasis
 * tokens inherit base and overlay bold/italic/codespan flags.
 */
function renderInline(text, base = {}) {
  if (!text) return [new TextRun({ ...base, text: '' })];
  const runs = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) {
      runs.push(new TextRun({ ...base, text: tok.slice(2, -2), bold: true }));
    } else if (tok.startsWith('`')) {
      runs.push(new TextRun({ ...base, text: tok.slice(1, -1), font: MONO_FONT, size: SIZE.small }));
    } else {
      runs.push(new TextRun({ ...base, text: tok.slice(1, -1), italics: true }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ ...base, text: text.slice(last) }));
  return runs.length ? runs : [new TextRun({ ...base, text: '' })];
}
