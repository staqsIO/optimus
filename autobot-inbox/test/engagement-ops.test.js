/**
 * Engagement MCP verbs — shared registry HTTP mapping.
 *
 * The MCP server (tools/optimus-mcp/index.js) registers the engagement verbs
 * from the ENGAGEMENT_OPERATIONS registry (engagement-ops.js). These tests pin
 * the method + path + body each op sends, with a mock fetch, so they run offline
 * in test:ci and catch any drift between a verb and its Board API call.
 *
 * Board-only by construction: none of these tools are in CUSTOMER_OPERATIONS, so
 * the customer-token filter in index.js never surfaces them to a customer token.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../../tools/optimus-mcp/client.js';
import {
  ENGAGEMENT_OPERATIONS,
  findEngagementOperation,
  ENGAGEMENT_KINDS,
  PROPOSAL_SOURCE_TYPES,
} from '../../tools/optimus-mcp/engagement-ops.js';

const ENG_ID = '11111111-2222-3333-4444-555555555555';

// Capturing mock fetch: records the last request, returns a canned 200.
function mockFetch({ ok = true, status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// Run one op by tool name and return { method, path, body } of the HTTP call.
async function callOp(tool, args, fetchOpts) {
  const fetchImpl = mockFetch(fetchOpts);
  const api = createApi({ token: 'board.jwt.sig', apiUrl: 'https://api.test', fetchImpl });
  const op = findEngagementOperation(tool);
  assert.ok(op, `op exists: ${tool}`);
  const data = await op.run(api, args);
  const last = fetchImpl.calls.at(-1);
  return {
    data,
    method: last.opts.method,
    // strip the base so assertions read cleanly
    path: last.url.replace('https://api.test', ''),
    body: last.opts.body ? JSON.parse(last.opts.body) : null,
    auth: last.opts.headers.Authorization,
  };
}

// ── registry shape ───────────────────────────────────────────────────────────

test('registry: 7 engagement verbs, unique tool names, none collide with customer ops', async () => {
  assert.equal(ENGAGEMENT_OPERATIONS.length, 7);
  const names = ENGAGEMENT_OPERATIONS.map((o) => o.tool);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const op of ENGAGEMENT_OPERATIONS) {
    assert.equal(typeof op.tool, 'string');
    assert.equal(typeof op.summary, 'string');
    assert.equal(typeof op.run, 'function');
  }
  // Confirm the board/customer split: the artifacts module owns CUSTOMER_OPERATIONS.
  const { CUSTOMER_OPERATIONS } = await import('../../tools/optimus-mcp/client.js');
  const customerNames = new Set(CUSTOMER_OPERATIONS.map((o) => o.tool));
  for (const n of names) assert.equal(customerNames.has(n), false, `${n} is board-only`);
});

// ── reads ────────────────────────────────────────────────────────────────────

test('optimus_engagements: GET /api/engagements, optional status filter', async () => {
  const bare = await callOp('optimus_engagements', {});
  assert.equal(bare.method, 'GET');
  assert.equal(bare.path, '/api/engagements');
  assert.equal(bare.body, null);
  assert.equal(bare.auth, 'Bearer board.jwt.sig');

  const filtered = await callOp('optimus_engagements', { status: 'active' });
  assert.equal(filtered.path, '/api/engagements?status=active');
});

test('optimus_engagement: GET detail by id (url-encoded)', async () => {
  const r = await callOp('optimus_engagement', { id: ENG_ID });
  assert.equal(r.method, 'GET');
  assert.equal(r.path, `/api/engagements/${ENG_ID}`);
});

test('optimus_list_generated_proposals: GET deliverables', async () => {
  const r = await callOp('optimus_list_generated_proposals', { id: ENG_ID });
  assert.equal(r.method, 'GET');
  assert.equal(r.path, `/api/engagements/${ENG_ID}/generated-proposals`);
});

// ── create ───────────────────────────────────────────────────────────────────

test('optimus_create_engagement: POST with only the fields set; no ownership keys', async () => {
  const r = await callOp('optimus_create_engagement', { name: 'Acme Site', client: 'Acme Corp' });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/engagements');
  assert.deepEqual(r.body, { name: 'Acme Site', client: 'Acme Corp' });
  // compact() drops undefined kind/status/on_behalf_of_org_id
  assert.equal('kind' in r.body, false);
  assert.equal('owner_org_id' in r.body, false);
});

test('optimus_create_engagement: passes kind/status/on_behalf_of_org_id when set', async () => {
  const r = await callOp('optimus_create_engagement', {
    name: 'Acme', kind: 'website', status: 'active', on_behalf_of_org_id: 'org-1',
  });
  assert.deepEqual(r.body, {
    name: 'Acme', kind: 'website', status: 'active', on_behalf_of_org_id: 'org-1',
  });
  assert.ok(ENGAGEMENT_KINDS.includes('website'));
});

// ── add proposal (source) ────────────────────────────────────────────────────

test('add proposal: paste → source_type paste + content, default kind draft', async () => {
  const r = await callOp('optimus_add_engagement_proposal', { id: ENG_ID, content: '# notes' });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, `/api/engagements/${ENG_ID}/proposals`);
  assert.deepEqual(r.body, { kind: 'draft', source_type: 'paste', content: '# notes' });
});

test('add proposal: explicit source_type "paste" still attaches content (resolved var drives branch)', async () => {
  const r = await callOp('optimus_add_engagement_proposal', {
    id: ENG_ID, source_type: 'paste', content: 'hello', kind: 'note',
  });
  assert.deepEqual(r.body, { kind: 'note', source_type: 'paste', content: 'hello' });
});

test('add proposal: url is inferred and sent', async () => {
  const r = await callOp('optimus_add_engagement_proposal', {
    id: ENG_ID, url: 'https://x.test/doc', kind: 'finalized', title: 'Spec',
  });
  assert.deepEqual(r.body, {
    kind: 'finalized', title: 'Spec', source_type: 'url', url: 'https://x.test/doc',
  });
});

test('add proposal: upload requires content_b64 + filename', async () => {
  const r = await callOp('optimus_add_engagement_proposal', {
    id: ENG_ID, content_b64: 'QUJD', filename: 'brief.pdf',
  });
  assert.equal(r.body.source_type, 'upload');
  assert.equal(r.body.content_b64, 'QUJD');
  assert.equal(r.body.filename, 'brief.pdf');
  assert.ok(PROPOSAL_SOURCE_TYPES.includes('upload'));
});

test('add proposal: explicit source_type with missing payload throws (fail-closed)', async () => {
  const op = findEngagementOperation('optimus_add_engagement_proposal');
  const api = createApi({ token: 't', fetchImpl: mockFetch() });
  // async thunks so the synchronous validation throw surfaces as a rejection
  await assert.rejects(async () => op.run(api, { id: ENG_ID, source_type: 'paste' }), /requires content/);
  await assert.rejects(async () => op.run(api, { id: ENG_ID, source_type: 'url' }), /requires url/);
  await assert.rejects(
    async () => op.run(api, { id: ENG_ID, source_type: 'upload', content_b64: 'x' }),
    /requires content_b64 and filename/
  );
});

// ── synthesize (async) ───────────────────────────────────────────────────────

test('synthesize: POST, only sends set fields', async () => {
  const bare = await callOp('optimus_synthesize_engagement', { id: ENG_ID });
  assert.equal(bare.method, 'POST');
  assert.equal(bare.path, `/api/engagements/${ENG_ID}/synthesize`);
  assert.deepEqual(bare.body, {});

  const dry = await callOp('optimus_synthesize_engagement', { id: ENG_ID, dry_run: true, model_key: 'm' });
  assert.deepEqual(dry.body, { dry_run: true, model_key: 'm' });
});

// ── generate proposal (the deliverable) ──────────────────────────────────────

test('generate proposal: POST defaults format md', async () => {
  const r = await callOp('optimus_generate_proposal', { id: ENG_ID });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, `/api/engagements/${ENG_ID}/generate-proposal`);
  assert.deepEqual(r.body, { format: 'md' });
});

test('generate proposal: honors format + force', async () => {
  const r = await callOp('optimus_generate_proposal', { id: ENG_ID, format: 'docx', force: true });
  assert.deepEqual(r.body, { format: 'docx', force: true });
});

// ── error propagation ────────────────────────────────────────────────────────

test('a non-2xx Board API response surfaces as a thrown error', async () => {
  await assert.rejects(
    () => callOp('optimus_engagement', { id: ENG_ID }, { ok: false, status: 404, body: { error: 'not found' } }),
    /404: not found/
  );
});
