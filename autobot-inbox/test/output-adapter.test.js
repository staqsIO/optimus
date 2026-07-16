import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateOutputAdapter } from '../src/adapters/output-adapter.js';

describe('OutputAdapter interface', () => {
  it('accepts a conforming adapter', () => {
    const adapter = {
      channel: 'email',
      createDraft: async () => null,
      executeDraft: async () => 'sent-id',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects null', () => {
    const result = validateOutputAdapter(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects undefined', () => {
    const result = validateOutputAdapter(undefined);
    assert.equal(result.valid, false);
  });

  it('reports missing channel', () => {
    const adapter = {
      createDraft: async () => null,
      executeDraft: async () => 'sent-id',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('channel')));
  });

  it('reports missing createDraft', () => {
    const adapter = {
      channel: 'email',
      executeDraft: async () => 'sent-id',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('createDraft')));
  });

  it('reports missing executeDraft', () => {
    const adapter = {
      channel: 'email',
      createDraft: async () => null,
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('executeDraft')));
  });

  it('reports wrong type for channel', () => {
    const adapter = {
      channel: 123,
      createDraft: async () => null,
      executeDraft: async () => 'sent-id',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('channel') && e.includes('string')));
  });

  it('reports wrong type for createDraft', () => {
    const adapter = {
      channel: 'email',
      createDraft: 'not a function',
      executeDraft: async () => 'sent-id',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('createDraft') && e.includes('function')));
  });

  it('collects multiple errors at once', () => {
    const result = validateOutputAdapter({});
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 3);
  });

  it('allows extra properties beyond the interface', () => {
    const adapter = {
      channel: 'slack',
      createDraft: async () => null,
      executeDraft: async () => 'ts-123',
      bonus: 'property',
    };
    const result = validateOutputAdapter(adapter);
    assert.equal(result.valid, true);
  });
});
