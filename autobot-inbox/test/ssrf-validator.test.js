import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateAddress, safeFetch } from '../../lib/net/ssrf.js';

/**
 * SSRF validator — the single guard every server-side URL fetch routes through
 * (rag URL normalizer, redesign classify/submit, brand scraper).
 *
 * Proves the properties per-fetcher checks missed:
 *   (1) IPv4 private/reserved ranges are rejected;
 *   (2) IPv6 private ranges are rejected — including an IPv6-RESOLVING host,
 *       which the old redesign `address.split('.').map(Number)` check let
 *       through (all-NaN octets pass every IPv4 comparison);
 *   (3) IPv4-mapped IPv6 (::ffff:a.b.c.d) is rejected;
 *   (4) a normal public host is accepted;
 *   (5) non-http(s) schemes are rejected.
 *
 * DNS is mocked via the injected `lookup` — no real network calls.
 */

// Build a fake dns.lookup (`{ all: true }` shape) that returns fixed records.
function fakeLookup(records) {
  const arr = (Array.isArray(records) ? records : [records]).map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  return async () => arr;
}

const failLookup = async () => {
  const e = new Error('ENOTFOUND');
  e.code = 'ENOTFOUND';
  throw e;
};

describe('assertPublicUrl — SSRF guard', () => {
  describe('IPv4 private / reserved ranges rejected', () => {
    const cases = [
      ['loopback', '127.0.0.1'],
      ['RFC1918 10/8', '10.1.2.3'],
      ['RFC1918 172.16/12', '172.20.0.5'],
      ['RFC1918 192.168/16', '192.168.1.10'],
      ['link-local / cloud metadata', '169.254.169.254'],
      ['carrier-grade NAT 100.64/10', '100.100.0.1'],
      ['"this host" 0/8', '0.0.0.0'],
    ];
    for (const [label, ip] of cases) {
      it(`rejects a host resolving to ${label} (${ip})`, async () => {
        await assert.rejects(
          () => assertPublicUrl('http://evil.example.com/', { lookup: fakeLookup(ip) }),
          (err) => err.code === 'SSRF_BLOCKED',
        );
      });
    }
  });

  describe('IPv6 private ranges rejected', () => {
    const cases = [
      ['loopback ::1', '::1'],
      ['unique-local fc00::/7', 'fc00::1'],
      ['unique-local fd..', 'fd12:3456:789a::1'],
      ['link-local fe80::/10', 'fe80::1'],
      ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
      ['IPv4-mapped RFC1918', '::ffff:10.0.0.1'],
    ];
    for (const [label, ip] of cases) {
      it(`rejects a host resolving to ${label} (${ip})`, async () => {
        await assert.rejects(
          () => assertPublicUrl('http://evil.example.com/', { lookup: fakeLookup(ip) }),
          (err) => err.code === 'SSRF_BLOCKED',
        );
      });
    }

    it('rejects an IPv6-RESOLVING host that the old IPv4-only check let through', async () => {
      // Regression: old redesign validateUrl did address.split('.').map(Number)
      // → an IPv6 address yields [NaN] and passes every `=== 10 / 127 / ...`
      // comparison. The shared guard catches it as a private IPv6 address.
      await assert.rejects(
        () => assertPublicUrl('http://internal.example/', { lookup: fakeLookup('fd00::dead:beef') }),
        (err) => err.code === 'SSRF_BLOCKED',
      );
    });
  });

  describe('multi-record: any private address blocks', () => {
    it('rejects when one of several resolved records is private', async () => {
      await assert.rejects(
        () => assertPublicUrl('http://rebind.example/', {
          lookup: fakeLookup(['93.184.216.34', '10.0.0.5']),
        }),
        (err) => err.code === 'SSRF_BLOCKED',
      );
    });
  });

  describe('scheme + hostname enforcement', () => {
    it('rejects non-http(s) schemes', async () => {
      for (const u of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host/']) {
        await assert.rejects(
          () => assertPublicUrl(u, { lookup: fakeLookup('93.184.216.34') }),
          (err) => err.code === 'SSRF_BLOCKED',
        );
      }
    });

    it('rejects literal blocked hostnames without resolving', async () => {
      for (const u of ['http://localhost/', 'http://metadata.google.internal/']) {
        await assert.rejects(
          () => assertPublicUrl(u, { lookup: fakeLookup('93.184.216.34') }),
          (err) => err.code === 'SSRF_BLOCKED',
        );
      }
    });

    it('rejects an invalid URL', async () => {
      await assert.rejects(
        () => assertPublicUrl('not a url', { lookup: fakeLookup('93.184.216.34') }),
        (err) => err.code === 'SSRF_BLOCKED',
      );
    });
  });

  describe('DNS failure is distinguishable', () => {
    it('throws DNS_LOOKUP_FAILED (not SSRF_BLOCKED) when the host will not resolve', async () => {
      await assert.rejects(
        () => assertPublicUrl('http://nope.invalid/', { lookup: failLookup }),
        (err) => err.code === 'DNS_LOOKUP_FAILED',
      );
    });
  });

  describe('public hosts accepted', () => {
    it('accepts a normal public IPv4 host and returns the resolved address', async () => {
      const out = await assertPublicUrl('http://example.com/path', {
        lookup: fakeLookup('93.184.216.34'),
      });
      assert.equal(out.hostname, 'example.com');
      assert.deepEqual(out.addresses, ['93.184.216.34']);
      assert.match(out.url, /^http:\/\/example\.com\/path/);
    });

    it('accepts a public IPv6 host', async () => {
      const out = await assertPublicUrl('https://example.com/', {
        lookup: fakeLookup('2606:2800:220:1:248:1893:25c8:1946'),
      });
      assert.equal(out.addresses.length, 1);
    });
  });

  describe('safeFetch — redirects are re-validated per hop', () => {
    // Hostname-aware DNS mock: resolves each host to a fixed IP (or ENOTFOUND).
    function hostLookup(map) {
      return async (hostname) => {
        const ip = map[hostname];
        if (!ip) {
          const e = new Error('ENOTFOUND');
          e.code = 'ENOTFOUND';
          throw e;
        }
        return [{ address: ip, family: ip.includes(':') ? 6 : 4 }];
      };
    }

    // Minimal Response stub with a Headers-like `.get`.
    function resp(status, { location = null, body = null } = {}) {
      return {
        status,
        headers: { get: (n) => (n.toLowerCase() === 'location' ? location : null) },
        body,
        async text() {
          return body ?? '';
        },
      };
    }

    // Scripted fetch keyed by absolute URL; records the URLs it was asked to fetch.
    function scriptedFetch(routes) {
      const calls = [];
      const fn = async (url) => {
        calls.push(url);
        const r = routes[url];
        if (!r) throw new Error(`no scripted route for ${url}`);
        return r;
      };
      fn.calls = calls;
      return fn;
    }

    it('BLOCKS a redirect from a public host to a link-local/internal host', async () => {
      // public.example passes validation, then 302s to the cloud-metadata IP.
      const fetchImpl = scriptedFetch({
        'http://public.example/': resp(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
      });
      const lookup = hostLookup({
        'public.example': '93.184.216.34',
        '169.254.169.254': '169.254.169.254',
      });

      await assert.rejects(
        () => safeFetch('http://public.example/', {}, { fetch: fetchImpl, lookup }),
        (err) => err.code === 'SSRF_BLOCKED',
      );
      // The internal target was NEVER fetched — blocked before the hop was followed.
      assert.deepEqual(fetchImpl.calls, ['http://public.example/']);
    });

    it('FOLLOWS a public → public redirect chain within the hop cap', async () => {
      const fetchImpl = scriptedFetch({
        'http://a.example/': resp(302, { location: 'http://b.example/' }),
        'http://b.example/': resp(200, { body: 'landed' }),
      });
      const lookup = hostLookup({
        'a.example': '93.184.216.34',
        'b.example': '198.51.100.7',
      });

      const res = await safeFetch('http://a.example/', {}, { fetch: fetchImpl, lookup });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'landed');
      assert.deepEqual(fetchImpl.calls, ['http://a.example/', 'http://b.example/']);
    });

    it('throws SSRF_BLOCKED when the redirect chain exceeds the hop cap', async () => {
      const fetchImpl = scriptedFetch({
        'http://loop.example/': resp(302, { location: 'http://loop.example/' }),
      });
      const lookup = hostLookup({ 'loop.example': '203.0.113.9' });

      await assert.rejects(
        () => safeFetch('http://loop.example/', {}, { fetch: fetchImpl, lookup, maxRedirects: 2 }),
        (err) => err.code === 'SSRF_BLOCKED' && /Too many redirects/.test(err.message),
      );
    });
  });

  describe('isPrivateAddress unit', () => {
    it('classifies representative addresses', () => {
      assert.equal(isPrivateAddress('10.0.0.1'), true);
      assert.equal(isPrivateAddress('93.184.216.34'), false);
      assert.equal(isPrivateAddress('::1'), true);
      assert.equal(isPrivateAddress('fe80::1'), true);
      assert.equal(isPrivateAddress('2606:2800:220:1::1'), false);
      assert.equal(isPrivateAddress('::ffff:192.168.0.1'), true);
    });
  });
});
