// autobot-inbox/test/pg-listener.test.js — Phase 1 shared LISTEN consolidation.
// Lives here (not under lib/) because CI (`test:ci`) only runs autobot-inbox/test/.
//
// Exercises the in-process contract of the shared pg-listener:
//   - subscribe() BEFORE start() buffers registrations (LISTENed on connect)
//   - a single notification fans out to MULTIPLE handlers on a channel
//   - unsubscribe() detaches one handler without affecting siblings
//   - stop() is idempotent and safe to call repeatedly
//   - stop() sets _destroying so an error after stop() does NOT reconnect
//   - the active keepalive probe reconnects on a dead connection
//
// The pg.Client is injected via the module's __setClientFactoryForTest seam
// (mirrors _getPgLiteForTest in lib/db.js), so no real connection is opened
// and the test runs under a plain `node --test` with no experimental flags.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// A fake pg.Client capturing LISTEN/UNLISTEN and replaying notifications.
class FakeClient {
  constructor() {
    this.listened = [];
    this.queries = [];
    this.ended = false;
    this._handlers = { error: [], notification: [] };
    // Set to an Error to make the next non-LISTEN query (e.g. the keepalive
    // `SELECT 1`) reject — simulates a dead connection.
    this.failNextQuery = null;
  }
  on(event, cb) {
    (this._handlers[event] ||= []).push(cb);
    return this;
  }
  removeAllListeners() {
    this._handlers = { error: [], notification: [] };
  }
  async connect() {
    this.connected = true;
  }
  async query(text) {
    this.queries.push(text);
    const m = /^LISTEN\s+"?([^"]+)"?/i.exec(text);
    if (m) {
      this.listened.push(m[1]);
      return { rows: [] };
    }
    if (this.failNextQuery) {
      const err = this.failNextQuery;
      this.failNextQuery = null;
      throw err;
    }
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
  // Test helper: drive a NOTIFY into the registered notification handlers.
  fire(channel, payload) {
    for (const cb of this._handlers.notification) cb({ channel, payload });
  }
  // Test helper: drive a connection 'error' event into the listener.
  emitError(message = 'simulated connection error') {
    for (const cb of this._handlers.error) cb(new Error(message));
  }
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

// Fresh module instance per test so module-scope state never leaks between
// cases. Each import also re-installs the fake client factory.
async function freshListener() {
  const mod = await import(
    `../../lib/runtime/pg-listener.js?t=${Date.now()}-${Math.random()}`
  );
  const created = [];
  mod.__setClientFactoryForTest(() => {
    const c = new FakeClient();
    created.push(c);
    return c;
  });
  return { mod, created };
}

