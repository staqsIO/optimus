import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Plan 017 regression: a transient metadata-fetch failure must not permanently
 * drop the message. Failed msgIds go into inbox.gmail_fetch_retries and are
 * re-fetched with bounded attempts on later polls; on cap exhaustion the drop is
 * logged (never stalls the cursor). These tests exercise the retry helpers with
 * an in-memory fake of the retry table and a programmable fetchEmailMetadata.
 */

// In-memory stand-in for inbox.gmail_fetch_retries + inbox.messages.
function makeFakeDb() {
  const retries = new Map(); // `${account}|${msg}` -> { account_id, provider_msg_id, attempts, last_error, seq }
  const stored = new Set();  // provider_msg_ids present in inbox.messages
  let seq = 0;

  const query = async (sql, params = []) => {
    if (/INSERT INTO inbox\.gmail_fetch_retries/.test(sql)) {
      const [account, msg, lastError] = params;
      const key = `${account}|${msg}`;
      const existing = retries.get(key);
      if (existing) {
        existing.attempts += 1;
        existing.last_error = lastError;
      } else {
        retries.set(key, { account_id: account, provider_msg_id: msg, attempts: 1, last_error: lastError, seq: seq++ });
      }
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT provider_msg_id, attempts FROM inbox\.gmail_fetch_retries/.test(sql)) {
      const [account] = params;
      const rows = [...retries.values()]
        .filter(r => r.account_id === account)
        .sort((a, b) => a.seq - b.seq)
        .map(r => ({ provider_msg_id: r.provider_msg_id, attempts: r.attempts }));
      return { rows };
    }
    if (/SELECT 1 FROM inbox\.messages WHERE provider_msg_id/.test(sql)) {
      const [msg] = params;
      return { rows: stored.has(msg) ? [{ ok: 1 }] : [] };
    }
    if (/DELETE FROM inbox\.gmail_fetch_retries/.test(sql)) {
      const [account, msg] = params;
      retries.delete(`${account}|${msg}`);
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };

  return { query, retries, stored };
}

const db = makeFakeDb();

// Programmable fetch: each test reassigns fetchImpl.
let fetchImpl = async () => { throw new Error('fetchImpl not set'); };

// poller.js imports { query, withSystemOrgScope } — both must be present on the
// mocked module surface. On Node 22 mock.module replaces the WHOLE module, so a
// missing named export resolves to undefined and any call site (reconcileSignals')
// would crash; this file only exercises the retry helpers, but the import binding
// must still resolve. withSystemOrgScope returns a scoped executor delegating to
// the fake query, with a no-op release() (OPT-166 poller enforcement hotfix).
mock.module('../src/db.js', {
  namedExports: {
    query: db.query,
    withSystemOrgScope: async () => {
      const q = async (sql, params) => db.query(sql, params);
      q.release = async () => {};
      return q;
    },
  },
});
mock.module('../src/gmail/client.js', {
  namedExports: {
    fetchEmailMetadata: (...args) => fetchImpl(...args),
    fetchMessageLabels: async () => [],
  },
});

const { processFetchRetries, recordFetchRetry } = await import('../src/gmail/poller.js');

const ACCT = 'default';

beforeEach(() => {
  db.retries.clear();
  db.stored.clear();
  fetchImpl = async () => { throw new Error('fetchImpl not set'); };
});

describe('gmail poller — loss-free fetch retries (Plan 017)', () => {
  it('recordFetchRetry inserts then increments attempts for the same message', async () => {
    await recordFetchRetry(ACCT, 'msgA', new Error('429 rate limited'));
    assert.equal(db.retries.get(`${ACCT}|msgA`).attempts, 1);
    await recordFetchRetry(ACCT, 'msgA', new Error('503'));
    assert.equal(db.retries.get(`${ACCT}|msgA`).attempts, 2);
  });

  it('a transient failure is retried on a later poll and, on success, recovered', async () => {
    // Prior cycle recorded the failure.
    await recordFetchRetry(ACCT, 'msgB', new Error('timeout'));

    // Next poll: fetch still failing → row kept and attempts incremented, no loss.
    fetchImpl = async () => { throw new Error('502'); };
    let recovered = await processFetchRetries(null, ACCT);
    assert.deepEqual(recovered, []);
    assert.equal(db.retries.get(`${ACCT}|msgB`).attempts, 2, 'message still queued for retry');

    // Later poll: fetch succeeds → message recovered into the pipeline, row cleared.
    fetchImpl = async (msgId) => ({ id: msgId, labels: ['INBOX'] });
    recovered = await processFetchRetries(null, ACCT);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, 'msgB');
    assert.equal(db.retries.has(`${ACCT}|msgB`), false, 'retry row cleared after success');
  });

  it('bounds retries: after the cap the message is dropped with a log, cursor never stalls', async () => {
    // Seed attempts up to just below the cap (1..4).
    for (let i = 0; i < 4; i++) await recordFetchRetry(ACCT, 'msgC', new Error('err'));
    assert.equal(db.retries.get(`${ACCT}|msgC`).attempts, 4);

    const errLog = mock.method(console, 'error', () => {});
    fetchImpl = async () => { throw new Error('permanent 500'); };

    const recovered = await processFetchRetries(null, ACCT); // attempt would be 5 == cap
    assert.deepEqual(recovered, [], 'no message recovered');
    assert.equal(db.retries.has(`${ACCT}|msgC`), false, 'exhausted message dropped from retry set');

    const dropped = errLog.mock.calls.some(c =>
      /Dropping message after/.test(String(c.arguments[0])) &&
      c.arguments[1]?.provider_msg_id === 'msgC' &&
      c.arguments[1]?.account_id === ACCT
    );
    assert.ok(dropped, 'exhaustion logged with account_id + provider_msg_id');
    errLog.mock.restore();
  });

  it('clears the retry row without re-fetching when the message was stored meanwhile', async () => {
    await recordFetchRetry(ACCT, 'msgD', new Error('timeout'));
    db.stored.add('msgD'); // early-dedup: another path already stored it
    let fetched = false;
    fetchImpl = async () => { fetched = true; return { id: 'msgD', labels: ['INBOX'] }; };

    const recovered = await processFetchRetries(null, ACCT);
    assert.deepEqual(recovered, []);
    assert.equal(fetched, false, 'did not re-fetch an already-stored message');
    assert.equal(db.retries.has(`${ACCT}|msgD`), false, 'retry row cleared');
  });

  it('does not recover a message that is no longer in INBOX (clears the row)', async () => {
    await recordFetchRetry(ACCT, 'msgE', new Error('timeout'));
    fetchImpl = async (msgId) => ({ id: msgId, labels: ['SENT'] });

    const recovered = await processFetchRetries(null, ACCT);
    assert.deepEqual(recovered, []);
    assert.equal(db.retries.has(`${ACCT}|msgE`), false, 'retry row cleared on successful non-INBOX fetch');
  });
});
