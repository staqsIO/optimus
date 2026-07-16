import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSsrfRouteGuard, makeSsrfWebSocketGuard, attachPopupSsrfGuards } from '../../lib/scrapers/playwright.js';

/**
 * SSRF guard for the Playwright scraper — proves the redirect + sub-resource
 * bypass in issue #501 is closed: a target that passes the entry-URL check
 * (lib/scrapers/index.js) can no longer bounce Chromium into an internal host
 * via a server 3xx redirect or an img/script/xhr/css sub-resource, because
 * `page.route('**\/*', guard)` re-validates every request the page makes,
 * including each redirect hop (a fresh request through the same handler).
 *
 * Also covers the two same-threat-model bypasses found in review: WebSocket
 * connections (a separate Playwright interception mechanism, `routeWebSocket`,
 * that `page.route()` never sees) and popups (`window.open`/`target="_blank"`
 * spawn a new Page that doesn't inherit the opener's routes), plus a
 * functional regression where inert `data:`/`blob:`/`about:` sub-resources
 * were incorrectly aborted.
 *
 * No real browser, no real DNS — `route`/`ws`/`context`/`page` are fakes and
 * `assertPublicUrl` is injected, matching the style of ssrf-validator.test.js.
 */

// Minimal fake Playwright `route` — records which of abort()/continue() fired.
function fakeRoute(url) {
  const calls = [];
  return {
    request: () => ({ url: () => url }),
    abort: (reason) => calls.push(['abort', reason]),
    continue: () => calls.push(['continue']),
    calls,
  };
}

// Minimal fake Playwright `WebSocketRoute` — records which of
// close()/connectToServer() fired.
function fakeWs(url) {
  const calls = [];
  return {
    url: () => url,
    close: (reason) => calls.push(['close', reason]),
    connectToServer: () => calls.push(['connectToServer']),
    calls,
  };
}

// Minimal fake Playwright `BrowserContext` — stores the 'page' listener so a
// test can simulate a popup being created without a real browser.
function fakeContext() {
  let pageListener = null;
  return {
    on: (event, listener) => { if (event === 'page') pageListener = listener; },
    emitPage: (popup) => pageListener(popup),
  };
}

// Minimal fake Playwright `Page` (as seen from the popup side) — records
// which routes were registered on it.
function fakePopupPage() {
  const registered = [];
  return {
    route: async (pattern, handler) => { registered.push(['route', pattern, handler]); },
    routeWebSocket: async (pattern, handler) => { registered.push(['routeWebSocket', pattern, handler]); },
    close: async () => { registered.push(['close']); },
    registered,
  };
}

// Fake popup whose guard registration rejects (e.g. the CDP call itself
// fails), used to prove the guard fails CLOSED — the popup is closed rather
// than left running with no SSRF protection.
function fakeFailingPopupPage({ failHttp = false, failWs = false } = {}) {
  const registered = [];
  return {
    route: async () => {
      registered.push(['route']);
      if (failHttp) throw new Error('route registration failed');
    },
    routeWebSocket: async () => {
      registered.push(['routeWebSocket']);
      if (failWs) throw new Error('routeWebSocket registration failed');
    },
    close: async () => { registered.push(['close']); },
    registered,
  };
}

describe('makeSsrfRouteGuard — Playwright request-level SSRF guard', () => {
  it('allows a public URL: continue() called, abort() not called', async () => {
    const assertFn = async () => ({ url: 'http://public.example/', hostname: 'public.example', addresses: ['93.184.216.34'] });
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });
    const route = fakeRoute('http://public.example/');

    await guard(route);

    assert.deepEqual(route.calls, [['continue']]);
  });

  it('blocks a private/internal URL: abort() called, continue() not called', async () => {
    const assertFn = async () => {
      const e = new Error('Blocked private address');
      e.code = 'SSRF_BLOCKED';
      throw e;
    };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });
    const route = fakeRoute('http://internal.example/');

    await guard(route);

    assert.deepEqual(route.calls, [['abort', 'blockedbyclient']]);
  });

  it('blocks a redirect-to-metadata request routed through the same handler', async () => {
    // Simulates the #501 bypass: the entry URL passed the caller's pre-check,
    // then the server 302s to the cloud-metadata IP. Chromium re-issues that
    // as a fresh request, which re-enters this same guard.
    const assertFn = async (url) => {
      if (url.startsWith('http://169.254.169.254/')) {
        const e = new Error('Blocked private address 169.254.169.254');
        e.code = 'SSRF_BLOCKED';
        throw e;
      }
      return { url, hostname: 'public.example', addresses: ['93.184.216.34'] };
    };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });

    const entryRoute = fakeRoute('http://public.example/');
    await guard(entryRoute);
    assert.deepEqual(entryRoute.calls, [['continue']]);

    const redirectRoute = fakeRoute('http://169.254.169.254/latest/meta-data/');
    await guard(redirectRoute);
    assert.deepEqual(redirectRoute.calls, [['abort', 'blockedbyclient']]);
  });

  it('is lenient on a plain DNS miss: continue() called', async () => {
    const assertFn = async () => {
      const e = new Error('DNS resolution failed');
      e.code = 'DNS_LOOKUP_FAILED';
      throw e;
    };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });
    const route = fakeRoute('http://nope.invalid/');

    await guard(route);

    assert.deepEqual(route.calls, [['continue']]);
  });

  it('aborts an unparseable request URL without calling assertPublicUrl', async () => {
    let called = false;
    const assertFn = async () => { called = true; };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });
    const route = fakeRoute('not a url');

    await guard(route);

    assert.deepEqual(route.calls, [['abort', 'blockedbyclient']]);
    assert.equal(called, false);
  });

  it('memoizes per-origin: assertPublicUrl is called only once for two requests to the same origin', async () => {
    let calls = 0;
    const assertFn = async () => { calls += 1; return { url: 'http://public.example/', hostname: 'public.example', addresses: ['93.184.216.34'] }; };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });

    await guard(fakeRoute('http://public.example/'));
    await guard(fakeRoute('http://public.example/assets/logo.png'));

    assert.equal(calls, 1);
  });

  it('allows an inline data: sub-resource without calling assertPublicUrl', async () => {
    let called = false;
    const assertFn = async () => { called = true; };
    const guard = makeSsrfRouteGuard({ assertPublicUrl: assertFn });
    const route = fakeRoute('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');

    await guard(route);

    assert.deepEqual(route.calls, [['continue']]);
    assert.equal(called, false, 'assertPublicUrl must not run for inert data: URLs');
  });
});

