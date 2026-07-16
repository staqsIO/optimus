import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { beginDrain, isDraining, registerAbort, drainTimeoutMs, _resetDrainState } from '../../lib/runtime/lifecycle.js';

describe('lifecycle drain coordinator (Phase 2.3)', () => {
  beforeEach(() => _resetDrainState());

  it('isDraining flips on beginDrain', () => {
    assert.equal(isDraining(), false);
    beginDrain();
    assert.equal(isDraining(), true);
  });

  it('beginDrain aborts every registered controller', () => {
    const a = new AbortController();
    const b = new AbortController();
    registerAbort(a);
    registerAbort(b);
    assert.equal(a.signal.aborted, false);
    beginDrain();
    assert.equal(a.signal.aborted, true, 'in-flight iteration controller A aborted');
    assert.equal(b.signal.aborted, true, 'controller B aborted');
  });

  it('registering AFTER drain has begun aborts immediately', () => {
    beginDrain();
    const c = new AbortController();
    registerAbort(c);
    assert.equal(c.signal.aborted, true);
  });

  it('unregister removes a controller so it is NOT aborted later', () => {
    const c = new AbortController();
    const unregister = registerAbort(c);
    unregister();
    beginDrain();
    assert.equal(c.signal.aborted, false, 'settled iteration must not be aborted');
  });

  it('drainTimeoutMs honors env, defaults to 30s', () => {
    const prev = process.env.DRAIN_TIMEOUT_MS;
    delete process.env.DRAIN_TIMEOUT_MS;
    assert.equal(drainTimeoutMs(), 30_000);
    process.env.DRAIN_TIMEOUT_MS = '5000';
    assert.equal(drainTimeoutMs(), 5000);
    if (prev === undefined) delete process.env.DRAIN_TIMEOUT_MS; else process.env.DRAIN_TIMEOUT_MS = prev;
  });

  it('beginDrain is idempotent (double SIGTERM safe)', () => {
    const a = new AbortController();
    registerAbort(a);
    beginDrain();
    beginDrain(); // must not throw
    assert.equal(a.signal.aborted, true);
  });
});
