/**
 * Proposal ingest — extract content + branding from a third-party (or our
 * own) .docx file so the board can drop in a finished proposal and have
 * the system build the matching contract template + brand profile from it.
 *
 * What we pull out:
 *   * Content              → markdown body (via mammoth)
 *   * Heading + body font  → first w:rFonts in styles.xml's Heading1 / Normal
 *   * Brand color          → w:color on Heading1 style (UMB's gold lives here)
 *   * Logo                 → word/media/image1.* if present, prefer PNG
 *   * Embedded fonts       → word/fonts/*.ttf (Word's "embed fonts" output)
 *
 * The docx file is just a ZIP — we already use the same JSZip-style ad-hoc
 * extraction in tests, so no new dependency. mammoth handles the markdown
 * conversion. Everything is wrapped in defensive try/catch because user
 * uploads come in every shape.
 */

import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'contracts/proposal-ingest' });

/**
 * Extract content + brand assets from a .docx file.
 *
 * @param {Buffer} docxBuffer — raw bytes of the .docx
 * @returns {Promise<{
 *   title: string | null,
 *   markdown: string,
 *   plainText: string,
 *   brand: {
 *     heading_font_family: string | null,
 *     body_font_family:    string | null,
 *     brand_color_hex:     string | null,
 *   },
 *   assets: {
 *     logo:  { data: Buffer, mime: string, width: number|null, height: number|null } | null,
 *     fonts: Array<{ kind: string, data: Buffer, mime: 'font/ttf', filename: string }>,
 *   },
 * }>}
 */