describe('makeSsrfWebSocketGuard — Playwright WebSocket-level SSRF guard', () => {
  // #501 review Blocker 1: page.route() never sees WebSocket traffic —
  // Playwright ships routeWebSocket as a separate mechanism — so a scraped
  // page's `new WebSocket('ws://169.254.169.254/...')` would otherwise sail
  // straight past the HTTP guard.
  it('closes a WebSocket to a private/internal host: close() called, connectToServer() not called', async () => {
    const assertFn = async (url) => {
      assert.equal(url, 'http://169.254.169.254/latest/meta-data/', 'ws: must be rewritten to http: before validation');
      const e = new Error('Blocked private address 169.254.169.254');
      e.code = 'SSRF_BLOCKED';
      throw e;
    };
    const guard = makeSsrfWebSocketGuard({ assertPublicUrl: assertFn });
    const ws = fakeWs('ws://169.254.169.254/latest/meta-data/');

    await guard(ws);

    assert.deepEqual(ws.calls, [['close', undefined]]);
  });

  it('passes a WebSocket to a public host through to the real server: connectToServer() called', async () => {
    const assertFn = async (url) => {
      assert.equal(url, 'https://public.example/socket', 'wss: must be rewritten to https: before validation');
      return { url, hostname: 'public.example', addresses: ['93.184.216.34'] };
    };
    const guard = makeSsrfWebSocketGuard({ assertPublicUrl: assertFn });
    const ws = fakeWs('wss://public.example/socket');

    await guard(ws);

    assert.deepEqual(ws.calls, [['connectToServer']]);
  });

  it('is lenient on a plain DNS miss: connectToServer() called, close() not called', async () => {
    // Mirrors the HTTP guard's DNS-miss leniency (a dead hostname is not an
    // SSRF signal). Same `err.code === 'DNS_LOOKUP_FAILED'` branch, exercised
    // through the WS path in isolation.
    const assertFn = async () => {
      const e = new Error('DNS resolution failed');
      e.code = 'DNS_LOOKUP_FAILED';
      throw e;
    };
    const guard = makeSsrfWebSocketGuard({ assertPublicUrl: assertFn });
    const ws = fakeWs('wss://nope.invalid/socket');

    await guard(ws);

    assert.deepEqual(ws.calls, [['connectToServer']]);
  });

  it('never fails open on WS: an unparseable WS URL is closed, not connected', async () => {
    let called = false;
    const assertFn = async () => { called = true; };
    const guard = makeSsrfWebSocketGuard({ assertPublicUrl: assertFn });
    const ws = fakeWs('not a url');

    await guard(ws);

    assert.deepEqual(ws.calls, [['close', undefined]]);
    assert.equal(called, false);
  });
});

describe('attachPopupSsrfGuards — guards every popup the browser context opens', () => {
  // #501 review Blocker 2: page.route()/page.routeWebSocket() are per-Page,
  // not inherited by pages the context spawns later (window.open,
  // target="_blank"), so a popup would otherwise get NO guard at all.
  it('attaches both the HTTP and WebSocket guard to every popup page the context creates', () => {
    const context = fakeContext();
    const httpGuard = async () => {};
    const wsGuard = async () => {};
    attachPopupSsrfGuards(context, { httpGuard, wsGuard });

    const popup = fakePopupPage();
    context.emitPage(popup);

    assert.deepEqual(
      popup.registered.map(([kind, pattern, handler]) => [kind, pattern, handler]),
      [
        ['route', '**/*', httpGuard],
        ['routeWebSocket', '**/*', wsGuard],
      ],
    );
  });

  // #549 nit 1: if a guard registration on the popup itself rejects, the popup
  // must be CLOSED (fail closed), not left running with a log line and no/partial
  // SSRF protection — the fail-open posture the review flagged.
  it('closes the popup when the WebSocket guard fails to register (fail closed)', async () => {
    const context = fakeContext();
    attachPopupSsrfGuards(context, { httpGuard: async () => {}, wsGuard: async () => {} });

    const popup = fakeFailingPopupPage({ failWs: true });
    await context.emitPage(popup);

    assert.ok(
      popup.registered.some(([kind]) => kind === 'close'),
      'popup must be closed when a guard cannot be registered',
    );
  });

  it('closes the popup when the HTTP guard fails to register (fail closed)', async () => {
    const context = fakeContext();
    attachPopupSsrfGuards(context, { httpGuard: async () => {}, wsGuard: async () => {} });

    const popup = fakeFailingPopupPage({ failHttp: true });
    await context.emitPage(popup);

    assert.ok(
      popup.registered.some(([kind]) => kind === 'close'),
      'popup must be closed when a guard cannot be registered',
    );
  });
});
