import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleTldvWebhook } from '../src/tldv/webhook.js';

// A known test secret injected via env. Auth is checked before any DB access,
// and a non-transcript event returns early before the DB is touched, so these
// tests exercise the auth boundary without a database.
const TEST_SECRET = 'sk_test_1234567890_ABCDEFGHIJKLMNOP';

function makeReq(headers = {}) {
  return { headers, url: '/api/webhooks/tldv' };
}
function makeUrl(query = '') {
  return new URL(`http://localhost/api/webhooks/tldv${query}`);
}
// Body that passes auth but short-circuits before any DB call (non-transcript event).
const IGNORED_BODY = { event: 'SomethingElse', data: {} };

describe('handleTldvWebhook auth', () => {
  let warnings;
  let origWarn;
  let origSecret;

  beforeEach(() => {
    origSecret = process.env.TLDV_WEBHOOK_SECRET;
    process.env.TLDV_WEBHOOK_SECRET = TEST_SECRET;
    warnings = [];
    origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
  });

  afterEach(() => {
    console.warn = origWarn;
    if (origSecret === undefined) delete process.env.TLDV_WEBHOOK_SECRET;
    else process.env.TLDV_WEBHOOK_SECRET = origSecret;
  });

  it('accepts a correct Authorization: Bearer header', async () => {
    const res = await handleTldvWebhook(
      makeReq({ authorization: `Bearer ${TEST_SECRET}` }),
      IGNORED_BODY,
      makeUrl()
    );
    assert.equal(res.ok, true);
    assert.equal(res.message, 'Event ignored');
  });

  it('accepts a correct X-Tldv-Secret header', async () => {
    const res = await handleTldvWebhook(
      makeReq({ 'x-tldv-secret': TEST_SECRET }),
      IGNORED_BODY,
      makeUrl()
    );
    assert.equal(res.ok, true);
  });

  it('rejects a wrong header secret with 401', async () => {
    await assert.rejects(
      handleTldvWebhook(makeReq({ authorization: 'Bearer wrong-secret' }), IGNORED_BODY, makeUrl()),
      (err) => err.statusCode === 401
    );
  });

  it('rejects a missing secret (no header, no query) with 401', async () => {
    await assert.rejects(
      handleTldvWebhook(makeReq(), IGNORED_BODY, makeUrl()),
      (err) => err.statusCode === 401
    );
  });

  it('returns 500 when TLDV_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.TLDV_WEBHOOK_SECRET;
    await assert.rejects(
      handleTldvWebhook(makeReq({ authorization: `Bearer ${TEST_SECRET}` }), IGNORED_BODY, makeUrl()),
      (err) => err.statusCode === 500
    );
  });

  it('accepts the deprecated query-param secret and warns about it', async () => {
    const res = await handleTldvWebhook(
      makeReq(),
      IGNORED_BODY,
      makeUrl(`?secret=${TEST_SECRET}`)
    );
    assert.equal(res.ok, true);
    assert.ok(
      warnings.some((w) => w.includes('DEPRECATED query-param auth')),
      'expected a deprecation warning for query-param auth'
    );
  });

  it('never logs any substring of the expected server secret on failure', async () => {
    await assert.rejects(
      handleTldvWebhook(makeReq({ authorization: 'Bearer totally-wrong' }), IGNORED_BODY, makeUrl()),
      (err) => err.statusCode === 401
    );
    const logged = warnings.join('\n');
    // The full secret must never appear.
    assert.ok(!logged.includes(TEST_SECRET), 'log leaked the full server secret');
    // Nor any non-trivial prefix/suffix of it (the old code logged first/last 4).
    assert.ok(!logged.includes(TEST_SECRET.slice(0, 4)), 'log leaked a prefix of the server secret');
    assert.ok(!logged.includes(TEST_SECRET.slice(-4)), 'log leaked a suffix of the server secret');
  });
});
