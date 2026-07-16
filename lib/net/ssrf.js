import { lookup as dnsLookup } from 'dns/promises';

/**
 * Single SSRF validator for every server-side fetch of a caller/feed-supplied
 * URL.
 *
 * Blocks internal/reserved targets for BOTH IPv4 and IPv6, checked
 * POST-DNS-resolution across ALL resolved addresses. This closes two classes of
 * bypass that per-fetcher checks missed:
 *   - an IPv6-resolving host slipping past an IPv4-only (`split('.')`) check;
 *   - a multi-record host where only some A/AAAA records are private.
 *
 * Rejection throws an Error carrying a machine-readable `code`:
 *   - `SSRF_BLOCKED`      — scheme / hostname / a resolved IP is disallowed.
 *   - `DNS_LOOKUP_FAILED` — the hostname would not resolve.
 * so a caller that must stay lenient on a plain DNS miss (the scraper path) can
 * distinguish it from an actual SSRF block.
 *
 * NOTE (residual TOCTOU): this validates the resolved address(es) but the
 * subsequent `fetch` re-resolves the hostname, so a DNS-rebinding attacker could
 * in principle return a public IP here and a private one to `fetch`. Full
 * closure requires pinning the fetch to the validated IP (fetch the IP with a
 * `Host` header). The returned `addresses` are exposed so a caller can pin if it
 * needs to; the default guard narrows the window (re-validate immediately before
 * fetch) without eliminating it.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  'metadata.goog',
]);

// IPv4 private / reserved ranges: RFC1918, loopback, link-local (incl. the
// 169.254.169.254 cloud-metadata address), carrier-grade NAT, and "this host".
const IPV4_PRIVATE = [
  /^0\./, // 0.0.0.0/8 "this host"
  /^10\./, // 10.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^127\./, // loopback
  /^169\.254\./, // link-local (cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
];

function isPrivateIPv4(addr) {
  return IPV4_PRIVATE.some((re) => re.test(addr));
}

function isPrivateIPv6(addr) {
  const a = addr.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (a === '::1' || a === '::') return true; // loopback / unspecified

  // IPv4-mapped (::ffff:a.b.c.d) — defer to the IPv4 ranges (e.g. ::ffff:127.0.0.1).
  const mapped = a.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  // Compare the leading hextet's high bits.
  const firstHextet = a.split(':')[0];
  if (!firstHextet) return false;
  const val = parseInt(firstHextet, 16);
  if (Number.isNaN(val)) return false;
  if (val >= 0xfc00 && val <= 0xfdff) return true; // unique-local fc00::/7
  if (val >= 0xfe80 && val <= 0xfebf) return true; // link-local fe80::/10
  return false;
}

/** True if a resolved IP literal is private/reserved (IPv4 or IPv6). */
export function isPrivateAddress(address) {
  return address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

function ssrfBlocked(reason) {
  const e = new Error(reason);
  e.code = 'SSRF_BLOCKED';
  e.reason = reason;
  return e;
}

function dnsFailed(hostname) {
  const e = new Error(`DNS resolution failed for ${hostname}`);
  e.code = 'DNS_LOOKUP_FAILED';
  e.reason = 'DNS resolution failed';
  return e;
}

/**
 * Assert that `urlString` is a public, fetchable http(s) URL. Throws on any
 * disallowed scheme, hostname, or resolved private/reserved IP.
 *
 * @param {string} urlString
 * @param {{ lookup?: Function }} [deps] - inject a `lookup` for testing.
 * @returns {Promise<{ url: string, hostname: string, addresses: string[] }>}
 */
export async function assertPublicUrl(urlString, { lookup = dnsLookup } = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw ssrfBlocked('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ssrfBlocked('Only http/https URLs are allowed');
  }

  let hostname = parsed.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw ssrfBlocked(`Blocked host: ${hostname}`);
  }

  let results;
  try {
    results = await lookup(hostname, { all: true });
  } catch {
    throw dnsFailed(hostname);
  }

  const addresses = (Array.isArray(results) ? results : [results])
    .map((r) => (r && typeof r === 'object' ? r.address : r))
    .filter(Boolean);
  if (addresses.length === 0) {
    throw dnsFailed(hostname);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw ssrfBlocked(`Blocked private address ${address} for ${hostname}`);
    }
  }

  return { url: parsed.href, hostname, addresses };
}

/** Default cap on redirect hops followed by `safeFetch` before it gives up. */
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * SSRF-safe replacement for a raw `fetch` of a caller/feed-supplied URL.
 *
 * `assertPublicUrl` alone is NOT enough: it validates the *initial* URL, but a
 * default `fetch` follows 3xx redirects itself (`redirect: 'follow'`), so an
 * attacker-controlled host that PASSES validation can return a 302 to
 * `http://169.254.169.254/...` (cloud metadata) or any internal host, and the
 * built-in redirect follow fetches it UNINSPECTED. This closes that bypass by
 * driving the redirect chain manually and re-validating EVERY hop before it is
 * followed.
 *
 * Behaviour:
 *   - validates the URL (and each subsequent redirect target) with
 *     `assertPublicUrl` BEFORE fetching it;
 *   - fetches with `redirect: 'manual'` so the runtime never auto-follows;
 *   - on a 3xx with a `Location`, resolves it against the current URL and loops
 *     — bounded by `maxRedirects` hops (exceeding the cap throws SSRF_BLOCKED);
 *   - a 3xx WITHOUT a `Location` header is returned as-is (nothing to follow);
 *   - preserves the caller's other fetch options (method, headers, body,
 *     signal, …); only `redirect` is overridden.
 *
 * Any hop that fails validation throws with `code === 'SSRF_BLOCKED'` (or
 * `DNS_LOOKUP_FAILED` on a plain DNS miss), same as `assertPublicUrl`.
 *
 * @param {string} urlString
 * @param {RequestInit} [opts] - caller's fetch options (redirect is forced to 'manual').
 * @param {{ fetch?: Function, lookup?: Function, maxRedirects?: number }} [deps]
 *        - inject `fetch`/`lookup`/`maxRedirects` for testing.
 * @returns {Promise<Response>} the final (non-redirect) response.
 */
export async function safeFetch(
  urlString,
  opts = {},
  { fetch: fetchImpl = fetch, lookup = dnsLookup, maxRedirects = DEFAULT_MAX_REDIRECTS } = {},
) {
  let currentUrl = urlString;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate on EVERY hop (initial URL + each redirect target) before the
    // fetch. This subsumes any standalone assertPublicUrl pre-check at call sites.
    const { url } = await assertPublicUrl(currentUrl, { lookup });

    const res = await fetchImpl(url, { ...opts, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.('location');
      if (!location) {
        // Redirect with no target — nothing to follow, hand it back untouched.
        return res;
      }
      if (hop === maxRedirects) {
        throw ssrfBlocked(`Too many redirects (> ${maxRedirects}) for ${urlString}`);
      }
      // Drain the redirect response body so the connection isn't left dangling.
      if (typeof res.body?.cancel === 'function') {
        try {
          res.body.cancel();
        } catch {
          /* best-effort */
        }
      }
      currentUrl = new URL(location, url).href;
      continue;
    }

    return res;
  }

  // Unreachable: the loop returns or throws within maxRedirects+1 iterations.
  throw ssrfBlocked(`Too many redirects (> ${maxRedirects}) for ${urlString}`);
}
