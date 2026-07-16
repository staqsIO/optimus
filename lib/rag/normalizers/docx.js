/**
 * DOCX text extractor.
 *
 * Wraps mammoth's raw-text extractor. Mammoth's HTML conversion is richer
 * but for the spec-synth pipeline we want plain text — the LLM does the
 * structural work. `extractRawText` strips formatting, footnotes, and
 * complex elements without losing the paragraph flow.
 */

import mammoth from 'mammoth';

export async function extractDocx(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('extractDocx: expected a Node Buffer');
  }
  const result = await mammoth.extractRawText({ buffer });
  const text = (result?.value || '').trim();
  if (!text) {
    const err = new Error('DOCX contained no extractable text.');
    err.code = 'DOCX_EMPTY';
    throw err;
  }
  return {
    text,
    warnings: (result?.messages || []).filter((m) => m.type === 'warning').map((m) => m.message),
  };
}
