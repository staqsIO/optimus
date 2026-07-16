import { scrapeWithPlaywright } from './playwright.js';
import { scrapeWithFirecrawl } from './firecrawl.js';
import { createLogger } from '../logger.js';
import { assertPublicUrl } from '../net/ssrf.js';

const log = createLogger('scrapers');

/**
 * Validate URL is not an SSRF target (internal/private IPs).
 * Must run BEFORE any URL is sent to scrapers (including Firecrawl).
 *
 * Delegates to the shared `assertPublicUrl` (IPv4 + IPv6, post-resolution).
 * A plain DNS miss is NOT treated as SSRF here — the scrape is allowed to fail
 * naturally, preserving the prior behavior of this path.
 */
async function validateNotSSRF(url) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    if (err.code === 'DNS_LOOKUP_FAILED') {
      log.warn(`DNS lookup failed for ${url}: ${err.message}`);
      return;
    }
    throw err;
  }
}

/**
 * Scrape a URL for brand extraction. Validates SSRF first, then runs
 * Playwright (primary) with optional Firecrawl enrichment.
 *
 * @param {string} url - Target URL
 * @param {string} workDir - Directory to write artifacts
 * @param {Object} options - { frameworkColors, auditAEO, firecrawlEnabled, extractCatalog }
 * @returns {{ scraped, firecrawlBrand }}
 */
export async function scrapeForBrand(url, workDir, options = {}) {
  // SSRF validation BEFORE any external call (Linus requirement)
  await validateNotSSRF(url);

  // Run Playwright (primary) and Firecrawl (enrichment) in parallel
  const firecrawlEnabled = options.firecrawlEnabled !== false && !!process.env.FIRECRAWL_API_KEY;

  const [scraped, firecrawlBrand] = await Promise.all([
    scrapeWithPlaywright(url, workDir, {
      frameworkColors: options.frameworkColors,
      auditAEO: options.auditAEO,
      extractCatalog: options.extractCatalog,
    }),
    firecrawlEnabled ? scrapeWithFirecrawl(url) : Promise.resolve(null),
  ]);

  if (firecrawlBrand) {
    log.info('Brand enrichment: Firecrawl provided personality/voice data');
  }

  return { scraped, firecrawlBrand };
}

export { scrapeWithPlaywright, scrapeWithFirecrawl, validateNotSSRF };