export async function extractProposal(docxBuffer) {
  if (!Buffer.isBuffer(docxBuffer)) {
    throw new Error('extractProposal requires a Buffer');
  }

  // --- 1. Content via mammoth ----------------------------------------------
  const mammoth = (await import('mammoth')).default || (await import('mammoth'));
  let markdown = '';
  let plainText = '';
  let title = null;
  try {
    const md = await mammoth.convertToMarkdown({ buffer: docxBuffer });
    markdown = (md?.value || '').trim();
    // Strip mammoth's backslash escaping of punctuation — it's safe for our
    // downstream renderers (which don't apply markdown escapes to em-dashes
    // or periods anyway) and produces a noticeably cleaner document.
    markdown = markdown.replace(/\\([!.\-,()_*[\]<>:;'"`~])/g, '$1');
    // First H1 is the document title.
    const h1 = markdown.match(/^#\s+(.+?)\s*$/m);
    if (h1) title = h1[1].trim();
  } catch (err) {
    log.warn({ err: err.message }, 'mammoth markdown conversion failed');
  }
  try {
    const raw = await mammoth.extractRawText({ buffer: docxBuffer });
    plainText = (raw?.value || '').trim();
  } catch (err) {
    log.warn({ err: err.message }, 'mammoth raw-text extraction failed');
  }

  // --- 2. Unzip in-memory to grab styles.xml / theme1.xml / media ----------
  const files = await unzipDocx(docxBuffer);

  const brand = {
    heading_font_family: null,
    body_font_family: null,
    brand_color_hex: null,
  };

  const stylesXml = readUtf8(files['word/styles.xml']);
  if (stylesXml) {
    const h1Style = matchStyleBlock(stylesXml, 'Heading1');
    if (h1Style) {
      brand.heading_font_family = extractFontFromStyle(h1Style) || brand.heading_font_family;
      const colorMatch = h1Style.match(/<w:color\s+[^>]*w:val=["']([0-9A-Fa-f]{6})["']/);
      if (colorMatch) brand.brand_color_hex = colorMatch[1].toUpperCase();
    }
    const normal = matchStyleBlock(stylesXml, 'Normal');
    if (normal) {
      brand.body_font_family = extractFontFromStyle(normal) || brand.body_font_family;
    }
    // Fallback: pull any usable font name from rFonts if styles didn't yield.
    if (!brand.heading_font_family) {
      const any = stylesXml.match(/w:ascii=["']([^"']+)["']/);
      if (any) brand.heading_font_family = any[1];
    }
  }

  // The "Normal" style often inherits — it shows up as the heading font here
  // even when the visible body type is something else (Word leaves an
  // ascii=… that doesn't reflect the cascade). When word/fonts/ contains
  // embedded TTFs from a *second* family, treat that as the body type.
  {
    const families = new Set();
    for (const path of Object.keys(files)) {
      if (!path.startsWith('word/fonts/') || !/\.ttf$/i.test(path)) continue;
      const f = path.split('/').pop().replace(/\.ttf$/i, '');
      // Strip weight/style suffixes to recover the family.
      const fam = f
        .replace(/[-_]?(bold[-_]?italic|italic[-_]?bold|bold|italic|regular|oblique)$/i, '')
        .replace(/[-_]+$/, '');
      if (fam) families.add(fam);
    }
    if (families.size >= 2 && brand.heading_font_family) {
      const headingSlug = brand.heading_font_family.replace(/\s+/g, '').toLowerCase();
      // Pick the family that *doesn't* slug-match the heading font, prefer
      // shorter names (DMSans beats DMSans-CondensedBlack).
      const candidates = [...families]
        .filter((fam) => fam.toLowerCase() !== headingSlug && !fam.toLowerCase().includes(headingSlug))
        .sort((a, b) => a.length - b.length);
      if (candidates[0]) {
        // Re-space the camelCased family name so "DMSans" → "DM Sans".
        // Two passes: split UC-UC-lc transitions ("DMSans" → "DM Sans") AND
        // lc-UC transitions ("DmSans" → "Dm Sans"). Order matters — the
        // UC-UC-lc pass must run first to keep two-letter acronyms intact.
        brand.body_font_family = candidates[0]
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
    if (!brand.body_font_family) brand.body_font_family = brand.heading_font_family;
  }

  // Theme often carries the real palette — only consult if styles didn't.
  if (!brand.brand_color_hex) {
    const themeXml = readUtf8(files['word/theme/theme1.xml']);
    if (themeXml) {
      // First accent color, skipping the system pure white / black entries.
      const colors = [...themeXml.matchAll(/<a:srgbClr val=["']([0-9A-Fa-f]{6})["']/g)]
        .map((m) => m[1].toUpperCase())
        .filter((c) => c !== '000000' && c !== 'FFFFFF');
      if (colors[0]) brand.brand_color_hex = colors[0];
    }
  }

  // --- 3. Logo (prefer PNG in word/media/) --------------------------------
  let logo = null;
  for (const path of Object.keys(files)) {
    if (!path.startsWith('word/media/')) continue;
    if (!/\.(png|jpg|jpeg)$/i.test(path)) continue;
    const data = files[path];
    if (!data?.length) continue;
    const mime = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    // Prefer PNG over JPEG; first wins on tie.
    if (!logo || (mime === 'image/png' && logo.mime !== 'image/png')) {
      const dims = mime === 'image/png' ? pngDims(data) : { width: null, height: null };
      logo = { data, mime, width: dims.width, height: dims.height };
    }
  }

  // --- 4. Embedded fonts (Word's "embed fonts" feature) -------------------
  const fonts = [];
  for (const path of Object.keys(files)) {
    if (!path.startsWith('word/fonts/')) continue;
    if (!/\.ttf$/i.test(path)) continue;
    const filename = path.split('/').pop();
    const kind = guessFontKind(filename, brand);
    if (!kind) continue;
    fonts.push({ kind, data: files[path], mime: 'font/ttf', filename });
  }

  log.info({
    sizeBytes: docxBuffer.length,
    chars: markdown.length,
    headingFont: brand.heading_font_family,
    bodyFont: brand.body_font_family,
    color: brand.brand_color_hex,
    logo: logo ? `${logo.width || '?'}x${logo.height || '?'} ${logo.mime}` : null,
    fonts: fonts.length,
  }, 'Proposal ingest extracted');

  return { title, markdown, plainText, brand, assets: { logo, fonts } };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function readUtf8(buf) {
  if (!buf) return null;
  try { return Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf); }
  catch { return null; }
}

function matchStyleBlock(xml, styleId) {
  const re = new RegExp(
    `<w:style[^>]*w:styleId=["']${styleId}["'][^>]*>[\\s\\S]*?</w:style>`,
    'i'
  );
  const m = xml.match(re);
  return m ? m[0] : null;
}

function extractFontFromStyle(styleXml) {
  // Prefer ascii, then hAnsi, then first typeface found inside the block.
  const ascii = styleXml.match(/w:ascii=["']([^"']+)["']/);
  if (ascii) return ascii[1];
  const hAnsi = styleXml.match(/w:hAnsi=["']([^"']+)["']/);
  if (hAnsi) return hAnsi[1];
  return null;
}

/**
 * Map an embedded TTF filename onto our asset_kind taxonomy. Heuristic —
 * Word names files like "CormorantGaramond-bold.ttf". When the family
 * matches the heading font we tag it as font_heading_*, otherwise body.
 */
function guessFontKind(filename, brand) {
  const fn = filename.toLowerCase().replace(/\.ttf$/, '');
  let weight = 'regular';
  let italic = false;
  if (/bold[-_]?italic|italic[-_]?bold|bi/.test(fn)) { weight = 'bold'; italic = true; }
  else if (/bold/.test(fn)) { weight = 'bold'; }
  else if (/italic|oblique/.test(fn)) { italic = true; }

  const headingSlug = (brand.heading_font_family || '').replace(/\s+/g, '').toLowerCase();
  const bodySlug    = (brand.body_font_family    || '').replace(/\s+/g, '').toLowerCase();
  const matchesHeading = headingSlug && fn.includes(headingSlug);
  const matchesBody    = bodySlug    && fn.includes(bodySlug);

  let role;
  if (matchesHeading && !matchesBody) role = 'heading';
  else if (matchesBody && !matchesHeading) role = 'body';
  else if (matchesHeading) role = 'heading';
  else if (matchesBody) role = 'body';
  else role = null;

  if (!role) return null;
  const suffix = italic
    ? (weight === 'bold' ? 'bold_italic' : 'italic')
    : (weight === 'bold' ? 'bold' : 'regular');
  return `font_${role}_${suffix}`;
}

/**
 * Minimal in-process unzip — just enough for the .docx surface we care
 * about. Reads the End-Of-Central-Directory record, walks the central
 * directory, and inflates each entry. Handles store (0) and deflate (8).
 *
 * Pulling in `unzipper` / `node-stream-zip` would be cleaner but we avoid
 * adding a dep for ~50 lines of well-bounded code.
 */
async function unzipDocx(buffer) {
  const { inflateRaw } = await import('zlib');
  const { promisify } = await import('util');
  const inflateAsync = promisify(inflateRaw);

  // Find End of Central Directory (EOCD) signature 0x06054b50, scanning
  // backward from the end (it lives in the last 65557 bytes).
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid .docx (no EOCD record)');

  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const files = {};
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method     = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const uncompr    = buffer.readUInt32LE(p + 24);
    const nameLen    = buffer.readUInt16LE(p + 28);
    const extraLen   = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff   = buffer.readUInt32LE(p + 42);
    const name       = buffer.slice(p + 46, p + 46 + nameLen).toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;

    // Read the local file header to find where the actual data begins.
    if (buffer.readUInt32LE(localOff) !== 0x04034b50) continue;
    const localNameLen  = buffer.readUInt16LE(localOff + 26);
    const localExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buffer.slice(dataStart, dataStart + compressed);

    let content;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      try { content = await inflateAsync(raw); }
      catch (err) {
        log.warn({ name, err: err.message }, 'inflate failed; skipping entry');
        continue;
      }
    } else {
      log.warn({ name, method }, 'unsupported compression method; skipping entry');
      continue;
    }

    if (content.length !== uncompr) {
      log.warn({ name, expected: uncompr, got: content.length }, 'size mismatch');
    }
    files[name] = content;
  }
  return files;
}

/**
 * Pull (width, height) from a PNG IHDR chunk. PNG starts with an 8-byte
 * signature, then IHDR begins at offset 8 with length=13 + type "IHDR"
 * + width(4) + height(4). Cheap, no dep.
 */
function pngDims(buffer) {
  try {
    if (buffer.length < 24) return { width: null, height: null };
    const sig = buffer.slice(0, 8);
    if (sig[0] !== 0x89 || sig[1] !== 0x50 || sig[2] !== 0x4e || sig[3] !== 0x47) {
      return { width: null, height: null };
    }
    const width  = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}
