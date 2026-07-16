import { createLogger } from '../logger.js';

const log = createLogger('scraper-firecrawl');

/**
 * Scrape brand identity from a URL using Firecrawl's branding format.
 * Returns structured branding data or null if unavailable/failed.
 *
 * Firecrawl provides: personality, brand voice, high-level palette, typography
 * This SUPPLEMENTS Playwright (which provides computed styles, images, HTML structure)
 */
export async function scrapeWithFirecrawl(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['branding'],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log.warn(`Firecrawl returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json();
    if (!data.success || !data.data?.branding) {
      log.warn(`Firecrawl returned no branding data for ${url}`);
      return null;
    }

    log.info(`Firecrawl brand extraction succeeded for ${url}`);
    return data.data.branding;
  } catch (err) {
    log.warn(`Firecrawl failed (non-fatal): ${err.message}`);
    return null;
  }
}
