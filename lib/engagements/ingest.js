/**
 * Engagement proposal ingest — three source branches.
 *
 *   paste  : raw text / markdown from a textarea
 *   upload : file content already read by the caller (e.g. .md from form upload)
 *   url    : fetch via lib/rag/normalizers/url.js, fail clearly when auth-walled
 *
 * Every successful ingest is embedded via lib/rag/embedder.js for future
 * cross-proposal retrieval. Embedding failure is non-fatal — the proposal
 * still lands, just without a vector. Synth doesn't require embeddings.
 */

import { insertProposal } from './db.js';
import { embedOne } from '../rag/embedder.js';
import { normalizeUrl } from '../rag/normalizers/url.js';
import { createLogger } from '../logger.js';

const log = createLogger('engagements/ingest');

// OpenAI text-embedding-3-small caps at ~8k tokens (~32k chars).
// Truncate aggressively to stay well under.
const EMBED_TRUNCATE_CHARS = 30_000;

async function tryEmbed(text) {
  try {
    return await embedOne(text.slice(0, EMBED_TRUNCATE_CHARS));
  } catch (err) {
    log.warn(`embedding failed (proposal still ingested): ${err.message}`);
    return null;
  }
}

/**
 * Ingest a pasted proposal.
 *
 * @param {object} args
 * @param {string} args.engagementId
 * @param {string} args.content  - raw markdown/text from the textarea
 * @param {string} [args.title]
 * @param {string} [args.kind='draft']  - draft|finalized|note
 * @param {string} [args.createdBy]
 * @returns the inserted proposal row
 */
export async function ingestPaste({ engagementId, content, title, kind = 'draft', createdBy }) {
  if (!engagementId) throw new Error('engagementId is required');
  const trimmed = (content || '').trim();
  if (!trimmed) throw new Error('content is empty');

  const embedding = await tryEmbed(trimmed);

  return insertProposal({
    engagementId,
    title: title || derivedTitleFromText(trimmed),
    kind,
    sourceType: 'paste',
    rawContent: trimmed,
    parsedMarkdown: trimmed,
    embedding,
    createdBy,
  });
}

/**
 * Ingest an uploaded file. Supports .md / .txt / .pdf / .docx.
 *
 * The caller passes binary content as base64 (`contentB64`) — the route
 * decodes it server-side and dispatches to a format-specific extractor.
 * Text files (.md/.txt) are decoded as UTF-8; PDFs route through
 * `lib/rag/normalizers/pdf.js`; .docx through `docx.js`.
 *
 * @param {object} args
 * @param {string} args.engagementId
 * @param {string} args.filename
 * @param {string} args.contentB64  - base64-encoded raw file bytes
 * @param {string} [args.kind='draft']
 * @param {string} [args.createdBy]
 */
export async function ingestUpload({ engagementId, filename, contentB64, kind = 'draft', createdBy }) {
  if (!engagementId) throw new Error('engagementId is required');
  if (!filename) throw new Error('filename is required');
  if (!contentB64 || typeof contentB64 !== 'string') {
    throw new Error('contentB64 is required (base64-encoded file bytes)');
  }

  const buf = Buffer.from(contentB64, 'base64');
  if (buf.length === 0) throw new Error('uploaded file is empty');

  const ext = filename.toLowerCase().split('.').pop();

  let parsedMarkdown;
  let rawContent;

  if (['md', 'markdown', 'txt'].includes(ext)) {
    parsedMarkdown = buf.toString('utf-8').trim();
    rawContent = parsedMarkdown;
    if (!parsedMarkdown) throw new Error('uploaded text file is empty after trim');
  } else if (ext === 'pdf') {
    const { extractPdf } = await import('../rag/normalizers/pdf.js');
    try {
      const result = await extractPdf(buf);
      parsedMarkdown = result.text;
      rawContent = result.text;
      log.info(`PDF ingest: ${filename} (${result.pageCount} pages, ${parsedMarkdown.length} chars)`);
    } catch (err) {
      // Surface the underlying code so the API route can return 4xx not 5xx.
      if (!err.code) err.code = 'PDF_PARSE_FAILED';
      throw err;
    }
  } else if (ext === 'docx') {
    const { extractDocx } = await import('../rag/normalizers/docx.js');
    try {
      const result = await extractDocx(buf);
      parsedMarkdown = result.text;
      rawContent = result.text;
      if (result.warnings?.length) {
        log.warn(`DOCX ingest warnings for ${filename}: ${result.warnings.slice(0, 3).join('; ')}`);
      }
      log.info(`DOCX ingest: ${filename} (${parsedMarkdown.length} chars)`);
    } catch (err) {
      if (!err.code) err.code = 'DOCX_PARSE_FAILED';
      throw err;
    }
  } else {
    const err = new Error(
      `Unsupported file type .${ext}. Accepted: .md, .txt, .pdf, .docx — or use the Paste tab.`
    );
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
  }

  const embedding = await tryEmbed(parsedMarkdown);

  return insertProposal({
    engagementId,
    title: filename,
    kind,
    sourceType: 'upload',
    sourceUri: filename,
    rawContent,
    parsedMarkdown,
    embedding,
    createdBy,
  });
}

/**
 * Ingest a URL. Best-effort: many real-world docs (Google Docs, Notion
 * private pages) are auth-walled and will fail. Caller should surface the
 * error message so the user can fall back to paste.
 *
 * @param {object} args
 * @param {string} args.engagementId
 * @param {string} args.url
 * @param {string} [args.kind='draft']
 * @param {string} [args.createdBy]
 */
export async function ingestUrl({ engagementId, url, kind = 'draft', createdBy }) {
  if (!engagementId) throw new Error('engagementId is required');
  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error('url must start with http(s)://');
  }

  let normalized;
  try {
    normalized = await normalizeUrl(url);
  } catch (err) {
    const wrapped = new Error(
      `Could not fetch ${url}: ${err.message}. If it's auth-walled, paste the content instead.`
    );
    wrapped.code = 'URL_FETCH_FAILED';
    throw wrapped;
  }

  const content = (normalized.content || '').trim();
  if (!content || content.length < 50) {
    const err = new Error(
      `Fetched ${url} but extracted no readable content (likely auth-walled or JS-rendered). Paste the content instead.`
    );
    err.code = 'URL_EMPTY';
    throw err;
  }

  const embedding = await tryEmbed(content);

  return insertProposal({
    engagementId,
    title: normalized.title || url,
    kind,
    sourceType: 'url',
    sourceUri: url,
    rawContent: content,
    parsedMarkdown: content,
    embedding,
    createdBy,
  });
}

function derivedTitleFromText(text) {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) || '';
  const cleaned = firstLine.replace(/^#+\s*/, '').trim();
  return cleaned.slice(0, 120) || 'Untitled proposal';
}
