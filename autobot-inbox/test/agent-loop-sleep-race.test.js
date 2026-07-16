import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop } from '../../lib/runtime/agent-loop.js';

/**
 * STAQPRO-351: agent loops were dying silently because sleep() leaked dangling
 * resolvers and timers — each new sleep() clobbered this._wakeUp and never
 * cleared the prior timer, so stale wakers could overwrite a live slot, dropping
 * the wake-up event entirely.
 *
 * These tests pin the post-fix invariants on AgentLoop.prototype.sleep without
 * standing up a full agent (which needs DB + config). We exercise sleep() on
 * a bare prototype instance so the test stays hermetic.
 */
describe('AgentLoop sleep() race safety', () => {
  const makeStub = () => {
    const obj = Object.create(AgentLoop.prototype);
    obj._wakeUp = null;
    return obj;
  };

  it('clears _wakeUp when the timer fires on its own', async () => {
    const obj = makeStub();
    const start = Date.now();
    await obj.sleep(15);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 10, `slept ${elapsed}ms, expected >=10`);
    assert.equal(obj._wakeUp, null, '_wakeUp should be cleared after timer fires');
  });

  it('stale wakers never clobber the live _wakeUp slot', async () => {
    const obj = makeStub();

    const p1 = obj.sleep(10_000);
    const wake1 = obj._wakeUp;
    assert.equal(typeof wake1, 'function', 'first sleep installs a wake fn');

    const p2 = obj.sleep(10_000);
    const wake2 = obj._wakeUp;
    assert.notStrictEqual(wake1, wake2, 'second sleep replaces _wakeUp');

    // Resolving the *stale* wake1 must:
    //   1. resolve its own promise (p1)
    //   2. NOT touch _wakeUp (it doesn't own that slot anymore)
    wake1();
    await p1;
    assert.strictEqual(obj._wakeUp, wake2, 'stale wake1 must not clear _wakeUp');

    // The live wake2 owns the slot — calling it should clear _wakeUp.
    wake2();
    await p2;
    assert.equal(obj._wakeUp, null, 'live wake2 clears _wakeUp on resolve');
  });

  it('does not leak setTimeout handles when waked early', async () => {
    // If sleep didn't clearTimeout on early wake, the timer would still fire
    // and try to resolve again. Promises are idempotent so we can't observe
    // double-resolve directly — but we can observe that the timer callback
    // does NOT clobber a fresh _wakeUp set after the original sleep returns.
    const obj = makeStub();

    const p1 = obj.sleep(20);
    const wake1 = obj._wakeUp;
    wake1(); // resolve early; timer should be cleared by wake1
    await p1;
    assert.equal(obj._wakeUp, null);

    // Now install a new sleep with a long timer. If the old setTimeout had
    // leaked, it would fire after ~20ms and clobber _wakeUp to null even
    // though wake2 is the rightful owner.
    const p2 = obj.sleep(10_000);
    const wake2 = obj._wakeUp;
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(obj._wakeUp, wake2, 'leaked timer did not clobber slot');

    wake2();
    await p2;
  });
});
