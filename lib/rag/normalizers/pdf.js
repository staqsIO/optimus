/**
 * PDF text extractor.
 *
 * Wraps pdf-parse to return a normalized { text, pageCount } shape. The
 * caller passes a Node Buffer (decoded base64 from the upload endpoint).
 * Layout is best-effort — pdf-parse concatenates page text without preserving
 * columns or tables. For proposal docs that's usually fine; if a doc has
 * complex layout we'll surface it as "looks scrambled" in the UI and fall
 * back to paste.
 */

export async function extractPdf(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('extractPdf: expected a Node Buffer');
  }
  const { PDFParse } = await import('pdf-parse');

  // pdf-parse v2 takes data via constructor and exposes getText().
  // Pass a Uint8Array view of the Buffer (no copy).
  const parser = new PDFParse({
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  });

  let result;
  try {
    result = await parser.getText();
  } catch (err) {
    const wrapped = new Error(`Could not parse PDF: ${err.message}`);
    wrapped.code = 'PDF_PARSE_FAILED';
    throw wrapped;
  }

  const text = (result?.text || '').trim();
  if (!text) {
    const err = new Error('PDF contained no extractable text — likely a scanned/image PDF.');
    err.code = 'PDF_NO_TEXT';
    throw err;
  }
  return {
    text,
    pageCount: result?.pages?.length || result?.numpages || null,
    info: result?.info || null,
  };
}
