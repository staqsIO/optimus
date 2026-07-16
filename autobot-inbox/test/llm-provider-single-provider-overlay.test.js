/**
 * Unit tests for the LLM_SINGLE_PROVIDER overlay in lib/llm/provider.js
 * (OSS zero-config demo boot — spec/features/d1-d2-zero-config-demo-spec.md).
 *
 * Covers:
 *   - Prod no-op: with LLM_SINGLE_PROVIDER unset, provider resolution for an
 *     openrouter-configured model is unchanged (still fails fast on the
 *     missing OPENROUTER_API_KEY, exactly as before this change).
 *   - Remap: with LLM_SINGLE_PROVIDER=anthropic, an openrouter-configured
 *     model resolves to provider "anthropic" using a Claude modelId, and
 *     only requires ANTHROPIC_API_KEY.
 *   - LLM_SINGLE_PROVIDER_MODEL override picks a specific fallback key.
 *   - No matching model for LLM_SINGLE_PROVIDER throws a clear error.
 *
 * Run: node --test test/llm-provider-single-provider-overlay.test.js
 * (or `npm run test:ci` for the whole suite — CI parity, force-exit + timeout)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMClient } from '../../lib/llm/provider.js';

const MODELS = {
  'google/gemini-2.5-pro': {
    provider: 'openrouter',
    inputCostPer1M: 1.25,
    outputCostPer1M: 5,
  },
  'deepseek/deepseek-chat-v3-0324': {
    provider: 'openrouter',
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.1,
  },
  // Declared with the EXPENSIVE anthropic model FIRST, so the default-fallback
  // test genuinely proves cheapest-by-cost selection (not first-declared). This
  // mirrors agents.json, where Opus (most expensive) is the first Claude entry.
  'claude-opus-4-6': {
    provider: 'anthropic',
    inputCostPer1M: 15,
    outputCostPer1M: 75,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    inputCostPer1M: 3,
    outputCostPer1M: 15,
  },
  'claude-haiku-4-5-20251001': {
    // provider omitted — defaults to 'anthropic', matching agents.json convention
    inputCostPer1M: 1,
    outputCostPer1M: 5,
  },
};

describe('LLM_SINGLE_PROVIDER overlay', () => {
  let originalSingleProvider;
  let originalSingleProviderModel;
  let originalAnthropicKey;
  let originalOpenrouterKey;

  before(() => {
    originalSingleProvider = process.env.LLM_SINGLE_PROVIDER;
    originalSingleProviderModel = process.env.LLM_SINGLE_PROVIDER_MODEL;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalOpenrouterKey = process.env.OPENROUTER_API_KEY;
  });

  after(() => {
    const restore = (key, val) => { if (val === undefined) delete process.env[key]; else process.env[key] = val; };
    restore('LLM_SINGLE_PROVIDER', originalSingleProvider);
    restore('LLM_SINGLE_PROVIDER_MODEL', originalSingleProviderModel);
    restore('ANTHROPIC_API_KEY', originalAnthropicKey);
    restore('OPENROUTER_API_KEY', originalOpenrouterKey);
  });

  beforeEach(() => {
    delete process.env.LLM_SINGLE_PROVIDER;
    delete process.env.LLM_SINGLE_PROVIDER_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it('prod no-op: unset LLM_SINGLE_PROVIDER still resolves openrouter and fails fast on missing OPENROUTER_API_KEY', () => {
    assert.throws(
      () => createLLMClient('google/gemini-2.5-pro', MODELS),
      /OPENROUTER_API_KEY required/,
      'unset LLM_SINGLE_PROVIDER must not change prod provider resolution',
    );
  });

  it('prod no-op: unset LLM_SINGLE_PROVIDER resolves openrouter successfully once OPENROUTER_API_KEY is present (byte-identical to pre-change behavior)', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const llm = createLLMClient('google/gemini-2.5-pro', MODELS);
    assert.equal(llm.provider, 'openrouter');
    assert.equal(llm.modelId, 'google/gemini-2.5-pro');
  });

  it('remaps an openrouter model to the CHEAPEST anthropic model when LLM_SINGLE_PROVIDER=anthropic', () => {
    process.env.LLM_SINGLE_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = createLLMClient('google/gemini-2.5-pro', MODELS);
    assert.equal(llm.provider, 'anthropic');
    // Default fallback picks the CHEAPEST anthropic model by inputCostPer1M —
    // 'claude-haiku-4-5-20251001' (cost 1) — NOT the first-declared one
    // ('claude-opus-4-6', cost 15). A first-match fallback would silently route
    // the whole zero-config demo onto Opus (the V-5 defect this guards against).
    assert.equal(llm.modelId, 'claude-haiku-4-5-20251001');
  });

  it('remapped call only requires ANTHROPIC_API_KEY, not OPENROUTER_API_KEY', () => {
    process.env.LLM_SINGLE_PROVIDER = 'anthropic';
    // Deliberately no OPENROUTER_API_KEY set.
    assert.throws(
      () => createLLMClient('google/gemini-2.5-pro', MODELS),
      /ANTHROPIC_API_KEY required/,
      'remapped path must fail on the target (anthropic) key, never the original (openrouter) key',
    );
  });

  it('honors LLM_SINGLE_PROVIDER_MODEL as an explicit fallback override', () => {
    process.env.LLM_SINGLE_PROVIDER = 'anthropic';
    process.env.LLM_SINGLE_PROVIDER_MODEL = 'claude-sonnet-4-6';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = createLLMClient('deepseek/deepseek-chat-v3-0324', MODELS);
    assert.equal(llm.provider, 'anthropic');
    assert.equal(llm.modelId, 'claude-sonnet-4-6');
  });

  it('is a no-op when the model already matches LLM_SINGLE_PROVIDER (no remap, no warning)', () => {
    process.env.LLM_SINGLE_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = createLLMClient('claude-sonnet-4-6', MODELS);
    assert.equal(llm.provider, 'anthropic');
    assert.equal(llm.modelId, 'claude-sonnet-4-6');
  });

  it('throws a clear error when LLM_SINGLE_PROVIDER has no matching model and no override', () => {
    process.env.LLM_SINGLE_PROVIDER = 'ollama';
    assert.throws(
      () => createLLMClient('google/gemini-2.5-pro', MODELS),
      /LLM_SINGLE_PROVIDER="ollama" is set but no model.*resolves to provider "ollama"/,
    );
  });
});
