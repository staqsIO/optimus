/**
 * Ollama provider tests (OPT-39 dormant seam).
 *
 * Mocked at the SDK-client boundary — a pre-set llm.client bypasses
 * ensureOllamaClient so no real Ollama server is needed. Mirrors the
 * openrouter test pattern in llm-provider-stream.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, callProviderStream } from '../../lib/llm/provider.js';

async function collect(gen) {
  const tokens = [];
  let final = null;
  for await (const ev of gen) {
    if (ev.type === 'token') tokens.push(ev.delta);
    else if (ev.type === 'final') final = ev.response;
  }
  return { tokens, final };
}

function asyncIterableOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

// ---------------------------------------------------------------------------
// createLLMClient — dormant gate
// ---------------------------------------------------------------------------

test('createLLMClient ollama does not require an API key and sets provider=ollama', async () => {
  // Import dynamically so we can test the factory without side effects.
  const { createLLMClient } = await import('../../lib/llm/provider.js');
  const llm = createLLMClient('my-local-model', {
    'my-local-model': { provider: 'ollama' },
  });
  assert.equal(llm.provider, 'ollama');
  assert.equal(llm.client, null); // lazily populated on first call
});

test('createLLMClient rejects unknown providers with a helpful error', async () => {
  const { createLLMClient } = await import('../../lib/llm/provider.js');
  assert.throws(
    () => createLLMClient('bad', { bad: { provider: 'gpt-wrapper' } }),
    /Unknown provider "gpt-wrapper"/,
  );
});

// ---------------------------------------------------------------------------
// callProvider (blocking) — ollama path
// ---------------------------------------------------------------------------

test('callProvider ollama normalizes text, tool calls, and stop reason', async () => {
  const mockResponse = {
    choices: [{
      message: {
        content: 'Hello from Ollama',
        tool_calls: [
          { id: 'tc_1', function: { name: 'do_thing', arguments: '{"x":1}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 30, completion_tokens: 12 },
  };

  const llm = {
    provider: 'ollama',
    modelId: 'llama3.2',
    modelConfig: {},
    client: { chat: { completions: { create: async () => mockResponse } } },
  };

  const result = await callProvider(llm, {
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 200,
  });

  assert.equal(result.text, 'Hello from Ollama');
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 12);
  assert.equal(result.stopReason, 'tool_use'); // OPENAI_STOP_MAP: tool_calls → tool_use
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0], {
    type: 'tool_use',
    id: 'tc_1',
    name: 'do_thing',
    input: { x: 1 },
  });
});

test('callProvider ollama falls back gracefully when usage is absent', async () => {
  const mockResponse = {
    choices: [{ message: { content: 'bare response' }, finish_reason: 'stop' }],
    // no usage field — some Ollama models omit it
  };

  const llm = {
    provider: 'ollama',
    modelId: 'llama3.2',
    modelConfig: {},
    client: { chat: { completions: { create: async () => mockResponse } } },
  };

  const result = await callProvider(llm, {
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    maxTokens: 100,
  });

  assert.equal(result.text, 'bare response');
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.stopReason, 'end_turn'); // OPENAI_STOP_MAP: stop → end_turn
  assert.deepEqual(result.toolCalls, []);
});

// ---------------------------------------------------------------------------
// callProviderStream — ollama path
// ---------------------------------------------------------------------------

test('ollama stream normalizes token deltas and accumulated tool args', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'Hey' } }] },
    { choices: [{ delta: { content: ' there' } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'tc_2', function: { name: 'lookup', arguments: '{"q' } }],
        },
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '":"foo"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
  ];

  let capturedBody = null;
  const llm = {
    provider: 'ollama',
    modelId: 'llama3.2',
    modelConfig: {},
    client: {
      chat: {
        completions: {
          create: async (body) => {
            capturedBody = body;
            return asyncIterableOf(chunks);
          },
        },
      },
    },
  };

  const { tokens, final } = await collect(callProviderStream(llm, {
    system: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
    tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
  }));

  assert.deepEqual(tokens, ['Hey', ' there']);
  assert.equal(final.text, 'Hey there');
  assert.equal(final.inputTokens, 20);
  assert.equal(final.outputTokens, 8);
  assert.equal(final.stopReason, 'tool_use');
  assert.deepEqual(final.toolCalls[0], {
    type: 'tool_use',
    id: 'tc_2',
    name: 'lookup',
    input: { q: 'foo' },
  });

  // Body must include streaming flags and OpenAI-converted tool schema
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  assert.equal(capturedBody.tools[0].type, 'function');
  assert.equal(capturedBody.tools[0].function.name, 'lookup');

  // raw.content is Anthropic-format so the tool-use loop can push it back
  assert.deepEqual(final.raw.content, [
    { type: 'text', text: 'Hey there' },
    { type: 'tool_use', id: 'tc_2', name: 'lookup', input: { q: 'foo' } },
  ]);
});

test('ollama stream with no tools yields text-only final', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'plain text' } }] },
    { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ];

  const llm = {
    provider: 'ollama',
    modelId: 'llama3.2',
    modelConfig: {},
    client: { chat: { completions: { create: async () => asyncIterableOf(chunks) } } },
  };

  const { tokens, final } = await collect(callProviderStream(llm, {
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    maxTokens: 50,
  }));

  assert.deepEqual(tokens, ['plain text']);
  assert.equal(final.text, 'plain text');
  assert.equal(final.stopReason, 'end_turn');
  assert.deepEqual(final.toolCalls, []);
});

// ---------------------------------------------------------------------------
// Gate: non-ollama config does not route to ollama
// ---------------------------------------------------------------------------

test('anthropic provider does not reach ollama path', async () => {
  // If the ollama path were accidentally hit for an anthropic model it would
  // call client.chat.completions.create — which doesn't exist on Anthropic SDK.
  // A mock that throws proves the anthropic path is taken instead.
  const ollamaSpy = { chat: { completions: { create: async () => { throw new Error('ollama hit'); } } } };
  const anthropicEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ];

  const llm = {
    provider: 'anthropic',
    modelId: 'claude-test',
    client: {
      messages: { create: async () => ({ [Symbol.asyncIterator]: () => asyncIterableOf(anthropicEvents)[Symbol.asyncIterator]() }) },
      ...ollamaSpy, // would explode if reached
    },
  };

  // Should not throw — anthropic path handles it
  const { final } = await collect(callProviderStream(llm, {
    system: 's',
    messages: [{ role: 'user', content: 'q' }],
    maxTokens: 10,
  }));
  assert.equal(final.text, 'ok');
});
