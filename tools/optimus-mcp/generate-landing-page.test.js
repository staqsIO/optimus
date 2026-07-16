/**
 * generate_landing_page — offline tests (mock fetch, no network, no MCP SDK).
 *
 * Pins the HTTP contract of the public redesign flow the tool wraps:
 *   POST /api/redesign/submit  { url, visitorIntent }
 *   GET  /api/redesign/status/:id
 *   preview URL = <base>/api/redesign/preview/<jobId>
 *
 * Run: node --test tools/optimus-mcp/generate-landing-page.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateLandingPage,
  previewUrlFor,
  resolveApiBase,
} from './generate-landing-page.js';

const BASE = 'https://preview.staqs.io';
const noSleep = async () => {};

// Scripted mock fetch: pass an array of responders, one consumed per call. Each
// responder gets (url, opts) and returns { ok, status, body }. Records calls.
function mockFetch(responders) {
  const calls = [];
  const queue = [...responders];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : undefined });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const { ok = true, status = 200, body = {} } = r(url, opts);
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ── base / preview-url helpers ───────────────────────────────────────────────

test('resolveApiBase: explicit > OPTIMUS_API_BASE > OPTIMUS_API_URL > default; trailing slash stripped', () => {
  assert.equal(resolveApiBase('https://x.io/'), 'https://x.io');
  const save = { b: process.env.OPTIMUS_API_BASE, u: process.env.OPTIMUS_API_URL };
  delete process.env.OPTIMUS_API_BASE; delete process.env.OPTIMUS_API_URL;
  assert.equal(resolveApiBase(), BASE);
  process.env.OPTIMUS_API_URL = 'https://url-env.io';
  assert.equal(resolveApiBase(), 'https://url-env.io');
  process.env.OPTIMUS_API_BASE = 'https://base-env.io';
  assert.equal(resolveApiBase(), 'https://base-env.io'); // BASE wins over URL
  if (save.b === undefined) delete process.env.OPTIMUS_API_BASE; else process.env.OPTIMUS_API_BASE = save.b;
  if (save.u === undefined) delete process.env.OPTIMUS_API_URL; else process.env.OPTIMUS_API_URL = save.u;
});

test('previewUrlFor builds <base>/api/redesign/preview/<jobId>', () => {
  assert.equal(previewUrlFor(BASE, 'abc-123'), `${BASE}/api/redesign/preview/abc-123`);
});

// ── submit body + validation ─────────────────────────────────────────────────

test('posts { url, visitorIntent } to /api/redesign/submit', async () => {
  const fetchImpl = mockFetch([
    () => ({ body: { jobId: 'job-1', status: 'created' } }),
  ]);
  await generateLandingPage({
    url: 'https://allbirds.com', intent: 'waterproof rain shoes',
    wait: false, apiBase: BASE, fetchImpl,
  });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, `${BASE}/api/redesign/submit`);
  assert.equal(c.opts.method, 'POST');
  assert.deepEqual(c.body, { url: 'https://allbirds.com', visitorIntent: 'waterproof rain shoes' });
});

test('requires url and intent', async () => {
  await assert.rejects(() => generateLandingPage({ intent: 'x', fetchImpl: mockFetch([() => ({})]) }), /url/);
  await assert.rejects(() => generateLandingPage({ url: 'https://x.io', fetchImpl: mockFetch([() => ({})]) }), /intent/);
});

// ── wait:false → immediate jobId + URLs ──────────────────────────────────────

test('wait:false returns jobId, status, statusUrl, and the preview URL', async () => {
  const fetchImpl = mockFetch([() => ({ body: { jobId: 'job-7', status: 'created' } })]);
  const r = await generateLandingPage({
    url: 'https://x.io', intent: 'demo', wait: false, apiBase: BASE, fetchImpl,
  });
  assert.equal(r.jobId, 'job-7');
  assert.equal(r.status, 'created');
  assert.equal(r.statusUrl, `${BASE}/api/redesign/status/job-7`);
  assert.equal(r.previewUrl, `${BASE}/api/redesign/preview/job-7`);
  assert.equal(fetchImpl.calls.length, 1); // no polling
});

// ── 429 cap ──────────────────────────────────────────────────────────────────

test('429 → rate_limited with a clear daily-cap message', async () => {
  const fetchImpl = mockFetch([
    () => ({ ok: false, status: 429, body: { error: 'Service busy: daily capacity reached. Try again tomorrow.' } }),
  ]);
  const r = await generateLandingPage({ url: 'https://x.io', intent: 'demo', apiBase: BASE, fetchImpl });
  assert.equal(r.status, 'rate_limited');
  assert.match(r.message, /cap reached/i);
  assert.match(r.message, /tomorrow/i);
  assert.equal(fetchImpl.calls.length, 1); // never polls
});

// ── 400 safetyBlock ──────────────────────────────────────────────────────────

test('400 → rejected (intent flagged unsafe by Model Armor)', async () => {
  const fetchImpl = mockFetch([
    () => ({ ok: false, status: 400, body: { error: 'visitor_intent flagged by safety screen' } }),
  ]);
  const r = await generateLandingPage({ url: 'https://x.io', intent: 'unsafe thing', apiBase: BASE, fetchImpl });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /unsafe|safety/i);
});

// ── wait:true → poll to completion ───────────────────────────────────────────

test('wait:true polls status until completed and returns previewUrl + costUsd', async () => {
  const fetchImpl = mockFetch([
    (url) => url.endsWith('/submit')
      ? ({ body: { jobId: 'job-9', status: 'created' } })
      : ({ body: { jobId: 'job-9', status: 'completed', costUsd: 2.31 } }),
  ]);
  const r = await generateLandingPage({
    url: 'https://x.io', intent: 'demo', wait: true, apiBase: BASE, fetchImpl, sleepImpl: noSleep,
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.jobId, 'job-9');
  assert.equal(r.previewUrl, `${BASE}/api/redesign/preview/job-9`);
  assert.equal(r.costUsd, 2.31);
  // submit + at least one status poll
  assert.ok(fetchImpl.calls.some((c) => c.url === `${BASE}/api/redesign/status/job-9`));
});

test('wait:true returns failed when the job fails', async () => {
  const fetchImpl = mockFetch([
    (url) => url.endsWith('/submit')
      ? ({ body: { jobId: 'job-f', status: 'created' } })
      : ({ body: { jobId: 'job-f', status: 'failed', error: 'scrape blocked' } }),
  ]);
  const r = await generateLandingPage({
    url: 'https://x.io', intent: 'demo', apiBase: BASE, fetchImpl, sleepImpl: noSleep,
  });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /scrape blocked/);
});

test('wait:true times out → status "generating" with previewUrl to check shortly', async () => {
  const fetchImpl = mockFetch([
    (url) => url.endsWith('/submit')
      ? ({ body: { jobId: 'job-t', status: 'created' } })
      : ({ body: { jobId: 'job-t', status: 'in_progress', progressPhase: 'generate' } }),
  ]);
  const r = await generateLandingPage({
    url: 'https://x.io', intent: 'demo', apiBase: BASE, fetchImpl,
    sleepImpl: noSleep, maxWaitMs: 25, pollIntervalMs: 10,
  });
  assert.equal(r.status, 'generating');
  assert.equal(r.previewUrl, `${BASE}/api/redesign/preview/job-t`);
  assert.match(r.message, /shortly/i);
});

// ── pre-warm: submit returns completed immediately (dedup / serve-by-match) ──

test('dedup hit (submit returns completed) short-circuits without polling', async () => {
  const fetchImpl = mockFetch([
    () => ({ body: { jobId: 'job-d', status: 'completed', deduplicated: true, previewUrl: '/api/redesign/preview/job-d' } }),
  ]);
  const r = await generateLandingPage({ url: 'https://x.io', intent: 'demo', apiBase: BASE, fetchImpl, sleepImpl: noSleep });
  assert.equal(r.status, 'completed');
  assert.equal(r.deduplicated, true);
  assert.equal(r.previewUrl, `${BASE}/api/redesign/preview/job-d`);
  assert.equal(fetchImpl.calls.length, 1); // only the submit call
});
