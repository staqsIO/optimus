import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenRouterBody } from '../../lib/llm/provider.js';

const baseArgs = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  temperature: 0,
};

// The OpenRouter `provider` routing object (require_parameters / allow_fallbacks
// / order) is understood only by OpenRouter's API. buildOpenRouterBody is also
// reused by the Ollama paths purely for Anthropic→OpenAI message/tool
// conversion; Ollama's /v1/chat/completions would reject the unknown field. So
// the routing object MUST be gated behind `providerRouting` (opt-in), which only
// the OpenRouter call sites pass.

test('Ollama path (no providerRouting) omits the OpenRouter provider object', () => {
  const body = buildOpenRouterBody({ modelId: 'llama3' }, baseArgs);
  assert.equal(body.provider, undefined);
});

test('OpenRouter path (providerRouting:true) pins require_parameters + allow_fallbacks', () => {
  const prev = process.env.OPENROUTER_ALLOW_FALLBACKS;
  delete process.env.OPENROUTER_ALLOW_FALLBACKS;
  try {
    const body = buildOpenRouterBody(
      { modelId: 'qwen/qwen-2.5-72b-instruct' },
      { ...baseArgs, providerRouting: true }
    );
    assert.ok(body.provider, 'provider object must be present on OpenRouter path');
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.provider.allow_fallbacks, false); // defaults closed
    assert.equal('order' in body.provider, false); // no providerOrder → no order
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_ALLOW_FALLBACKS;
    else process.env.OPENROUTER_ALLOW_FALLBACKS = prev;
  }
});

test('OPENROUTER_ALLOW_FALLBACKS=true opens fallbacks; providerOrder becomes order', () => {
  const prev = process.env.OPENROUTER_ALLOW_FALLBACKS;
  process.env.OPENROUTER_ALLOW_FALLBACKS = 'true';
  try {
    const body = buildOpenRouterBody(
      { modelId: 'deepseek/deepseek-chat', providerOrder: ['deepseek', 'novita'] },
      { ...baseArgs, providerRouting: true }
    );
    assert.equal(body.provider.allow_fallbacks, true);
    assert.deepEqual(body.provider.order, ['deepseek', 'novita']);
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_ALLOW_FALLBACKS;
    else process.env.OPENROUTER_ALLOW_FALLBACKS = prev;
  }
});

test('tools are converted to OpenAI function format on both paths', () => {
  const tools = [{ name: 't', description: 'd', input_schema: { type: 'object' } }];
  const body = buildOpenRouterBody({ modelId: 'llama3' }, { ...baseArgs, tools });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 't');
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object' });
});
