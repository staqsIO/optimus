import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCapability,
  getCapability,
  hasCapability,
  clearCapabilities,
} from '../../lib/runtime/capability-registry.js';

describe('CapabilityRegistry', () => {
  beforeEach(() => {
    clearCapabilities();
  });

  describe('registerCapability', () => {
    it('stores an impl under a key', () => {
      const impl = { embedText: async () => [0.1, 0.2] };
      registerCapability('voice/embeddings', impl);
      assert.strictEqual(getCapability('voice/embeddings'), impl);
    });

    it('rejects non-string keys', () => {
      assert.throws(() => registerCapability(null, {}), /non-empty string/);
      assert.throws(() => registerCapability('', {}), /non-empty string/);
      assert.throws(() => registerCapability(42, {}), /non-empty string/);
    });

    it('rejects non-object impls', () => {
      assert.throws(() => registerCapability('x', null), /must be an object/);
      assert.throws(() => registerCapability('x', undefined), /must be an object/);
      assert.throws(() => registerCapability('x', 'string'), /must be an object/);
    });

    it('overwrites a previously registered impl', () => {
      registerCapability('linear/client', { v: 1 });
      registerCapability('linear/client', { v: 2 });
      assert.equal(getCapability('linear/client').v, 2);
    });
  });

  describe('getCapability', () => {
    it('throws when key is unregistered', () => {
      assert.throws(() => getCapability('missing'), /No capability registered: "missing"/);
    });
  });

  describe('hasCapability', () => {
    it('returns true for registered keys', () => {
      registerCapability('voice/embeddings', { embedText: () => {} });
      assert.equal(hasCapability('voice/embeddings'), true);
    });

    it('returns false for unregistered keys', () => {
      assert.equal(hasCapability('nope'), false);
    });
  });

  describe('clearCapabilities', () => {
    it('removes all registrations', () => {
      registerCapability('a', { x: 1 });
      registerCapability('b', { x: 2 });
      clearCapabilities();
      assert.equal(hasCapability('a'), false);
      assert.equal(hasCapability('b'), false);
    });
  });
});
