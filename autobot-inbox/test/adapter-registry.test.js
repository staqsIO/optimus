import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAdapter,
  getAdapter,
  getAdapterForMessage,
  clearAdapters,
} from '../src/adapters/registry.js';

// Minimal valid adapter (satisfies InputAdapter interface)
function makeAdapter(channel = 'test') {
  return {
    channel,
    async fetchContent() { return 'body'; },
    buildPromptContext() { return { channel, body: 'body', contentLabel: 'untrusted', contentType: 'message', sender: {}, threading: null, channelHint: '' }; },
  };
}

describe('AdapterRegistry', () => {
  beforeEach(() => {
    clearAdapters();
  });

  describe('registerAdapter', () => {
    it('stores a valid adapter', () => {
      registerAdapter('gmail', makeAdapter('email'));
      const adapter = getAdapter('gmail');
      assert.equal(adapter.channel, 'email');
    });

    it('rejects non-string provider', () => {
      assert.throws(() => registerAdapter(null, makeAdapter()), /non-empty string/);
      assert.throws(() => registerAdapter('', makeAdapter()), /non-empty string/);
      assert.throws(() => registerAdapter(123, makeAdapter()), /non-empty string/);
    });

    it('rejects adapter missing required methods', () => {
      assert.throws(
        () => registerAdapter('bad', { channel: 'test' }),
        /Invalid adapter.*missing required property: fetchContent/
      );
    });

    it('rejects adapter with wrong types', () => {
      assert.throws(
        () => registerAdapter('bad', { channel: 'test', fetchContent: 'not-a-fn', buildPromptContext: () => {} }),
        /Invalid adapter.*fetchContent must be a function/
      );
    });

    it('overwrites a previously registered adapter', () => {
      registerAdapter('gmail', makeAdapter('v1'));
      registerAdapter('gmail', makeAdapter('v2'));
      assert.equal(getAdapter('gmail').channel, 'v2');
    });
  });

  describe('getAdapter', () => {
    it('returns a registered adapter', () => {
      const adapter = makeAdapter('email');
      registerAdapter('gmail', adapter);
      assert.strictEqual(getAdapter('gmail'), adapter);
    });

    it('throws for unknown provider', () => {
      assert.throws(() => getAdapter('unknown'), /No adapter registered for provider "unknown"/);
    });
  });

  describe('getAdapterForMessage', () => {
    it('resolves adapter from message.provider', () => {
      registerAdapter('outlook', makeAdapter('email'));
      const adapter = getAdapterForMessage({ provider: 'outlook' });
      assert.equal(adapter.channel, 'email');
    });

    it('defaults to gmail when message.provider is missing', () => {
      registerAdapter('gmail', makeAdapter('email'));
      const adapter = getAdapterForMessage({});
      assert.equal(adapter.channel, 'email');
    });

    it('defaults to gmail when message.provider is null', () => {
      registerAdapter('gmail', makeAdapter('email'));
      const adapter = getAdapterForMessage({ provider: null });
      assert.equal(adapter.channel, 'email');
    });

    it('throws when resolved provider has no adapter', () => {
      assert.throws(
        () => getAdapterForMessage({ provider: 'unknown' }),
        /No adapter registered/
      );
    });
  });

  describe('clearAdapters', () => {
    it('removes all registered adapters', () => {
      registerAdapter('gmail', makeAdapter());
      registerAdapter('slack', makeAdapter());
      clearAdapters();
      assert.throws(() => getAdapter('gmail'));
      assert.throws(() => getAdapter('slack'));
    });
  });
});