describe('pg-listener (shared LISTEN consolidation)', () => {
  let mod;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://fake/db'; // force the connected path
  });

  afterEach(async () => {
    if (mod) await mod.stop();
    if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB_URL;
  });

  it('buffers subscribe() calls made BEFORE start() and LISTENs on connect', async () => {
    ({ mod } = await freshListener());
    const seen = [];
    mod.subscribe('task_completed', (p, ch) => seen.push([ch, p]));
    mod.subscribe('autobot_events', (p, ch) => seen.push([ch, p]));

    await mod.start();

    const client = mod.getListenerClient();
    assert.ok(client, 'client should be connected after start()');
    assert.deepEqual(
      [...client.listened].sort(),
      ['autobot_events', 'task_completed'],
      'both buffered channels should be LISTENed on connect'
    );

    client.fire('task_completed', '{"work_item_id":"w1"}');
    assert.deepEqual(seen, [['task_completed', '{"work_item_id":"w1"}']]);
  });

  it('fans a single notification out to multiple handlers on the same channel', async () => {
    ({ mod } = await freshListener());
    const a = [];
    const b = [];
    mod.subscribe('contact_changed', (p) => a.push(p));
    mod.subscribe('contact_changed', (p) => b.push(p));

    await mod.start();
    const client = mod.getListenerClient();

    // Channel LISTENed exactly once despite two handlers.
    assert.equal(client.listened.filter((c) => c === 'contact_changed').length, 1);

    client.fire('contact_changed', '{"id":"c1"}');
    assert.deepEqual(a, ['{"id":"c1"}']);
    assert.deepEqual(b, ['{"id":"c1"}']);
  });

  it('unsubscribe() detaches one handler without affecting siblings', async () => {
    ({ mod } = await freshListener());
    const a = [];
    const b = [];
    const unsubA = mod.subscribe('draft_reviewed', (p) => a.push(p));
    mod.subscribe('draft_reviewed', (p) => b.push(p));

    await mod.start();
    const client = mod.getListenerClient();

    client.fire('draft_reviewed', '{"proposal_id":"p1"}');
    assert.deepEqual(a, ['{"proposal_id":"p1"}']);
    assert.deepEqual(b, ['{"proposal_id":"p1"}']);

    unsubA();
    client.fire('draft_reviewed', '{"proposal_id":"p2"}');
    assert.deepEqual(a, ['{"proposal_id":"p1"}'], 'detached handler must not fire again');
    assert.deepEqual(b, ['{"proposal_id":"p1"}', '{"proposal_id":"p2"}']);
  });

  it('a handler that throws does not break dispatch to the others', async () => {
    ({ mod } = await freshListener());
    const ok = [];
    mod.subscribe('task_completed', () => {
      throw new Error('boom');
    });
    mod.subscribe('task_completed', (p) => ok.push(p));

    await mod.start();
    mod.getListenerClient().fire('task_completed', '{"work_item_id":"w9"}');
    assert.deepEqual(ok, ['{"work_item_id":"w9"}']);
  });

  it('subscribe() AFTER start() issues a LISTEN immediately', async () => {
    ({ mod } = await freshListener());
    await mod.start();
    const client = mod.getListenerClient();
    assert.equal(client.listened.length, 0, 'no channels yet');

    const seen = [];
    mod.subscribe('organization_changed', (p) => seen.push(p));
    // LISTEN is fire-and-forget on the async query; allow the microtask to run.
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(client.listened, ['organization_changed']);

    client.fire('organization_changed', '{"id":"o1"}');
    assert.deepEqual(seen, ['{"id":"o1"}']);
  });

  it('stop() is idempotent and UNLISTENs + ends the client', async () => {
    ({ mod } = await freshListener());
    mod.subscribe('task_completed', () => {});
    await mod.start();
    const client = mod.getListenerClient();

    await mod.stop();
    assert.ok(client.ended, 'client should be ended after stop()');
    assert.ok(client.queries.includes('UNLISTEN *'), 'stop() should UNLISTEN *');
    assert.equal(mod.getListenerClient(), null, 'client cleared after stop()');

    // Second stop() must not throw.
    await mod.stop();
    assert.equal(mod.getListenerClient(), null);
  });

  it('start() is a no-op without DATABASE_URL (PGlite/dev mode)', async () => {
    const { mod: fresh } = await freshListener();
    delete process.env.DATABASE_URL;
    // subscribe still records; start does not connect.
    fresh.subscribe('task_completed', () => {});
    await fresh.start();
    assert.equal(fresh.getListenerClient(), null, 'no client in PGlite mode');
    await fresh.stop(); // idempotent / safe
  });

  it('stop() sets _destroying so a later error does NOT reconnect (core bug class)', async () => {
    ({ mod } = await freshListener());
    mod.subscribe('task_completed', () => {});
    await mod.start();
    const client = mod.getListenerClient();

    await mod.stop();
    assert.equal(mod.getListenerClient(), null, 'client cleared after stop()');

    // Emit a connection error on the now-orphaned client. The error handler
    // routes to scheduleReconnect(), which must early-return because
    // _destroying is set — so NO new client is created.
    client.emitError('post-stop error');
    // Allow any (incorrectly) scheduled reconnect microtask/timer to run.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      mod.getListenerClient(),
      null,
      'no reconnect after stop() — _destroying must block scheduleReconnect()'
    );
  });

  it('active keepalive probe reconnects when SELECT 1 fails (dead connection)', async () => {
    // Tiny keepalive interval so the probe fires within the test. Read at
    // module-eval time, so set it BEFORE the cache-busted import in freshListener.
    process.env.PG_LISTENER_KEEPALIVE_MS = '10';
    try {
      ({ mod } = await freshListener());
      mod.subscribe('task_completed', () => {});
      await mod.start();
      const first = mod.getListenerClient();
      assert.ok(first, 'connected on start()');

      // Make the next non-LISTEN query (the keepalive SELECT 1) reject.
      first.failNextQuery = new Error('connection terminated');

      // Wait for the keepalive interval (10ms) to fire and detect the dead
      // connection. scheduleReconnect() tears the dead client down immediately
      // (client nulled + old client ended), then arms a backoff reconnect.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(first.ended, 'keepalive failure should tear down (end) the dead client');

      // The reconnect is armed with the backoff seed (1000ms). Wait past it for
      // the new client to connect and re-LISTEN every channel.
      await new Promise((r) => setTimeout(r, 1100));
      const second = mod.getListenerClient();
      assert.ok(second, 'a new client should exist after keepalive-triggered reconnect');
      assert.notEqual(second, first, 'reconnect should replace the dead client');
      assert.ok(
        second.listened.includes('task_completed'),
        'reconnected client should re-LISTEN every registered channel'
      );
    } finally {
      delete process.env.PG_LISTENER_KEEPALIVE_MS;
    }
  });
});
