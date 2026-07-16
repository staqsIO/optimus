import { safeFetch } from '../../net/ssrf.js';

/**
 * URL normalizer: fetches a web page, extracts readable text content,
 * returns normalized document for RAG ingestion.
 */
export async function normalizeUrl(url) {
  // SSRF guard: safeFetch validates the initial URL AND re-validates every
  // redirect target before following it (redirect: 'manual'), so an attacker's
  // 302 to an internal host cannot be followed. Throws SSRF_BLOCKED on a bad
  // hop — existing callers already handle normalizeUrl throwing.
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'Optimus-RAG/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const html = await res.text();

  // Simple HTML to text extraction (strip tags, decode entities, collapse whitespace)
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim() || url;

  return {
    title,
    content: text.slice(0, 100000), // Cap at 100K chars
    source: 'url',
    metadata: { url, fetched_at: new Date().toISOString() },
  };
}
