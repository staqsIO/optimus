import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setSignalEmitter,
  emitAdapterSignal,
  clearSignalEmitter,
  registerAdapter,
  clearAdapters,
} from '../../lib/adapters/registry.js';

// Minimal valid adapter stub (satisfies InputAdapter interface)
function makeStubAdapter() {
  return {
    channel: 'email',
    fetchContent: async () => 'body',
    buildPromptContext: () => ({ channel: 'email' }),
  };
}

describe('Adapter signal emission', () => {
  beforeEach(() => {
    clearSignalEmitter();
    clearAdapters();
  });

  it('setSignalEmitter sets the emitter callback', async () => {
    let called = false;
    setSignalEmitter(async () => { called = true; });
    await emitAdapterSignal('email.received', {}, 'gmail');
    assert.equal(called, true);
  });

  it('emitAdapterSignal calls the emitter with correct args', async () => {
    let capturedArgs;
    setSignalEmitter(async (signalType, payload, sourceAdapter) => {
      capturedArgs = { signalType, payload, sourceAdapter };
    });

    const payload = { messageId: 'msg-1', subject: 'Hello' };
    await emitAdapterSignal('email.received', payload, 'gmail');

    assert.deepStrictEqual(capturedArgs, {
      signalType: 'email.received',
      payload,
      sourceAdapter: 'gmail',
    });
  });

  it('emitAdapterSignal returns null when no emitter set', async () => {
    const result = await emitAdapterSignal('email.received', {}, 'gmail');
    assert.equal(result, null);
  });

  it('emitAdapterSignal returns the signal from the emitter', async () => {
    const expectedSignal = { id: 'sig-1', type: 'email.received', ts: Date.now() };
    setSignalEmitter(async () => expectedSignal);

    const result = await emitAdapterSignal('email.received', {}, 'gmail');
    assert.deepStrictEqual(result, expectedSignal);
  });

  it('clearSignalEmitter clears the emitter so subsequent calls return null', async () => {
    let callCount = 0;
    setSignalEmitter(async () => { callCount++; });

    await emitAdapterSignal('slack.message', {}, 'slack');
    assert.equal(callCount, 1);

    clearSignalEmitter();

    const result = await emitAdapterSignal('slack.message', {}, 'slack');
    assert.equal(result, null);
    assert.equal(callCount, 1); // not called again
  });

  it('signal emission works alongside adapter registration (no interference)', async () => {
    // Register an adapter
    const adapter = makeStubAdapter();
    registerAdapter('gmail', adapter);

    // Set up signal emitter
    const signals = [];
    setSignalEmitter(async (signalType, payload, sourceAdapter) => {
      signals.push({ signalType, sourceAdapter });
      return { id: `sig-${signals.length}` };
    });

    // Emit signals
    const sig1 = await emitAdapterSignal('email.received', { id: 1 }, 'gmail');
    const sig2 = await emitAdapterSignal('webhook.payload', { id: 2 }, 'webhook');

    // Adapter registry still works
    const { getAdapter } = await import('../../lib/adapters/registry.js');
    const retrieved = getAdapter('gmail');
    assert.equal(retrieved, adapter);

    // Signals were recorded
    assert.equal(signals.length, 2);
    assert.deepStrictEqual(sig1, { id: 'sig-1' });
    assert.deepStrictEqual(sig2, { id: 'sig-2' });
  });
});
