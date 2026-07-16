import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateInputAdapter } from '../src/adapters/input-adapter.js';

describe('InputAdapter interface', () => {
  it('accepts a conforming adapter', () => {
    const adapter = {
      channel: 'email',
      fetchContent: async () => null,
      buildPromptContext: () => ({}),
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects null', () => {
    const result = validateInputAdapter(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects undefined', () => {
    const result = validateInputAdapter(undefined);
    assert.equal(result.valid, false);
  });

  it('reports missing channel', () => {
    const adapter = {
      fetchContent: async () => null,
      buildPromptContext: () => ({}),
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('channel')));
  });

  it('reports missing fetchContent', () => {
    const adapter = {
      channel: 'email',
      buildPromptContext: () => ({}),
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fetchContent')));
  });

  it('reports missing buildPromptContext', () => {
    const adapter = {
      channel: 'email',
      fetchContent: async () => null,
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('buildPromptContext')));
  });

  it('reports wrong type for channel', () => {
    const adapter = {
      channel: 42,
      fetchContent: async () => null,
      buildPromptContext: () => ({}),
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('channel') && e.includes('string')));
  });

  it('reports wrong type for fetchContent', () => {
    const adapter = {
      channel: 'email',
      fetchContent: 'not a function',
      buildPromptContext: () => ({}),
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('fetchContent') && e.includes('function')));
  });

  it('collects multiple errors at once', () => {
    const result = validateInputAdapter({});
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 3);
  });

  it('allows extra properties beyond the interface', () => {
    const adapter = {
      channel: 'slack',
      fetchContent: async () => null,
      buildPromptContext: () => ({}),
      extraProp: true,
    };
    const result = validateInputAdapter(adapter);
    assert.equal(result.valid, true);
  });
});
