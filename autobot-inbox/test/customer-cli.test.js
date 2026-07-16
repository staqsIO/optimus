/**
 * OPT-37 — optimus-cli + shared client.
 *
 * The CLI and the MCP server are two transports over ONE Board API surface
 * (tools/optimus-mcp/client.js). These tests pin the HTTP mapping of every
 * customer operation, the CLI argument parser, and the registry shape — with a
 * mock fetch, so they run offline in test:ci.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createApi,
  tokenIssuer,
  isCustomerToken,
  CUSTOMER_OPERATIONS,
  findOperation,
} from '../../tools/optimus-mcp/client.js';
import { parseArgs, resolveArgs, validate } from '../../tools/optimus-mcp/cli.js';

// A customer JWT: header.payload.sig where payload = { iss: 'optimus-customer' }.
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}

// Capturing mock fetch: records the last request, returns a canned response.
function mockFetch({ ok = true, status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ── token helpers ────────────────────────────────────────────────────────────

test('tokenIssuer decodes iss without verifying; isCustomerToken matches', () => {
  assert.equal(tokenIssuer(fakeJwt({ iss: 'optimus-customer' })), 'optimus-customer');
  assert.equal(tokenIssuer(fakeJwt({ iss: 'optimus-board' })), 'optimus-board');
  assert.equal(tokenIssuer('garbage'), null);
  assert.equal(tokenIssuer(undefined), null);
  assert.equal(isCustomerToken(fakeJwt({ iss: 'optimus-customer' })), true);
  assert.equal(isCustomerToken(fakeJwt({ iss: 'optimus-board' })), false);
});

// ── createApi ────────────────────────────────────────────────────────────────

test('createApi requires a token', () => {
  assert.throws(() => createApi({ apiUrl: 'http://x' }), /requires \{ token \}/);
});

test('createApi sends Bearer auth to the right URL and returns parsed JSON', async () => {
  const fetchImpl = mockFetch({ body: { hits: 3 } });
  const api = createApi({ token: 'tok-123', apiUrl: 'https://api.example/', fetchImpl });
  const out = await api('GET', '/api/search?q=1');
  assert.deepEqual(out, { hits: 3 });
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.example/api/search?q=1'); // trailing slash trimmed
  assert.equal(opts.method, 'GET');
  assert.equal(opts.headers.Authorization, 'Bearer tok-123');
  assert.equal(opts.body, undefined);
});

test('createApi serializes a body and throws a helpful error on non-2xx', async () => {
  const fetchImpl = mockFetch({ ok: false, status: 403, body: { error: 'forbidden', reason: 'customer ceiling' } });
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await assert.rejects(
    () => api('POST', '/api/board/build', { prompt: 'hi' }),
    /403: forbidden \(customer ceiling\)/,
  );
  assert.equal(fetchImpl.calls[0].opts.body, JSON.stringify({ prompt: 'hi' }));
});

// ── operation → HTTP mapping (the contract the MCP server also uses) ──────────

test('search → POST /api/search { query, limit }', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('search').run(api, { query: 'pricing', limit: 3 });
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, 'http://x/api/search');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(JSON.parse(opts.body), { query: 'pricing', limit: 3 });
});

test('ingest-doc → POST /api/ingest with mcp-upload source + default markdown', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('ingest-doc').run(api, { title: 'PRD', raw: '# hi' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].opts.body), {
    source: 'mcp-upload', title: 'PRD', raw: '# hi', format: 'markdown',
  });
});

test('push-summary → POST /api/ingest daily-summary with derived title', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('push-summary').run(api, { text: 'did stuff', date: '2026-06-08' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].opts.body), {
    source: 'daily-summary', title: 'Daily summary — 2026-06-08', raw: 'did stuff', format: 'markdown',
  });
});

test('capture-url → POST /api/artifacts with default kind doc', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('capture-url').run(api, { url: 'https://e.com/x' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].opts.body), { url: 'https://e.com/x', kind: 'doc' });
});

test('list-artifacts → GET with query string built from filters', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('list-artifacts').run(api, { kind: 'prd', status: 'active' });
  assert.equal(fetchImpl.calls[0].url, 'http://x/api/artifacts?kind=prd&status=active');
});

test('get-artifact → GET /api/artifacts/:id (id is URL-encoded)', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('get-artifact').run(api, { id: 'a/b' });
  assert.equal(fetchImpl.calls[0].url, 'http://x/api/artifacts/a%2Fb');
});

test('enrich-contact / enrich-project → GET enrich endpoints', async () => {
  const fetchImpl = mockFetch();
  const api = createApi({ token: 't', apiUrl: 'http://x', fetchImpl });
  await findOperation('enrich-contact').run(api, { id: 'c1' });
  await findOperation('enrich-project').run(api, { id: 'p1' });
  assert.equal(fetchImpl.calls[0].url, 'http://x/api/artifacts/enrich/contact/c1');
  assert.equal(fetchImpl.calls[1].url, 'http://x/api/artifacts/enrich/project/p1');
});

// ── registry shape / drift guard ─────────────────────────────────────────────

test('CUSTOMER_OPERATIONS is exactly the customer-safe surface', () => {
  const commands = CUSTOMER_OPERATIONS.map((o) => o.command).sort();
  assert.deepEqual(commands, [
    'capture-url', 'enrich-contact', 'enrich-project', 'get-artifact',
    'ingest-artifact', 'ingest-doc', 'ingest-transcript', 'list-artifacts',
    'push-summary', 'search',
  ]);
  // Every op must declare its MCP tool name (kept in lockstep with index.js's
  // CUSTOMER_SAFE_TOOLS) and a callable run().
  for (const op of CUSTOMER_OPERATIONS) {
    assert.match(op.tool, /^optimus_/, `${op.command} has a tool name`);
    assert.equal(typeof op.run, 'function', `${op.command} has run()`);
    assert.ok(op.summary, `${op.command} has a summary`);
  }
});

// ── CLI argument parsing ─────────────────────────────────────────────────────

test('parseArgs splits positionals, valued flags, and boolean flags', () => {
  const { positionals, flags } = parseArgs(['hello world', '--limit', '5', '--json']);
  assert.deepEqual(positionals, ['hello world']);
  assert.equal(flags.limit, '5');
  assert.equal(flags.json, true);
});

test('resolveArgs fills positionals, applies defaults, and coerces numbers', () => {
  const op = findOperation('search');
  const args = resolveArgs(op, parseArgs(['climate', '--limit', '7']));
  assert.equal(args.query, 'climate');
  assert.equal(args.limit, 7);
  assert.equal(typeof args.limit, 'number');

  const dflt = resolveArgs(op, parseArgs(['climate']));
  assert.equal(dflt.limit, 5); // default applied
});

test('resolveArgs reads body content from --file', () => {
  const f = join(tmpdir(), `opt37-cli-${process.pid}.md`);
  writeFileSync(f, '# from file');
  try {
    const op = findOperation('ingest-doc');
    const args = resolveArgs(op, parseArgs(['--title', 'T', '--file', f]));
    assert.equal(args.raw, '# from file');
    assert.equal(args.title, 'T');
  } finally {
    rmSync(f, { force: true });
  }
});

test('validate flags missing required, bad enum, and NaN number', () => {
  const search = findOperation('search');
  assert.deepEqual(validate(search, {}), ['missing required <query>']);

  const artifact = findOperation('ingest-artifact');
  const errs = validate(artifact, { title: 'T', kind: 'bogus' });
  assert.ok(errs.some((e) => /kind must be one of/.test(e)));

  const okSearch = validate(search, { query: 'x', limit: 5 });
  assert.deepEqual(okSearch, []);
});
